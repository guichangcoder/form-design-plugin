import { useMemo } from 'react';
import { FormPluginConfig, FormValues, ConditionalState } from '../types';

/** 将值转为可比较的字符串形式（解决类型不一致问题：输入框出来的永远是 string，但表单值可能是 number/boolean） */
function toComparable(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(',');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 判断值是否为"空"：undefined / null / 空字符串 / 空数组 */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 判断条件是否命中 */
export function evaluateCondition(
  operator: 'equals' | 'notEquals' | 'contains' | 'isEmpty' | 'isNotEmpty',
  actual: unknown,
  expected: unknown
): boolean {
  switch (operator) {
    case 'equals':
      // 用 toComparable 做宽松比较：数字 10 等于字符串 "10"，布尔 true 等于 "true"
      return toComparable(actual) === toComparable(expected);
    case 'notEquals':
      return toComparable(actual) !== toComparable(expected);
    case 'contains':
      // 数组：检查是否包含元素（多选字段）
      if (Array.isArray(actual)) {
        return actual.some((item) => toComparable(item) === toComparable(expected));
      }
      // 字符串：检查子串包含（文本字段）
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      // 其他类型：退化为相等判断
      return toComparable(actual) === toComparable(expected);
    case 'isEmpty':
      return isEmptyValue(actual);
    case 'isNotEmpty':
      return !isEmptyValue(actual);
    default:
      return false;
  }
}

/** 确保 map[tableId] 存在 Set 并返回 */
function ensureSet(map: Record<string, Set<string>>, tableId: string): Set<string> {
  if (!map[tableId]) map[tableId] = new Set();
  return map[tableId];
}

/** 确保 map[tableId][rowIndex] 存在 Set 并返回 */
function ensureRowSet(
  map: Record<string, Array<Set<string>>>,
  tableId: string,
  rowIndex: number
): Set<string> {
  if (!map[tableId]) map[tableId] = [];
  if (!map[tableId][rowIndex]) map[tableId][rowIndex] = new Set();
  return map[tableId][rowIndex];
}

/** 按动作类型把 fieldId 写入对应集合 */
function applyAction(
  actionType: 'show' | 'hide' | 'require' | 'unrequire',
  matched: boolean,
  fid: string,
  sets: { hidden: Set<string>; required: Set<string>; unrequired: Set<string> }
): void {
  switch (actionType) {
    case 'hide':
      if (matched) sets.hidden.add(fid);
      break;
    case 'show':
      if (!matched) sets.hidden.add(fid);
      break;
    case 'require':
      if (matched) sets.required.add(fid);
      break;
    case 'unrequire':
      if (matched) sets.unrequired.add(fid);
      break;
  }
}

/**
 * 计算条件显示状态（飞书官方诊断 P2-9 修复：子表规则按行索引计算）。
 *
 * 语义约定：
 * - 触发字段在【主表】：规则全局生效。作用于主表字段 → 主表整体；
 *   作用于子表字段 → 该子表【所有行】（写入全表级集合）。
 * - 触发字段在【子表】：逐行评估，只作用于【同一张子表的同一行】
 *   （写入行级集合）。跨表动作会被忽略 —— RuleEditor 在配置侧已限制
 *   子表触发规则只能选择同一张子表作为目标表，防止用户误以为
 *   「第 2 行的值」能控制主表字段。
 */
export function computeConditionalState(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>
): ConditionalState {
  const hiddenFields: Record<string, Set<string>> = {};
  const forcedRequired: Record<string, Set<string>> = {};
  const forcedUnrequired: Record<string, Set<string>> = {};
  const rowHiddenFields: Record<string, Array<Set<string>>> = {};
  const rowForcedRequired: Record<string, Array<Set<string>>> = {};
  const rowForcedUnrequired: Record<string, Array<Set<string>>> = {};

  const mainTableId = config.mainTable.tableId;
  const isSubTable = (tableId: string) =>
    !!tableId && tableId !== mainTableId && config.subTables.some((s) => s.tableId === tableId);

  for (const rule of config.conditionalRules) {
    const triggerTableId = rule.trigger.tableId;

    if (!isSubTable(triggerTableId)) {
      // —— 主表触发：全局生效 ——
      const actual = mainValues[rule.trigger.fieldId];
      const matched = evaluateCondition(rule.trigger.operator, actual, rule.trigger.value);
      for (const action of rule.actions) {
        const sets = {
          hidden: ensureSet(hiddenFields, action.tableId),
          required: ensureSet(forcedRequired, action.tableId),
          unrequired: ensureSet(forcedUnrequired, action.tableId),
        };
        for (const fid of action.fieldIds) {
          applyAction(action.type, matched, fid, sets);
        }
      }
      continue;
    }

    // —— 子表触发：逐行评估，仅作用于同一张子表的同一行（P2-9）——
    const rows = subValues[triggerTableId] ?? [];
    for (const action of rule.actions) {
      // 跨表动作忽略（配置侧已限制，这里兜底防御旧配置）
      if (action.tableId !== triggerTableId) continue;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const actual = rows[rowIndex]?.[rule.trigger.fieldId];
        const matched = evaluateCondition(rule.trigger.operator, actual, rule.trigger.value);
        const sets = {
          hidden: ensureRowSet(rowHiddenFields, action.tableId, rowIndex),
          required: ensureRowSet(rowForcedRequired, action.tableId, rowIndex),
          unrequired: ensureRowSet(rowForcedUnrequired, action.tableId, rowIndex),
        };
        for (const fid of action.fieldIds) {
          applyAction(action.type, matched, fid, sets);
        }
      }
    }
  }

  return {
    hiddenFields,
    forcedRequired,
    forcedUnrequired,
    rowHiddenFields,
    rowForcedRequired,
    rowForcedUnrequired,
  };
}

/** 条件显示 hook：随表单值与配置变化实时计算 */
export function useConditional(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>
): ConditionalState {
  return useMemo(
    () => computeConditionalState(config, mainValues, subValues),
    [config, mainValues, subValues]
  );
}
