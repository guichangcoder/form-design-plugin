/**
 * 展示态「数据源绑定自愈」的重试编排（纯函数，可被测试真实调用）。
 *
 * 🔴 为什么必须抽出来：
 * 这里真正的风险是**重试次数形同虚设** —— 曾经把轮数上限挂在组件 ref 上，
 * 却指望 `useEffect` 靠依赖变化重跑；而重绑失败时依赖（inConfig/loading/baseToken）
 * 一个都没变，effect 根本不会再跑，于是「最多 3 轮」实际只跑 1 轮。
 *
 * 我用静态断言（检查函数体里有 `while`）去守这条，**反向注入当场证明是假绿**：
 * 把循环条件改成 `while (false && ...)`，源码里 `while (` 依然匹配，测试 718/718 全绿。
 * 所以改成注入 `tryBind` / `wait` / `now`，在测试里真的跑一遍并数调用次数。
 */

export interface RebindRunOptions {
  /** 单次尝试绑定，返回是否成功 */
  tryBind: () => Promise<boolean>;
  /** 失败间隔（毫秒） */
  retryDelayMs: number;
  /** 最多尝试轮数（≥1 时才尝试） */
  maxRounds: number;
  /** 睡眠（可注入） */
  wait?: (ms: number) => Promise<void>;
  /** 是否已取消（组件卸载 / 依赖变化） */
  isAlive?: () => boolean;
  /** 每轮开始前的回调（用于日志/计数） */
  onRound?: (round: number) => void;
  /** 全部失败时的回调 */
  onGiveUp?: () => void;
}

export interface RebindRunResult {
  /** 是否最终绑定成功 */
  ok: boolean;
  /** 实际尝试轮数 */
  attempts: number;
  /** 结束原因 */
  reason: 'bound' | 'cancelled' | 'exhausted' | 'no-rounds';
}

/**
 * 有界重试：在**同一次调用内部**循环，直到成功、耗尽轮数或取消。
 *
 * 顺序铁律：
 *   ① 先判 `maxRounds`（没有预算就一次都不试）；
 *   ② 每轮先判 `isAlive`（组件已卸载就别再发起请求）；
 *   ③ 失败后仍有剩余轮数才等待 —— **最后一轮失败后不再白等一次**。
 */
export async function runRebindWithRetry(opts: RebindRunOptions): Promise<RebindRunResult> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = opts.isAlive ?? (() => true);
  const maxRounds = Math.floor(opts.maxRounds);
  if (!(maxRounds >= 1)) return { ok: false, attempts: 0, reason: 'no-rounds' };

  let attempts = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (!alive()) return { ok: false, attempts, reason: 'cancelled' };
    attempts = round;
    opts.onRound?.(round);
    let ok = false;
    try {
      ok = await opts.tryBind();
    } catch {
      ok = false; // 单轮异常不该中断整个自愈流程
    }
    if (ok) return { ok: true, attempts, reason: 'bound' };
    if (!alive()) return { ok: false, attempts, reason: 'cancelled' };
    // 最后一轮失败后不再等待（省掉一次无意义的延时）
    if (round < maxRounds) await wait(Math.max(0, opts.retryDelayMs));
  }
  opts.onGiveUp?.();
  return { ok: false, attempts, reason: 'exhausted' };
}