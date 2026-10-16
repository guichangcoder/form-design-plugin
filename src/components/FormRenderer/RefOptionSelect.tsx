import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Typography } from '@douyinfe/semi-ui';
import { getBaseToken } from '../../services/appContext';
import { FieldConfig, FormValues } from '../../types';
import { hasOptionRef, resolveRefOptions } from '../../utils/optionRef';
import { classifySdkError, ClassifiedError } from '../../utils/permError';
import { fuzzyOptionFilter } from './fuzzyOptionFilter';
import {
  loadTableRows,
  subscribeProgress,
  getLoaded,
  LoadProgress,
  FullRow,
} from '../../services/tableRecordCache';

interface Props {
  /** 含完整 optionRef 的字段配置 */
  field: FieldConfig;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  /** 是否多选 */
  multiple?: boolean;
  /** 当前记录（主表值 / 子表当前行值）：联动条件据此实时过滤 */
  formValues: FormValues;
  /** 配置态预览：完全不加载数据 */
  preview?: boolean;
}

/**
 * 引用选项选择器（参考多维表格原生「引用选项」）：
 * - 选项 = 源表取值字段的记录值（去重）；
 * - **懒加载**：下拉展开才启动加载；**全量加载**：分页翻到底，不再 2000 条截断；
 * - **渐进式**：先出已加载部分并显示进度，后台继续翻页；
 * - 联动条件引用当前记录其他字段时，随该字段值实时重筛（省-市级联；父字段未选则无选项）；
 * - 权限：以当前打开者身份读源表，服务端只返回其有权限的记录。
 */
export function RefOptionSelect({
  field,
  value,
  onChange,
  disabled,
  multiple,
  formValues,
  preview,
}: Props) {
  const ref = field.optionRef;
  const refOk = hasOptionRef(field);
  const [records, setRecords] = useState<FullRow[]>([]);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState('');
  const [errorHelp, setErrorHelp] = useState<ClassifiedError | null>(null);
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);

  useEffect(() => {
    if (preview || !refOk || !ref?.tableId) return;
    const key = `row:${ref.tableId}`;
    // 命中缓存（本会话里别的同源字段已拉过）→ 直接可用，无需展开
    const cached = getLoaded<FullRow>(key);
    if (cached) setRecords(cached);
    // ★ 懒加载：只有下拉展开过才真正启动加载
    if (!opened) return;
    let alive = true;
    loadTableRows(ref.tableId, { label: ref.tableId });
    const apply = (data: FullRow[]) => {
      if (alive) setRecords(data);
    };
    const unsub = subscribeProgress<FullRow>(key, (p, data) => {
      if (!alive) return;
      setProgress(p);
      apply(data);
      if (p.error) {
        console.error(
          `[optionRef] 加载引用选项失败：field="${field.label || field.fieldName}" ` +
            `sourceTableId=${ref?.tableId} sourceFieldId=${ref?.fieldId} ` +
            `baseToken=${(() => {
              try {
                const tok = getBaseToken();
                return tok ? `...${String(tok).slice(-6)}` : '(无)';
              } catch {
                return '(无)';
              }
            })()} error=${p.error}`
        );
        const c = classifySdkError(new Error(p.error), '引用选项的源数据表');
        setError(c.title);
        setErrorHelp(c);
      }
    });
    return () => {
      alive = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, refOk, ref?.tableId, ref?.fieldId, opened]);

  // 联动过滤：formValues 变化时实时重筛（内存计算，不重拉表）
  const options = useMemo(
    () =>
      refOk
        ? resolveRefOptions(ref!, records, formValues).map((t) => ({ value: t, label: t }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refOk, ref, records, JSON.stringify(formValues)]
  );

  if (!refOk) {
    return <Typography.Text type="warning">引用选项未配置完整，请重新编辑该字段的配置</Typography.Text>;
  }
  if (preview) {
    return (
      <input
        disabled
        placeholder="预览模式不加载数据"
        style={{ width: '100%', height: 32, padding: '0 10px', borderRadius: 6, border: '1px solid #e5e6eb', background: '#f7f8fa', color: '#86909c' }}
      />
    );
  }
  if (error) {
    return (
      <div
        style={{
          padding: '8px 10px',
          border: '1px solid #fdba74',
          background: '#fff7ed',
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.7,
          color: '#9a3412',
        }}
      >
        <div>⚠️ {error}</div>
        {errorHelp?.action && <div style={{ marginTop: 2 }}>{errorHelp.action}</div>}
      </div>
    );
  }

  const done = progress?.done;
  const loaded = progress?.loaded ?? 0;
  const total = progress?.total;
  const loadingText = !progress
    ? '正在加载引用选项…'
    : done
      ? total
        ? `已加载全部 ${loaded} 条源记录`
        : `已加载 ${loaded} 条源记录`
      : `正在加载…已 ${loaded}${total ? ` / ${total}` : ''} 条`;

  // 未展开且已有缓存：直接可用；未展开且无缓存：显示提示（点开才加载）
  const needOpenHint = !opened && !progress;

  return (
    <Select
      style={{ width: '100%' }}
      multiple={multiple}
      optionList={options}
      value={multiple ? ((value as string[]) ?? []) : ((value as string) || undefined)}
      placeholder={
        needOpenHint
          ? '点击展开以加载引用选项（下拉时才加载）'
          : (field.placeholder ?? '请选择（输入可搜索）')
      }
      disabled={disabled}
      loading={!done && opened}
      filter={fuzzyOptionFilter}
      onDropdownVisibleChange={(v: boolean) => {
        if (v && !openedRef.current) {
          openedRef.current = true;
          setOpened(true);
        }
      }}
      emptyContent={
        needOpenHint
          ? '点击展开后将加载引用选项'
          : done
            ? '无满足条件的引用选项'
            : '加载中…'
      }
      virtualize={{ itemSize: 32 }}
      outerBottomSlot={
        opened ? (
          <div style={{ padding: '6px 12px', fontSize: 12, color: '#86909c' }}>{loadingText}</div>
        ) : undefined
      }
      onChange={(v: any) => onChange(v)}
    />
  );
}