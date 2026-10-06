# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
npm install             # 安装依赖
npm run dev             # Vite 开发服务器，端口 8848，允许局域网访问
npm run build           # 生产构建到 dist/
npm run typecheck       # TypeScript 严格类型检查（tsc --noEmit）
npm run preview         # 预览已构建产物，端口 8848
```

`package.json` 目前没有 `lint` 或测试脚本，仓库也没有测试文件/测试运行器；因此暂时没有可运行单个测试的命令。新增测试时需要先引入并配置测试框架及对应 npm script。`npm run build` 当前可能报告大 chunk 和动态导入相关的 Vite warning，但成功退出即表示构建完成。

本项目是嵌入飞书 iframe 的插件，`vite.config.ts` 中的 `base: './'` 是必要配置，不要改成绝对路径。开发时将 `http://localhost:8848`（或局域网可访问地址）作为服务地址加载到飞书多维表格的自定义插件中；直接在普通浏览器打开只会触发环境检测提示。发布前需使用可访问的 HTTPS 地址。

## 架构概览

这是 React 18 + TypeScript + Vite 的飞书多维表格侧边栏/应用模式插件，使用 Semi UI 和 `@lark-base-open/js-sdk`。

- **入口与宿主检测**：`src/index.tsx` 初始化 i18n、Semi CSS，并以 `StrictMode → ErrorBoundary → LoadApp → App` 包装应用。`LoadApp` 优先放行有 dashboard API/state 的应用模式宿主，否则探测 `bitable.bridge.getLanguage()`，最后以超时兜底；普通浏览器会显示环境提示。
- **顶层路由/状态**：`src/App.tsx` 使用 `useForms` 加载多表单数据，并根据宿主区分两套流程：
  - `dashboard`：通过 `dashboard.state`（并用 URL query 的 `isConfig`/`isCreate` 兜底）决定 Create/Config/View/FullScreen；配置态直接展示 `ConfigPanel`，展示态优先展示默认表单/唯一表单。
  - `bridge`：侧边栏中在配置态和填写态之间切换；配置态先进入 `FormManager`，再编辑单份表单，填写态在 `FormPicker` 选表单后进入 `FormRenderer`。
  `App` 还负责 dashboard 状态轮询、`onConfigChange` 同步、`setRendered`、View 态空配置自修复，以及诊断条/错误提示。
- **配置层**：`src/components/ConfigPanel/` 编辑基本信息、主题色、主表字段、子表/关联字段和条件规则。主表或子表选定后，`useTableMeta`/`useFieldMeta` 从 Base 拉取元信息并用 `metaToFieldConfig` 初始化字段。`FormManager` 管理多份相互独立的 `FormPluginConfig`，包括新建、编辑、删除和设默认。
- **填写层**：`src/components/FormRenderer/` 保存主表值和按子表 ID 分组的多行值。`MainForm`/`SubForm` 过滤可见字段并交给 `FieldRenderer` 按 `FieldType` 渲染 Semi 控件；`useConditional` 根据当前值生成隐藏字段、动态必填和取消必填状态。
- **数据写入层**：`src/services/recordService.ts` 先 `addRecord` 主表取得 `recordId`，再把该 ID 注入每个子表的关联字段并按 200 条一批调用 `addRecords`。任一子表写入失败时尝试删除已创建的主表记录。`src/utils/valueConverter.ts` 负责日期毫秒时间戳、附件 `{text, val}` 等 SDK 格式转换，关联字段由提交服务单独注入。
- **基础服务与工具**：`baseService.ts` 封装表/字段元信息、可录入字段过滤、选项提取、关联字段查找和 field ID→table ID 反查；`validator.ts` 校验当前可见字段的必填值；`theme.ts` 将表单主题色写入 CSS 变量；`toast.ts` 统一 SDK toast。`src/locales/` 目前只初始化中文资源，实际界面仍有不少直接写在组件中的中文文案。

## 配置持久化与 dashboard 约束

`src/services/configService.ts` 是持久化入口，`useForms.ts` 只是 React 状态封装：

- 读取优先尝试 dashboard `getConfig().customConfig`，然后尝试 `bitable.bridge.getData`，最后在可用时读取 iframe `localStorage`；同时兼容旧版单份配置并包装成 `forms[0]`。
- 保存到 dashboard 时必须调用 `dashboard.saveConfig` 并让真实错误向上抛出，否则飞书不会关闭配置弹窗或完成 widget 创建。`dataConditions` 只传用户选定的**主表**一个数据源（带 `dataRange: { type: 'ALL' }`），不要为子表追加数据源。
- dashboard 的 `customConfig` 有 10240 字节上限。`configSize.ts` 的 `serializeConfig` 只保留用户决策字段，剥离字段名/类型/选项、表名、子表 table ID 和规则 table ID；`hydrateConfig` 加载时通过 Base 元信息和 field ID 反查补全。修改配置结构时必须同时考虑这套瘦身/还原逻辑。
- bridge 存储同样写入瘦配置；bridge 不可用时才回退 localStorage。`localStorage` 中的 `__plugin_last_save_payload__` 和 `__plugin_last_save_readback__` 是 dashboard 保存诊断用临时记录，不是业务配置。
- 配置模型定义在 `src/types/index.ts`：持久化根对象是 `PluginData { forms, defaultFormId }`，不是单独的 `FormPluginConfig`。字段和条件规则都按 Base 的稳定 `fieldId`/`tableId` 工作。

## 飞书 SDK 与领域限制

- 子表必须预先在 Base 中创建指向主表的 SingleLink/DuplexLink 关联字段；插件只在提交时自动写入关联，不提供普通关联字段输入。
- SDK 的 `addRecords` 单次最多 200 条，子表写入必须分批；`batchUploadFile` 上传附件时使用 SDK，不要并发调用或改成普通 HTTP 上传。
- 配置阶段会过滤 Formula、Lookup、创建/修改时间、创建/修改人、自动编号、Barcode 等系统只读字段。
- 当前人员、群聊、地理位置字段使用文本输入简化；关联字段只读提示；日期由 Semi 的值转换为时间戳；单选/多选选项来自字段元信息。
- SDK 不提供事务，现有实现用失败后删除主记录的方式尽量保持一致性，修改提交顺序或错误处理时要保留这一点。

## 诊断与排错入口

`App.tsx` 的开发/宿主诊断条会显示宿主上下文、dashboard state、保存结果和配置读回摘要。`src/services/probe.ts` 主动探测 URL 状态、Base 表列表、dashboard `getConfig` 和 iframe 上下文；`diagExport.ts` 可通过页面按钮下载 JSON 诊断包。遇到 View 态被飞书替换成“配置数据发生变更”占位时，先看 ErrorBoundary 红框、诊断条和导出的诊断包，不要只根据宿主占位文案判断 React 根因。

## 仓库文件说明

`README.md` 和 `技术方案_多维表格表单设计插件.md` 包含产品/部署背景，但部分目录名仍是早期设计（例如 `useConfig`）；实现的当前事实以 `src/`、`package.json` 和 `vite.config.ts` 为准。仓库没有额外的 Cursor 或 Copilot 规则文件。`.gitignore` 忽略 `dist/`，但当前 git 历史中仍跟踪 `dist/index.html`，构建后提交前应检查 `git status`。
