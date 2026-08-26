import { FieldType } from '@lark-base-open/js-sdk';
import { READONLY_FIELD_TYPES } from '../types';

/** 判断字段类型是否为系统只读（不可录入） */
export function isReadonlyField(type: FieldType): boolean {
  return READONLY_FIELD_TYPES.includes(type);
}

/** 判断字段类型是否可录入（用于配置阶段过滤字段列表） */
export function isInputtableField(type: FieldType): boolean {
  return !isReadonlyField(type);
}

/**
 * 从字段元信息中提取单选/多选的可选项。
 * 多维表格的 property.options 结构: { id, name, color }
 */
export function extractSelectOptions(meta: {
  type: FieldType;
  property?: { options?: { id: string; name: string; color?: string }[] };
}): { id: string; name: string; color?: string }[] {
  if (meta.type === FieldType.SingleSelect || meta.type === FieldType.MultiSelect) {
    return meta.property?.options ?? [];
  }
  return [];
}

/**
 * 字段类型 -> 人类可读中文名（配置面板展示用）
 */
export const FIELD_TYPE_LABEL: Partial<Record<FieldType, string>> = {
  [FieldType.Text]: '多行文本',
  [FieldType.Number]: '数字',
  [FieldType.SingleSelect]: '单选',
  [FieldType.MultiSelect]: '多选',
  [FieldType.DateTime]: '日期',
  [FieldType.Checkbox]: '复选框',
  [FieldType.User]: '人员',
  [FieldType.Phone]: '电话',
  [FieldType.Url]: '超链接',
  [FieldType.Attachment]: '附件',
  [FieldType.SingleLink]: '单向关联',
  [FieldType.DuplexLink]: '双向关联',
  [FieldType.Location]: '地理位置',
  [FieldType.GroupChat]: '群聊',
  [FieldType.Progress]: '进度',
  [FieldType.Currency]: '货币',
  [FieldType.Rating]: '评分',
  [FieldType.Email]: '邮箱',
};
