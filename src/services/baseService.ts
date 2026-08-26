import { bitable, FieldType } from '@lark-base-open/js-sdk';
import { isInputtableField, extractSelectOptions } from '../utils/fieldMapper';
import { FieldConfig } from '../types';

export interface TableMetaLite {
  id: string;
  name: string;
}

export interface FieldMetaLite {
  id: string;
  name: string;
  type: FieldType;
  options: { id: string; name: string; color?: string }[];
}

/** 获取当前多维表格所有数据表元信息 */
export async function getTableMetaList(): Promise<TableMetaLite[]> {
  const list = await bitable.base.getTableMetaList();
  return list.map((t) => ({ id: t.id, name: t.name }));
}

/** 获取某表的字段元信息（仅可录入字段），并附带单选/多选项 */
export async function getFieldMetaList(tableId: string): Promise<FieldMetaLite[]> {
  const table = await bitable.base.getTableById(tableId);
  const metas = await table.getFieldMetaList();
  return metas
    .filter((m) => isInputtableField(m.type))
    .map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      options: extractSelectOptions(m as any),
    }));
}

/** 把字段元信息转换为表单配置项 FieldConfig（默认显示、非必填） */
export function metaToFieldConfig(meta: FieldMetaLite): FieldConfig {
  return {
    fieldId: meta.id,
    fieldName: meta.name,
    fieldType: meta.type,
    visible: true,
    required: false,
    label: meta.name,
    options: meta.options,
  };
}

/** 查找某表中所有关联类型字段（用于配置主子表关联字段） */
export async function getLinkFields(
  tableId: string
): Promise<{ fieldId: string; fieldName: string; fieldType: FieldType }[]> {
  const table = await bitable.base.getTableById(tableId);
  const metas = await table.getFieldMetaList();
  return metas
    .filter((m) => m.type === FieldType.SingleLink || m.type === FieldType.DuplexLink)
    .map((m) => ({ fieldId: m.id, fieldName: m.name, fieldType: m.type }));
}
