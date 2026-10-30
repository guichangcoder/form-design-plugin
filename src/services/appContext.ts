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
import { waitReady, decideBaseBinding } from '../utils/baseReady';

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
/**
 * 「配置声明过、但本次没绑上」的 baseToken。
 *
 * 🔴 为什么必须单独记：若不记，绑定失败时 `currentBaseToken` 仍是空串，
 * `getBaseStrict()` 会把「声明了但绑失败」误判成「从未声明数据源」，
 * 然后心安理得地回退全局 base —— 等于这次修复白做（这正是前几轮失败的形态）。
 */
let declaredBaseToken = '';

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

/**
 * Workspace 模块是否可用（仅应用插件/仪表盘插件点位可用）。
 *
 * ⚠️ 判据只用 `getBitable`：它才是绑定 base 的入口。
 * 早先还要求 `getBaseList` 存在，但那是**配置态选表**才需要的接口，
 * 展示态（View）只需 `getBitable` —— 用 getBaseList 当门槛会把展示态误判成
 * 「Workspace 不可用」从而跳过绑定、静默使用错误的 base（2026-10-30 实证）。
 */
export function isWorkspaceAvailable(): boolean {
  try {
    const w = workspace as any;
    return !!w && typeof w.getBitable === 'function';
  } catch {
    return false;
  }
}

