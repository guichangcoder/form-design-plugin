import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Select, Tag, Space, Typography } from '@douyinfe/semi-ui';
import { getLinkTargetTableId } from '../../services/baseService';
import { getBase } from '../../services/appContext';
import {
  loadHeadColumn,
  getHeadCache,
  searchAllPages,
  SearchHandle,
  FieldRow,
} from '../../services/tableRecordCache';

interface Props {
  /** 已选记录 ID 列表 */
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  /** 当前字段所在表 ID（用于兜底反查关联目标表） */
  tableId: string;
  fieldId: string;
  /** 配置里已知的关联目标表 ID（hydrate 已从字段元信息补齐） */
  linkTableId?: string;
  /** 配置态预览：完全不加载数据 */
  preview?: boolean;
}

interface Candidate {
  recordId: string;
  label: string;
}

/**
 * 关联字段（单向/双向）选择器：
 * - **展开只取最新 200 条**（1 次请求，秒出）——不再展开就全量翻页等半天；
 * - **输入关键字才逐页查询**：按 200/页 向服务端发起 contains 过滤，命中立即并进候选，
 *   可随时停止（更换关键字/关闭下拉即取消），保留 20 万安全上限；
 * - 权限：以当前打开者身份读表，服务端只返回其有权限的记录（与多维表格权限体系一致）。
 */
