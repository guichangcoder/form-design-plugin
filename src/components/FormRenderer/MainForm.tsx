import React from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { FormPluginConfig, FormValues, ConditionalState, FieldError, UniqueFieldState } from '../../types';
import { isFieldRequired, isHiddenField } from '../../utils/validator';
import { getOptionRefDependencies } from '../../utils/optionRef';
import { FormScope } from '../../utils/formFieldRef';
import { FieldRenderer } from './FieldRenderer';

interface Props {
  config: FormPluginConfig;
  values: FormValues;
  onChange: (v: FormValues) => void;
  cond: ConditionalState;
  /** 提交校验后的字段级错误（字段下方红字提示） */
  errors?: FieldError[];
  /** 唯一性校验状态，key = fieldId */
  uniqueState?: Record<string, UniqueFieldState>;
  /** 字段失焦回调（触发唯一性校验） */
  onFieldBlur?: (fieldId: string) => void;
  /** 配置态实时预览：数据驱动控件不加载数据 */
  preview?: boolean;
  /** ★ 全表单值作用域（仅当有字段配置了 formRef 时才下传） */
  formScope?: FormScope | null;
}

/**
 * 主表字段渲染。
 * ★ 用 React.memo 包裹：日期联动预填写回 mainValues 时，只要 values / cond 等引用未变，
 *   就跳过整块重渲染，避免「一次写回 → 全树重渲染 → 受控日期面板被重置」的放大效应。
 *   各 prop 均为引用稳定（values/cond/errors/uniqueState 由父级 state 直接传入）。
 */
export const MainForm = React.memo(function MainForm({
  config,
  values,
  onChange,
  cond,
  errors,
  uniqueState,
  onFieldBlur,
  preview,
  formScope,
}: Props) {
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
                formScope={formScope}
                onBlur={onFieldBlur ? () => onFieldBlur(f.fieldId) : undefined}
                uniqueStatus={
                  f.unique?.enabled ? (uniqueState?.[f.fieldId]?.status ?? 'idle') : undefined
                }
                uniqueHint={uniqueState?.[f.fieldId]?.detail}
                preview={preview}
              />
              {err && <div className="field-err">{err.message}</div>}
            </div>
          );
        })}
    </div>
  );
});
