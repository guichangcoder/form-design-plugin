import { useState, useCallback } from 'react';
import { PluginData } from '../types';
import { loadConfig, saveConfig, clearConfig, SaveResult } from '../services/configService';

/** 多表单数据读写 hook：加载 / 保存 / 重置整个 PluginData（含多份独立表单） */
export function useForms() {
  const [data, setData] = useState<PluginData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await loadConfig();
      setData(d);
    } catch (e) {
      console.error('[useForms] 加载配置失败:', e);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(async (d: PluginData): Promise<SaveResult> => {
    const r = await saveConfig(d);
    setData(d);
    return r;
  }, []);

  const reset = useCallback(async () => {
    await clearConfig();
    setData(null);
  }, []);

  return { data, setData, loading, load, save, reset };
}
