/**
 * 当前用户身份的**全表单共享缓存**。
 *
 * 背景：`getBridge().getUserId()` 是异步 bridge 调用，且不止一处需要它——
 *   - FormRenderer：给「默认值＝当前用户」的人员字段填值；
 *   - PersonSelector：把「只有 id 的本人」显示成「我（当前用户）」。
 *
 * 若各处各自调用，会出现两个问题：
 *   ① 同一身份发多次请求（违反「同一数据只取一次」的性能约定）；
 *   ② PersonSelector 首帧拿不到 id → 用户会**短暂看到一串截断的 open_id**
 *      再变成「我（当前用户）」（用户反馈「显示一串 ID」的闪现场景）。
 *
 * 这里做进程内缓存 + 单飞（inflight 去重）：任何组件先解析成功后，
 * 其他组件可立刻用 `getCachedUserIdSync()` **同步**拿到，首帧即正确。
 *
 * ⚠️ 只缓存「取不到 = 空串」这一结果，不做重试 —— 身份在整个会话内不变，
 *    反复重试只会放大失败请求。
 */
import { getBridge } from '../services/appContext';

let cached: string | null = null;
let inflight: Promise<string> | null = null;

/** 同步读取已缓存的当前用户 id；尚未解析过时返回空串（不阻塞渲染） */
export function getCachedUserIdSync(): string {
  return cached ?? '';
}

/** 是否已解析过（含解析失败后登记为空串的情形） */
export function hasResolvedCurrentUser(): boolean {
  return cached !== null;
}

/**
 * 取当前用户 id（全表单**共享一次请求**）。
 * 失败不抛异常，登记空串并返回。
 */
export function loadCurrentUserId(): Promise<string> {
  if (cached !== null) return Promise.resolve(cached);
  if (!inflight) {
    inflight = (async () => {
      try {
        const id = await getBridge().getUserId();
        cached = id || '';
      } catch {
        cached = '';
      }
      return cached;
    })();
  }
  return inflight;
}

/** 仅供测试：清空缓存，避免用例之间互相污染 */
export function __resetCurrentUserCacheForTest(): void {
  cached = null;
  inflight = null;
}