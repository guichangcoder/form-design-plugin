import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Select, Tag, Space, Typography } from '@douyinfe/semi-ui';
import { getLinkTargetTableId } from '../../services/baseService';
import { fuzzyOptionFilter } from './fuzzyOptionFilter';
import {
  loadFieldColumn,
  subscribeProgress,
  getLoaded,
  searchRecordsByKeyword,
  LoadProgress,
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
 * - **懒加载**：下拉展开时才启动加载（不再打开表单就并发拉表）；
 * - **全量加载**：分页一直翻到底，不再有「第 2000 条之后搜不到」的硬截断；
 * - **渐进式**：第一页秒出可用，后台继续翻页并显示「已加载 x/y 条」；
 * - **服务端补搜**：全量未完成时输入关键字，额外走服务端 contains 过滤补齐远端命中；
 * - 权限：一律以当前打开者身份读表，服务端只返回其有权限的记录（与多维表格权限体系一致）。
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
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState('');
  const [primaryFieldId, setPrimaryFieldId] = useState<string>('');
  // 服务端补搜命中的额外记录（recordId → 标签）
  const extraRef = useRef<Map<string, string>>(new Map());
  const [extraTick, setExtraTick] = useState(0);
  const [opened, setOpened] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 展开前也要能显示已选标签（否则只显示 recordId）
  const [preselectedLabels, setPreselectedLabels] = useState<Map<string, string>>(new Map());

  const targetTableIdRef = useRef<string>('');

  /** 解析关联目标表主字段 id（仅元信息，代价极小） */
  useEffect(() => {
    if (preview) return;
    let alive = true;
    (async () => {
      try {
        const { getBase } = await import('../../services/appContext');
        const targetTableId =
          linkTableId || (await getLinkTargetTableId(tableId, fieldId)) || '';
        if (!targetTableId) {
          if (alive) setError('未找到关联目标表，请重新保存配置');
          return;
        }
        targetTableIdRef.current = targetTableId;
        const table = await getBase().getTableById(targetTableId);
        const metas = await table.getFieldMetaList();
        const primary = metas.find((m) => (m as { isPrimary?: boolean }).isPrimary) ?? metas[0];
        if (alive) setPrimaryFieldId(primary?.id ?? '');
      } catch (e) {
        if (alive) setError(`加载关联表信息失败：${(e as Error)?.message ?? String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tableId, fieldId, linkTableId, preview]);

  /** 展开时才真正启动全量加载（懒加载 + 缓存复用 + 进度订阅） */
  useEffect(() => {
    if (preview || !opened || !primaryFieldId) return;
    const targetTableId = targetTableIdRef.current;
    if (!targetTableId) return;

    let alive = true;
    const key = loadFieldColumn(targetTableId, primaryFieldId, {
      label: `${targetTableId}/${primaryFieldId}`,
    }).key;

    const apply = (data: FieldRow[]) => {
      if (!alive) return;
      setCandidates(data.map((r) => ({ recordId: r.recordId, label: r.text || r.recordId })));
    };

    // 已有缓存立即用（再次展开零等待）
    const cached = getLoaded<FieldRow>(key);
    if (cached) apply(cached);

    const unsub = subscribeProgress<FieldRow>(key, (p, data) => {
      if (!alive) return;
      setProgress(p);
      apply(data);
      if (p.error) setError(`加载关联表记录失败：${p.error}`);
      if (p.truncated) {
        console.warn('[linkSelector] 记录数达到加载上限，候选可能不完整');
      }
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [opened, primaryFieldId, preview]);

  /** 下拉展开时，把已选但未加载到的记录标签补全（保证标签可读） */
  useEffect(() => {
    const targetTableId = targetTableIdRef.current;
    if (!opened || !targetTableId || preview) return;
    const ids = Array.isArray(value) ? value : [];
    const known = new Set(candidates.map((c) => c.recordId));
    const missing = ids.filter((id) => !known.has(id) && !preselectedLabels.has(id));
    if (missing.length === 0) return;
    let alive = true;
    (async () => {
      try {
        const { getBase } = await import('../../services/appContext');
        const table = await getBase().getTableById(targetTableId);
        const recs: any[] = await (table as any).getRecordsByIds(missing.slice(0, 200));
        const map = new Map<string, string>();
        const fid = primaryFieldId;
        for (const r of recs ?? []) {
          const t = fid
            ? String((r?.fields ?? {})[fid] ?? '')
            : '';
          map.set(r.recordId, t || r.recordId);
        }
        if (alive && map.size) setPreselectedLabels((m) => new Map([...m, ...map]));
      } catch {
        /* 标签补全失败则退回显示 id */
      }
    })();
    return () => {
      alive = false;
    };
  }, [opened, value, candidates, primaryFieldId, preselectedLabels, preview]);

  /** 搜索：本地过滤由 Semi 的 filter 负责；这里额外做服务端补搜（防全量未完成时搜不到） */
  const handleSearch = useCallback(
    (kw: string) => {
      const q = (kw || '').trim();
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (!q || q.length < 1) return;
      const targetTableId = targetTableIdRef.current;
      if (!targetTableId || !primaryFieldId) return;
      searchTimer.current = setTimeout(async () => {
        const hits = await searchRecordsByKeyword(targetTableId, primaryFieldId, q);
        if (hits.length === 0) return;
        let changed = false;
        for (const h of hits) {
          if (!extraRef.current.has(h.recordId)) {
            extraRef.current.set(h.recordId, h.text || h.recordId);
            changed = true;
          }
        }
        if (changed) setExtraTick((t) => t + 1);
      }, 300);
    },
    [primaryFieldId]
  );

  const selectedIds = Array.isArray(value) ? value : [];
  const labelOf = (id: string) =>
    candidates.find((c) => c.recordId === id)?.label ||
    preselectedLabels.get(id) ||
    extraRef.current.get(id) ||
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

  // 候选去重合并：全量候选 + 服务端补搜候选
  const merged: Candidate[] = (() => {
    const map = new Map<string, Candidate>();
    candidates.forEach((c) => map.set(c.recordId, c));
    extraRef.current.forEach((label, recordId) => {
      if (!map.has(recordId)) map.set(recordId, { recordId, label });
    });
    // 已选值的标签也纳入，保证多选回显
    selectedIds.forEach((id) => {
      if (!map.has(id)) {
        const lbl = preselectedLabels.get(id);
        if (lbl) map.set(id, { recordId: id, label: lbl });
      }
    });
    return [...map.values()];
    // extraTick 用于触发重组（extraRef 是 ref，变更不触发渲染）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })();

  const done = progress?.done;
  const total = progress?.total;
  const loaded = progress?.loaded ?? 0;
  const loadingText = !progress
    ? '正在加载关联表记录…'
    : done
      ? total
        ? `已加载全部 ${loaded} 条记录`
        : `已加载 ${loaded} 条记录`
      : `正在加载…已 ${loaded}${total ? ` / ${total}` : ''} 条`;

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
        remote
        filter={fuzzyOptionFilter}
        onSearch={handleSearch}
        onDropdownVisibleChange={(v: boolean) => v && setOpened(true)}
        disabled={disabled}
        loading={!done && opened}
        placeholder={
          !opened
            ? '点击展开以加载关联记录（下拉时才加载）'
            : '搜索并选择关联记录'
        }
        value={selectedIds}
        onChange={(ids) => apply((ids as string[]) ?? [])}
        optionList={merged.map((c) => ({ value: c.recordId, label: c.label }))}
        emptyContent={
          !opened ? '点击展开后将加载关联记录' : done ? '无匹配记录' : '加载中…'
        }
        virtualize={{ itemSize: 32 }}
        outerBottomSlot={
          opened ? (
            <div style={{ padding: '6px 12px', fontSize: 12, color: '#86909c' }}>{loadingText}</div>
          ) : undefined
        }
      />
    </div>
  );
}