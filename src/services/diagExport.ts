/**
 * 一键导出"现场诊断包"为 JSON 下载。
 * 解决用户高频痛点：
 *   1. 不知道看哪个 console —— 用户看的是飞书顶层 web，不是插件 iframe
 *   2. 截图不完整 —— console 自动折叠隐藏细节（飞书 3905 行）
 *   3. 反馈慢 —— 一次导出，可直接 attach 发回定位
 *
 * 用法：在 App.tsx 工具栏放一个 "📥 导出诊断包" 按钮
 */

import { dashboard } from '@lark-base-open/js-sdk';

interface DiagSnapshot {
  generatedAt: string;
  // 1. URL + 路由上下文
  url: {
    href: string;
    origin: string;
    pathname: string;
    hash: string;
    search: string;
    searchParams: Record<string, string>;
    hashParams: Record<string, string>;
  };
  // 2. 宿主状态
  dashboard: {
    stateProp: unknown;
    stateFromHash: string | null;
    stateFromQuery: string | null;
    inIframe: boolean;
    parentOrigin: string | null;
    hasSaveConfigFn: boolean;
    hasGetConfigFn: boolean;
    hasSetRenderedFn: boolean;
  };
  // 3. 已保存配置（关键：能看清楚 runtime 拿到什么）
  config: {
    getConfigOk: boolean;
    getConfigError: string | null;
    dataConditions: unknown;
    customConfigType: string;
    customConfigJsonLength: number;
    customConfigPreview: string;
    formsCount: number;
    firstFormMainTableId: string | null;
    firstFormFieldsCount: number;
  };
  // 最近一次保存的 payload 与宿主读回结果（dev 模式修复的关键证据）
  saveRecords: {
    lastSave: unknown;
    lastReadback: unknown;
  };
  // 4. 宿主探测（base 可达性）
  probe: {
    baseGetTableListOk: boolean;
    baseTableCount: number;
    baseFirstTableId: string | null;
    baseError: string | null;
  };
  // 5. 浏览器诊断
  env: {
    userAgent: string;
    cookieEnabled: boolean;
    iframeDepth: number;
    hasReactDevtools: boolean;
  };
  // 6. 自定义追加信息（可由调用方传入 saveDiag、probeHost 结果）
  extras: Record<string, unknown>;
}

function parseUrlParams(url: string, source: 'search' | 'hash'): Record<string, string> {
  try {
    const u = new URL(url);
    const raw =
      source === 'search'
        ? u.search
        : u.hash.includes('?')
        ? u.hash.slice(u.hash.indexOf('?'))
        : '';
    const obj: Record<string, string> = {};
    new URLSearchParams(raw).forEach((v, k) => {
      obj[k] = v;
    });
    return obj;
  } catch {
    return {};
  }
}

function getIframeDepth(): number {
  let d = 0;
  let w: Window | null = window;
  try {
    while (w && w.parent && w.parent !== w) {
      d += 1;
      w = w.parent;
      if (d > 10) break;
    }
  } catch (_e) {
    /* 跨域时访问 parent 抛错，停止 */
  }
  return d;
}

