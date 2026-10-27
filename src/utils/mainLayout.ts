/**
 * 主表「排布列数」相关纯逻辑（不依赖 React / Semi / SDK，回归测试可在 Node 中直接跑）。
 *
 * 需求：主表默认纵向单列排布，可选双列 / 三列，让短控件并排减少纵向滚动。
 *
 * ★ 为什么要抽纯函数：
 *   列数解析与「哪些字段跨整行」是**显示决策**，靠源码正则断言只能证明 class 名存在，
 *   证明不了运行时真的算出了正确列数 / 跨列标记。抽成纯函数后测试可直接调用真实实现。
 *
 * 语义约定：
 * - 缺省（含旧配置 mainColumns 缺失）= 1 列 → 与既有单列渲染**完全一致**（零破坏）。
 * - 非法值（0 / 4 / 'x' / NaN）一律回退 1 列。
 * - 多列时，**内容形态天然需要整行**的字段（多行文本、附件、关联记录）跨满整行：
 *   把它们塞进半栏会被压得很窄，输入框高度与标签换行都会失控。
 */

import { FieldType } from '@lark-base-open/js-sdk';

/** 主表排布列数：单列 / 双列 / 三列 */
export type MainColumns = 1 | 2 | 3;

/** 配置面板可选的列数（顺序即展示顺序） */
export const MAIN_COLUMNS_OPTIONS: readonly MainColumns[] = [1, 2, 3] as const;

/** 列数上限（用于夹取值域） */
export const MAX_MAIN_COLUMNS = 3;

/**
 * 解析主表列数：非法 / 缺失一律回退 1 列（单列）。
 * 旧配置没有该字段 → 1 列，行为与今日完全一致。
 */
export function resolveMainColumns(value: unknown): MainColumns {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > MAX_MAIN_COLUMNS) return MAX_MAIN_COLUMNS;
  return i as MainColumns;
}

/**
 * 是否启用多列布局（> 1 列）。
 * 单列时调用方**不套用 grid 容器**，保证既有渲染路径零变化。
 */
export function isMultiColumn(value: unknown): boolean {
  return resolveMainColumns(value) > 1;
}

/**
 * 该字段在多列布局下是否应跨满整行。
 *
 * 规则（按字段「控件形态」而非业务含义判断）：
 * - 多行文本框（Text → TextArea）：内容可能很长，半栏太窄 → 整行
 * - 附件：文件名 + 多个缩略图必然换行 → 整行
 * - 关联记录：可多选的记录标签会横向堆叠 → 整行
 * 其余（数字 / 日期 / 选项 / 人员 / 电话等）单行控件，并排无压力。
 */
export function shouldSpanFullRow(fieldType: FieldType): boolean {
  return (
    fieldType === FieldType.Text ||
    fieldType === FieldType.Attachment ||
    fieldType === FieldType.SingleLink ||
    fieldType === FieldType.DuplexLink
  );
}

/**
 * 计算字段在 grid 中占用的列数：跨整行 = 全部列，否则 1 列。
 * 单列布局恒为 1（此时「跨整行」与普通字段视觉一致）。
 */
export function fieldGridSpan(fieldType: FieldType, columns: unknown): number {
  const cols = resolveMainColumns(columns);
  if (cols === 1) return 1;
  return shouldSpanFullRow(fieldType) ? cols : 1;
}