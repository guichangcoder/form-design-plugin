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
 * 因此只对**确定未落库**的错误重试：Data not ready / Write conflict / 超时 /
 * 内部抖动都属于「请求未被处理」，而权限、参数、类型不支持等错误一律不重试。
 */

/** 可安全重试的错误码（请求确定没有被成功处理） */
export const RETRYABLE_CODES: number[] = [
  1254291, // Write conflict
  1254607, // Data not ready
  1255040, // 请求超时
  1255001, // InternalError
  1255002, // RpcError
  1255003, // MarshalError
  1255004, // UmMarshalError
  1255005, // ConvError
];

/**
 * 可重试错误的文案特征（拿不到 code 时兜底判断）。
 * 宿主/桥接层有时只透传 message 不透传 code，此时按文案识别。
 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /write\s*conflict/i,
  /data\s*not\s*ready/i,
  /please\s*try\s*again/i,
  /try\s*again\s*later/i,
  /timeout|timed\s*out|请求超时|超时/i,
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
 * 判断某个错误是否值得重试。
 * 判定顺序：显式错误码优先 → 文案特征兜底。
 */
export function isRetryableError(e: unknown): boolean {
  const code = extractErrorCode(e);
  if (code !== undefined) return RETRYABLE_CODES.includes(code);
  const text = extractErrorMessage(e);
  if (!text) return false;
  return RETRYABLE_PATTERNS.some((p) => p.test(text));
}

/**
 * 生成第 n 次重试前的等待毫秒数（从 0 开始计：n=0 是首次重试）。
 * 采用官方建议的 0.5–1 秒区间，并对多次重试做轻微递增，
 * 但总量有界（最多 3 次重试 ≈ 最多 2.4 秒），不让用户长时间白屏。
 */
export function retryDelayMs(attempt: number): number {
  const base = 500;
  const step = 300;
  const cap = 1200;
  return Math.min(base + step * attempt, cap);
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