/**
 * 日期联动预填的核心逻辑（纯函数，不依赖 React / SDK，回归测试可直接在 Node 中跑）。
 *
 * 语义：
 * - 目标字段配置了 dateAutoFill 后，来源字段有值时自动算出目标值写入；
 * - 用户手动改过目标字段（manual 集合）→ 之后不再自动覆盖；
 * - 目标字段当前值是上次自动填的（auto 集合）→ 来源变化时重新计算覆盖；
 * - 用户把目标字段清空 → 撤销 manual 标记（允许重新自动预填）。
 */
import { DateAutoFillConfig, FieldConfig, FormValues } from '../types';
import { applyDateOffset, isSameInstant, toDateOrNull } from './dateCalc';
import { isEmptyValue } from './validator';

/** manual / auto 集合的 key：主表 `main:<fieldId>`；子表 `sub:<tableId>:<rowIndex>:<fieldId>` */
export type FillKeyOf = (fieldId: string) => string;

/**
 * 按配置计算并写入自动预填值。
 * @returns 更新后的行值；无需变化时返回 null（调用方据此跳过 setState，避免死循环）
 */
export function applyAutoFill(
  fields: FieldConfig[],
  values: FormValues,
  manual: Set<string>,
  auto: Set<string>,
  keyOf: FillKeyOf
): FormValues | null {
  let next: FormValues | null = null;
  for (const f of fields) {
    const cfg = f.dateAutoFill;
    if (!cfg?.sourceFieldId) continue;
    const key = keyOf(f.fieldId);
    if (manual.has(key)) continue;

    const expected = applyDateOffset(toDateOrNull(values[cfg.sourceFieldId]), cfg);
    const cur = values[f.fieldId];
    if (!expected) {
      // 来源为空：清掉「本次自动填的」值
      if (!isEmptyValue(cur) && auto.has(key)) {
        next = next ?? { ...values };
        next[f.fieldId] = undefined;
        auto.delete(key);
      }
      continue;
    }
    if (!isSameInstant(cur, expected)) {
      next = next ?? { ...values };
      next[f.fieldId] = expected;
      auto.add(key);
    }
  }
  return next;
}

/**
 * 识别用户对日期联动目标字段的手动修改，写入 manual 集合。
 * - 改成非空且与原值不同 → manual（之后不再自动覆盖）
 * - 改成空 → 清除 manual / auto（下次来源有值时重新预填）
 */
export function markManualEdits(
  fields: FieldConfig[],
  before: FormValues,
  after: FormValues,
  manual: Set<string>,
  auto: Set<string>,
  keyOf: FillKeyOf
): void {
  for (const f of fields) {
    if (!f.dateAutoFill?.sourceFieldId) continue;
    const key = keyOf(f.fieldId);
    const b = before[f.fieldId];
    const a = after[f.fieldId];
    if (isEmptyValue(a)) {
      manual.delete(key);
      auto.delete(key);
      continue;
    }
    if (!isSameInstant(b, a)) {
      manual.add(key);
      auto.delete(key);
    }
  }
}

/** 找出区块内所有日期联动配置（配置面板/诊断用） */
export function listAutoFillFields(fields: FieldConfig[]): FieldConfig[] {
  return (fields ?? []).filter((f) => !!f.dateAutoFill?.sourceFieldId);
}

/** 校验一条联动配置是否可用（来源字段存在且是日期字段） */
export function isAutoFillUsable(cfg: DateAutoFillConfig | undefined, fields: FieldConfig[]): boolean {
  if (!cfg?.sourceFieldId) return false;
  const src = (fields ?? []).find((f) => f.fieldId === cfg.sourceFieldId);
  return !!src;
}
