/**
 * 人员字段「显示名」纯逻辑（不依赖 React / Semi / SDK，回归测试可在 Node 中直接跑）。
 *
 * ★ 为什么要抽成纯函数：
 *   UI 显示类缺陷（「显示一串 ID」）靠源码正则断言兜不住 —— 断言只能证明某个
 *   字样存在，证明不了**运行时真的产出了正确字符串**。抽成纯函数后测试可
 *   直接调用真实实现，反向注入（把兜底改回裸 id）必然被抓到。
 *
 * 显示优先级（外层 Tag 与下拉框内已选值共用，保证两处一致）：
 *   ① 已知姓名（候选历史人员里读到 / value 里自带）→ 显示姓名；
 *   ② 就是本人（id === meId）→ 「我（当前用户）」；
 *   ③ 身份尚未解析完成（meId 为空）→ 中性占位「当前用户」；
 *      绝不能显示 id：`getUserId()` 是异步 bridge 调用，首帧可能还没回来，
 *      显示 id 会让用户先看到一串 ou_xxx、几十毫秒后才变成正确文案（闪动）。
 *   ④ 其他（已解析、非本人、无姓名，异常数据如人员已移出可见范围）
 *      → 截断展示，保留可读前缀便于排查，且不撑破布局。
 */

/** 无姓名且身份未知时展示占位，避免任何情况下漏出原始 id */
export const UNKNOWN_PERSON_PLACEHOLDER = '当前用户';
/** 本人（无姓名）时的显示文案 */
export const SELF_PERSON_LABEL = '我（当前用户）';

/** 截断超长 id（open_id 形如 ou_xxx 共 30+ 字符），保留前缀 + 后缀便于排查 */
export function truncateId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/**
 * 计算某个人员 id 的显示名。
 *
 * @param id       人员 open_id / user_id
 * @param nameById 已知的 id → 姓名映射（来自候选历史人员与 value 自带的 name）
 * @param meId     当前用户 id（为空串表示尚未解析完成）
 */
export function resolvePersonLabel(
  id: string,
  nameById: ReadonlyMap<string, string>,
  meId: string
): string {
  if (!id) return '';
  const named = nameById.get(id);
  if (named) return named;
  if (meId && id === meId) return SELF_PERSON_LABEL;
  // 身份尚未解析完成 → 中性占位；此刻显示 id 会闪一串 ou_xxx
  if (!meId) return UNKNOWN_PERSON_PLACEHOLDER;
  // 已解析、非本人、无姓名（异常数据）→ 截断，仍不显示完整 id
  return truncateId(id);
}

/**
 * 由候选 + 已选值构造 id → 姓名映射（只收真名，绝不把 id 当姓名）。
 * @param value       当前已选人员（可能自带 name）
 * @param candidates  下拉候选（含历史人员姓名；「当前用户」候选通常无 name）
 */
export function buildNameMap(
  value: Array<{ id: string; name?: string; enName?: string }>,
  candidates: Array<{ id: string; name?: string; enName?: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  (value || []).forEach((u) => {
    if (u && u.id && (u.name || u.enName)) map.set(u.id, (u.name || u.enName) as string);
  });
  (candidates || []).forEach((c) => {
    if (!c || !c.id) return;
    if (!c.name && !c.enName) return;
    map.set(c.id, (c.name || c.enName) as string);
  });
  return map;
}