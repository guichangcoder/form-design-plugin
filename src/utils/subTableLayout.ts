/**
 * 子表「展现形式」相关的纯函数。
 *
 * 为什么单独抽一个模块：
 * 1. 横向表格的列模型（列头 / 列宽 / 逐行隐藏 / 逐行必填）是纯计算，抽出来就能在 Node 里
 *    跑断言（`tests/regression.entry.mjs` F25），不必靠肉眼看界面。
 * 2. 纵向卡片与横向表格必须共用同一套「行变更」语义（含引用选项的级联清空），
 *    否则两种形态下用户填出来的数据可能不一致。
 *
 * 语义约定（横向表格）：
 * - 字段在当前条件下【所有行】都被隐藏 → 整列从表头移除（列对该表已无意义）。
 * - 字段只在【部分行】被行级规则隐藏 → 列保留，这些行的单元格留空（提交时值照旧被过滤）。
 * - 必填：所有行都必填 → 列头显示 `*`；只有部分行必填 → 该行列头不给星，改在对应单元格内提示。
 */
import { FieldType } from '@lark-base-open/js-sdk';
import {
  ConditionalState,
  FieldConfig,
  FormValues,
  SubTableConfig,
  SubTableLayout,
} from '../types';
import { getOptionRefDependencies } from './optionRef';
import { isFieldRequired, isHiddenField } from './validator';

/** 序号列固定宽度（同时是左侧吸顶列） */
export const SUB_ROW_INDEX_WIDTH = 48;
/** 操作列固定宽度（右侧吸顶，放删除按钮） */
export const SUB_ROW_ACTION_WIDTH = 56;

/** 解析子表展现形式；缺省（含旧配置）视为纵向卡片 */
export function resolveSubLayout(sub: SubTableConfig): SubTableLayout {
  return sub.layout === 'table' ? 'table' : 'vertical';
}

/**
 * 按字段类型给出「建议最小列宽」：
 * 容器够宽时由 CSS 按比例撑满，不够宽时该宽度参与 min-width 计算并触发横向滚动。
 * 目标是容得下控件的正常形态（如附件/人员选择器比数字框需要更宽）。
 */
export function suggestColumnWidth(field: FieldConfig): number {
  switch (field.fieldType) {
    case FieldType.Text:
      return 200;
    case FieldType.Number:
    case FieldType.Currency:
    case FieldType.Progress:
    case FieldType.DateTime:
      return 150;
    case FieldType.SingleSelect:
      return 160;
    case FieldType.MultiSelect:
      return 170;
    case FieldType.Checkbox:
      return 110;
    case FieldType.Rating:
      return 150;
    case FieldType.Phone:
    case FieldType.Url:
    case FieldType.Email:
      return 190;
    case FieldType.User:
      return 220;
    case FieldType.Attachment:
      return 230;
    case FieldType.SingleLink:
    case FieldType.DuplexLink:
      return 230;
    default:
      return 180;
  }
}

/** 横向表格的一列（含该列的逐行必填 / 逐行隐藏信息） */
export interface SubColumn {
  fieldId: string;
  label: string;
  width: number;
  /** 需要该字段的行索引集合（行级必填的并集） */
  requiredRows: number[];
  /** 所有行都必填 → 列头显示星号 */
  requiredEverywhere: boolean;
  /** 部分行必填 → 列头不给星，改在对应单元格内提示（避免误导其他行） */
  partialRequired: boolean;
  /** 该列中因行级条件被隐藏的行索引集合（这些行的单元格留空） */
  hiddenRows: number[];
}

export interface SubColumnsResult {
  columns: SubColumn[];
  /** 固定区总宽（序号列 + 操作列） */
  fixedWidth: number;
  /** 内容列总宽 */
  contentWidth: number;
  /** 表格最小总宽：超出容器时由外层 overflow-x 触发左右滑动 */
  minWidth: number;
  /** 无任何可见列（用户把所有字段都隐藏了） */
  empty: boolean;
}

/**
 * 构建横向表格的列模型。
 * @param sub 子表配置
 * @param cond 条件引擎计算结果（含全表级 + 行级集合）
 * @param rowCount 当前行数（判断「所有行都隐藏」与「所有行都必填」需要它）
 * @param showActionColumn 是否显示最右侧操作列（不可删除时不显示）
 */
