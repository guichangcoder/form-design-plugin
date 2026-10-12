/**
 * 应用模式数据源上下文（飞书官方诊断 P0-1 修复）。
 *
 * 官方规范：应用插件与多维表格是一对多关系，Workspace 是所有 JSSDK 接口的
 * 唯一入口；dashboard / base / ui / bridge 四个实例都与「指定多维表格」绑定，
 * 必须通过 `workspace.getBitable(baseToken)` 获取，不能混用全局默认实例
 * （全局 bitable/dashboard 绑定的是宿主默认 base，与用户选择的数据源可能不一致）。
 *
 * 本模块持有「当前选中的 base」的 IBitableApp 实例，业务代码统一从这里取
 * base/bridge/dashboard，而不是直接 import 全局 bitable。
 *
 * 兼容策略：
 * - 仪表盘/应用模式宿主：用户显式选择 base 后，全部读写都走该实例。
 * - 旧配置（无 baseToken）与侧边栏 bridge 模式：回退到全局 bitable（原行为）。
 */
import { workspace, bitable, dashboard } from '@lark-base-open/js-sdk';
import type { IBaseInfo, IBaseListResult } from '@lark-base-open/js-sdk';

/** IBitableApp 未从包根导出，这里按 Workspace.getBitable 的返回形态自定义 */
export interface BitableAppInstance {
  base: typeof bitable.base;
  bridge: typeof bitable.bridge;
  ui: typeof bitable.ui;
  dashboard: typeof dashboard;
  util?: unknown;
}

let currentApp: BitableAppInstance | null = null;
let currentBaseToken = '';
let currentBaseName = '';

/** base 切换订阅（useTableMeta 等需要在切换后重新拉表列表） */
const listeners = new Set<() => void>();
export function onAppChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emitAppChange() {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  });
}

/** Workspace 模块是否可用（仅应用插件/仪表盘插件点位可用） */
export function isWorkspaceAvailable(): boolean {
  try {
    const w = workspace as any;
    return !!w && typeof w.getBaseList === 'function' && typeof w.getBitable === 'function';
  } catch {
    return false;
  }
}

/**
 * 拉取可选多维表格列表（支持搜索与分页）。
 * 对应官方要求：配置态先用 Workspace.getBaseList() 做可搜索、分页的 Base 选择器。
 */
export async function listBases(query?: string, cursor?: string): Promise<IBaseListResult> {
  if (!isWorkspaceAvailable()) {
    return { base_list: [], page: { cursor: '', hasMore: false } };
  }
  const params: { query?: string; page?: { cursor?: string } } = {};
  if (query) params.query = query;
  if (cursor) params.page = { cursor };
  return await (workspace as any).getBaseList(params);
}

/**
 * 选中一个多维表格：通过 Workspace 获取该 base 的完整实例并设为当前上下文。
 * 失败时返回 false 并保持原上下文不变。
 */
export async function selectBase(baseToken: string, baseName?: string): Promise<boolean> {
  if (!baseToken) return false;
  try {
    const app = await (workspace as any).getBitable(baseToken);
    if (!app || !app.base) return false;
    currentApp = app as BitableAppInstance;
    currentBaseToken = baseToken;
    currentBaseName = baseName ?? currentBaseName;
    emitAppChange();
    return true;
  } catch (e) {
    console.warn('[appContext] getBitable 失败:', e);
    return false;
  }
}

/** 当前 baseToken（未选择时为空串） */
export function getBaseToken(): string {
  return currentBaseToken;
}

export function getBaseName(): string {
  return currentBaseName;
}

export function hasSelectedBase(): boolean {
  return !!currentApp;
}

/**
 * 当前 base 实例。已选 base 用 Workspace 实例；否则回退全局 bitable.base
 * （侧边栏模式 / 旧配置 / dev 本地）。
 */
export function getBase(): typeof bitable.base {
  return (currentApp?.base ?? bitable.base) as typeof bitable.base;
}

/** 当前 bridge 实例（配置备份等）。 */
export function getBridge(): typeof bitable.bridge {
  return (currentApp?.bridge ?? bitable.bridge) as typeof bitable.bridge;
}

/** 当前 ui 实例（toast 等）。 */
export function getUi(): typeof bitable.ui {
  return (currentApp?.ui ?? bitable.ui) as typeof bitable.ui;
}

/**
 * 当前 dashboard 实例（saveConfig/getConfig）。
 * 已选 base 时用该 base 的 dashboard（官方：四实例都从 Workspace 取）；
 * 未选 base（如 View 态初次读取配置以发现 baseToken）用全局 dashboard。
 */
export function getDashboard(): typeof dashboard {
  return (currentApp?.dashboard ?? dashboard) as typeof dashboard;
}

/** 仅供内存回归测试：直接注入 mock base 实例（生产代码不要调用） */
export function __setAppForTest(app: Partial<BitableAppInstance> | null): void {
  currentApp = (app as BitableAppInstance) ?? null;
  currentBaseToken = app ? 'test-base-token' : '';
}

/** 仅供诊断：当前上下文来源 */
export function diagnoseAppContext(): Record<string, unknown> {
  return {
    workspaceAvailable: isWorkspaceAvailable(),
    hasSelectedBase: hasSelectedBase(),
    baseToken: currentBaseToken ? `...${currentBaseToken.slice(-6)}` : '',
    baseName: currentBaseName,
  };
}

export type { IBaseInfo };
