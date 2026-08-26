import {
  FormPluginConfig,
  FormValues,
  ValidationResult,
  SubTableConfig,
  FieldConfig,
  ConditionalState,
} from '../types';

/** 判断某个字段在给定表内是否应当被隐藏 */
function isHidden(
  tableId: string,
  fieldId: string,
  hiddenFields: Record<string, Set<string>>
): boolean {
  return !!hiddenFields[tableId]?.has(fieldId);
}

/**
 * 判断主表/子表某个字段在当前条件下是否必填。
 * 基础必填 = field.required；再叠加条件引擎的 forcedRequired / forcedUnrequired。
 */
export function isFieldRequired(
  field: FieldConfig,
  tableId: string,
  cond: ConditionalState
): boolean {
  if (cond.forcedUnrequired[tableId]?.has(field.fieldId)) return false;
  if (cond.forcedRequired[tableId]?.has(field.fieldId)) return true;
  return field.required;
}

/**
 * 校验必填项。隐藏字段不参与校验（符合"条件显示"的语义）。
 * @param config 插件配置
 * @param mainValues 主表字段值
 * @param subValues 子表字段值，按 subConfig.tableId -> 行数组 组织
 * @param cond 条件引擎计算结果（用于判断隐藏与动态必填）
 */
export function validateForm(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>,
  cond: ConditionalState
): ValidationResult {
  const errors: string[] = [];

  // 1. 校验主表
  for (const field of config.mainTable.fields) {
    if (isHidden(config.mainTable.tableId, field.fieldId, cond.hiddenFields)) continue;
    if (isFieldRequired(field, config.mainTable.tableId, cond)) {
      if (isEmptyValue(mainValues[field.fieldId])) {
        errors.push(`主表「${field.label || field.fieldName}」为必填项`);
      }
    }
  }

  // 2. 校验子表（每条记录）
  for (const sub of config.subTables) {
    const rows = subValues[sub.tableId] ?? [];
    if (rows.length === 0) continue;
    rows.forEach((row, rowIndex) => {
      validateSubRow(sub, row, rowIndex, cond, errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

function validateSubRow(
  sub: SubTableConfig,
  row: FormValues,
  rowIndex: number,
  cond: ConditionalState,
  errors: string[]
): void {
  for (const field of sub.fields) {
    if (isHidden(sub.tableId, field.fieldId, cond.hiddenFields)) continue;
    if (isFieldRequired(field, sub.tableId, cond)) {
      if (isEmptyValue(row[field.fieldId])) {
        errors.push(
          `子表「${sub.tableName}」第 ${rowIndex + 1} 行：「${field.label || field.fieldName}」为必填项`
        );
      }
    }
  }
}

/** 判空：覆盖 undefined / null / '' / 空数组 */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