export function buildSubColumns(
  sub: SubTableConfig,
  cond: ConditionalState,
  rowCount: number,
  showActionColumn: boolean
): SubColumnsResult {
  const columns: SubColumn[] = [];

  for (const f of sub.fields) {
    // 「指向主表的关联字段」由提交逻辑自动注入，任何形态下都不渲染
    if (f.fieldId === sub.linkFieldId) continue;
    if (!f.visible) continue;
    // 全表级隐藏 → 整列移除（不传 rowIndex 只判全表级集合）
    if (isHiddenField(cond, sub.tableId, f.fieldId)) continue;

    const requiredRows: number[] = [];
    const hiddenRows: number[] = [];
    for (let i = 0; i < rowCount; i++) {
      if (isFieldRequired(f, sub.tableId, cond, i)) requiredRows.push(i);
      if (isHiddenField(cond, sub.tableId, f.fieldId, i)) hiddenRows.push(i);
    }

    const requiredEverywhere = rowCount > 0 && requiredRows.length === rowCount;
    columns.push({
      fieldId: f.fieldId,
      label: f.label || f.fieldName || f.fieldId,
      width: suggestColumnWidth(f),
      requiredRows,
      requiredEverywhere,
      partialRequired: requiredRows.length > 0 && !requiredEverywhere,
      hiddenRows,
    });
  }

  const contentWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const fixedWidth = SUB_ROW_INDEX_WIDTH + (showActionColumn ? SUB_ROW_ACTION_WIDTH : 0);

  return {
    columns,
    fixedWidth,
    contentWidth,
    minWidth: fixedWidth + contentWidth,
    empty: columns.length === 0,
  };
}

/** 用字段默认值构造一行（与 FormRenderer.initialValues / SubForm.addRow 语义一致） */
export function defaultRowValues(fields: FieldConfig[]): FormValues {
  return fields.reduce<FormValues>((values, field) => {
    if (field.defaultValue !== undefined) {
      values[field.fieldId] = Array.isArray(field.defaultValue)
        ? [...(field.defaultValue as unknown[])]
        : field.defaultValue;
    }
    return values;
  }, {});
}

/**
 * 行内字段变更 + 级联清空。
 * 引用选项依赖了被改字段的同行字段（如省→市），父值一变，已选的下级值即失效直接清空，
 * 避免提交脏数据。纵向卡片与横向表格共用本函数，保证两种形态写入行为一致。
 */
export function applyRowFieldChange(
  fields: FieldConfig[],
  row: FormValues,
  fieldId: string,
  value: unknown
): FormValues {
  const next: FormValues = { ...row, [fieldId]: value };
  for (const f of fields) {
    if (f.fieldId === fieldId) continue;
    if (!getOptionRefDependencies(f).includes(fieldId)) continue;
    if (next[f.fieldId] === undefined) continue;
    next[f.fieldId] = f.fieldType === FieldType.MultiSelect ? [] : undefined;
  }
  return next;
}

/** 更新指定行的某个字段（返回新数组，不改原值） */
export function updateRowAt(
  fields: FieldConfig[],
  rows: FormValues[],
  rowIndex: number,
  fieldId: string,
  value: unknown
): FormValues[] {
  return rows.map((r, i) => (i === rowIndex ? applyRowFieldChange(fields, r, fieldId, value) : r));
}

/** 删除指定行（返回新数组） */
export function removeRowAt(rows: FormValues[], rowIndex: number): FormValues[] {
  return rows.filter((_, i) => i !== rowIndex);
}

/** 追加一行（字段默认值填充） */
export function appendRow(rows: FormValues[], fields: FieldConfig[]): FormValues[] {
  return [...rows, defaultRowValues(fields)];
}

/** 是否还能继续添加行（受 maxRows 约束；未配置 maxRows 则不限制） */
export function canAppendRow(maxRows: number | undefined, rowCount: number): boolean {
  if (!maxRows) return true;
  return rowCount < maxRows;
}

/** 该行在该列上是否被行级条件隐藏（表格里表现为单元格留空） */
export function isCellHidden(column: SubColumn, rowIndex: number): boolean {
  return column.hiddenRows.includes(rowIndex);
}