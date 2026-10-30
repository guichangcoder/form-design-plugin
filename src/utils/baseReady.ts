/**
 * 「等数据源就绪」的判定逻辑（纯函数，可被测试真实调用）。
 *
 * 🔴 为什么单独抽出来：
 * 这段逻辑的**全部价值在于「什么时候该继续等、什么时候必须立刻放行」**，
 * 而这个分支光靠读代码/正则断言根本证明不了 —— 曾经写成「任何异常都 catch 掉
 * 继续空转」，宿主一旦不支持该 API 就会每轮白等满 8 秒，首屏被硬生生拖住。
 * 只有把 probe 作为参数注入、在测试里真的跑一遍并数调用次数，才能证明它不会空等。
 *
 * 背景：SDK 的 `workspace.getBitable(baseToken)` 在宿主数据未拉完时
 * **直接返回 null 且不等待**，因此必须由调用方先等 `getBitableReady`。
 */

/** 宿主未注册该 API（SDK 枚举 `HostNotRegistered` = 10299997）/ 不支持（996） */
export const HOST_NOT_SUPPORTED_CODES = [10299997, 996];

export interface WaitReadyOptions {
  /** 总预算（毫秒） */
  timeoutMs: number;
  /** 轮询间隔（毫秒） */
  pollMs: number;
  /** 当前时间戳（可注入，便于测试不依赖真实时钟） */
  now?: () => number;
  /** 睡眠（可注入，测试里用假 sleep 避免真实等待） */
  sleep?: (ms: number) => Promise<void>;
  /** 日志（可注入） */
  onWarn?: (msg: unknown) => void;
}

export interface WaitReadyResult {
  /** 是否允许继续往下走（true = 可以用 getBitable 取实例了） */
  ready: boolean;
  /** 实际探测次数（测试用来断言「没有空转」） */
  probes: number;
  /** 结束原因，便于诊断与断言 */
  reason: 'ready' | 'no-token' | 'no-api' | 'host-unsupported' | 'probe-error' | 'timeout';
}

/**
 * `getBaseStrict` 的判定核心（纯函数，可被测试真实调用）。
 *
 * 🔴 为什么必须抽出来：这段判定的唯一价值就是「**声明了却绑不上时绝不假装成功**」。
 * 我曾用「源码里出现 declaredBaseToken / getBaseStrict 字样」当断言，反向注入把
 * `return { bound: false }` 换成「回退全局 base + bound:true」（即把整个修复废掉），
 * 测试 **726/726 全绿** —— 字面存在的断言证明不了行为。故改为真实调用三分支。
 *
 * 三态语义：
 *   · `hasApp`             → 已绑定，`bound: true`（base 就是配置声明的那个）
 *   · 没声明过任何 token    → 侧边栏/旧配置，全局 base 是**正确**语义，`bound: true`
 *   · 声明过但没绑上        → `bound: false`，不给 base（让上层如实报错）
 *
 * @returns `bound: false` 表示「不能提供 base」；`bound: true` 表示可以用 `useGlobal`
 *   或已经绑定好的实例。
 */
export function decideBaseBinding(input: {
  /** 是否已持有 Workspace 绑定实例 */
  hasApp: boolean;
  /** 当前已绑定的 token */
  currentToken: string;
  /** 配置声明过、但可能没绑上的 token */
  declaredToken: string;
}): { bound: boolean; useGlobal: boolean } {
  if (input.hasApp) return { bound: true, useGlobal: false };
  // 从未声明过数据源 → 全局实例即正确语义（侧边栏 / 旧配置 / 本地 dev）
  if (!input.currentToken && !input.declaredToken) return { bound: true, useGlobal: true };
  // 声明过却没绑上 → 绝不能假装成功，否则会拿错 base 去查表
  return { bound: false, useGlobal: false };
}

/**
 * `waitReady` 的判定主体。
 *
 * 轮询「是否就绪」，直到就绪、确定无法判断、或超时。
 *
 * 判定规则（顺序不可变）：
 *   ① 没有 token → 不等待，`no-token`
 *   ② probe 不是函数 → 无从判断，放行 `no-api`
 *   ③ probe 抛「未注册/不支持」→ 放行 `host-unsupported`（**绝不空等**）
 *   ④ probe 抛其它异常 → 放行 `probe-error`（判断不了就不阻塞用户）
 *   ⑤ probe 回 true → 就绪
 *   ⑥ probe 回 false → 继续等，超时后 `timeout`（此时返回 ready:false）
 *
 * 注意 ③④ 与 ⑥ 的区别是这套逻辑的核心：
 * **「明确未就绪」才值得等；「判断不了」必须立刻放行。**
 */
export async function waitReady(
  probe: ((token: string) => Promise<boolean>) | undefined | null,
  token: string,
  opts: WaitReadyOptions
): Promise<WaitReadyResult> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = opts.onWarn ?? (() => undefined);

  if (!token) return { ready: false, probes: 0, reason: 'no-token' };
  if (typeof probe !== 'function') return { ready: true, probes: 0, reason: 'no-api' };

  // 预算 ≤ 0：仍然探测一次（不能因为预算为 0 就放弃唯一一次判断机会）
  const deadline = now() + Math.max(0, opts.timeoutMs);
  let probes = 0;
  for (;;) {
    probes += 1;
    try {
      const ok = await probe(token);
      if (ok) return { ready: true, probes, reason: 'ready' };
    } catch (e) {
      const code = (e as { code?: number } | null)?.code;
      if (code !== undefined && HOST_NOT_SUPPORTED_CODES.includes(code)) {
        return { ready: true, probes, reason: 'host-unsupported' };
      }
      warn(e);
      return { ready: true, probes, reason: 'probe-error' };
    }
    if (now() >= deadline) return { ready: false, probes, reason: 'timeout' };
    await sleep(Math.max(0, opts.pollMs));
  }
}