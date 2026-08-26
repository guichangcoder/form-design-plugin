# 多维表格表单设计插件

飞书多维表格（Base）侧边栏插件，提供自定义表单界面，解决多维表格在录入场景下的三个痛点：

- **主子表联动录入**：一个表单内同时填写主表 + 多个子表，提交后自动用主表记录关联写入子表
- **必填项控制**：配置阶段标记必填字段，提交前校验，不通过则提示
- **条件显示**：基于字段值动态显示/隐藏、动态设置/取消必填（如"有费用"→显示费用字段）

## 技术栈

| 组件 | 选型 |
|------|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 5 |
| SDK | `@lark-base-open/js-sdk` |
| UI 库 | Semi UI（`@douyinfe/semi-ui`） |
| 国际化 | i18next + react-i18next |

## 目录结构

```
src/
├── components/
│   ├── LoadApp/            # 飞书环境检测包装（非阻塞）
│   ├── ConfigPanel/        # 配置面板（管理员配置表单）
│   │   ├── index.tsx       # 配置主界面（主表/子表/规则）
│   │   ├── FieldConfigList.tsx  # 字段可见/必填配置
│   │   ├── SubTableConfig.tsx   # 子表 + 关联字段配置
│   │   └── RuleEditor.tsx       # 条件显示规则编辑器
│   └── FormRenderer/       # 表单渲染（用户填写）
│       ├── index.tsx       # 表单主界面 + 提交
│       ├── MainForm.tsx    # 主表表单
│       ├── SubForm.tsx     # 子表多行表单
│       └── FieldRenderer.tsx    # 单字段渲染（按类型分发）
├── hooks/                  # useConfig / useTableMeta / useFieldMeta / useTheme / useConditional
├── services/               # configService / baseService / recordService
├── types/                  # 配置数据结构与枚举
├── utils/                  # fieldMapper / validator / valueConverter
├── locales/                # i18n（中文）
├── App.tsx                 # 模式切换（配置 / 填写）
├── App.css
└── index.tsx               # 入口
```

## 本地开发

```bash
npm install
npm run dev
# 输出 http://localhost:8848
```

在飞书多维表格中调试：打开一个多维表格 → 扩展脚本 → 新增脚本 → 粘贴本地 dev URL → 确定。

## 构建与发布

```bash
npm run build      # 产出 dist/
npm run typecheck  # 类型检查（不阻塞构建）
```

发布流程：

1. `npm run build` 后将 `dist/` 上传到可访问的 HTTPS 地址（或托管平台）
2. 在飞书开放平台提交扩展脚本上架申请，填写插件访问地址
3. 等待官方审核

> 注意：插件通过 iframe 嵌入飞书，资源必须使用相对路径（`vite.config.ts` 已配置 `base: './'`）。

## 使用说明

1. 首次打开插件进入**配置模式**：选择主表 → 勾选字段、标记必填 →（可选）添加子表并设置指向主表的关联字段 →（可选）配置条件显示规则 → 保存。
2. 保存后进入**填写模式**：按配置的表单录入主表与子表数据，提交后写入多维表格。
3. 点击右上角「配置」可随时回到配置模式修改。

## 已知约束

- 主表与子表之间需**已在多维表格中创建关联字段**（单向/双向关联），否则子表无法关联主表记录。
- 子表一次提交最多 200 条（SDK 限制），超出自动分批。
- 附件上传使用 `bitable.base.batchUploadFile`，禁止并发。
- 人员/群聊/地理位置字段当前以文本输入简化，后续迭代增强选择器。
