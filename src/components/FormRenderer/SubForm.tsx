import React from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { SubTableConfig, FormValues, ConditionalState } from '../../types';
import { isFieldRequired } from '../../utils/validator';
import { toast } from '../../utils/toast';
import { FieldRenderer } from './FieldRenderer';
import { Button } from '@douyinfe/semi-ui';
import { IconPlus, IconMinus } from '@douyinfe/semi-icons';

interface Props {
  sub: SubTableConfig;
  rows: FormValues[];
  onChange: (rows: FormValues[]) => void;
  cond: ConditionalState;
}

export function SubForm({ sub, rows, onChange, cond }: Props) {
  const updateRow = (idx: number, fieldId: string, v: unknown) =>
    onChange(rows.map((r, i) => (i === idx ? { ...r, [fieldId]: v } : r)));

  const addRow = () => {
    if (sub.maxRows && rows.length >= sub.maxRows) {
      toast(`最多添加 ${sub.maxRows} 条`, 'warning');
      return;
    }
    const defaults = sub.fields.reduce<FormValues>((values, field) => {
      if (field.defaultValue !== undefined) {
        values[field.fieldId] = Array.isArray(field.defaultValue)
          ? [...field.defaultValue]
          : field.defaultValue;
      }
      return values;
    }, {});
    onChange([...rows, defaults]);
  };

  const removeRow = (idx: number) => onChange(rows.filter((_, i) => i !== idx));

  // 关联字段（含指向主表的关联字段）由提交逻辑自动维护，录入表单不显示
  const visible = (f: SubTableConfig['fields'][number]) =>
    f.visible &&
    f.fieldType !== FieldType.SingleLink &&
    f.fieldType !== FieldType.DuplexLink &&
    !cond.hiddenFields[sub.tableId]?.has(f.fieldId);

  return (
    <div>
      {rows.map((row, idx) => (
        <div key={idx} className="sub-row">
          <div className="sub-row-head">
            <span className="row-num">第 {idx + 1} 条</span>
            {sub.allowMultiple && rows.length > 1 && (
              <Button
                theme="borderless"
                type="danger"
                size="small"
                icon={<IconMinus />}
                className="row-del"
                onClick={() => removeRow(idx)}
              >
                删除此行
              </Button>
            )}
          </div>
          {sub.fields.filter(visible).map((f) => (
            <div key={f.fieldId} className="field-row">
              <label className="field-label">
                {isFieldRequired(f, sub.tableId, cond) && (
                  <span className="required-star">*</span>
                )}
                {f.label || f.fieldName}
              </label>
              <FieldRenderer
                field={f}
                value={row[f.fieldId]}
                onChange={(v) => updateRow(idx, f.fieldId, v)}
                disabled={f.readonly}
              />
            </div>
          ))}
        </div>
      ))}
      {sub.allowMultiple && (
        <Button className="add-row-btn" icon={<IconPlus />} onClick={addRow}>
          添加一行
        </Button>
      )}
    </div>
  );
}
