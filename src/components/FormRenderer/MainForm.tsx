import React from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { FormPluginConfig, FormValues, ConditionalState, FieldError } from '../../types';
import { isFieldRequired, isHiddenField } from '../../utils/validator';
import { getOptionRefDependencies } from '../../utils/optionRef';
import { FieldRenderer } from './FieldRenderer';

interface Props {
  config: FormPluginConfig;
  values: FormValues;
  onChange: (v: FormValues) => void;
  cond: ConditionalState;
  /** 提交校验后的字段级错误（字段下方红字提示） */
  errors?: FieldError[];
}

export function MainForm({ config, values, onChange, cond, errors }: Props) {
  const setField = (fieldId: string, v: unknown) => {
    const next: FormValues = { ...values, [fieldId]: v };
    // 级联清空：凡是引用选项依赖了被改字段的字段（如下级「市」依赖「省」），
    // 父值一变，已选的下级值即失效，直接清空，避免提交脏数据。
    for (const f of config.mainTable.fields) {
      if (f.fieldId === fieldId) continue;
      if (!getOptionRefDependencies(f).includes(fieldId)) continue;
      if (next[f.fieldId] === undefined) continue;
      next[f.fieldId] = f.fieldType === FieldType.MultiSelect ? [] : undefined;
    }
    onChange(next);
  };
  const tableId = config.mainTable.tableId;
  const errOf = (fieldId: string) =>
    errors?.find((e) => e.tableId === tableId && e.fieldId === fieldId && e.rowIndex === undefined);

  return (
    <div>
      {config.mainTable.fields
        .filter((f) => f.visible && !isHiddenField(cond, tableId, f.fieldId))
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
                tableId={tableId}
                value={values[f.fieldId]}
                onChange={(v) => setField(f.fieldId, v)}
                disabled={f.readonly}
                formValues={values}
              />
              {err && <div className="field-err">{err.message}</div>}
            </div>
          );
        })}
    </div>
  );
}
