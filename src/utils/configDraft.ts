/**
 * 配置草稿的「初始化 / 重挂载」判定（纯函数，可被回归测试真实调用）。
 *
 * 🔴 为什么需要这个模块（2026-10-29 线上缺陷）：
 * ConfigPanel 用 `useState(() => initialConfig ?? defaultConfig())` 初始化草稿。
 * React 的 useState 初始化函数**只在首次挂载时执行一次**，之后 `initialConfig`
 * 无论怎么变都不会再进 draft。原来面板的 key 只绑了 baseToken，
 * 于是出现「保存后生效一次 → 重新进入配置态看不到上次配置」：
 *   · 首次进入：initialConfig 已就绪 → 初始化正确 → 保存成功 → 表单生效（「只生效一次」）
 *   · 再次进入：组件没重挂载（key 相同），useState 不再执行
 *              → draft 还是上一轮残留的旧对象 → 显示的不是已保存的最新配置
 *   · 页面刷新：若配置在异步加载完成前就挂载，initialConfig 为 null
 *              → draft 用 defaultConfig() 的空壳 → 用户看到「配置全丢了」
 *
 * 修法两层（缺一不可）：
 *   1. 给面板一个**内容指纹 key**，配置内容变了就整体重挂载（见 draftMountKey）；
 *   2. 组件内再用 effect 监听 initialConfig 变化做兜底同步（防止 key 设计被误改）。
 */

/**
 * 计算配置草稿的「挂载指纹」：内容变化即视为一次新的配置会话，应整体重挂载。
 *
 * 为什么不用 JSON.stringify(whole)：字段里的 options 数组体积可能很大（30 项 × N 字段），
 * 每次按键都算一次全量序列化会明显卡顿。这里只取对「是否需要重挂载」有意义的
 * 结构性信息：表单 id/版本/主表/列数/字段 id 序列/子表 id 序列。
 *
 * ⚠️ 不纳入 defaultValue / label 等逐字内容 —— 那些是用户在面板里**正在编辑**的值，
 * 若纳入会导致「每打一个字就重挂载 → 输入框失焦」。只在「换了另一份配置」时才需要重挂载。
 */
export function draftMountKey(
  formId: string | undefined,
  cfg: { mainTable?: { tableId?: string; columns?: unknown; fields?: { fieldId: string }[] }; subTables?: { tableId?: string; fields?: { fieldId: string }[] }[]; version?: string | number } | null | undefined
): string {
  if (!cfg) return `empty:${formId ?? ''}`;
  const main = cfg.mainTable;
  const mainFields = (main?.fields ?? []).map((f) => f?.fieldId ?? '').join(',');
  const subs = (cfg.subTables ?? [])
    .map((s) => `${s?.tableId ?? ''}[${(s?.fields ?? []).map((f) => f?.fieldId ?? '').join(',')}]`)
    .join('|');
  return [
    formId ?? '',
    cfg.version ?? '',
    main?.tableId ?? '',
    String(main?.columns ?? ''),
    mainFields,
    subs,
  ].join('#');
}

/**
 * 判断「外部传入的配置」是否应当覆盖当前草稿。
 *
 * 用于组件内 effect 兜底：只有当外部配置的指纹与「上一次已采纳的指纹」不同时才覆盖，
 * 否则用户每敲一个字都会被外部旧对象覆盖回去（典型半受控频闪）。
 *
 * @param incomingKey  本次 props 里 initialConfig 的指纹
 * @param adoptedKey   上次已同步进 draft 的指纹
 * @param dirty        当前草稿是否有用户未保存的改动
 */
export function shouldAdoptIncoming(
  incomingKey: string,
  adoptedKey: string | null,
  dirty: boolean
): boolean {
  // 同一份配置：不覆盖（否则会把用户正在编辑的内容冲掉）
  if (incomingKey === adoptedKey) return false;
  // 有未保存改动且外部配置没换 → 不覆盖
  if (dirty && adoptedKey !== null && incomingKey === adoptedKey) return false;
  // 外部换了一份配置 → 必须采纳（这是「再次进入配置态看到最新配置」的关键）
  return true;
}

/**
 * 解析「配置态应当编辑哪一份表单」的 id。
 *
 * 🔴 为什么要这一步（悬空 defaultFormId）：
 * `defaultFormId` 可能指向**已被删除**的表单。原实现
 * `forms.find(f => f.id === defaultFormId) ?? forms[0]` 会回退到 forms[0] 显示，
 * 但保存时 `handleSaveForm` 仍写 `base.defaultFormId ?? forms2[0].id`，
 * 即那个悬空 id 被**一直沿用** → 每次进入都回退到 forms[0]，
 * 多表单场景下表现为「配了 A 表单，回来看到的却是 B」/「配置对不上号」。
 *
 * 本函数返回**真实存在**的表单 id：优先 defaultFormId，其次第一份，都没有则 null。
 * 调用方应把返回值一并写回 defaultFormId，让悬空引用自愈。
 */
export function resolveDashFormId(
  forms: { id: string }[] | null | undefined,
  defaultFormId: string | null | undefined
): string | null {
  const list = forms ?? [];
  if (list.length === 0) return null;
  if (defaultFormId && list.some((f) => f?.id === defaultFormId)) return defaultFormId;
  return list[0]?.id ?? null;
}