import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  /** 配置态预览：完全不加载数据 */
  preview?: boolean;
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
export function PersonSelector({ value, onChange, disabled, tableId, fieldId, preview }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(false);
  const meRef = useRef<BitableUser | null>(null);

  // 1) 打开即取「当前用户」（一次极轻调用，保证不开下拉也能选到自己）
  useEffect(() => {
    if (preview) return;
    let alive = true;
    (async () => {
      try {
        const meId = await getBridge().getUserId();
        if (meId && alive) meRef.current = { id: meId, name: undefined };
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [preview]);

  // 2) ★ 懒加载：下拉展开时才读「本字段历史人员」（去重候选），避免打开表单就拉整列。
  useEffect(() => {
    if (preview || !opened) return;
    let alive = true;
    setLoading(true);
    (async () => {
      const list: Candidate[] = [];
      const seen = new Set<string>();
      const push = (u: BitableUser) => {
        if (u && u.id && !seen.has(u.id)) {
          seen.add(u.id);
          list.push({ ...u, _label: u.name || u.enName || u.id });
        }
      };

      // 读取本字段历史人员（去重）。
      // 优先分页取前列数据（候选人员是去重后的，前 1000 行足够覆盖团队），
      // 避免在几万行的大表上用 getFieldValueList 整列拉取导致打开表单卡顿。
      try {
        const table = await getBase().getTableById(tableId);
        const field: any = await table.getField(fieldId);
        const PAGE_SIZE = 200; // SDK 单次上限
        const MAX_PAGES = 5; // 最多取前 1000 行
        const collect = (items: Array<{ value?: unknown }>) => {
          for (const item of items) {
            const v = item?.value;
            if (Array.isArray(v)) v.forEach((u) => push(u as BitableUser));
          }
        };
        if (typeof field.getFieldValueListByPage === 'function') {
          let pageToken: number | undefined;
          let pages = 0;
          do {
            const res: any = await field.getFieldValueListByPage({
              pageSize: PAGE_SIZE,
              ...(pageToken !== undefined ? { pageToken } : {}),
            });
            collect((res?.fieldValues ?? []) as Array<{ value?: unknown }>);
            pages += 1;
            pageToken = res?.hasMore && pages < MAX_PAGES ? res?.pageToken : undefined;
          } while (pageToken);
        } else {
          // 旧宿主无分页接口：回退整列取值
          collect((await field.getFieldValueList()) as Array<{ value?: unknown }>);
        }
      } catch {
        /* 读取历史人员失败不影响选择器可用 */
      }

      // 2) 始终提供「当前用户」（不预置 name，让飞书按 open_id 解析真实名称）
      if (meRef.current) push(meRef.current);

      if (alive) {
        setCandidates(list);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tableId, fieldId, opened, preview]);

  /** 下拉展开时才加载（懒加载入口）；同时保证「当前用户」始终在候选里 */
  const ensureOpened = () => {
    if (opened) return;
    setOpened(true);
    if (meRef.current && !candidates.some((c) => c.id === meRef.current!.id)) {
      setCandidates((list) => [
        { id: meRef.current!.id, name: undefined, _label: '当前用户' },
        ...list,
      ]);
    }
  };

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
        onDropdownVisibleChange={(v: boolean) => v && ensureOpened()}
        placeholder={opened ? '搜索并选择人员' : '点击展开以加载人员列表（下拉时才加载）'}
        value={selectedIds}
        onChange={(ids) => apply((ids as string[]) ?? [])}
        optionList={candidates.map((c) => ({ value: c.id, label: c._label }))}
        emptyContent={
          loading
            ? '加载中…'
            : opened
              ? '暂无可选人员（填写后历史人员会自动出现）'
              : '点击展开后将加载人员（含「当前用户」）'
        }
      />
    </div>
  );
}
