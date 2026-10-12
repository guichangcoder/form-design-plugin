import { FieldType } from '@lark-base-open/js-sdk';
import {
  FormPluginConfig,
  FormValues,
  ValidationResult,
  SubTableConfig,
  FieldConfig,
  ConditionalState,
  FieldError,
} from '../types';

/**
 * 判断某个字段是否应当被隐藏。
 * 全表级集合对主表与子表所有行生效；子表行级集合只对指定行生效（传 rowIndex 时判断）。
 */
export function isHiddenField(
  cond: ConditionalState,
  tableId: string,
  fieldId: string,
  rowIndex?: number
): boolean {
  if (cond.hiddenFields[tableId]?.has(fieldId)) return true;
  if (rowIndex !== undefined && cond.rowHiddenFields[tableId]?.[rowIndex]?.has(fieldId)) {
    return true;
  }
  return false;
}

/**
 * 判断主表/子表某个字段在当前条件下是否必填。
 * 基础必填 = field.required；再叠加条件引擎的 forcedRequired / forcedUnrequired
 * （全表级 + 子表行级，行级优先判断取消、再判断强制）。
 */
export function isFieldRequired(
  field: FieldConfig,
  tableId: string,
  cond: ConditionalState,
  rowIndex?: number
): boolean {
  // 关联字段由提交逻辑自动注入主表 recordId，不应要求用户填写。
  if (field.fieldType === FieldType.SingleLink || field.fieldType === FieldType.DuplexLink) {
    return false;
  }
  if (cond.forcedUnrequired[tableId]?.has(field.fieldId)) return false;
  if (rowIndex !== undefined && cond.rowForcedUnrequired[tableId]?.[rowIndex]?.has(field.fieldId)) {
    return false;
  }
  if (cond.forcedRequired[tableId]?.has(field.fieldId)) return true;
  if (rowIndex !== undefined && cond.rowForcedRequired[tableId]?.[rowIndex]?.has(field.fieldId)) {
    return true;
  }
  return field.required;
}

/**
 * 日期值本地校验（飞书官方诊断 P2-8）。
 * 合法形态：有限毫秒时间戳 / Date 实例 / 可解析的日期字符串。
 * 无效值（如默认值里残留的 'not-a-date'）在提交前就报字段级错误，
 * 不原样透传给 Base 写接口。
 */
export function isValidDateValue(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v instanceof Date) return Number.isFinite(v.getTime());
  if (typeof v === 'string') return Number.isFinite(new Date(v).getTime());
  return false;
}

/**
 * 校验必填项与字段格式。隐藏字段不参与校验（符合"条件显示"的语义），
 * 隐藏字段的值也不会被提交（见 recordService 的隐藏值过滤）。
 * @param config 插件配置
 * @param mainValues 主表字段值
 * @param subValues 子表字段值，按 subConfig.tableId -> 行数组 组织
 * @param cond 条件引擎计算结果（用于判断隐藏与动态必填，子表按行判断）
 */
export function validateForm(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>,
  cond: ConditionalState
): ValidationResult {
  const errors: string[] = [];
  const fieldErrors: FieldError[] = [];

  // 1. 校验主表
  for (const field of config.mainTable.fields) {
    if (isHiddenField(cond, config.mainTable.tableId, field.fieldId)) continue;
    const value = mainValues[field.fieldId];
    if (isFieldRequired(field, config.mainTable.tableId, cond)) {
      if (isEmptyValue(value)) {
        errors.push(`主表「${field.label || field.fieldName}」为必填项`);
        fieldErrors.push({
          tableId: config.mainTable.tableId,
          fieldId: field.fieldId,
          message: '必填项，请填写',
        });
        continue;
      }
    }
    // 日期格式本地校验（非空才校验）
    if (field.fieldType === FieldType.DateTime && !isEmptyValue(value) && !isValidDateValue(value)) {
      errors.push(`主表「${field.label || field.fieldName}」日期格式无效，请重新选择`);
      fieldErrors.push({
        tableId: config.mainTable.tableId,
        fieldId: field.fieldId,
        message: '日期格式无效，请重新选择',
      });
    }
  }

  // 2. 校验子表（每条记录，按行应用条件规则）
  for (const sub of config.subTables) {
    const rows = subValues[sub.tableId] ?? [];
    // 子表初始会展示一行空白占位；用户未填写任何字段时，不创建空子表记录，
    // 也不应因为子表必填字段而阻止只填写主表。
    // 注意：rowIndex 必须是原始行索引（行级条件规则按原始行索引计算），
    // 不能用 filter 后的新索引，否则空行错位会导致行级必填/隐藏判定张冠李戴。
    rows.forEach((row, rowIndex) => {
      const hasAnyValue = sub.fields.some((field) => !isEmptyValue(row[field.fieldId]));
      if (!hasAnyValue) return;
      validateSubRow(sub, row, rowIndex, cond, errors, fieldErrors);
    });
  }

  return { valid: errors.length === 0, errors, fieldErrors };
}

function validateSubRow(
  sub: SubTableConfig,
  row: FormValues,
  rowIndex: number,
  cond: ConditionalState,
  errors: string[],
  fieldErrors: FieldError[]
): void {
  for (const field of sub.fields) {
    if (isHiddenField(cond, sub.tableId, field.fieldId, rowIndex)) continue;
    const value = row[field.fieldId];
    if (isFieldRequired(field, sub.tableId, cond, rowIndex)) {
      if (isEmptyValue(value)) {
        errors.push(
          `子表「${sub.tableName}」第 ${rowIndex + 1} 行：「${field.label || field.fieldName}」为必填项`
        );
        fieldErrors.push({
          tableId: sub.tableId,
          fieldId: field.fieldId,
          rowIndex,
          message: '必填项，请填写',
        });
        continue;
      }
    }
    if (field.fieldType === FieldType.DateTime && !isEmptyValue(value) && !isValidDateValue(value)) {
      errors.push(
        `子表「${sub.tableName}」第 ${rowIndex + 1} 行：「${field.label || field.fieldName}」日期格式无效，请重新选择`
      );
      fieldErrors.push({
        tableId: sub.tableId,
        fieldId: field.fieldId,
        rowIndex,
        message: '日期格式无效，请重新选择',
      });
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
