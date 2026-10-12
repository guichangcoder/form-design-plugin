import { useState, useEffect, useCallback } from 'react';
import { getTableMetaList } from '../services/baseService';
import { onAppChange } from '../services/appContext';

/** 加载当前多维表格的所有数据表元信息（应用模式切换 base 后自动重载） */
export function useTableMeta() {
  const [tables, setTables] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTables(await getTableMetaList());
    } catch (e) {
      console.warn('[useTableMeta] 加载表列表失败:', e);
      setTables([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 应用模式：Workspace 切换 base 后，表列表必须从新 base 重拉
  useEffect(() => onAppChange(() => reload()), [reload]);

  return { tables, loading, reload };
}