export async function collectDiagnostic(
  extras: Record<string, unknown> = {}
): Promise<DiagSnapshot> {
  // URL
  const href = location.href;
  const url: DiagSnapshot['url'] = {
    href,
    origin: location.origin,
    pathname: location.pathname,
    hash: location.hash,
    search: location.search,
    searchParams: parseUrlParams(href, 'search'),
    hashParams: parseUrlParams(href, 'hash'),
  };

  // dashboard
  let stateProp: unknown = null;
  try {
    stateProp = (dashboard as any).state;
  } catch {
    /* ignore */
  }
  const dash: DiagSnapshot['dashboard'] = {
    stateProp,
    stateFromHash: parseUrlParams(href, 'hash').isConfig === '1' ? 'Config (from hash)' : null,
    stateFromQuery:
      parseUrlParams(href, 'search').isConfig === '1' ? 'Config (from query)' : null,
    inIframe: window.parent !== window,
    parentOrigin: (() => {
      try {
        return window.parent.location.origin;
      } catch {
        return '(cross-origin)';
      }
    })(),
    hasSaveConfigFn: typeof (dashboard as any)?.saveConfig === 'function',
    hasGetConfigFn: typeof (dashboard as any)?.getConfig === 'function',
    hasSetRenderedFn: typeof (dashboard as any)?.setRendered === 'function',
  };

  // config
  const cfg: DiagSnapshot['config'] = {
    getConfigOk: false,
    getConfigError: null,
    dataConditions: null,
    customConfigType: 'null',
    customConfigJsonLength: 0,
    customConfigPreview: '',
    formsCount: 0,
    firstFormMainTableId: null,
    firstFormFieldsCount: 0,
  };
  try {
    const r: any = await (dashboard as any).getConfig();
    cfg.dataConditions = r?.dataConditions ?? null;
    cfg.getConfigOk = true;
    const cc = r?.customConfig;
    if (cc != null) {
      try {
        const json = typeof cc === 'string' ? cc : JSON.stringify(cc);
        cfg.customConfigType = typeof cc;
        cfg.customConfigJsonLength = json.length;
        cfg.customConfigPreview = json.slice(0, 2048);
        if (Array.isArray((cc as any)?.forms)) {
          cfg.formsCount = (cc as any).forms.length;
          const f0 = (cc as any).forms[0];
          if (f0?.mainTable?.tableId) cfg.firstFormMainTableId = String(f0.mainTable.tableId);
          if (Array.isArray(f0?.mainTable?.fields)) {
            cfg.firstFormFieldsCount = f0.mainTable.fields.length;
          }
        }
      } catch (e) {
        cfg.customConfigPreview = `<serialize error: ${String(e)}>`;
      }
    }
  } catch (e) {
    cfg.getConfigError = String((e as Error)?.message ?? e);
  }

  const readStorageJson = (key: string): unknown => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (value?.customConfig) {
        value.customConfigPreview = JSON.stringify(value.customConfig).slice(0, 2048);
        value.customConfigJsonLength = JSON.stringify(value.customConfig).length;
        delete value.customConfig;
      }
      return value;
    } catch (e) {
      return { parseError: String(e) };
    }
  };
  const saveRecords: DiagSnapshot['saveRecords'] = {
    lastSave: readStorageJson('__plugin_last_save_payload__'),
    lastReadback: readStorageJson('__plugin_last_save_readback__'),
  };

  // probe (base)
  const probe: DiagSnapshot['probe'] = {
    baseGetTableListOk: false,
    baseTableCount: 0,
    baseFirstTableId: null,
    baseError: null,
  };
  try {
    const mod = await import('@lark-base-open/js-sdk');
    const list: any = await (mod as any).bitable.base.getTableList();
    probe.baseGetTableListOk = true;
    probe.baseTableCount = Array.isArray(list) ? list.length : 0;
    if (Array.isArray(list) && list[0]) {
      probe.baseFirstTableId = list[0]?.id ?? list[0]?.tableId ?? null;
    }
  } catch (e) {
    probe.baseError = String((e as Error)?.message ?? e);
  }

  // env
  const env: DiagSnapshot['env'] = {
    userAgent: navigator.userAgent,
    cookieEnabled: navigator.cookieEnabled,
    iframeDepth: getIframeDepth(),
    hasReactDevtools: !!(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__,
  };

  return {
    generatedAt: new Date().toISOString(),
    url,
    dashboard: dash,
    config: cfg,
    saveRecords,
    probe,
    env,
    extras,
  };
}

/** 触发浏览器下载 JSON 文件 */
export function downloadDiagnosticJSON(snapshot: DiagSnapshot, filename = 'plugin-diag.json') {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      document.body.removeChild(a);
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(url);
  }, 100);
}

/** 一体化按钮：收集 → 下载 */
export async function exportDiagnosticBundle(
  extras: Record<string, unknown> = {}
): Promise<DiagSnapshot> {
  const snap = await collectDiagnostic(extras);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadDiagnosticJSON(snap, `plugin-diag-${stamp}.json`);
  return snap;
}
