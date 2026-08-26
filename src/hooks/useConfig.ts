import { useState, useCallback } from 'react';
import { FormPluginConfig } from '../types';
import { loadConfig, saveConfig, clearConfig, SaveResult } from '../services/configService';

/** 配置读写 hook：加载、保存、重置插件配置 */
export function useConfig() {
  const [config, setConfig] = useState<FormPluginConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await loadConfig();
      setConfig(c);
    } catch (e) {
      // 任何环境下的加载失败都不能变成 unhandled rejection（浏览器无宿主时会崩）
      console.error('[useConfig] 加载配置失败:', e);
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(async (c: FormPluginConfig): Promise<SaveResult> => {
    const r = await saveConfig(c);
    setConfig(c);
    return r;
  }, []);

  const reset = useCallback(async () => {
    await clearConfig();
    setConfig(null);
  }, []);

  return { config, setConfig, loading, load, save, reset };
}
