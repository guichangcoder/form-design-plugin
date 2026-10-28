/**
 * 写接口的有界重试策略（纯函数 + 可注入 sleep，测试可真实调用）。
 *
 * 背景：飞书多维表格底层对同一张数据表的处理是**按版本串行**的，官方文档明确
 * 「不支持并发」，并建议调用方自行加重试：
 *   - 1254607 Data not ready  ：前置操作未完成 / 本次数据过大，官方建议等待后重试
 *   - 1254291 Write conflict  ：同一数据表不支持并发写
 *   - 1255040 请求超时        ：官方建议直接重试
 *   - 1255001/1255002/1255003/1255004/1255005：内部/RPC/序列化抖动
 *
 * 用户反馈的「偶发、只有个别人、隔一会儿又正常」正是这类**瞬时**错误的特征，
 * 而原实现是单次调用、零重试，因此把平台抖动放大成了用户可见的失败。
 *
 * ⚠️ 幂等风险：JS-SDK 的 addRecord 不接受 client_token，重试无法在服务端去重。
 *
 * 因此这里把错误分成三类（2026-10-28 修正）：
 *   ① **确定未写入** → 可安全重试：Write conflict / Data not ready / 内部抖动。
 *   ② **结果未知** → **绝不自动重试**：请求超时（1255040）。
 *   ③ 不可恢复 → 立即失败：权限、参数、类型不支持。
 *
 * 🔴 为什么超时必须单独拎出来（原来它被错误地归进①）：
 * 超时的语义是「客户端没等到响应」，**服务端很可能已经写入成功**。
 * 而 addRecord 不是幂等的、SDK 又不支持 client_token，
 * 重试就等于**再写一条**。实测（mock 复刻「已落库 + 首次超时」）：
 *   一次提交 → 实际落库 2 条，且函数返回「成功」→ 用户完全不知道有重复。
 *
 * 飞书官方文档确实写着「1255040 请求超时 → 进行重试」，但那是针对 **REST API** 说的，
 * REST 的 records 接口带 `client_token`（uuidv4）幂等键，重复提交服务端会自动去重；
 * **JS-SDK 没有这个参数**，所以不能照搬这条建议 —— 这是本项目一个真实的踩坑点。
 * 权衡：重复数据比「明确失败」危害大得多（失败用户会当场看到并重试，重复数据往往几周后才发现），
 * 因此超时一律不自动重放，交给用户在确认未写入后自行重新提交。
 */

/**
 * 可安全重试的错误码（**请求确定没有被处理**）。
 *
 * ⚠️ 这里**不能**放 1255040（请求超时）：超时意味着客户端没收到响应，
 * 而服务端可能已经写入成功。addRecord 非幂等、JS-SDK 也无 client_token，
 * 重试会造成重复记录（已实测复现）。详见文件头注释。
 */
export const RETRYABLE_CODES: number[] = [
  1254291, // Write conflict：同表并发写被拒，请求确定未处理
  1254607, // Data not ready：前置操作未完成，请求确定未处理
  1255001, // InternalError
  1255002, // RpcError
  1255003, // MarshalError
  1255004, // UmMarshalError
  1255005, // ConvError
];

/**
 * 「结果未知」错误码：请求可能已被服务端处理，**禁止自动重放**。
 * 只在提示文案上体现「请先到表里确认是否已写入」，不做任何自动重试。
 */
export const AMBIGUOUS_CODES: number[] = [
  1255040, // 请求超时（504）：可能已落库
];

/**
 * 「结果未知」的文案特征（拿不到 code 时兜底）。
 * 命中一律**不重试** —— 请求可能已落库，重放即重复写入。
 * ⚠️ 必须在 RETRYABLE_PATTERNS 之前判定。
 */
const AMBIGUOUS_PATTERNS: RegExp[] = [
  /timeout|timed\s*out/i,
  /请求超时|响应超时|网络超时/,
  /超时/,
];

/**
 * 可重试错误的文案特征（拿不到 code 时兜底判断）。
 * 宿主/桥接层有时只透传 message 不透传 code，此时按文案识别。
 *
 * ⚠️ 这里**刻意不含** timeout / 超时：见 AMBIGUOUS_PATTERNS。
 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /write\s*conflict/i,
  /data\s*not\s*ready/i,
  /please\s*try\s*again/i,
  /try\s*again\s*later/i,
  /internal\s*error|rpc\s*error/i,
  /服务繁忙|系统繁忙|请稍后重试/i,
];

/** 从任意异常里尽力取出数字错误码（OpenError.code / TransferableError.code） */
export function extractErrorCode(e: unknown): number | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const candidates = [
    (e as { code?: unknown }).code,
    (e as { errCode?: unknown }).errCode,
    (e as { detailCode?: unknown }).detailCode,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && /^\d+$/.test(c)) return Number(c);
  }
  return undefined;
}

/** 从任意异常里取出可读文案 */
export function extractErrorMessage(e: unknown): string {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const msg = (e as { message?: unknown }).message;
  if (typeof msg === 'string' && msg) return msg;
  const deprecatedMsg = (e as { msg?: unknown }).msg;
  if (typeof deprecatedMsg === 'string' && deprecatedMsg) return deprecatedMsg;
  try {
    return String(e);
  } catch {
    return '';
  }
}

