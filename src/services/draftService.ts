/**
 * 表单草稿的持久化服务（localStorage）。
 *
 * 设计取舍：
 * - **纯本地**，不写服务端、不进数据表 —— 草稿是「未提交的临时内容」，
 *   写服务端会污染业务数据，也不符合「只有提交才正式写入」的需求。
 * - **按 base + 表单 + 用户三重隔离**（见 utils/formDraft.ts::draftStorageKey）。
 * - **静默容错**：localStorage 可能被沙箱禁用 / 配额耗尽（QuotaExceededError）→
 *   读写失败一律不影响表单主流程（草稿是增强功能，绝不能因此让表单不能用）。
 */
import { DraftPayload, draftStorageKey, deserializeDraftRow } from '../utils/formDraft';

/** localStorage 是否可用（部分 webview 沙箱会禁用，或隐私模式抛错） */
export function isDraftStorageAvailable(): boolean {
  try {
    const k = '__draft_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** 读取草稿；不存在 / 解析失败 / 结构不符 → 返回 null（调用方按「无草稿」处理） */
export function loadDraft(
  baseToken: string,
  formId: string,
  userId: string
): DraftPayload | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(baseToken, formId, userId));
    if (!raw) return null;
    const o = JSON.parse(raw) as DraftPayload;
    if (!o || typeof o !== 'object') return null;
    if (o.formId !== formId) return null; // 防止 key 被手工改串
    return o;
  } catch (e) {
    console.warn('[draft] 读取草稿失败，按无草稿处理:', e);
    return null;
  }
}

/**
 * 保存草稿。
 * @returns true=已写入；false=未写入（配额不足 / 存储不可用）。**不抛错**，由调用方决定是否提示。
 */
export function saveDraft(
  baseToken: string,
  formId: string,
  userId: string,
  payload: DraftPayload
): boolean {
  try {
    localStorage.setItem(
      draftStorageKey(baseToken, formId, userId),
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    // QuotaExceededError 等：草稿体积失控（超大文本 / 极多子表行）
    console.warn('[draft] 保存草稿失败（可能超出存储配额）:', e);
    return false;
  }
}

/** 删除草稿（提交成功后调用：草稿使命完成） */
export function clearDraft(baseToken: string, formId: string, userId: string): void {
  try {
    localStorage.removeItem(draftStorageKey(baseToken, formId, userId));
  } catch (e) {
    console.warn('[draft] 清除草稿失败:', e);
  }
}

/** 草稿 → 主表值（还原 Date 实例等） */
export function draftMainValues(draft: DraftPayload): Record<string, unknown> {
  return deserializeDraftRow(draft.main ?? {});
}

/** 草稿 → 子表值（逐行还原） */
export function draftSubValues(draft: DraftPayload): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [tid, rows] of Object.entries(draft.subs ?? {})) {
    out[tid] = (rows ?? []).map(deserializeDraftRow);
  }
  return out;
}