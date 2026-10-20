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

/** 自动预填迭代的安全上限：链式联动的最大写回轮数（超出即熔断，防止不收敛） */
export const MAX_FILL_PASSES = 5;

/**
 * 找出「日期联动依赖图」中的环，以及依赖了环的字段（下游同样不可信）。
 *
 * 依赖边：`目标字段 → 来源字段`（目标值由来源值算出）。
 * - 自引用（来源 == 自己）视为环；
 * - A→B 且 B→A 视为环；
 * - 依赖了环上字段的字段会随环不断变化，一并返回。
 *
 * 环上没有数学上良定义的值（A=B+1年 且 B=A+1年 会无限发散），
 * 故这些字段一律**不参与自动预填**，降级为用户手填，避免每帧写回导致控件频闪。
 *
 * @returns 不可安全自动预填的字段 ID 集合
 */
export function findAutoFillCycles(fields: FieldConfig[]): Set<string> {
  const src = new Map<string, string>();
  for (const f of fields ?? []) {
    const s = f.dateAutoFill?.sourceFieldId;
    if (s) src.set(f.fieldId, s);
  }

  const cyclic = new Set<string>();
  for (const start of src.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur && src.has(cur)) {
      if (seen.has(cur)) {
        // 发现环：从 cur 在路径中的首次出现处，到路径末尾都是环上节点
        const idx = path.indexOf(cur);
        for (let i = idx; i < path.length; i += 1) cyclic.add(path[i]);
        break;
      }
      seen.add(cur);
      path.push(cur);
      cur = src.get(cur);
    }
  }

  // 环的下游：依赖了环上字段的字段同样不稳定，一并排除（迭代到不动点）
  let grew = true;
  while (grew) {
    grew = false;
    for (const [fid, s] of src) {
      if (cyclic.has(fid)) continue;
      if (cyclic.has(s)) {
        cyclic.add(fid);
        grew = true;
      }
    }
  }
  return cyclic;
}

/**
 * 配置侧预防：判断把 `targetFieldId` 的来源设为 `sourceFieldId` 是否会成环。
 * 若来源字段沿依赖链上溯能到达目标字段（含二者相同）→ 成环。
 */
export function wouldCreateAutoFillCycle(
  fields: FieldConfig[],
  targetFieldId: string,
  sourceFieldId: string
): boolean {
  if (!sourceFieldId) return false;
  if (targetFieldId === sourceFieldId) return true;
  const src = new Map<string, string>();
  for (const f of fields ?? []) {
    if (f.fieldId === targetFieldId) continue; // 排除自身旧配置，只看其余字段的链
    const s = f.dateAutoFill?.sourceFieldId;
    if (s) src.set(f.fieldId, s);
  }
  const seen = new Set<string>();
  let cur: string | undefined = sourceFieldId;
  while (cur && !seen.has(cur)) {
    if (cur === targetFieldId) return true;
    seen.add(cur);
    cur = src.get(cur);
  }
  return false;
}

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
  // 环上（及环下游）字段无法收敛，直接跳过，不参与自动预填
  const cyclic = findAutoFillCycles(fields);
  for (const f of fields) {
    const cfg = f.dateAutoFill;
    if (!cfg?.sourceFieldId) continue;
    if (cyclic.has(f.fieldId)) continue;
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

/**
 * ★ 有界不动点求解：在一个同步循环内把自动预填迭代到稳定，**只返回最终结果一次**。
 *
 * 背景：调用方原先在 effect 里「跑一轮 → setState → 依赖变化 → 再跑一轮」，
 * 长链联动（A→B→C→D→E）要写 4 次 state、重渲染 4 次，受控的 DatePicker 面板
 * 每渲染一次就被重置一次 → 用户看到「多次频闪、点不中日期」。
 *
 * 现在改为在这里同步迭代到收敛（或达到 MAX_FILL_PASSES 熔断上限），
 * 调用方只 setState 一次，面板最多被重置一次，频闪消失。
 *
 * @returns 稳定后的行值；与入参完全一致时返回 null（调用方跳过 setState）
 */
export function resolveAutoFill(
  fields: FieldConfig[],
  values: FormValues,
  manual: Set<string>,
  auto: Set<string>,
  keyOf: FillKeyOf
): FormValues | null {
  let cur = values;
  let changed = false;
  for (let pass = 0; pass < MAX_FILL_PASSES; pass += 1) {
    const next = applyAutoFill(fields, cur, manual, auto, keyOf);
    if (!next) break; // 已收敛
    cur = next;
    changed = true;
  }
  return changed ? cur : null;
}
