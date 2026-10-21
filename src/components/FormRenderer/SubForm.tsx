import React from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { SubTableConfig, FormValues, ConditionalState, FieldError, UniqueFieldState } from '../../types';
import { isFieldRequired, isHiddenField } from '../../utils/validator';
import { getOptionRefDependencies } from '../../utils/optionRef';
import { FormScope } from '../../utils/formFieldRef';
import {
  appendRow,
  applyRowFieldChange,
  canAppendRow,
  removeRowAt,
  resolveSubLayout,
} from '../../utils/subTableLayout';
import { toast } from '../../utils/toast';
import { FieldRenderer } from './FieldRenderer';
import { SubFormTable } from './SubFormTable';
import { Button } from '@douyinfe/semi-ui';
import { IconPlus, IconMinus } from '@douyinfe/semi-icons';

interface Props {
  sub: SubTableConfig;
  rows: FormValues[];
  onChange: (rows: FormValues[]) => void;
  cond: ConditionalState;
  /** 提交校验后的字段级错误（按行 + 字段下方红字提示） */
  errors?: FieldError[];
  /** 唯一性校验状态，key = `<rowIndex>:<fieldId>` */
  uniqueState?: Record<string, UniqueFieldState>;
  /** 字段失焦回调（触发唯一性校验），需带行索引 */
  onFieldBlur?: (fieldId: string, rowIndex: number) => void;
  /** 配置态实时预览：数据驱动控件不加载数据 */
  preview?: boolean;
  /** ★ 全表单值作用域（仅当有字段配置了 formRef 时才下传） */
  formScope?: FormScope | null;
}

/**
 * 子表渲染入口：按 sub.layout 分流到两种展现形式。
 * - 'vertical'（缺省）→ 纵向卡片式，每条记录一张卡片
 * - 'table'          → 横向表格式，每条记录一行，超宽可左右滑动
 * 两者的行变更 / 级联清空 / 默认值填充都走 utils/subTableLayout.ts 的同一组纯函数。
 * ★ React.memo 包裹：理由同 MainForm —— 阻断日期联动写回引发的全树重渲染。
 */
export const SubForm = React.memo(function SubForm(props: Props) {
  if (resolveSubLayout(props.sub) === 'table') {
    return <SubFormTable {...props} />;
  }
  return <SubFormVertical {...props} />;
});

function SubFormVertical({ sub, rows, onChange, cond, errors, uniqueState, onFieldBlur, preview, formScope }: Props) {
  const updateRow = (idx: number, fieldId: string, v: unknown) =>
    onChange(rows.map((r, i) => (i === idx ? applyRowFieldChange(sub.fields, r, fieldId, v) : r)));

  const addRow = () => {
    if (!canAppendRow(sub.maxRows, rows.length)) {
      toast(`最多添加 ${sub.maxRows} 条`, 'warning');
      return;
    }
    onChange(appendRow(rows, sub.fields));
  };

  const removeRow = (idx: number) => onChange(removeRowAt(rows, idx));

  // 仅排除「指向主表的关联字段」本身（提交逻辑自动注入主表 recordId，hydrate 时也会从
  // sub.fields 剔除）；其他关联字段照常渲染为记录选择器，供用户从目标表挑选记录。
  // 条件隐藏按「全表级 + 当前行级」判断（P2-9：子表规则逐行生效）。
  const visibleInRow = (f: SubTableConfig['fields'][number], rowIndex: number) =>
    f.visible &&
    f.fieldId !== sub.linkFieldId &&
    !isHiddenField(cond, sub.tableId, f.fieldId, rowIndex);

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
          {sub.fields.filter((f) => visibleInRow(f, idx)).map((f) => {
            const err = errors?.find(
              (e) => e.tableId === sub.tableId && e.fieldId === f.fieldId && e.rowIndex === idx
            );
            return (
              <div key={f.fieldId} className={`field-row ${err ? 'field-row--error' : ''}`}>
                <label className="field-label">
                  {isFieldRequired(f, sub.tableId, cond, idx) && (
                    <span className="required-star">*</span>
                  )}
                  {f.label || f.fieldName}
                </label>
                <FieldRenderer
                  field={f}
                  tableId={sub.tableId}
                  value={row[f.fieldId]}
                  onChange={(v) => updateRow(idx, f.fieldId, v)}
                  disabled={f.readonly}
                  formValues={row}
                  formScope={formScope}
                  onBlur={onFieldBlur ? () => onFieldBlur(f.fieldId, idx) : undefined}
                  uniqueStatus={
                    f.unique?.enabled
                      ? (uniqueState?.[`${idx}:${f.fieldId}`]?.status ?? 'idle')
                      : undefined
                  }
                  uniqueHint={uniqueState?.[`${idx}:${f.fieldId}`]?.detail}
                  preview={preview}
                />
                {err && <div className="field-err">{err.message}</div>}
              </div>
            );
          })}
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
