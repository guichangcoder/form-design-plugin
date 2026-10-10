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

/**
 * 计算条件显示状态。
 * 说明：触发字段若位于子表，取其"第一行"的值做判断（子表多行联动为后续增强）。
 */
export function computeConditionalState(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>
): ConditionalState {
  const hiddenFields: Record<string, Set<string>> = {};
  const forcedRequired: Record<string, Set<string>> = {};
  const forcedUnrequired: Record<string, Set<string>> = {};

  const getValue = (tableId: string, fieldId: string): unknown => {
    if (tableId === config.mainTable.tableId) return mainValues[fieldId];
    const rows = subValues[tableId];
    return rows && rows.length ? rows[0][fieldId] : undefined;
  };

  for (const rule of config.conditionalRules) {
    const actual = getValue(rule.trigger.tableId, rule.trigger.fieldId);
    const matched = evaluateCondition(rule.trigger.operator, actual, rule.trigger.value);

    for (const action of rule.actions) {
      if (!hiddenFields[action.tableId]) hiddenFields[action.tableId] = new Set();
      if (!forcedRequired[action.tableId]) forcedRequired[action.tableId] = new Set();
      if (!forcedUnrequired[action.tableId]) forcedUnrequired[action.tableId] = new Set();

      for (const fid of action.fieldIds) {
        switch (action.type) {
          case 'hide':
            if (matched) hiddenFields[action.tableId].add(fid);
            break;
          case 'show':
            if (!matched) hiddenFields[action.tableId].add(fid);
            break;
          case 'require':
            if (matched) forcedRequired[action.tableId].add(fid);
            break;
          case 'unrequire':
            if (matched) forcedUnrequired[action.tableId].add(fid);
            break;
        }
      }
    }
  }

  return { hiddenFields, forcedRequired, forcedUnrequired };
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