export function LinkSelector({
  value,
  onChange,
  disabled,
  tableId,
  fieldId,
  linkTableId,
  preview,
}: Props) {
  const [head, setHead] = useState<Candidate[]>([]);
  const [headDone, setHeadDone] = useState(false);
  const [headHasMore, setHeadHasMore] = useState(false);
  const [headTotal, setHeadTotal] = useState<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  const [searchHits, setSearchHits] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchScanned, setSearchScanned] = useState(0);
  // 关键字防抖定时器 & 当前搜索句柄（用于取消上一次）
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRef = useRef<SearchHandle<FieldRow> | null>(null);
  const keywordRef = useRef('');
  const [targetTableId, setTargetTableId] = useState('');
  const [primaryFieldId, setPrimaryFieldId] = useState('');
  // 已选值的标签（未加载到候选时用 getRecordsByIds 补全）
  const [selectedLabels, setSelectedLabels] = useState<Map<string, string>>(new Map());

  /** 解析关联目标表与主字段（仅元信息，代价极小） */
  useEffect(() => {
    if (preview) return;
    let alive = true;
    (async () => {
      try {
        const tid = linkTableId || (await getLinkTargetTableId(tableId, fieldId)) || '';
        if (!tid) {
          if (alive) setError('未找到关联目标表，请重新保存配置');
          return;
        }
        const table = await getBase().getTableById(tid);
        const metas = await table.getFieldMetaList();
        const primary = metas.find((m) => (m as { isPrimary?: boolean }).isPrimary) ?? metas[0];
        if (alive) {
          setTargetTableId(tid);
          setPrimaryFieldId(primary?.id ?? '');
        }
      } catch (e) {
        if (alive) setError(`加载关联表信息失败：${(e as Error)?.message ?? String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tableId, fieldId, linkTableId, preview]);

  /** 展开时：只拉最新 200 条（1 次请求）；命中缓存则零等待 */
  useEffect(() => {
    if (preview || !opened || !targetTableId || !primaryFieldId) return;
    let alive = true;
    const key = `col:${targetTableId}:${primaryFieldId}`;
    const cached = getHeadCache<FieldRow>(key);
    if (cached) {
      setHead(cached.rows.map((r) => ({ recordId: r.recordId, label: r.text || r.recordId })));
      setHeadHasMore(cached.hasMore);
      setHeadTotal(cached.total);
      setHeadDone(true);
      return;
    }
    setHeadDone(false);
    const { promise } = loadHeadColumn(targetTableId, primaryFieldId, {
      label: `${targetTableId}/${primaryFieldId}`,
    });
    promise.then((res) => {
      if (!alive) return;
      setHead(res.rows.map((r) => ({ recordId: r.recordId, label: r.text || r.recordId })));
      setHeadHasMore(res.hasMore);
      setHeadTotal(res.total);
      setHeadDone(true);
      if (res.error) setError(`加载关联表记录失败：${res.error}`);
    });
    return () => {
      alive = false;
    };
  }, [opened, targetTableId, primaryFieldId, preview]);

  /** 已选值标签补全（展开后，候选里没有的用 getRecordsByIds 取回） */
  useEffect(() => {
    if (!opened || !targetTableId || !primaryFieldId || preview) return;
    const ids = Array.isArray(value) ? value : [];
    const known = new Set([
      ...head.map((c) => c.recordId),
      ...searchHits.map((c) => c.recordId),
    ]);
    const missing = ids.filter((id) => !known.has(id) && !selectedLabels.has(id));
    if (missing.length === 0) return;
    let alive = true;
    (async () => {
      try {
        const table = await getBase().getTableById(targetTableId);
        const recs: any[] = await (table as any).getRecordsByIds(missing.slice(0, 200));
        const map = new Map<string, string>();
        for (const r of recs ?? []) {
          map.set(r.recordId, stringify((r.fields ?? {})[primaryFieldId]) || r.recordId);
        }
        if (alive && map.size) setSelectedLabels((m) => new Map([...m, ...map]));
      } catch {
        /* 标签补全失败则退回显示 id */
      }
    })();
    return () => {
      alive = false;
    };
  }, [opened, value, head, searchHits, primaryFieldId, selectedLabels, targetTableId, preview]);

  /** 关键字输入：取消上一次搜索 → 逐页查询，命中即时并入 */
  const handleSearch = useCallback(
    (kw: string) => {
      keywordRef.current = kw;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      // 立即取消上一次仍在跑的搜索
      handleRef.current?.cancel();
      handleRef.current = null;
      setSearching(false);

      const q = (kw || '').trim();
      if (!q || q.length < 1 || !targetTableId || !primaryFieldId) {
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
        const h = searchAllPages(targetTableId, primaryFieldId, my, {
          onHits: (rows) => {
            if (keywordRef.current.trim() !== my) return; // 关键字已变，丢弃旧结果
            setSearchHits((prev) => {
              const map = new Map(prev.map((c) => [c.recordId, c]));
              rows.forEach((r) => map.set(r.recordId, { recordId: r.recordId, label: r.text || r.recordId }));
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
            handleRef.current = null;
          }
        });
      }, 250);
    },
    [targetTableId, primaryFieldId]
  );

  /** 关闭下拉时取消正在进行的搜索 */
  useEffect(() => {
    return () => {
      handleRef.current?.cancel();
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const selectedIds = Array.isArray(value) ? value : [];
  const labelOf = (id: string) =>
    head.find((c) => c.recordId === id)?.label ||
    searchHits.find((c) => c.recordId === id)?.label ||
    selectedLabels.get(id) ||
    id;

  const apply = (ids: string[]) => onChange(ids);

  if (preview) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          disabled
          placeholder="预览模式不加载数据"
          style={{ flex: 1, height: 32, padding: '0 10px', borderRadius: 6, border: '1px solid #e5e6eb', background: '#f7f8fa', color: '#86909c' }}
        />
      </div>
    );
  }

  if (error) {
    return <Typography.Text type="warning">{error}</Typography.Text>;
  }

  // 候选 = 最新 200 条 + 搜索命中（去重）
  const merged: Candidate[] = (() => {
    const map = new Map<string, Candidate>();
    // 有搜索关键字时，优先展示搜索结果（避免 200 条噪声干扰）
    if (searchHits.length) {
      searchHits.forEach((c) => map.set(c.recordId, c));
    } else {
      head.forEach((c) => map.set(c.recordId, c));
    }
    selectedIds.forEach((id) => {
      if (!map.has(id)) {
        const lbl = selectedLabels.get(id) || head.find((c) => c.recordId === id)?.label;
        if (lbl) map.set(id, { recordId: id, label: lbl });
      }
    });
    return [...map.values()];
  })();

  const footerText = searching
    ? `正在按关键字翻页查询…已扫描 ${searchScanned} 条`
    : searchHits.length
      ? `搜索命中 ${searchHits.length} 条（已扫描 ${searchScanned} 条）`
      : headDone
        ? headTotal
          ? `已加载最新 ${head.length} 条 / 共 ${headTotal} 条${headHasMore ? '，输入关键字可搜索全部' : ''}`
          : `已加载最新 ${head.length} 条${headHasMore ? '，输入关键字可搜索全部' : ''}`
        : '正在加载最新记录…';

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        {selectedIds.map((id) => (
          <Tag
            key={id}
            type="light"
            closable={!disabled}
            onClose={() => apply(selectedIds.filter((x) => x !== id))}
          >
            {labelOf(id)}
          </Tag>
        ))}
        {selectedIds.length === 0 && (
          <Typography.Text type="tertiary">尚未关联记录</Typography.Text>
        )}
      </Space>
      <Select
        style={{ width: '100%' }}
        multiple
        /**
         * filter 必须为真值：Semi 以 `filterable = Boolean(filter)` 决定是否渲染搜索输入框
         * （select/index.js 的 renderTriggerInput 与 foundation 的 _isFilterable）。
         * 之前写 `filter={undefined}` 会直接判定「不可搜索」→根本不渲染输入框 → onSearch 永不触发。
         * 传 `filter` 渲染输入框；同时用 `remote` 跳过 Semi 的本地过滤，改由我们走服务端搜索。
         */
        filter
        remote
        /** 选中一项后不清空关键字，便于连续多选（搜索状态保留） */
        autoClearSearchValue={false}
        onSearch={handleSearch}
        onDropdownVisibleChange={(v: boolean) => {
          if (v) setOpened(true);
        }}
        disabled={disabled}
        loading={opened && !headDone && !head.length}
        placeholder="点击展开（默认显示最新记录），或直接输入关键字搜索全部"
        value={selectedIds}
        onChange={(ids) => apply((ids as string[]) ?? [])}
        optionList={merged.map((c) => ({ value: c.recordId, label: c.label }))}
        emptyContent={
          !opened
            ? '点击展开后将加载最新记录'
            : searching
              ? '正在搜索…'
              : keywordRef.current.trim()
                ? '未找到匹配记录'
                : headDone
                  ? '暂无记录'
                  : '加载中…'
        }
        virtualize={{ itemSize: 32 }}
        outerBottomSlot={
          opened ? (
            <div style={{ padding: '6px 12px', fontSize: 12, color: '#86909c' }}>{footerText}</div>
          ) : undefined
        }
      />
    </div>
  );
}

/** 本地小工具：与 cellText 同源（避免额外依赖） */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(stringify).filter(Boolean).join(' ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string' && o.text) return o.text;
    if (typeof o.name === 'string' && o.name) return o.name;
  }
  return '';
}