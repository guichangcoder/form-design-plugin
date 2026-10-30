import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Tag, Space, Typography } from '@douyinfe/semi-ui';
import { getBase, getTableStrict} from '../../services/appContext';
import { getCachedUserIdSync, loadCurrentUserId } from '../../utils/currentUser';
import { buildNameMap, resolvePersonLabel } from '../../utils/personLabel';
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
  /**
   * 当前用户 open_id（state 而非仅 ref）：用于把「默认值＝当前用户」填进来的
   * 无名人员标签显示成「我（当前用户）」，否则用户只会看到一个含义不明的「当前用户」。
   */
  const [meId, setMeId] = useState(() => getCachedUserIdSync());

  // 1) 打开即取「当前用户」（走全表单共享缓存：若 FormRenderer 已解析过，
  //    首帧就拿到 meId，直接显示「我（当前用户）」，不会先闪一串截断 open_id）
  useEffect(() => {
    if (preview) return;
    let alive = true;
    (async () => {
      try {
        const id = await loadCurrentUserId();
        if (id && alive) {
          meRef.current = { id, name: undefined };
          setMeId(id);
        }
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
      // 只取最新的一页（200 行）即可覆盖团队常见人员：人员字段取值高度重复，
      // 首屏 1 次请求 ≈ 秒出；不再翻 5 页，避免「仅等加载就要等很久」。
      try {
        const table = await getTableStrict(tableId);
        const field: any = await table.getField(fieldId);
        const HEAD_ROWS = 200; // 与 SDK 单次上限一致，1 次请求
        const collect = (items: Array<{ value?: unknown }>) => {
          for (const item of items) {
            const v = item?.value;
            if (Array.isArray(v)) v.forEach((u) => push(u as BitableUser));
          }
        };
        if (typeof field.getFieldValueListByPage === 'function') {
          const res: any = await field.getFieldValueListByPage({ pageSize: HEAD_ROWS });
          collect((res?.fieldValues ?? []) as Array<{ value?: unknown }>);
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

  /** id → 姓名映射（只收真名；逻辑在 utils/personLabel.ts，可被测试真实调用） */
  const labelMap = useMemo(() => buildNameMap(value || [], candidates), [candidates, value]);

  /**
   * ★ 统一显示名（外层 Tag 与下拉框内已选值**共用**）。
   * 具体优先级与「绝不漏出裸 id」的成因见 utils/personLabel.ts（纯函数、有回归断言）。
   */
  const displayName = (id: string): string => resolvePersonLabel(id, labelMap, meId);

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
            {displayName(u.id)}
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
        optionList={candidates.map((c) => ({ value: c.id, label: displayName(c.id) }))}
        /**
         * ★ 下拉框内的已选值也必须走 displayName。否则 Semi 会回落到 optionList 的
         *   label ——「当前用户」候选的 label 是裸 open_id（SDK 无取姓名接口），
         *   于是出现「外层标签正常、框内是一串 ou_xxx」的割裂显示。
         *
         * ⚠️ Semi 多选契约：回调必须返回 `{ content, isRenderInTag }`，
         *    由 Semi 自己在外层包 Tag（含关闭按钮）。返回裸 ReactNode 会导致
         *    「Tag 套 Tag」+ 关闭按钮失效。
         */
        renderSelectedItem={(optionNode: Record<string, any>) => ({
          isRenderInTag: true,
          content: displayName(String(optionNode?.value ?? '')),
        })}
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
