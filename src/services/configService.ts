import { bitable } from '@lark-base-open/js-sdk';
import { CONFIG_STORAGE_KEY, FormPluginConfig } from '../types';

/** 配置形态校验：必须有 mainTable 对象、subTables/conditionalRules 数组 */
function isValidConfig(d: unknown): d is FormPluginConfig {
  if (!d || typeof d !== 'object') return false;
  const c = d as Record<string, unknown>;
  return (
    !!c.mainTable &&
    typeof c.mainTable === 'object' &&
    Array.isArray(c.subTables) &&
    Array.isArray(c.conditionalRules)
  );
}

/** localStorage 是否可用（部分 webview 沙箱可能禁用） */
function lsAvailable(): boolean {
  try {
    localStorage.setItem('__cfg_probe__', '1');
    localStorage.removeItem('__cfg_probe__');
    return true;
  } catch {
    return false;
  }
}
const LS_OK = lsAvailable();

/** 保存结果：标识实际写入位置（用于 UI 提示） */
export interface SaveResult {
  storage: 'bridge' | 'local';
  warning?: string;
}

/**
 * 读取插件配置
 * - 优先 `bitable.bridge.getData`（正式发布后可用）
 * - 失败/无数据时回退到 localStorage（dev 模式 localhost URL 加载时，bridge.setData 不可用，
 *   我们用 localStorage 兜底，保证开发期能正常保存和恢复）
 */
export async function loadConfig(): Promise<FormPluginConfig | null> {
  // 1) 尝试 bridge
  try {
    let data: unknown = await bitable.bridge.getData(CONFIG_STORAGE_KEY);
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = undefined;
      }
    }
    if (data && isValidConfig(data)) return data;
  } catch (e) {
    console.warn('[config] bridge.getData 失败，将回退到本地存储:', e);
  }

  // 2) 回退到 localStorage
  if (LS_OK) {
    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (isValidConfig(d)) return d;
      }
    } catch (e) {
      console.warn('[config] localStorage 读取失败:', e);
    }
  }
  return null;
}

/**
 * 保存插件配置
 * - 优先 `bitable.bridge.setData`
 * - 失败时回退到 localStorage（dev 模式 block entity 不可用时）
 */
export async function saveConfig(config: FormPluginConfig): Promise<SaveResult> {
  // 1) 尝试 bridge
  try {
    await bitable.bridge.setData(CONFIG_STORAGE_KEY, config);
    return { storage: 'bridge' };
  } catch (e) {
    console.warn('[config] bridge.setData 失败，回退到本地存储:', e);
  }
  // 2) 回退到 localStorage
  if (LS_OK) {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
      return {
        storage: 'local',
        warning: '开发模式：bridge.setData 不可用，已保存到本地存储（iframe localStorage）。正式发布后会自动使用云端存储。',
      };
    } catch (e) {
      console.error('[config] localStorage 写入失败:', e);
      throw new Error(
        `保存失败：bridge 与本地存储均不可用 (${(e as Error)?.message ?? String(e)})`
      );
    }
  }
  throw new Error('保存失败：bridge 不可用且当前环境不支持 localStorage');
}

/** 清空配置（bridge + localStorage 都清） */
export async function clearConfig(): Promise<void> {
  try {
    await bitable.bridge.setData(CONFIG_STORAGE_KEY, null);
  } catch {
    /* ignore */
  }
  if (LS_OK) {
    try {
      localStorage.removeItem(CONFIG_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
