import React from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { FormPluginConfig, FormValues, ConditionalState, FieldError } from '../../types';
import { isFieldRequired, isHiddenField } from '../../utils/validator';
import { FieldRenderer } from './FieldRenderer';

interface Props {
  config: FormPluginConfig;
  values: FormValues;
  onChange: (v: FormValues) => void;
  cond: ConditionalState;
  /** 提交校验后的字段级错误（字段下方红字提示） */
  errors?: FieldError[];
}

/** 关联字段由提交逻辑自动维护（提交时自动关联主表），录入表单不显示 */
function isAutoLink(fieldType?: FieldType): boolean {
  return fieldType === FieldType.SingleLink || fieldType === FieldType.DuplexLink;
}

export function MainForm({ config, values, onChange, cond, errors }: Props) {
  const setField = (fieldId: string, v: unknown) => onChange({ ...values, [fieldId]: v });
  const tableId = config.mainTable.tableId;
  const errOf = (fieldId: string) =>
    errors?.find((e) => e.tableId === tableId && e.fieldId === fieldId && e.rowIndex === undefined);

  return (
    <div>
      {config.mainTable.fields
        .filter((f) => f.visible && !isAutoLink(f.fieldType) && !isHiddenField(cond, tableId, f.fieldId))
        .map((f) => {
          const err = errOf(f.fieldId);
          return (
            <div key={f.fieldId} className={`field-row ${err ? 'field-row--error' : ''}`}>
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
              {err && <div className="field-err">{err.message}</div>}
            </div>
          );
        })}
    </div>
  );
}