/**
 * 判断某个错误是否属于「结果未知」——请求可能已被服务端处理，**绝不能自动重放**。
 * 目前只有请求超时属于这一类。
 */
export function isAmbiguousError(e: unknown): boolean {
  const code = extractErrorCode(e);
  if (code !== undefined) {
    if (AMBIGUOUS_CODES.includes(code)) return true;
    // 明确在可重试清单里的，就不是「未知」
    if (RETRYABLE_CODES.includes(code)) return false;
  }
  const text = extractErrorMessage(e);
  if (!text) return false;
  return AMBIGUOUS_PATTERNS.some((p) => p.test(text));
}

/**
 * 判断某个错误是否值得重试。
 * 判定顺序：① 「结果未知」优先排除（超时）→ ② 显式错误码 → ③ 文案特征兜底。
 *
 * ⚠️ ① 必须最先：超时文案常常同时含 "try again"（如官方原文
 * `Request timed out, please try again later.`），
 * 若先走文案兜底会被误判为可重试 → 重复写入。
 */
export function isRetryableError(e: unknown): boolean {
  if (isAmbiguousError(e)) return false;
  const code = extractErrorCode(e);
  if (code !== undefined) return RETRYABLE_CODES.includes(code);
  const text = extractErrorMessage(e);
  if (!text) return false;
  return RETRYABLE_PATTERNS.some((p) => p.test(text));
}

/**
 * 生成第 n 次重试前的**基准**等待毫秒数（从 0 开始计：n=0 是首次重试）。
 * 采用官方建议的 0.5–1 秒区间，并对多次重试做轻微递增，
 * 但总量有界（最多 3 次重试 ≈ 最多 2.4 秒），不让用户长时间白屏。
 *
 * ⚠️ 这只是**基准值**，真实等待必须再叠随机抖动，见 `retryDelayMs`。
 */
export function retryBaseDelayMs(attempt: number): number {
  const base = 500;
  const step = 300;
  const cap = 1200;
  return Math.min(base + step * attempt, cap);
}

/** 抖动幅度：基准值的 ±40% */
export const RETRY_JITTER_RATIO = 0.4;

/**
 * 生成第 n 次重试前的实际等待毫秒数 = 基准值 × (1 ± 40% 随机)。
 *
 * 🔴 为什么必须加抖动（实测教训，2026-10-28）：
 * 原来是**固定**的 500/800/1100ms 序列。多个用户在同一时刻撞上
 * `1254291 Write conflict` 后，会在**完全相同的时刻**一起重试 ——
 * 于是又一起撞、再一起重试，重试次数被「同步碰撞」吃掉，
 * 形成成功率天花板。
 *
 * 实测（mock 复刻飞书「同表版本串行 + 并发即冲突」语义，各跑 5 次取稳定值）：
 *   并发 5 人 → 固定延迟只成功 4 人；加抖动后 5/5 全部成功
 *   并发 8 人 → 固定延迟仍是 4 人；加抖动 8/8
 *   并发 12 人 → 固定延迟仍是 4 人；加抖动 12/12
 *   并发 20 人 → 固定延迟仍是 4 人；加抖动 20/20
 * 即固定延迟下「成功上限 ≈ 4 人」，与人多人少无关 —— 纯粹是同步重试撞出来的。
 *
 * 抖动把并发重试摊开到不同时刻，冲突概率大幅下降，且不需要加重试次数、
 * 不需要延长用户等待（均值仍落在官方建议区间内）。
 *
 * @param attempt 第几次重试（0 = 首次重试）
 * @param random  随机源（测试注入，默认 Math.random）
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = retryBaseDelayMs(attempt);
  const spread = base * RETRY_JITTER_RATIO;
  // 落在 [base - spread, base + spread]，四舍五入到整数毫秒
  return Math.round(base - spread + random() * spread * 2);
}

export interface RetryOptions {
  /** 最大重试次数（不含首次调用） */
  maxRetries?: number;
  /** 可注入的等待函数（测试用，默认真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 可注入的判定（测试用，默认 isRetryableError） */
  shouldRetry?: (e: unknown) => boolean;
  /** 每次重试前的回调（用于日志/埋点） */
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

export interface RetryResult<T> {
  value: T;
  /** 实际重试次数（0 = 首次即成功） */
  retries: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 执行一次可能失败的异步写操作，仅在**可重试错误**上有界重试。
 *
 * 不可重试的错误会立即抛出，不做无意义的等待；重试次数用尽后抛出最后一次错误。
 */
export async function withWriteRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? isRetryableError;

  let retries = 0;
  for (;;) {
    try {
      const value = await fn();
      return { value, retries };
    } catch (e) {
      if (retries >= maxRetries || !shouldRetry(e)) {
        throw e;
      }
      const delay = retryDelayMs(retries);
      retries += 1;
      options.onRetry?.({ attempt: retries, delay, error: e });
      await sleep(delay);
    }
  }
}