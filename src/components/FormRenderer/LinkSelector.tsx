import React, { useEffect, useState } from 'react';
import { Select, Tag, Space, Typography } from '@douyinfe/semi-ui';
import { getBase } from '../../services/appContext';
import { getLinkTargetTableId } from '../../services/baseService';
import { fuzzyOptionFilter } from './fuzzyOptionFilter';
import { stringifyCellValue } from '../../utils/cellText';

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
}

interface Candidate {
  recordId: string;
  label: string;
}

/** 一次选择器最多加载的记录条数（分页拉取，防止超大表把面板拖垮） */
const MAX_RECORDS = 2000;
const PAGE_SIZE = 200; // SDK 单次上限就是 200，传更大值非法

/**
 * 关联字段（单向/双向）选择器：
 * 加载「关联目标表」的记录，以其主字段内容作为选项标签，
 * 选中后表单态保存 recordId 数组，提交时由 valueConverter 包裹为 IOpenLink 写入。
 */
export function LinkSelector({ value, onChange, disabled, tableId, fieldId, linkTableId }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        // 1) 解析关联目标表：优先配置里的 linkTableId，缺失时从字段元信息反查
        const targetTableId =
          linkTableId || (await getLinkTargetTableId(tableId, fieldId)) || '';
        if (!targetTableId) {
          if (alive) setError('未找到关联目标表，请重新保存配置');
          return;
        }

        const table = await getBase().getTableById(targetTableId);

        // 2) 找主字段（isPrimary），作为选项标签来源
        const metas = await table.getFieldMetaList();
        const primary =
          metas.find((m) => (m as { isPrimary?: boolean }).isPrimary) ?? metas[0];
        const primaryFieldId = primary?.id;

        // 3) 分页拉取记录（上限 MAX_RECORDS）
        const list: Candidate[] = [];
        let pageToken: string | undefined;
        do {
          const res = await table.getRecords({
            pageSize: PAGE_SIZE,
            ...(pageToken ? { pageToken: pageToken as any } : {}),
          });
          for (const rec of res.records ?? []) {
            const raw = primaryFieldId
              ? (rec.fields as Record<string, unknown>)[primaryFieldId]
              : undefined;
            const label = stringifyCellValue(raw) || rec.recordId;
            list.push({ recordId: rec.recordId, label });
            if (list.length >= MAX_RECORDS) break;
          }
          pageToken = res.hasMore ? (res.pageToken as string | undefined) : undefined;
        } while (pageToken && list.length < MAX_RECORDS);

        if (alive) setCandidates(list);
      } catch (e) {
        if (alive) setError(`加载关联表记录失败：${(e as Error)?.message ?? String(e)}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tableId, fieldId, linkTableId]);

  const selectedIds = Array.isArray(value) ? value : [];
  const labelOf = (id: string) =>
    candidates.find((c) => c.recordId === id)?.label || id;

  const apply = (ids: string[]) => onChange(ids);

  if (error) {
    return <Typography.Text type="warning">{error}</Typography.Text>;
  }

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
        filter={fuzzyOptionFilter}
        disabled={disabled}
        loading={loading}
        placeholder={loading ? '正在加载关联表记录…' : '搜索并选择关联记录'}
        value={selectedIds}
        onChange={(ids) => apply((ids as string[]) ?? [])}
        optionList={candidates.map((c) => ({ value: c.recordId, label: c.label }))}
        emptyContent={loading ? '加载中…' : '关联表暂无可选记录'}
      />
    </div>
  );
}
