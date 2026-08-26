import { bitable, FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig, FormValues } from '../types';
import { isEmptyValue } from './validator';

/**
 * 将表单态的单个字段值，转换为多维表格 SDK 写入所需的 cell 值格式。
 * 不同字段类型的存储格式不同：日期需转毫秒时间戳，附件需包裹为 {text,val}。
 */
export function convertCellValue(
  type: FieldType,
  raw: unknown,
  _field?: FieldConfig
): unknown {
  switch (type) {
    case FieldType.DateTime:
      return typeof raw === 'number' ? raw : Number(new Date(String(raw)).getTime());
    case FieldType.Attachment:
      // 附件值：batchUploadFile 返回的 fileToken 数组，需包裹为 {text, val}
      return Array.isArray(raw) ? { text: '', val: raw as string[] } : raw;
    default:
      return raw;
  }
}

/**
 * 将一组表单字段值转换为 SDK 写入格式（fields 对象）。
 * key 统一使用字段 ID，value 为转换后的 cell 值。空值字段会被跳过。
 * 关联字段（SingleLink/DuplexLink）不在此处处理，由 submitForm 单独设置。
 */
export async function convertToSdkFormat(
  fields: FieldConfig[],
  values: FormValues,
  tableId: string
): Promise<Record<string, unknown>> {
  const table = await bitable.base.getTableById(tableId);
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = values[field.fieldId];
    if (isEmptyValue(raw)) continue;
    // 关联字段写入由 submitForm 注入（含主表 recordId），这里跳过
    if (field.fieldType === FieldType.SingleLink || field.fieldType === FieldType.DuplexLink) {
      continue;
    }
    const fieldInstance = await table.getField(field.fieldId);
    const meta = await fieldInstance.getMeta();
    result[field.fieldId] = convertCellValue(meta.type, raw, field);
  }
  return result;
}
