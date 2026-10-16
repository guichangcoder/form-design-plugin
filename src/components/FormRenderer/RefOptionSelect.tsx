import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select, Typography } from '@douyinfe/semi-ui';
import { getBaseToken } from '../../services/appContext';
import { FieldConfig, FormValues } from '../../types';
import { hasOptionRef, resolveRefOptions } from '../../utils/optionRef';
import { stringifyCellValue } from '../../utils/cellText';
import { classifySdkError, ClassifiedError } from '../../utils/permError';
import {
  loadHeadRows,
  loadRowsByConditions,
  getHeadCache,
  searchAllRows,
  SearchHandle,
  FullRow,
  ConditionSpec,
} from '../../services/tableRecordCache';

interface Props {
  field: FieldConfig;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  multiple?: boolean;
  formValues: FormValues;
  preview?: boolean;
}

/**
 * 引用选项选择器（参考多维表格原生「引用选项」）：
 * - **展开只取最新 200 条**（1 次请求，秒出）；
 * - 输入关键字时逐页查询（contains），命中即时并入，可随时取消；
 * - 联动条件（省-市）始终在**已加载的候选**上内存过滤，随父字段值实时重筛；
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
  const [head, setHead] = useState<FullRow[]>([]);
  const [headDone, setHeadDone] = useState(false);
  const [searchHits, setSearchHits] = useState<FullRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [errorHelp, setErrorHelp] = useState<ClassifiedError | null>(null);
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRef = useRef<SearchHandle<FullRow> | null>(null);
  const keywordRef = useRef('');

  /**
   * 当前联动条件（valueSource=field 的项，父字段已填值才算成立）。
   * 这些条件会作为**服务端精确过滤**下发，保证子级选项完整（不受首屏 200 条限制）。
   */
  const condKey = useMemo(() => {
    if (!refOk) return '';
    const specs: ConditionSpec[] = [];
    for (const c of ref!.conditions ?? []) {
      if (c.valueSource === 'field') {
        if (!c.formFieldId) return ''; // 配置不完整 → 不下发
        const text = stringifyCellValue(formValues?.[c.formFieldId]).trim();
        if (!text) return ''; // 父级未填 → 子级无选项（符合原生行为）
        specs.push({ fieldId: c.sourceFieldId, text });
      } else {
        const text = (c.staticValue ?? '').trim();
        if (!text) return ''; // 固定值为空 → 不下发（不放出全部选项）
        specs.push({ fieldId: c.sourceFieldId, text });
      }
    }
    // 用 JSON 编码做 key，避免文本里含 = / & 时解析错位
    return specs.length ? JSON.stringify(specs) : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOk, ref, JSON.stringify(formValues)]);

  /** 由 condKey 还原服务端条件（顺序敏感，与 condKey 同源） */
  const condSpecs = useMemo<ConditionSpec[]>(() => {
    if (!condKey) return [];
    try {
      return JSON.parse(condKey);
    } catch {
      return [];
    }
  }, [condKey]);

  /**
   * 展开时取候选源记录：
   * - 有联动条件 → 按条件服务端精确取回（完整，1~2 次请求）；
   * - 无联动条件 → 只取最新 200 条（1 次请求，秒出），关键字搜索可补全。
   */
  useEffect(() => {
    if (preview || !refOk || !ref?.tableId || !opened) return;
    let alive = true;
    setHeadDone(false);

    if (condSpecs.length > 0) {
      loadRowsByConditions(ref.tableId, condSpecs, {
        label: `cond:${condKey}`,
      })
        .promise.then((res) => {
          if (!alive) return;
          // 条件过滤未生效（宿主忽略 filter）→ 回退到首屏 + 内存过滤
          if (res.rows.length > 0 && !res.filterEffective) {
            loadHeadRows(ref.tableId, { label: ref.tableId }).promise.then((h) => {
              if (!alive) return;
              setHead(h.rows);
              setHeadDone(true);
            });
            return;
          }
          setHead(res.rows);
          setHeadDone(true);
          if (res.error) setError(res.error);
        })
        .catch(() => {
          if (alive) setHeadDone(true);
        });
      return () => {
        alive = false;
      };
    }

    const key = `row:${ref.tableId}`;
    const cached = getHeadCache<FullRow>(key);
    if (cached) {
      setHead(cached.rows);
      setHeadDone(true);
      if (cached.error) setError(cached.error);
      return;
    }
    loadHeadRows(ref.tableId, { label: ref.tableId })
      .promise.then((res) => {
        if (!alive) return;
        setHead(res.rows);
        setHeadDone(true);
        if (res.error) {
          console.error(
            `[optionRef] 加载引用选项失败：field="${field.label || field.fieldName}" ` +
              `sourceTableId=${ref.tableId} sourceFieldId=${ref.fieldId} ` +
              `baseToken=${(() => {
                try {
                  const tok = getBaseToken();
                  return tok ? `...${String(tok).slice(-6)}` : '(无)';
                } catch {
                  return '(无)';
                }
              })()} error=${res.error}`
          );
          const c = classifySdkError(new Error(res.error), '引用选项的源数据表');
          setError(c.title);
          setErrorHelp(c);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, refOk, ref?.tableId, ref?.fieldId, opened, condKey]);

  /** 关键字输入：逐页查询（按源值字段 contains），命中即时并入 */
  const handleSearch = useCallback(
    (kw: string) => {
      keywordRef.current = kw;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      handleRef.current?.cancel();
      handleRef.current = null;
      setSearching(false);
      const q = (kw || '').trim();
      if (!q || !ref?.tableId || !ref?.fieldId) {
        setSearchHits([]);
        return;
      }
      searchTimer.current = setTimeout(() => {
        const my = q;
        setSearchHits([]);
        setSearching(true);
        const h = searchAllRows(ref.tableId, ref.fieldId, my, {
          extraConditions: condSpecs,
          onHits: (rows) => {
            if (keywordRef.current.trim() !== my) return;
            setSearchHits((prev) => {
              const map = new Map(prev.map((r) => [r.recordId, r]));
              rows.forEach((r) => map.set(r.recordId, r));
              return [...map.values()];
            });
          },
        });
        handleRef.current = h;
        h.done.then(() => {
          if (handleRef.current === h) {
            setSearching(false);
            handleRef.current = null;
          }
        });
      }, 250);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ref?.tableId, ref?.fieldId, condKey]
  );

  useEffect(() => {
    return () => {
      handleRef.current?.cancel();
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  /** 候选行 = 最新 200 + 搜索命中（去重） */
  const sourceRows = useMemo(() => {
    const map = new Map<string, FullRow>();
    (searchHits.length ? searchHits : head).forEach((r) => map.set(r.recordId, r));
    return [...map.values()];
  }, [head, searchHits]);

  /** 联动过滤：在已加载候选上内存重筛（不重拉表） */
  const options = useMemo(
    () => (refOk ? resolveRefOptions(ref!, sourceRows, formValues).map((t) => ({ value: t, label: t })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refOk, ref, sourceRows, JSON.stringify(formValues)]
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

  const condApplied = condSpecs.length > 0;
  const footerText = searching
    ? '正在按关键字翻页查询…'
    : searchHits.length
      ? `搜索命中 ${searchHits.length} 条源记录`
      : headDone
        ? condApplied
          ? `已按联动条件取回全部 ${head.length} 条源记录`
          : `已加载最新 ${head.length} 条源记录，输入关键字可搜索全部`
        : '正在加载源记录…';

  return (
    <Select
      style={{ width: '100%' }}
      multiple={multiple}
      /**
       * filter 必须为真值：Semi 以 `filterable = Boolean(filter)` 决定是否渲染搜索输入框
       * （select/index.js 的 renderTriggerInput 与 foundation 的 _isFilterable）。
       * 之前写 `filter={undefined}` 会判定「不可搜索」→ 输入框根本不渲染 → onSearch 永不触发。
       * 传 `filter` 渲染输入框；用 `remote` 跳过 Semi 本地过滤，改由我们走服务端搜索。
       */
      filter
      remote
      /** 选中后保留关键字，便于连续多选 */
      autoClearSearchValue={false}
      optionList={options}
      value={multiple ? ((value as string[]) ?? []) : ((value as string) || undefined)}
      placeholder={
        condApplied
          ? '点击展开（按上级选择联动加载），或输入关键字搜索'
          : '点击展开（默认最新记录），或输入关键字搜索全部'
      }
      disabled={disabled}
      loading={opened && !headDone && !head.length}
      onSearch={handleSearch}
      onDropdownVisibleChange={(v: boolean) => {
        if (v && !openedRef.current) {
          openedRef.current = true;
          setOpened(true);
        }
      }}
      emptyContent={
        !opened
          ? '点击展开后将加载源记录'
          : searching
            ? '正在搜索…'
            : keywordRef.current.trim()
              ? '未找到匹配的引用选项'
              : headDone
                ? condApplied
                  ? '上级未选择或该条件下无选项'
                  : '无满足条件的引用选项'
                : '加载中…'
      }
      virtualize={{ itemSize: 32 }}
      outerBottomSlot={
        opened ? (
          <div style={{ padding: '6px 12px', fontSize: 12, color: '#86909c' }}>{footerText}</div>
        ) : undefined
      }
      onChange={(v: any) => onChange(v)}
    />
  );
}