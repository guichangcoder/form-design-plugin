/**
 * 表单草稿的纯逻辑（不依赖 React / Semi / SDK，回归测试可在 Node 中直接跑）。
 *
 * 需求：用户填了一半点「保存草稿」（或自动暂存），**切换页面 / 刷新后回来还能接着填**；
 * 只有点「提交」才真正写入数据表 —— 草稿绝不会进数据表。
 *
 * ★ 为什么抽纯函数：
 *   「哪些值能安全持久化」是**值形态判断**（Date 实例、File 对象、undefined 的差异），
 *   靠源码正则断言证明不了运行时产出；抽成纯函数后测试可直接喂真实值验证。
 *
 * 序列化约定（JSON 只能承载有限的类型）：
 * - Date 实例（日期字段的值）→ `{ __draftType: 'date', v: <毫秒时间戳> }`，读回还原为 Date
 *   （DateTime 控件要求 Date 实例，直接存时间戳数字会在控件里显示异常）
 * - File / Blob（附件字段的值）→ **丢弃**。File 无法 JSON 化，且附件需要先上传到服务端
 *   才有稳定标识；草稿里保留「已选文件」会得到一堆无法还原的空壳。宁可让用户重选。
 * - undefined / 函数 / Symbol → 丢弃（JSON 里本就无意义）
 * - 其余（string / number / boolean / 数组 / 纯对象）→ 原样保留
 */

/** 草稿值的序列化包装标记 */
export const DRAFT_DATE_MARK = '__draftType';

/** 草稿载荷（写入存储的 JSON 形态） */
export interface DraftPayload {
  /** 草稿所属表单 ID */
  formId: string;
  /** 写入时间（毫秒时间戳），用于展示「草稿保存于 xx」 */
  savedAt: number;
  /** 主表值（已序列化） */
  main: Record<string, unknown>;
  /** 子表值：tableId → 各行值（已序列化） */
  subs: Record<string, Array<Record<string, unknown>>>;
  /** 配置版本指纹：字段结构变化后旧草稿可能对不上，用它能识别并提示 */
  schemaSig?: string;
}

/** 判断是否为「可 JSON 化的草稿值」（递归） */
export function isDraftableValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return false;
  if (v instanceof Date) return true;
  // File / Blob / ArrayBuffer 等二进制对象无法 JSON 化 → 丢弃
  if (typeof File !== 'undefined' && v instanceof File) return false;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return false;
  if (Array.isArray(v)) return true; // 数组整体保留，元素在序列化时逐项处理
  if (t === 'object') return true;
  return false;
}

/** 序列化单个值为可 JSON 存储的形态；不可序列化 → 返回 `undefined`（调用方跳过该字段） */
export function serializeDraftValue(v: unknown): unknown {
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? { [DRAFT_DATE_MARK]: 'date', v: ms } : undefined;
  }
  if (
    typeof File !== 'undefined' &&
    (v instanceof File || (Array.isArray(v) && v.some((x) => x instanceof File)))
  ) {
    return undefined; // 含附件 → 整个字段放弃（不做部分保留，避免半截数据误导）
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      const s = serializeDraftValue(item);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = serializeDraftValue(val);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  if (!isDraftableValue(v)) return undefined;
  return v;
}

/** 反序列化：把草稿里的 Date 包装还原为 Date 实例 */
export function deserializeDraftValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deserializeDraftValue);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o[DRAFT_DATE_MARK] === 'date' && typeof o.v === 'number') return new Date(o.v);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = deserializeDraftValue(val);
    return out;
  }
  return v;
}

/** 序列化一整行值：跳过不可持久化的字段（不写空壳） */
export function serializeDraftRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    const s = serializeDraftValue(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** 反序列化一整行值 */
export function deserializeDraftRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = deserializeDraftValue(v);
  return out;
}

/** 该行是否「有实质内容」（至少一个字段非空）—— 空行不值得存草稿 */
export function rowHasContent(row: Record<string, unknown>): boolean {
  return Object.values(row ?? {}).some((v) => {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}

/**
 * 判断一份草稿是否「值得保存」：主表或任一子表行有内容。
 * 全空草稿不落盘（否则每次打开都会提示「有草稿」，反而打扰用户）。
 */
export function draftHasContent(
  main: Record<string, unknown>,
  subs: Record<string, Array<Record<string, unknown>>>
): boolean {
  if (rowHasContent(main)) return true;
  return Object.values(subs ?? {}).some((rows) => (rows ?? []).some(rowHasContent));
}

/**
 * 生成「字段结构指纹」：字段 ID 集合的稳定摘要。
 * 用途：配置被改动（字段增删）后，旧草稿的 key 可能对不上号 → 用它判断草稿是否仍可信。
 * 只取排序后的 fieldId，字段改名/改标签不影响指纹（草稿按 fieldId 存值）。
 */
export function formSchemaSignature(
  mainFieldIds: string[],
  subFieldIdsByTable: Record<string, string[]>
): string {
  const main = [...(mainFieldIds ?? [])].sort().join(',');
  const subs = Object.keys(subFieldIdsByTable ?? {})
    .sort()
    .map((t) => `${t}:${[...(subFieldIdsByTable[t] ?? [])].sort().join(',')}`)
    .join('|');
  return `${main}||${subs}`;
}

/**
 * 把草稿值合并进初始值：**以草稿覆盖初值**，但只覆盖草稿里真实存在的 key。
 * - 配置里新增的字段（草稿里没有）→ 保留其 defaultValue；
 * - 草稿里的值 → 优先（用户之前填过的内容不能被默认值抹掉）。
 */
export function mergeDraftRow<T extends Record<string, unknown>>(
  initial: T,
  draftRow: Record<string, unknown> | undefined
): T {
  if (!draftRow) return initial;
  const out: Record<string, unknown> = { ...initial };
  for (const [k, v] of Object.entries(draftRow)) out[k] = v;
  return out as T;
}

/**
 * 生成草稿的存储 key：**按 base + 表单 + 用户三重隔离**。
 *
 * 为什么必须隔离到用户：
 *   插件运行在浏览器 iframe 里，localStorage 是**同域名共用**的。如果只按表单 ID 存，
 *   A 同事填的内容会在 B 同事打开时被恢复出来 —— 既困惑又可能泄露信息。
 * 为什么必须带 baseToken：
 *   同一份表单配置可能被复制到别的多维表格（1:N 关系），草稿必须归属各自的 base。
 */
export function draftStorageKey(baseToken: string, formId: string, userId: string): string {
  return `formDesignDraft:${baseToken || 'nobase'}:${formId}:${userId || 'anonymous'}`;
}