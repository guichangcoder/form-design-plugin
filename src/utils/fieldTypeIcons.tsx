/**
 * 字段类型 → 图标（飞书官方诊断 P2-10：字段选择菜单用 icon 标记字段类型）。
 * 仅做展示映射，未覆盖的类型回退到通用图标。
 */
import React from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import {
  IconFont,
  IconHash,
  IconList,
  IconOrderedList,
  IconCalendar,
  IconCheckboxTick,
  IconMember,
  IconPhone,
  IconLink,
  IconImage,
  IconMapPin,
  IconMail,
  IconCoinMoney,
  IconPercentage,
  IconFavoriteList,
  IconGlobe,
  IconEdit,
} from '@douyinfe/semi-icons';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICON_MAP: Partial<Record<FieldType, React.ComponentType<any>>> = {
  [FieldType.Text]: IconFont,
  [FieldType.Number]: IconHash,
  [FieldType.SingleSelect]: IconList,
  [FieldType.MultiSelect]: IconOrderedList,
  [FieldType.DateTime]: IconCalendar,
  [FieldType.Checkbox]: IconCheckboxTick,
  [FieldType.User]: IconMember,
  [FieldType.Phone]: IconPhone,
  [FieldType.Url]: IconGlobe,
  [FieldType.Email]: IconMail,
  [FieldType.Attachment]: IconImage,
  [FieldType.SingleLink]: IconLink,
  [FieldType.DuplexLink]: IconLink,
  [FieldType.Location]: IconMapPin,
  [FieldType.GroupChat]: IconMember,
  [FieldType.Progress]: IconPercentage,
  [FieldType.Currency]: IconCoinMoney,
  [FieldType.Rating]: IconFavoriteList,
};

/** 渲染字段类型图标（带统一尺寸与颜色） */
export function FieldTypeIcon({ type, size = 14 }: { type: FieldType; size?: number }) {
  const Cmp = ICON_MAP[type] ?? IconEdit;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        color: 'var(--semi-color-text-2, #4e5969)',
        flexShrink: 0,
        fontSize: size,
      }}
      aria-hidden
    >
      <Cmp />
    </span>
  );
}