/** 是否支持配置态的 base 选择器（getBaseList 存在） */
export function canListBases(): boolean {
  try {
    const w = workspace as any;
    return !!w && typeof w.getBaseList === 'function';
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
 *
 * 🔴🔴 2026-10-30 第五轮真根因（SDK 源码实证）：
 *
 * SDK 内部实现是：
 * ```js
 * getBitable(baseToken) {
 *   if (!cache.has(baseToken)) {
 *     if (!(await this.getBitableReady(baseToken))) return null;  // ← 关键
 *     cache.set(baseToken, this.genBitable(baseToken));
 *   }
 *   return cache.get(baseToken);
 * }
 * ```
 * 也就是说 `getBitable` **不等待**宿主把该 base 的数据拉完：
 * `getBitableReady` 为 false 时它**立刻返回 null**，不会等待、也不会重试。
 *
 * 而页面刷新后，宿主需要时间重新拉取数据源（`dataConditions` 声明的表）。
 * 我们原来只在 `loadConfig` 里调一次 `selectBase`：
 *   - 配置态保存那一刻数据还在缓存里 → 成功 → **「第一次配置完正常」**；
 *   - 刷新后立刻调用 → 还没 ready → 拿到 null → `ensureBaseBound` 返回 false
 *     → `getBase()` 静默回退到**宿主默认 base**
 *     → 拿默认 base 去查配置里的源表 tableId → **必然查不到**
 *     → 宿主返回一句被降级、无 message 的低层错误
 *     → **`getRecordsByPage error, msg: undefined code: 12`**（正是用户看到的报错）。
 *
 * 这同时解释了「配置态永远无法复现」「改 dataConditions 结构毫无效果」
 * 「换任何读表接口都一样失败」——因为问题根本不在读表，而在**从一开始就绑错了 base**。
 *
 * 修法：把「等就绪」这件事做实 —— 先轮询 `getBitableReady`，再取实例；
 * 仍然失败才有界重试几次。绝不因为一次「还没好」就永久降级到错误的 base。
 */

/** 等待 base 就绪的总预算（毫秒）。宿主刷新后拉数据通常在 1~3s 内完成 */
export const BASE_READY_TIMEOUT_MS = 8000;
/** 轮询 `getBitableReady` 的间隔（毫秒） */
export const BASE_READY_POLL_MS = 250;
/** 取到实例后仍为空时的额外重试次数 */
export const BASE_BIND_RETRY = 4;
/** 展示态自愈单轮的就绪预算（毫秒）—— 首轮已等过，这里只做「补一刀」快速探测 */
export const BASE_READY_RETRY_MS = 2500;
/** 展示态自愈的最多轮数（必须小：每轮失败都是一次用户可见的等待） */
export const AUTO_REBIND_MAX = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 等某个 base 的数据源就绪（`workspace.getBitableReady`）。
 *
 * 判定细节见 `utils/baseReady.ts`（纯函数、被测试真实调用）：
 * 「明确未就绪」才继续等；「无从判断」（宿主没有该 API / 抛不支持 / 抛其它错）
 * 一律立即放行 —— 判断不了就不该阻塞用户。
 */
export async function waitBitableReady(
  baseToken: string,
  timeoutMs = BASE_READY_TIMEOUT_MS,
  pollMs = BASE_READY_POLL_MS
): Promise<boolean> {
  const w = workspace as any;
  const probe =
    typeof w?.getBitableReady === 'function'
      ? (t: string) => w.getBitableReady(t) as Promise<boolean>
      : null;
  const r = await waitReady(probe, baseToken, {
    timeoutMs,
    pollMs,
    sleep,
    onWarn: (e) => console.warn('[appContext] getBitableReady 异常，跳过等待:', e),
  });
  return r.ready;
}

/**
 * @param readyTimeoutMs 等待数据源就绪的预算。默认取 `BASE_READY_TIMEOUT_MS`；
 *   展示态自愈重绑时传更短的值，避免多轮累加成让用户干等十几秒。
 */
export async function selectBase(
  baseToken: string,
  baseName?: string,
  readyTimeoutMs = BASE_READY_TIMEOUT_MS
): Promise<boolean> {
  if (!baseToken) return false;
  // 先登记「声明过这个 base」——即使后面绑定失败，也要让 getBaseStrict 知道
  // 我们不是「从未声明数据源」，而是「声明了却没连上」。两者的处置完全不同。
  declaredBaseToken = baseToken;
  if (baseName) currentBaseName = baseName;
  // ★ 第一步：等数据源就绪（这是之前缺失、导致刷新后绑错 base 的那一步）
  await waitBitableReady(baseToken, readyTimeoutMs);
  // ★ 第二步：取实例；仍为空则有界重试（就绪与实例可用之间可能有极短间隙）
  for (let attempt = 0; attempt <= BASE_BIND_RETRY; attempt += 1) {
    try {
      const app = await (workspace as any).getBitable(baseToken);
      if (app && app.base) {
        currentApp = app as BitableAppInstance;
        currentBaseToken = baseToken;
        currentBaseName = baseName ?? currentBaseName;
        emitAppChange();
        return true;
      }
    } catch (e) {
      console.warn('[appContext] getBitable 抛错（第 ' + (attempt + 1) + ' 次）:', e);
    }
    if (attempt < BASE_BIND_RETRY) await sleep(200 + attempt * 150);
  }
  console.warn('[appContext] getBitable 始终未返回可用实例，baseToken =', `...${baseToken.slice(-6)}`);
  return false;
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
 *
 * ⚠️ 这个回退是历史遗留，**在「配置声明了 baseToken」的场景下是危险的**：
 * 绑定失败时它会静默给出宿主默认 base，让上层拿错误的 base 去查源表，
 * 报出与真实原因无关的低层错误（见 selectBase 上方注释）。
 * 需要严格语义的调用方（读配置声明的源表）应改用 `getBaseStrict()`。
 */
export function getBase(): typeof bitable.base {
  return (currentApp?.base ?? bitable.base) as typeof bitable.base;
}

/**
 * 严格版 `getBase()`：**绝不静默回退到宿主默认 base**。
 *
 * 返回 `{ base, bound }`：
 *   · 绑定成功 → `bound: true`，base 即配置声明的那个 base；
 *   · 没声明 baseToken（侧边栏/旧配置）→ `bound: true`，base 为全局实例（语义正确）；
 *   · 声明了 baseToken 但绑定失败 → `bound: false`，base 为 undefined。
 *
 * 调用方拿到 `bound: false` 时应当**如实报错**（「未能连接所选多维表格」），
 * 而不是拿默认 base 去查表、再报一个风马牛不相及的 `code: 12`。
 */
export function getBaseStrict(): { base?: typeof bitable.base; bound: boolean } {
  const v = decideBaseBinding({
    hasApp: !!currentApp?.base,
    currentToken: currentBaseToken,
    declaredToken: declaredBaseToken,
  });
  if (!v.bound) return { bound: false };
  if (v.useGlobal) return { base: bitable.base as typeof bitable.base, bound: true };
  return { base: currentApp!.base as typeof bitable.base, bound: true };
}

/** 配置声明过、但当前未绑定的 baseToken（诊断用） */
export function getDeclaredBaseToken(): string {
  return declaredBaseToken;
}

/** 绑定失败时抛给用户的可读文案（不暴露 code:12 这类无上下文信息） */
export const BASE_NOT_BOUND_MSG =
  '未能连接配置所指定的多维表格（数据源未就绪或未授权）。请刷新页面重试；' +
  '若持续失败，请进入配置模式重新选择数据源并保存。';

/**
 * 严格版 base：绑定失败即抛可读错误，**绝不回退宿主默认 base**。
 *
 * 用于「没有具体 tableId、但仍必须落在正确 base 上」的操作，
 * 例如列出 base 下的表清单、上传附件（附件 token 是 base 内资源）。
 * 用宽松 `getBase()` 做这些事，会在绑定失败时把内容/查询作用到别的多维表格。
 */
export function getBaseOrThrow(): typeof bitable.base {
  const { base, bound } = getBaseStrict();
  if (!bound || !base) throw new Error(BASE_NOT_BOUND_MSG);
  return base;
}

/**
 * 严格取表：绑定失败即抛可读错误，**绝不回退宿主默认 base**。
 *
 * 凡「读/写配置声明的表」的地方都该走这里：
 * 回退默认 base 会拿错表去读（报出无关的低层错误）甚至错写/错删。
 *
 * 返回类型沿用 SDK `getTableById` 的推断结果（不要写成 any）——
 * 写成 any 会连带把 `.map((m) => ...)` 里的 `m` 变成隐式 any，
 * 既丢类型保护，又会在 typecheck 里报一串 TS7006。
 */
export async function getTableStrict(
  tableId: string
): Promise<Awaited<ReturnType<typeof bitable.base.getTableById>>> {
  const base = getBaseOrThrow();
  return await base.getTableById(tableId);
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
  if (!app) declaredBaseToken = '';
}

/**
 * 仅供测试：构造「声明了 baseToken 但没绑上」的状态。
 *
 * 这是本次缺陷的关键状态，测不到它就等于没验证修复：
 * 早期版本没有这个钩子，我只能用静态断言守着，结果反向注入把
 * `return { bound: false }` 改成「回退全局 base」后 **734/734 仍全绿**。
 */
export function __setDeclaredBaseForTest(declared: string | null): void {
  currentApp = null;
  currentBaseToken = '';
  declaredBaseToken = declared ?? '';
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
