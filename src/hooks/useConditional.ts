import { useMemo } from 'react';
import { FormPluginConfig, FormValues, ConditionalState } from '../types';

/** 判断条件是否命中 */
export function evaluateCondition(
  operator: 'equals' | 'notEquals' | 'contains' | 'isEmpty' | 'isNotEmpty',
  actual: unknown,
  expected: unknown
): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'contains':
      return Array.isArray(actual) && actual.includes(expected);
    case 'isEmpty':
      return actual === undefined || actual === null || actual === '';
    case 'isNotEmpty':
      return !(actual === undefined || actual === null || actual === '');
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
