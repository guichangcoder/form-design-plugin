import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig, FormValues } from '../types';
import { isEmptyValue } from './validator';
import { getTableStrict, getBaseOrThrow } from '../services/appContext';
import { getLinkTargetTableId } from '../services/baseService';
import { isWritableFieldType } from './fieldMapper';

/**
 * 将表单态的单个字段值，转换为多维表格 SDK 写入所需的 cell 值格式。
 * 不同字段类型的存储格式不同：日期需转毫秒时间戳，附件需包裹为 {text,val}。
 */
export function convertCellValue(
  type: FieldType,
  raw: unknown,
  field?: FieldConfig
): unknown {
  switch (type) {
    case FieldType.DateTime: {
      if (typeof raw === 'number') return raw;
      if (raw instanceof Date) return raw.getTime();
      const timestamp = new Date(String(raw)).getTime();
      return Number.isFinite(timestamp) ? timestamp : raw;
    }
    case FieldType.Attachment:
      // 附件在 convertToSdkFormat 中统一上传并包裹为 {name,size,type,token,timeStamp}，
      // 这里对直接调用兜底返回原值（File[] 由 SDK 字段 transform 处理）。
      return raw;
    case FieldType.SingleSelect:
      return toSelectCellValue(raw, field);
    case FieldType.MultiSelect:
      return Array.isArray(raw) ? raw.map((v) => toSelectCellValue(v, field)) : raw;
    default:
      return raw;
  }
}

function toSelectCellValue(raw: unknown, field?: FieldConfig): unknown {
  if (raw && typeof raw === 'object') return raw;
  const value = String(raw ?? '');
  const option = field?.options?.find((o) => o.id === value || o.name === value);
  return { id: option?.id ?? value, text: option?.name ?? value };
}

/**
 * 将一组表单字段值转换为 SDK 写入格式（fields 对象）。
 * key 统一使用字段 ID，value 为转换后的 cell 值。空值字段会被跳过。
 * 关联字段：用户选择的目标表 recordId 数组在此包裹为 IOpenLink；
 * 子表「指向主表的关联字段」无用户值，由 submitForm 单独注入。
 */
export async function convertToSdkFormat(
  fields: FieldConfig[],
  values: FormValues,
  tableId: string
): Promise<Record<string, unknown>> {
  const table = await getTableStrict(tableId);
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = values[field.fieldId];
    if (isEmptyValue(raw)) continue;
    // 关联字段：用户从目标表选择的 recordId 数组 → 包裹为 IOpenLink 写入。
    // （子表中「指向主表的关联字段」无用户值，已被 isEmptyValue 跳过；
    //   recordService 随后会注入主表 recordId 覆盖同名 key。）
    if (field.fieldType === FieldType.SingleLink || field.fieldType === FieldType.DuplexLink) {
      const ids = (Array.isArray(raw) ? (raw as string[]) : []).filter(Boolean);
      if (ids.length === 0) continue;
      const target =
        field.linkTableId || (await getLinkTargetTableId(tableId, field.fieldId)) || '';
      if (!target) {
        throw new Error(`关联字段「${field.label || field.fieldName}」未找到目标表，请重新保存配置`);
      }
      result[field.fieldId] = {
        text: '',
        type: 'text',
        recordIds: ids,
        tableId: target,
        record_ids: ids,
        table_id: target,
      };
      continue;
    }
    // 附件：在提交阶段统一上传并包裹为 IOpenAttachment[]（token 由 batchUploadFile 返回）
    if (field.fieldType === FieldType.Attachment && Array.isArray(raw)) {
      const files = (raw as File[]).filter((f) => f instanceof File);
      if (files.length === 0) continue;
      const tokens = await getBaseOrThrow().batchUploadFile(files);
      result[field.fieldId] = files.map((f, i) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        token: tokens[i],
        timeStamp: Date.now(),
      }));
      continue;
    }
    const fieldInstance = await table.getField(field.fieldId);
    const meta = await fieldInstance.getMeta();
    /**
     * ★ 提交前最后一道把关（线上「主表写入失败：not support」根因修复）。
     *
     * 这里拿到的是**表里当前的真实类型**，可能已经与配置时的声明类型不同
     * （配置时是文本，之后被改成公式 / 自动编号 / 查找引用 / 关联等）。
     * 这类字段宿主一律拒绝写入，且报错是没有上下文的 `not support`，
     * 导致整条 addRecord 失败——同一张表里只有「碰到这些字段」的提交者报错，
     * 别人正常，过一会儿表结构/权限又变回来就又好了。
     *
     * 处理策略：**跳过该字段并保留其余字段的写入**，而不是让整条记录失败。
     * 站点数据比一个派生字段更重要，且该字段本来也写不进去。
     */
    if (!isWritableFieldType(meta.type)) {
      console.warn(
        `[valueConverter] 跳过不可写字段「${field.label || field.fieldName || field.fieldId}」` +
          `（fieldId=${field.fieldId}，当前实际类型=${FieldType[meta.type] ?? meta.type}）。` +
          '该类型不支持通过 API 写入，已从本次提交中排除以免整条记录写入失败。'
      );
      continue;
    }
    result[field.fieldId] = convertCellValue(meta.type, raw, field);
  }
  return result;
}
