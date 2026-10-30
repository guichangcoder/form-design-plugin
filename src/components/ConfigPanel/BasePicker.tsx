/**
 * 应用模式数据源选择器（飞书官方诊断 P0-1 修复）。
 * 用 Workspace.getBaseList() 实现可搜索、分页的多维表格选择；
 * 选中后通过 Workspace.getBitable(baseToken) 绑定该 base 的全部实例。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Select, Typography } from '@douyinfe/semi-ui';
import { listBases, selectBase, canListBases } from '../../services/appContext';
import type { IBaseInfo } from '../../services/appContext';
import { toast } from '../../utils/toast';

interface Props {
  /** 当前已选 baseToken（配置回填） */
  value?: string;
  /** 选择成功回调（baseToken, baseName） */
  onChange: (baseToken: string, baseName: string) => void;
}

export function BasePicker({ value, onChange }: Props) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string>('');
  const keywordRef = useRef('');
  const [selectedName, setSelectedName] = useState('');

  const fetchList = useCallback(async (query: string, append: boolean) => {
    if (!canListBases()) return;
    setLoading(true);
    try {
      const res = await listBases(query || undefined, append ? cursorRef.current || undefined : undefined);
      const items: IBaseInfo[] = res?.base_list ?? [];
      cursorRef.current = res?.page?.cursor ?? '';
      setHasMore(!!res?.page?.hasMore);
      const opts = items.map((b) => ({ value: b.token, label: b.name || b.token }));
      setOptions((prev) => {
        const merged = append ? [...prev] : [];
        // 去重合并
        const seen = new Set(merged.map((o) => o.value));
        for (const o of opts) {
          if (!seen.has(o.value)) merged.push(o);
        }
        return merged;
      });
    } catch (e) {
      console.warn('[BasePicker] getBaseList 失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 初次加载
  useEffect(() => {
    fetchList('', false);
  }, [fetchList]);

  // 配置回填：已有 value 但选项里还没有对应 label 时，先占位显示 token
  useEffect(() => {
    if (value && !options.some((o) => o.value === value)) {
      setOptions((prev) => [{ value, label: selectedName || `已选多维表格（...${value.slice(-6)}）` }, ...prev]);
    }
  }, [value, options, selectedName]);

  const handleSearch = (kw: string) => {
    keywordRef.current = kw;
    cursorRef.current = '';
    fetchList(kw, false);
  };

  const handleScrollToBottom = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    if (nearBottom && hasMore && !loading) fetchList(keywordRef.current, true);
  };

  const handleChange = async (v: any) => {
    const token = String(v ?? '');
    if (!token || token === value) return;
    const name = options.find((o) => o.value === token)?.label ?? '';
    setLoading(true);
    const ok = await selectBase(token, name);
    setLoading(false);
    if (!ok) {
      toast('无法访问该多维表格（可能没有权限），请换一个', 'error');
      return;
    }
    setSelectedName(name);
    onChange(token, name);
  };

  if (!canListBases()) {
    return (
      <Typography.Text type="warning" style={{ fontSize: 12 }}>
        当前环境不支持 Workspace（非应用模式点位），将使用默认多维表格
      </Typography.Text>
    );
  }

  return (
    <Select
      style={{ width: '100%' }}
      placeholder="选择数据源多维表格（可搜索）"
      value={value || undefined}
      optionList={options}
      loading={loading}
      filter
      searchPlaceholder="输入名称搜索多维表格"
      onSearch={handleSearch}
      onChange={handleChange}
      onListScroll={handleScrollToBottom}
      remote
      emptyContent={loading ? '加载中…' : '没有可选的多维表格'}
    />
  );
}
