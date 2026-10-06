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
  linkTableId?: string;
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
      linkTableId:
        m.type === FieldType.SingleLink || m.type === FieldType.DuplexLink
          ? (m as { property?: { tableId?: string } }).property?.tableId
          : undefined,
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
  tableId: string,
  targetTableId?: string
): Promise<{ fieldId: string; fieldName: string; fieldType: FieldType }[]> {
  const table = await bitable.base.getTableById(tableId);
  const metas = await table.getFieldMetaList();
  return metas
    .filter((m) => m.type === FieldType.SingleLink || m.type === FieldType.DuplexLink)
    .filter((m) => {
      if (!targetTableId) return true;
      return (m as { property?: { tableId?: string } }).property?.tableId === targetTableId;
    })
    .map((m) => ({ fieldId: m.id, fieldName: m.name, fieldType: m.type }));
}

/**
 * 建立「fieldId → 所属 tableId」的反向映射。
 * 用途：持久化层剥离了子表/条件规则的 tableId（避免触发宿主
 * 「配置数据发生变更」校验），加载时通过字段 ID 反查它属于哪张表。
 * 飞书字段 ID 在 base 内全局唯一，故该映射可靠。
 */
export async function buildFieldTableMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const tables = await bitable.base.getTableMetaList();
    // 表单首屏只需要恢复少量 tableId；并行读取能明显降低 dashboard hydration 耗时。
    await Promise.all(
      tables.map(async (t) => {
        try {
          const table = await bitable.base.getTableById(t.id);
          const metas = await table.getFieldMetaList();
          for (const m of metas) {
            if (m?.id) map.set(m.id, t.id);
          }
        } catch {
          /* 单表读取失败跳过 */
        }
      })
    );
  } catch {
    /* base 不可达时返回空 map */
  }
  return map;
}

/** 读取关联字段指向的表 ID；若字段不存在或不是关联字段，返回 null。 */
export async function getLinkTargetTableId(
  tableId: string,
  fieldId: string
): Promise<string | null> {
  const table = await bitable.base.getTableById(tableId);
  const meta = await table.getFieldMetaById(fieldId);
  if (meta.type !== FieldType.SingleLink && meta.type !== FieldType.DuplexLink) return null;
  return (meta as { property?: { tableId?: string } }).property?.tableId ?? null;
}
