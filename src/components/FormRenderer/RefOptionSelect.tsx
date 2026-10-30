import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select, Typography } from '@douyinfe/semi-ui';
import { getBaseToken } from '../../services/appContext';
import { FieldConfig, FormValues } from '../../types';
import { hasOptionRef, conditionSpecOf } from '../../utils/optionRef';
import { stringifyCellValue, extractOptionTexts } from '../../utils/cellText';
import { classifySdkError, ClassifiedError } from '../../utils/permError';
import {
  searchAllRows,
  enumerateRefOptions,
  OptionEnumResult,
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
 * 引用选项选择器（参考多维表格原生「引用选项」）。
 *
 * ★ 技术方案与**关联字段选择器（LinkSelector）同源**，因为它实测满足要求：
 *   - 选项由 `enumerateRefOptions` 完整穷举（内部引擎 = `getRecordsByPage` 分页扫描，
 *     与 LinkSelector 用的完全同一个接口 → 在所有宿主上都可用）；
 *   - **首屏秒出 + 后台续扫**：逐页回调，第一页就出选项，剩余在后台补，
 *     底部显示「已扫描 N / 共 M」，不会让用户干等；
 *   - 关键字搜索走 `searchAllRows`（服务端 `contains` + 附加条件 AND），命中即时并入。
 *
 * 完整性保证：翻到底才算「全部」；若撞页数/时间上限，底部**如实提示「可能不全」**，
 * 绝不静默只给前 200 条。选项来源优先级（都不影响完整性）：
 *   ① 单选/多选 + 无条件 → 字段配置的选项域（1 次请求、最快）；
 *   ② 单选/多选 + 有条件 → 存在性探测（成本与表行数无关）；
 *   ③ 其余 → 渐进全量扫描（必然可用）。
 *
 * 权限：以当前打开者身份读源表，服务端只返回其有权限的记录。
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
  /** 已穷举出的选项文本（保序、去重；穷举过程中渐进追加） */
  const [values, setValues] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  /** 穷举结果元信息：用于如实提示「是否完整」 */
  const [meta, setMeta] = useState<OptionEnumResult | null>(null);
  /** 扫描进度：已扫描记录数 / 服务端总数（用于「首屏秒出、后台续扫」的可见反馈） */
  const [scanProgress, setScanProgress] = useState<{ scanned: number; total?: number } | null>(null);
  const [searchHits, setSearchHits] = useState<FullRow[]>([]);
  const [searching, setSearching] = useState(false);
  /** 本次关键字搜索是否已跑完（用于「搜完了确实没命中」时也保持搜索态，不回退成全量列表） */
  const [searchDone, setSearchDone] = useState(false);
  const [searchScanned, setSearchScanned] = useState(0);
  const [error, setError] = useState('');
  const [errorHelp, setErrorHelp] = useState<ClassifiedError | null>(null);
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRef = useRef<SearchHandle<FullRow> | null>(null);
  /** 当前关键字（state，用于渲染；同时用 ref 做「结果是否属于本次关键字」的比对） */
  const [keyword, setKeyword] = useState('');
  const keywordRef = useRef('');
  /** 选中的选项文本（用于把「搜索态下不在候选里的已选值」补进候选项，避免回显丢失） */
  const selectedTexts = useMemo(() => {
    const arr = multiple ? ((value as string[]) ?? []) : value ? [value as string] : [];
    return (arr as string[]).filter((x) => typeof x === 'string' && x);
  }, [value, multiple]);

  /**
   * 当前联动条件（valueSource=field 的项，父字段已填值才算成立）。
   * 这些条件会作为**服务端精确过滤**下发，保证子级选项完整（不受 200 条限制）。
   * 条件携带源表字段类型：服务端对「单选」的 is 条件需要 fieldType 才能正确解析。
   */
  const condKey = useMemo(() => {
    if (!refOk) return '';
    const specs: ConditionSpec[] = [];
    for (const c of ref!.conditions ?? []) {
      const spec = conditionSpecOf(c, formValues);
      if (!spec) return ''; // 配置不完整 / 父级未填 → 不下发（子级无选项，符合原生行为）
      specs.push(spec);
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
   * 是否存在「未成立的联动条件」。
   * 例：配置了「市 ← 表单字段=省」但省还没填 → condKey 为空串，
   * 此时子级应**无选项**（符合原生级联行为），而不是回落成「取全部记录前 200」。
   */
  const hasPendingCond = useMemo(() => {
    if (!refOk || !ref?.conditions?.length) return false;
    return condSpecs.length !== ref.conditions.length;
  }, [refOk, ref, condSpecs.length]);

  /**
   * 展开时穷举选项（主路径）：
   *  - 有未成立的联动条件 → 直接空（不加载）；
   *  - 否则 enumerateRefOptions：秒出首屏、后台续扫，逐页并入。
   */
  useEffect(() => {
    if (preview || !refOk || !ref?.tableId || !ref?.fieldId || !opened) return;
    let alive = true;
    let enumP: { cancel: () => void } | null = null;
    setDone(false);
    setValues([]);
    setMeta(null);
    setScanProgress(null);
    if (hasPendingCond) {
      setDone(true);
      return;
    }
    const h = enumerateRefOptions(ref.tableId, ref.fieldId, condSpecs, {
      valueFieldType: ref.fieldType,
      onOption: (v) => {
        if (!alive) return;
        setValues((prev) => (prev.includes(v) ? prev : [...prev, v]));
      },
      onScanProgress: (scanned, total) => {
        if (!alive) return;
        setScanProgress({ scanned, total });
      },
    });
    enumP = h;
    h.promise
      .then((res) => {
        if (!alive) return;
        setMeta(res);
        setValues(res.values);
        setDone(true);
        // 🔴 枚举「跑完但失败」必须显式报出来。
        //   enumerateRefOptions 内部把读取异常 catch 成了 { values: [], error }，
        //   所以失败不会走 .catch 分支；若这里不处理 res.error，界面就只剩
        //   「已取到 0 个选项」，用户与开发者都无从判断是「真的没有选项」
        //   还是「源表根本读不到」（2026-10-30 实测踩坑）。
        //   仅当「一个值都没取到」时才用错误态替换下拉框：
        //   已有部分值时仍让用户能选，错误只进控制台，不遮挡可用选项。
        if (res.error) {
          console.warn(
            `[optionRef] 枚举引用选项未完成：field="${field.label || field.fieldName}" ` +
              `sourceTableId=${ref.tableId} sourceFieldId=${ref.fieldId} ` +
              `complete=${res.complete} values=${res.values.length} error=${res.error}`
          );
          if (res.values.length === 0) {
            const c = classifySdkError(new Error(res.error), '引用选项的源数据表');
            setError(c.title);
            setErrorHelp(c);
          }
        }
      })
      .catch((e) => {
        if (!alive) return;
        setDone(true);
        const c = classifySdkError(e, '引用选项的源数据表');
        setError(c.title);
        setErrorHelp(c);
        console.error(
          `[optionRef] 穷举引用选项失败：field="${field.label || field.fieldName}" ` +
            `sourceTableId=${ref.tableId} sourceFieldId=${ref.fieldId} ` +
            `baseToken=${(() => {
              try {
                const tok = getBaseToken();
                return tok ? `...${String(tok).slice(-6)}` : '(无)';
              } catch {
                return '(无)';
              }
            })()} error=${(e as Error)?.message ?? e}`
        );
      });
    return () => {
      alive = false;
      enumP?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, refOk, ref?.tableId, ref?.fieldId, opened, condKey, hasPendingCond]);

  /** 关键字输入：逐页查询（按源值字段 contains），命中即时并入（可被下一次输入取消） */
  const handleSearch = useCallback(
    (kw: string) => {
      keywordRef.current = kw;
      setKeyword(kw);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      handleRef.current?.cancel();
      handleRef.current = null;
      setSearching(false);
      const q = (kw || '').trim();
      setSearchDone(false);
      if (!q || !ref?.tableId || !ref?.fieldId) {
        setSearchHits([]);
        setSearchScanned(0);
        return;
      }
      // 防抖 250ms，避免每个按键都触发翻页
      searchTimer.current = setTimeout(() => {
        const my = q;
        setSearchHits([]);
        setSearchScanned(0);
        setSearching(true);
        const h = searchAllRows(ref.tableId, ref.fieldId, my, {
          extraConditions: condSpecs,
          onHits: (rows) => {
            if (keywordRef.current.trim() !== my) return; // 关键字已变，丢弃旧结果
            setSearchHits((prev) => {
              const map = new Map(prev.map((r) => [r.recordId, r]));
              rows.forEach((r) => map.set(r.recordId, r));
              return [...map.values()];
            });
          },
          onProgress: (scanned) => {
            if (keywordRef.current.trim() !== my) return;
            setSearchScanned(scanned);
          },
        });
        handleRef.current = h;
        h.done.then(() => {
          if (handleRef.current === h) {
            setSearching(false);
            setSearchDone(true);
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

  const kw = keyword.trim().toLowerCase();
  /** 是否处于「搜索态」：有关键字就进入搜索态（即便结果为空，也不回退成全量列表） */
  const inSearch = !!kw;

  /**
   * 本地关键字过滤（对**已穷举的全量选项**做过滤）。
   * ★ 这是「全量搜索」最可靠的一环：因为我们已把全部选项枚举到本地，
   *   直接在本地筛即**即时、完整**，不依赖服务端对「单选字段 contains」的支持。
   */
  const localHits = useMemo(
    () => (inSearch ? values.filter((v) => v.toLowerCase().includes(kw)) : []),
    [inSearch, values, kw]
  );

  /**
   * 最终候选项文本。
   * ★ 关键（与 LinkSelector 一致）：**有关键字时只展示「匹配关键字」的项**，
   * 绝不能把「未过滤的全量 values」也放进来 —— 否则列表几乎仍是全量，用户会觉得「搜索没生效」。
   * 匹配来源两个（都满足关键字）：
   *   ① 本地对已穷举全量选项的过滤（即时、完整）；
   *   ② 服务端逐页搜索命中（补充超出穷举上限、或穷举尚未跑到的那部分）。
   */
  const optionTexts = useMemo(() => {
    if (!refOk || hasPendingCond) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (t: string) => {
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    };
    if (inSearch) {
      localHits.forEach(push);
      searchHits.forEach((r) => {
        // ★ 多选取值字段：命中行可能含多个选项 → 逐个拆出，且每个都要自证含关键字
        for (const t of extractOptionTexts((r.fields ?? {})[ref!.fieldId], ref!.fieldType)) {
          if (t.toLowerCase().includes(kw)) push(t); // 二次自证：确实含关键字
        }
      });
    } else {
      values.forEach(push);
    }
    // 已选值不在候选中时补上，保证回显（Semi 多选需 label 可见）
    selectedTexts.forEach(push);
    return out.map((t) => ({ value: t, label: t }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOk, ref, hasPendingCond, values, searchHits, inSearch, localHits, kw, selectedTexts]);

  /** 搜索态下的命中数（本地 + 服务端去重后） */
  const searchHitCount = useMemo(
    () => optionTexts.filter((o) => !selectedTexts.includes(o.value as string)).length,
    [optionTexts, selectedTexts]
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
  const enumRunning = opened && !done && !inSearch;
  const footerText = searching
    ? `正在按关键字翻页查询…已扫描 ${searchScanned} 条`
    : inSearch
      ? searchHitCount > 0
        ? `搜索命中 ${searchHitCount} 个选项${searching ? '（仍在翻页补充…）' : ''}`
        : searching || (searchDone === false && searchScanned === 0)
          ? '正在搜索…'
          : '未找到匹配的引用选项'
      : hasPendingCond
        ? '请先填写上级字段'
        : enumRunning
          ? `正在穷举选项…已扫描 ${scanProgress?.scanned ?? 0}${scanProgress?.total ? ` / 共 ${scanProgress.total}` : ''} 条`
          : done
            ? meta && !meta.complete
              ? condApplied
                ? `已按条件取到 ${values.length} 个选项（已达上限，可能不全）`
                : `已取到 ${values.length} 个选项（已达上限，可能不全）`
              : condApplied
                ? `已按条件穷举全部 ${values.length} 个选项`
                : meta?.source === 'metadata'
                  ? `已加载全部 ${values.length} 个选项（源字段选项域）`
                  : `已加载全部 ${values.length} 个选项，输入关键字可搜索`
            : '正在加载选项…';

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
      optionList={optionTexts}
      value={multiple ? ((value as string[]) ?? []) : ((value as string) || undefined)}
      placeholder={
        hasPendingCond
          ? '请先填写上级字段'
          : condApplied
            ? '点击展开（按上级选择联动加载），或输入关键字搜索'
            : '点击展开（加载全部选项），或输入关键字搜索'
      }
      disabled={disabled}
      loading={opened && !done && !values.length && !inSearch}
      onSearch={handleSearch}
      onDropdownVisibleChange={(v: boolean) => {
        if (v && !openedRef.current) {
          openedRef.current = true;
          setOpened(true);
        }
      }}
      emptyContent={
        !opened
          ? '点击展开后将加载选项'
          : searching
            ? '正在搜索…'
            : kw
              ? '未找到匹配的引用选项'
              : hasPendingCond
                ? '请先填写上级字段'
                : done
                  ? condApplied
                    ? '上级未选择或该条件下无选项'
                    : '没有可用的引用选项'
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