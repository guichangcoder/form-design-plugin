/**
 * 配置面板「高级配置入口是否出现」的纯函数判定。
 *
 * 为什么单独成模块（而不是写在组件里）：这是**一个 UI 类判定**，其正确性只能用
 * 「真实调用」来证明（源码正则断言证明不了运行时产出）。抽成纯函数后回归测试可直接
 * 喂 FieldConfig 验证，无需渲染整棵树。
 *
 * ★ 本项目真实缺陷（2026-10-27 修复）：
 *   `fieldType` 是运行时可重取的元数据，持久化层会剥离它（configSize.STRIP_FIELDS），
 *   刷新后依赖 `hydrateConfig` 从 base 元信息补回。一旦补不回来（base 未绑定 /
 *   字段读不到 / 接口异常），`fieldType` 即为 undefined。
 *
 *   旧行为：入口守门写成 `isSelectField(f.fieldType)` → false → 「引用选项」按钮乃至
 *   整个高级配置区**整块消失** → 用户以为自己配过的条件丢了（与渲染侧静默降级
 *   共同构成「保存后生效、刷新后失效」）。
 *
 *   正确行为：**只要对应配置仍在（optionRef / formRef 完整），入口就必须保留** ——
 *   因为配置端只允许选择类字段启用它们，「配置仍在」本身即足以断定它是选择类字段，
 *   不必依赖可能缺失的类型元信息。
 */
import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig } from '../types';
import { hasOptionRef } from './optionRef';
import { hasFormRef } from './formFieldRef';

/** 字段类型是否为选择类（单选 / 多选） */
export function isSelectFieldType(t: FieldType | undefined): boolean {
  return t === FieldType.SingleSelect || t === FieldType.MultiSelect;
}

/**
 * 该字段是否应出现「引用选项」配置入口。
 * 类型是选择类，**或**已配过完整的 optionRef（类型元信息缺失时的兜底）。
 */
export function canConfigOptionRef(f: FieldConfig): boolean {
  return isSelectFieldType(f?.fieldType) || hasOptionRef(f);
}

/**
 * 该字段是否应出现「表单取值」配置入口。
 * 类型是选择类，**或**已配过完整的 formRef（类型元信息缺失时的兜底）。
 */
export function canConfigFormRef(f: FieldConfig): boolean {
  return isSelectFieldType(f?.fieldType) || hasFormRef(f);
}

/**
 * 高级配置区（整块）是否应渲染。任一子项可用就渲染 ——
 * 漏掉这里的判断会让「已配过配置的字段」整块消失。
 */
export function hasAnyAdvancedEntry(
  f: FieldConfig,
  opts: { uniqueCheckable: boolean; dateField: boolean; userField: boolean }
): boolean {
  return (
    opts.uniqueCheckable ||
    opts.dateField ||
    canConfigOptionRef(f) ||
    canConfigFormRef(f) ||
    opts.userField
  );
}