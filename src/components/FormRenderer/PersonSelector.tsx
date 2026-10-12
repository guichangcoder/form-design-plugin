import React, { useEffect, useMemo, useState } from 'react';
import { Select, Tag, Space, Typography } from '@douyinfe/semi-ui';
import { getBase, getBridge } from '../../services/appContext';
import { fuzzyOptionFilter } from './fuzzyOptionFilter';

/** 飞书多维表格「人员」字段单元格结构（IOpenUser 子集，足够写入使用） */
export interface BitableUser {
  id: string;
  name?: string;
  enName?: string;
}

interface Props {
  value: BitableUser[];
  onChange: (v: BitableUser[]) => void;
  disabled?: boolean;
  /** 字段所在表 ID（用于读取该字段已有人员作为候选） */
  tableId: string;
  fieldId: string;
}

interface Candidate extends BitableUser {
  _label: string;
}

/**
 * 人员字段选择器。
 *
 * 飞书 base 应用插件运行在 iframe 内，没有通讯录 OpenAPI（需后端 token），
 * 因此无法枚举全公司人员。务实做法：
 *   1) 从「本字段已有记录」中收集去重后的人员作为候选（团队型表格里人员会反复出现）；
 *   2) 始终提供「当前用户」选项（getUserId）。
 * 写入时按 IOpenUser 结构传 { id, name? }，由飞书解析展示名。
 */
export function PersonSelector({ value, onChange, disabled, tableId, fieldId }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list: Candidate[] = [];
      const seen = new Set<string>();
      const push = (u: BitableUser) => {
        if (u && u.id && !seen.has(u.id)) {
          seen.add(u.id);
          list.push({ ...u, _label: u.name || u.enName || u.id });
        }
      };

      // 1) 读取本字段历史人员（去重）
      try {
        const table = await getBase().getTableById(tableId);
        const field = await table.getField(fieldId);
        const values = await field.getFieldValueList();
        for (const item of values as Array<{ value?: unknown }>) {
          const v = item?.value;
          if (Array.isArray(v)) v.forEach((u) => push(u as BitableUser));
        }
      } catch {
        /* 读取历史人员失败不影响选择器可用 */
      }

      // 2) 始终提供「当前用户」（不预置 name，让飞书按 open_id 解析真实名称）
      try {
        const meId = await getBridge().getUserId();
        if (meId && !seen.has(meId)) {
          seen.add(meId);
          list.unshift({ id: meId, name: undefined, _label: '当前用户' });
        }
      } catch {
        /* ignore */
      }

      if (alive) {
        setCandidates(list);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tableId, fieldId]);

  const labelMap = useMemo(() => {
    const map = new Map<string, string>();
    // value 里的旧 name（如历史“我（当前用户）”）先写入
    (value || []).forEach((u) => {
      if (u && u.id) map.set(u.id, u.name || u.enName || '当前用户');
    });
    // 候选中的最新/真实名称覆盖旧 name
    candidates.forEach((c) => map.set(c.id, c._label));
    return map;
  }, [candidates, value]);

  const selectedIds = (value || []).map((u) => u.id);

  const apply = (ids: string[]) => {
    const pool = new Map<string, BitableUser>();
    // 优先用候选中的信息（当前用户候选无 name，避免写入“我（当前用户）”）
    candidates.forEach((u) => {
      if (u && u.id) pool.set(u.id, { id: u.id, name: u.name, enName: u.enName });
    });
    // value 兜底保留非候选人员（如被删字段中的历史人员）
    (value || []).forEach((u) => {
      if (u && u.id && !pool.has(u.id)) pool.set(u.id, { id: u.id, name: u.name, enName: u.enName });
    });
    onChange(ids.map((id) => pool.get(id)).filter(Boolean) as BitableUser[]);
  };

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        {(value || []).map((u) => (
          <Tag
            key={u.id}
            type="light"
            closable={!disabled}
            onClose={() => apply(selectedIds.filter((id) => id !== u.id))}
          >
            {labelMap.get(u.id) || u.id}
          </Tag>
        ))}
        {(!value || value.length === 0) && (
          <Typography.Text type="tertiary">尚未选择人员</Typography.Text>
        )}
      </Space>
      <Select
        style={{ width: '100%' }}
        multiple
        filter={fuzzyOptionFilter}
        disabled={disabled}
        loading={loading}
        placeholder={loading ? '正在加载人员列表…' : '搜索并选择人员'}
        value={selectedIds}
        onChange={(ids) => apply((ids as string[]) ?? [])}
        optionList={candidates.map((c) => ({ value: c.id, label: c._label }))}
        emptyContent={loading ? '加载中…' : '暂无可选人员（填写后历史人员会自动出现）'}
      />
    </div>
  );
}
