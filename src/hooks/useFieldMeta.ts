import { useState, useEffect } from 'react';
import { getFieldMetaList, FieldMetaLite } from '../services/baseService';

/** 给定表 ID，加载其可录入字段元信息（含单选/多选项） */
export function useFieldMeta(tableId: string | undefined) {
  const [fields, setFields] = useState<FieldMetaLite[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tableId) {
      setFields([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getFieldMetaList(tableId)
      .then((f) => {
        if (!cancelled) setFields(f);
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tableId]);

  return { fields, loading };
}
