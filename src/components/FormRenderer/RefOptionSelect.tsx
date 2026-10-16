import React, { useEffect, useMemo, useState } from 'react';
import { Select, Typography } from '@douyinfe/semi-ui';
import { getBase, getBaseToken } from '../../services/appContext';
import { FieldConfig, FormValues } from '../../types';
import { hasOptionRef, resolveRefOptions, SourceRecordLite } from '../../utils/optionRef';
import { classifySdkError, ClassifiedError } from '../../utils/permError';
import { fuzzyOptionFilter } from './fuzzyOptionFilter';

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
}

/** 源表记录加载上限（分页拉取，防止超大表拖垮面板） */
const MAX_RECORDS = 2000;
const PAGE_SIZE = 200; // SDK 单次上限就是 200，传更大值非法

/**
 * 引用选项选择器（参考多维表格原生「引用选项」）：
 * - 选项 = 源表取值字段的记录值（去重），从源表分页加载后内存过滤；
 * - 引用条件全部满足的记录才纳入；条件引用当前记录其他字段时，
 *   随该字段值实时重筛（省-市级联；父字段未选则无选项）；
 * - 源表记录只加载一次，联动变化不重复拉表。
 */
export function RefOptionSelect({ field, value, onChange, disabled, multiple, formValues }: Props) {
  const ref = field.optionRef;
  const refOk = hasOptionRef(field);
  const [records, setRecords] = useState<SourceRecordLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorHelp, setErrorHelp] = useState<ClassifiedError | null>(null);

  useEffect(() => {
    if (!refOk) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      setLoading(true);
      setError('');
      setErrorHelp(null);
      try {
        const table = await getBase().getTableById(ref!.tableId);
        const list: SourceRecordLite[] = [];
        let pageToken: string | undefined;
        do {
          const res = await table.getRecords({
            pageSize: PAGE_SIZE,
            ...(pageToken ? { pageToken: pageToken as any } : {}),
          });
          for (const rec of res.records ?? []) {
            list.push({ fields: (rec.fields ?? {}) as Record<string, unknown> });
            if (list.length >= MAX_RECORDS) break;
          }
          pageToken = res.hasMore ? (res.pageToken as string | undefined) : undefined;
        } while (pageToken && list.length < MAX_RECORDS);
        if (list.length >= MAX_RECORDS) {
          console.warn(
            `[optionRef] 源表记录超过 ${MAX_RECORDS} 条，只加载前 ${MAX_RECORDS} 条，选项可能不完整`
          );
        }
        if (alive) setRecords(list);
      } catch (e) {
        // ★ 诊断留痕：权限/表缺失是最常见的「别人打不开报错」根因，
        //   把上下文一次性打全，用户把控制台这段回传即可定位。
        const token = (() => {
          try {
            return getBaseToken() ?? '';
          } catch {
            return '';
          }
        })();
        console.error(
          `[optionRef] 加载引用选项失败：field="${field.label || field.fieldName}" ` +
            `sourceTableId=${ref?.tableId} sourceFieldId=${ref?.fieldId} ` +
            `baseToken=${token ? `...${String(token).slice(-6)}` : '(无)'} ` +
            `error=${(e as Error)?.message ?? String(e)}`
        );
        if (alive) {
          const c = classifySdkError(e, '引用选项的源数据表');
          setError(c.title);
          setErrorHelp(c);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // 源表/源字段/静态条件变化才重拉；联动过滤走 useMemo 内存计算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOk, ref?.tableId, ref?.fieldId, JSON.stringify(ref?.conditions)]);

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

  return (
    <Select
      style={{ width: '100%' }}
      multiple={multiple}
      optionList={options}
      value={multiple ? ((value as string[]) ?? []) : ((value as string) || undefined)}
      placeholder={
        loading
          ? '正在加载引用选项…'
          : (field.placeholder ?? '请选择（输入可搜索）')
      }
      disabled={disabled}
      loading={loading}
      filter={fuzzyOptionFilter}
      emptyContent={loading ? '加载中…' : '无满足条件的引用选项'}
      onChange={(v: any) => onChange(v)}
    />
  );
}
