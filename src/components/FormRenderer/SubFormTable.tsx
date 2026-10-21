import React from 'react';
import {
  ConditionalState,
  FieldError,
  FormValues,
  SubTableConfig,
  UniqueFieldState,
} from '../../types';
import { isFieldRequired } from '../../utils/validator';
import {
  SUB_ROW_ACTION_WIDTH,
  SUB_ROW_INDEX_WIDTH,
  appendRow,
  buildSubColumns,
  canAppendRow,
  removeRowAt,
  updateRowAt,
} from '../../utils/subTableLayout';
import { toast } from '../../utils/toast';
import { FieldRenderer } from './FieldRenderer';
import { Button } from '@douyinfe/semi-ui';
import { IconPlus, IconMinus } from '@douyinfe/semi-icons';

interface Props {
  sub: SubTableConfig;
  rows: FormValues[];
  onChange: (rows: FormValues[]) => void;
  cond: ConditionalState;
  /** 提交校验后的字段级错误（表格模式渲染为该单元格内下方小字） */
  errors?: FieldError[];
  /** 唯一性校验状态，key = `<rowIndex>:<fieldId>` */
  uniqueState?: Record<string, UniqueFieldState>;
  /** 字段失焦回调（触发唯一性校验），需带行索引 */
  onFieldBlur?: (fieldId: string, rowIndex: number) => void;
  /** 配置态实时预览：数据驱动控件不加载数据 */
  preview?: boolean;
}

/**
 * 子表横向表格形态：每条记录一行、字段作列头。
 *
 * 关键实现点：
 * 1. **左右滑动**：外层 `.sub-table-scroll` 设 `overflow-x: auto`，内层 table 用
 *    `min-width = Σ列宽 + 固定区` 撑开 —— 容器够宽时按比例填满，不够宽时出现横向滚动条，
 *    绝不压缩控件本身（控件被压到几十像素就没法用了）。
 * 2. **表头吸顶 + 序号/操作列固定**：三者都用 `position: sticky`，但必须给**不透明背景**，
 *    否则滑动时下层单元格会透出来。序号列 `left: 0`，操作列 `right: 0`。
 * 3. **单元格内复用 FieldRenderer**：不写第二套控件，保证引用选项级联、日期联动预填、
 *    人员/关联选择器、附件、唯一性校验的行为与纵向卡片完全一致。
 * 4. **行级隐藏 → 单元格留空**：表格只有一套列头，无法按行改列结构，故列保留、格子留空，
 *    提交时该值照旧被 recordService 过滤（P1-3 行为不变）。
 * 5. ★ React.memo 包裹：理由同 SubForm —— 阻断日期联动写回引发的全树重渲染。
 */
export const SubFormTable = React.memo(function SubFormTable({
  sub,
  rows,
  onChange,
  cond,
  errors,
  uniqueState,
  onFieldBlur,
  preview,
}: Props) {
  const showActionColumn = sub.allowMultiple && rows.length > 1;
  const { columns, minWidth, empty } = buildSubColumns(sub, cond, rows.length, showActionColumn);

  const changeCell = (rowIndex: number, fieldId: string, v: unknown) =>
    onChange(updateRowAt(sub.fields, rows, rowIndex, fieldId, v));

  const removeRow = (idx: number) => onChange(removeRowAt(rows, idx));

  const addRow = () => {
    if (!canAppendRow(sub.maxRows, rows.length)) {
      toast(`最多添加 ${sub.maxRows} 条`, 'warning');
      return;
    }
    onChange(appendRow(rows, sub.fields));
  };

  // 字段元信息查找（列只存了展示信息，渲染还需要完整 FieldConfig）
  const fieldOf = (fieldId: string) => sub.fields.find((f) => f.fieldId === fieldId);

  if (empty) {
    return (
      <div className="empty-tip">
        该子表暂无可显示字段。请在配置中开启字段的「显示」开关，或检查条件规则是否隐藏了全部字段。
      </div>
    );
  }

  return (
    <div>
      <div className="sub-table-scroll">
        <table className="sub-table" style={{ minWidth }}>
          <colgroup>
            <col style={{ width: SUB_ROW_INDEX_WIDTH }} />
            {columns.map((c) => (
              <col key={c.fieldId} style={{ width: c.width }} />
            ))}
            {showActionColumn && <col style={{ width: SUB_ROW_ACTION_WIDTH }} />}
          </colgroup>
          <thead>
            <tr>
              <th className="st-cell-idx">序号</th>
              {columns.map((c) => (
                <th key={c.fieldId} title={c.label}>
                  <span className="sub-th-label">
                    {c.requiredEverywhere && <span className="required-star">*</span>}
                    {c.label}
                  </span>
                </th>
              ))}
              {showActionColumn && <th className="st-cell-act" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx}>
                <td className="st-cell-idx">{idx + 1}</td>
                {columns.map((c) => {
                  const field = fieldOf(c.fieldId);
                  if (!field) return <td key={c.fieldId} />;
                  // 该行被行级条件隐藏 → 单元格留空（提交时值照旧被过滤）
                  if (c.hiddenRows.includes(idx)) {
                    return <td key={c.fieldId} className="st-cell-hidden" />;
                  }
                  const err = errors?.find(
                    (e) => e.tableId === sub.tableId && e.fieldId === c.fieldId && e.rowIndex === idx
                  );
                  // 该格当前是否必填（含行级规则）。必填格标橙，与表头红星视觉呼应。
                  const cellRequired = isFieldRequired(field, sub.tableId, cond, idx);
                  // 错误态优先（红框+红字已是更强的提示），此时不再叠加橙色必填底
                  const cellClass = err
                    ? 'st-cell--error'
                    : cellRequired
                      ? 'st-cell--required'
                      : undefined;
                  return (
                    <td key={c.fieldId} className={cellClass}>
                      <FieldRenderer
                        field={field}
                        tableId={sub.tableId}
                        value={row[c.fieldId]}
                        onChange={(v) => changeCell(idx, c.fieldId, v)}
                        disabled={field.readonly}
                        formValues={row}
                        onBlur={onFieldBlur ? () => onFieldBlur(c.fieldId, idx) : undefined}
                        uniqueStatus={
                          field.unique?.enabled
                            ? (uniqueState?.[`${idx}:${c.fieldId}`]?.status ?? 'idle')
                            : undefined
                        }
                        uniqueHint={uniqueState?.[`${idx}:${c.fieldId}`]?.detail}
                        preview={preview}
                        uniqueCompact
                        compact
                      />
                      {err && <div className="st-cell-err">{err.message}</div>}
                      {/* 部分行必填：列头不给星（会给其他行造成误导），改在需要填的格子内提示 */}
                      {!err && c.partialRequired && cellRequired && (
                        <div className="st-cell-hint">本行必填</div>
                      )}
                    </td>
                  );
                })}
                {showActionColumn && (
                  <td className="st-cell-act">
                    <Button
                      theme="borderless"
                      type="danger"
                      size="small"
                      icon={<IconMinus />}
                      title={`删除第 ${idx + 1} 条`}
                      onClick={() => removeRow(idx)}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sub.allowMultiple && (
        <Button className="add-row-btn" icon={<IconPlus />} onClick={addRow}>
          添加一行
        </Button>
      )}
    </div>
  );
});