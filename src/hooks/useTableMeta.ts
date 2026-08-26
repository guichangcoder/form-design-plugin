import { useState, useEffect, useCallback } from 'react';
import { getTableMetaList } from '../services/baseService';

/** 加载当前多维表格的所有数据表元信息 */
export function useTableMeta() {
  const [tables, setTables] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTables(await getTableMetaList());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { tables, loading, reload };
}
