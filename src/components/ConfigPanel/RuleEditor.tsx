import React from 'react';
import { ConditionalRule, FormPluginConfig } from '../../types';
import { Select, Input, Button, Typography } from '@douyinfe/semi-ui';
import { IconPlus, IconMinus } from '@douyinfe/semi-icons';

interface Props {
  config: FormPluginConfig;
  rules: ConditionalRule[];
  onChange: (rules: ConditionalRule[]) => void;
}

const OPERATORS = [
  { value: 'equals', label: '等于' },
  { value: 'notEquals', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'isEmpty', label: '为空' },
  { value: 'isNotEmpty', label: '不为空' },
];

const ACTION_TYPES = [
  { value: 'show', label: '显示' },
  { value: 'hide', label: '隐藏' },
  { value: 'require', label: '设为必填' },
  { value: 'unrequire', label: '取消必填' },
];

function getTableOptions(config: FormPluginConfig) {
  const map = new Map<string, string>();
  if (config.mainTable.tableId) map.set(config.mainTable.tableId, config.mainTable.tableName);
  config.subTables.forEach((s) => {
    if (s.tableId) map.set(s.tableId, s.tableName);
  });
  return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
}

function getFieldOptions(config: FormPluginConfig, tableId: string) {
  const list: { value: string; label: string }[] = [];
  if (config.mainTable.tableId === tableId) {
    config.mainTable.fields
      .filter((f) => f.visible)
      .forEach((f) => list.push({ value: f.fieldId, label: f.fieldName }));
  }
  config.subTables.forEach((s) => {
    if (s.tableId === tableId) {
      s.fields
        .filter((f) => f.visible)
        .forEach((f) => list.push({ value: f.fieldId, label: f.fieldName }));
    }
  });
  return list;
}

function newRule(): ConditionalRule {
  return {
    ruleId: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    trigger: { tableId: '', fieldId: '', operator: 'equals', value: '' },
    actions: [{ type: 'hide', tableId: '', fieldIds: [] }],
  };
}

export function RuleEditor({ config, rules, onChange }: Props) {
  const updateRule = (idx: number, patch: Partial<ConditionalRule>) => {
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  return (
    <div>
      {rules.length === 0 && (
        <div className="empty-tip">
          暂无规则。例如：当「是否有费用」等于「是」时，显示「费用明细」字段、并设为必填。
        </div>
      )}

      {rules.map((rule, idx) => {
        const action = rule.actions[0] ?? { type: 'hide', tableId: '', fieldIds: [] };
        const needValue = rule.trigger.operator !== 'isEmpty' && rule.trigger.operator !== 'isNotEmpty';
        return (
          <div key={rule.ruleId} className="rule-box">
            <div className="rule-row">
              <span className="rule-keyword">当</span>
              <Select
                style={{ width: 150 }}
                placeholder="表"
                value={rule.trigger.tableId || undefined}
                onChange={(v: any) =>
                  updateRule(idx, { trigger: { ...rule.trigger, tableId: v, fieldId: '' } })
                }
                optionList={getTableOptions(config)}
              />
              <Select
                style={{ width: 150 }}
                placeholder="字段"
                disabled={!rule.trigger.tableId}
                value={rule.trigger.fieldId || undefined}
                onChange={(v: any) => updateRule(idx, { trigger: { ...rule.trigger, fieldId: v } })}
                optionList={getFieldOptions(config, rule.trigger.tableId)}
              />
              <Select
                style={{ width: 120 }}
                value={rule.trigger.operator}
                onChange={(v: any) =>
                  updateRule(idx, { trigger: { ...rule.trigger, operator: v } })
                }
                optionList={OPERATORS}
              />
              {needValue && (
                <Input
                  style={{ width: 140 }}
                  placeholder="值"
                  value={String(rule.trigger.value ?? '')}
                  onChange={(v: any) => updateRule(idx, { trigger: { ...rule.trigger, value: v } })}
                />
              )}
            </div>

            <div className="rule-row">
              <span className="rule-keyword">则</span>
              <Select
                style={{ width: 120 }}
                value={action.type}
                onChange={(v: any) =>
                  updateRule(idx, { actions: [{ ...action, type: v }] })
                }
                optionList={ACTION_TYPES}
              />
              <Select
                style={{ width: 150 }}
                placeholder="目标表"
                value={action.tableId || undefined}
                onChange={(v: any) => updateRule(idx, { actions: [{ ...action, tableId: v, fieldIds: [] }] })}
                optionList={getTableOptions(config)}
              />
              <Select
                style={{ minWidth: 180 }}
                multiple
                placeholder="目标字段（可多选）"
                disabled={!action.tableId}
                value={action.fieldIds}
                onChange={(v: any) => updateRule(idx, { actions: [{ ...action, fieldIds: v }] })}
                optionList={getFieldOptions(config, action.tableId)}
              />
              <Button
                type="danger"
                theme="borderless"
                icon={<IconMinus />}
                onClick={() => onChange(rules.filter((_, i) => i !== idx))}
              >
                删除
              </Button>
            </div>
          </div>
        );
      })}

      <Button theme="borderless" icon={<IconPlus />} onClick={() => onChange([...rules, newRule()])}>
        添加规则
      </Button>
    </div>
  );
}
