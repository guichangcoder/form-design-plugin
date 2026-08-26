import React from 'react';
import { FormPluginConfig, FormValues, ConditionalState } from '../../types';
import { isFieldRequired } from '../../utils/validator';
import { FieldRenderer } from './FieldRenderer';

interface Props {
  config: FormPluginConfig;
  values: FormValues;
  onChange: (v: FormValues) => void;
  cond: ConditionalState;
}

function isHiddenField(tableId: string, fieldId: string, cond: ConditionalState): boolean {
  return !!cond.hiddenFields[tableId]?.has(fieldId);
}

export function MainForm({ config, values, onChange, cond }: Props) {
  const setField = (fieldId: string, v: unknown) => onChange({ ...values, [fieldId]: v });
  const tableId = config.mainTable.tableId;

  return (
    <div>
      {config.mainTable.fields
        .filter((f) => f.visible && !isHiddenField(tableId, f.fieldId, cond))
        .map((f) => (
          <div key={f.fieldId} className="field-row">
            <label className="field-label">
              {isFieldRequired(f, tableId, cond) && (
                <span className="required-star">*</span>
              )}
              {f.label || f.fieldName}
            </label>
            <FieldRenderer
              field={f}
              value={values[f.fieldId]}
              onChange={(v) => setField(f.fieldId, v)}
            />
          </div>
        ))}
    </div>
  );
}
