import React from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
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

/** 关联字段由提交逻辑自动维护（提交时自动关联主表），录入表单不显示 */
function isAutoLink(fieldType?: FieldType): boolean {
  return fieldType === FieldType.SingleLink || fieldType === FieldType.DuplexLink;
}

export function MainForm({ config, values, onChange, cond }: Props) {
  const setField = (fieldId: string, v: unknown) => onChange({ ...values, [fieldId]: v });
  const tableId = config.mainTable.tableId;

  return (
    <div>
      {config.mainTable.fields
        .filter((f) => f.visible && !isAutoLink(f.fieldType) && !isHiddenField(tableId, f.fieldId, cond))
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
              disabled={f.readonly}
            />
          </div>
        ))}
    </div>
  );
}
