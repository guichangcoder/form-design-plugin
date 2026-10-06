/**
 * 启动时主动探测宿主环境 —— 不依赖 SDK 抛错，把所有可观察到的状态一次性打印到页面顶部。
 *
 * 设计目的：你每次测试都被困在 "console 找不到入口 / 不知道发生了什么"，
 * 这里我们把现场信息直接渲染到诊断条上，你截图发我即可。
 *
 * 探测项：
 *  1. URL 全参数（host / hash / searchParams）—— 飞书宿主把状态参数放在哪一目了然
 *  2. dashboard.state 三种获取方式（属性 / hash / query）—— 哪条路径生效
 *  3. bitable.base.getTableList() —— genDefaultConfig 用到的数据，验证 base 是否可达
 *  4. dashboard.getConfig() —— 是否真的能读回配置（验证 host SDK 双向联通）
 *  5. 当前 document.referrer + parent 同源探测 —— 确认是在飞书 iframe 里
 */

import { bitable, dashboard } from '@lark-base-open/js-sdk';

type ProbeResult = {
  url: string;
  hash: string;
  query: { isCreate: string | null; isConfig: string | null; isFullScreen: string | null };
  dashboardStateProp: unknown;
  dashboardStateFromQuery: boolean;
  dashboardStateFromHash: boolean;
  baseGetTableList: { ok: boolean; count: number | null; firstId: string | null; err: string | null };
  dashboardGetConfig: { ok: boolean; err: string | null; expectedBlocked: boolean; hasCustomConfig: boolean; ccLen: number };
  referrer: string;
  topSameOrigin: 'yes' | 'cross-origin' | 'n/a';
  iframeContext: 'in-feishu-host' | 'standalone' | 'cross-origin-host' | 'unknown';
};

const QUERY_KEYS = ['isCreate', 'isConfig', 'isFullScreen'] as const;

function readQueryState(): boolean {
  try {
    const q = new URL(window.location.href).searchParams;
    return q.get('isConfig') === '1' || q.get('isCreate') === '1';
  } catch {
    return false;
  }
}

function readHashState(): boolean {
  try {
    const h = window.location.hash || '';
    const i = h.indexOf('?');
    if (i < 0) return false;
    const q = new URLSearchParams(h.slice(i + 1));
    return q.get('isConfig') === '1' || q.get('isCreate') === '1' || q.get('isFullScreen') === '1';
  } catch {
    return false;
  }
}

export async function probeHost(): Promise<ProbeResult> {
  const url = (() => {
    try { return window.location.href; } catch { return ''; }
  })();
  const hash = (() => {
    try { return window.location.hash; } catch { return ''; }
  })();

  const queryParams = (() => {
    try {
      const q = new URL(window.location.href).searchParams;
      return {
        isCreate: q.get('isCreate'),
        isConfig: q.get('isConfig'),
        isFullScreen: q.get('isFullScreen'),
      };
    } catch {
      return { isCreate: null, isConfig: null, isFullScreen: null };
    }
  })();

  let dashboardStateProp: unknown = 'err';
  try { dashboardStateProp = (dashboard as any).state; } catch { /* keep 'err' */ }

  // base.getTableList —— genDefaultConfig 用的就是这个数据
  const tblRes = { ok: false, count: null as number | null, firstId: null as string | null, err: null as string | null };
  try {
    const list: any = await (bitable as any).base.getTableList();
    const arr = Array.isArray(list) ? list : [];
    tblRes.ok = true;
    tblRes.count = arr.length;
    tblRes.firstId = arr[0]?.id ?? arr[0]?.tableId ?? null;
  } catch (e) {
    tblRes.err = String((e as Error)?.message ?? e);
  }

  // dashboard.getConfig —— 验证 host SDK 双向联通
  // 注意：Create 态（首次添加插件时）飞书宿主**禁用此接口**，会抛
  //   'currently in creation status, unable to invoke this API'
  // 这是正常行为，不要标红"失败"。
  const cfgRes = {
    ok: false,
    err: null as string | null,
    expectedBlocked: false, // 标识"create 态合理禁用"，不是 bug
    hasCustomConfig: false,
    ccLen: 0,
  };
  try {
    const cfg: any = await (dashboard as any).getConfig();
    cfgRes.ok = true;
    const cc = cfg?.customConfig;
    cfgRes.hasCustomConfig = !!cc;
    cfgRes.ccLen = typeof cc === 'string' ? cc.length : 0;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    cfgRes.err = msg;
    // 飞书在 Create/Config 态禁用 getConfig 是设计如此
    if (/creation status|create|config/i.test(msg) || msg.includes('unable to invoke')) {
      cfgRes.expectedBlocked = true;
    }
  }

  const referrer = (() => {
    try { return document.referrer || '(空)'; } catch { return ''; }
  })();

  // parent / top 同源探测 —— 飞书仪表盘插件必定是嵌套在飞书域里的跨源 iframe
  const topSameOrigin = (() => {
    try {
      if (window.parent === window) return 'n/a';
      // 跨源的话访问 window.parent.location.origin 会抛 SecurityError
      try { return String(window.parent.location.origin) === window.location.origin ? 'yes' : 'cross-origin'; }
      catch { return 'cross-origin'; }
    } catch { return 'n/a'; }
  })();

  const iframeContext = (() => {
    const ref = referrer || '';
    if (/feishu\.cn|larksuite\.com|bytedance\.net|bytetos\.com/.test(ref)) return 'in-feishu-host';
    if (topSameOrigin === 'cross-origin') return 'cross-origin-host';
    if (topSameOrigin === 'n/a') return 'standalone';
    return 'unknown';
  })();

  return {
    url,
    hash,
    query: queryParams,
    dashboardStateProp,
    dashboardStateFromQuery: readQueryState(),
    dashboardStateFromHash: readHashState(),
    baseGetTableList: tblRes,
    dashboardGetConfig: cfgRes,
    referrer,
    topSameOrigin,
    iframeContext,
  };
}

/** 把 ProbeResult 压成单行字符串（诊断条默认折叠显示） */
export function probeOneLine(p: ProbeResult): string {
  const tbl = p.baseGetTableList.ok
    ? `${p.baseGetTableList.count}张表${p.baseGetTableList.firstId ? `(首ID: ...${String(p.baseGetTableList.firstId).slice(-6)})` : ''}`
    : `失败(${p.baseGetTableList.err ?? '未知'})`;
  const cfg = p.dashboardGetConfig.ok ? 'OK' : `失败(${p.dashboardGetConfig.err ?? '未知'})`;
  return `基表探测:${tbl} ｜ getConfig:${cfg} ｜ 上下文:${p.iframeContext}`;
}
