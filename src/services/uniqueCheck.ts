/**
 * 唯一性校验（失焦实时校验 + 提交前兜底）。
 *
 * 数据获取：**分页全量拉取**该字段在数据表内的已有取值（pageSize 分页，直到 hasMore=false），
 * 结果按「表+字段」缓存在模块级 Map 中 —— 表单内多次失焦、多行校验都不会重复拉表。
 *
 * 比较规则：转文本 → 去首尾空格 → 不区分大小写。
 *
 * 校验时机：
 * - 主交互 = 字段失焦时（checkOneValue），在输入框右侧显示「可用 / 已存在 / 校验中 / 无法校验」；
 * - 提交前 = checkDuplicates 兜底（命中缓存，不重新拉表），防止用户未失焦就点提交绕过。
 *
 * 已知边界：
 * - MAX_RECORDS 上限保护（超大表不会把页面拖死），达到上限会标记 truncated 并提示校验可能不完整；
 * - 并发提交仍存在极小概率重复（飞书无事务锁，插件层无法杜绝）。
 */
import {
  ConditionalState,
  FieldConfig,
  FieldError,
  FormPluginConfig,
  FormValues,
  UNIQUE_CHECKABLE_TYPES,
} from '../types';
import { isEmptyValue, isHiddenField } from '../utils/validator';
import { classifySdkError } from '../utils/permError';
import { getBase } from './appContext';

/** 分页大小（飞书 getRecords 单页上限） */
const PAGE_SIZE = 500;
/** 全量拉取的条数上限：超过则截断并提示（防止超大表拖死页面） */
export const MAX_RECORDS = 20000;

export interface ExistingSet {
  ok: boolean;
  /** 归一化后的已有取值集合 */
  values: Set<string>;
  /** 实际扫描的记录数 */
  scanned: number;
  /** 是否因达到上限被截断（截断后校验可能不完整） */
  truncated: boolean;
  /** 读取失败原因（ok=false） */
  reason?: string;
  /** 读取失败时的建议动作 */
  action?: string;
}

export interface DuplicateFailure {
  tableId: string;
  fieldId: string;
  label: string;
  reason: string;
}

export interface DuplicateCheckResult {
  errors: FieldError[];
  failures: DuplicateFailure[];
}

export type UniqueStatus = 'ok' | 'dup' | 'error';

export interface SingleCheckResult {
  status: UniqueStatus;
  /** 展示给用户的提示 */
  message: string;
  /** 读取失败时的详细原因（status=error） */
  detail?: string;
  /** 因达到上限截断导致校验可能不完整 */
  truncated?: boolean;
}

/** 模块级缓存：同一「表+字段」只全量拉一次 */
const cache = new Map<string, Promise<ExistingSet>>();
const cacheKey = (tableId: string, fieldId: string) => `${tableId}::${fieldId}`;

/** 清空缓存（切换数据源 / 需要强制刷新时调用） */
export function invalidateExistingCache(tableId?: string, fieldId?: string): void {
  if (!tableId) {
    cache.clear();
    return;
  }
  if (fieldId) {
    cache.delete(cacheKey(tableId, fieldId));
    return;
  }
  for (const k of [...cache.keys()]) {
    if (k.startsWith(`${tableId}::`)) cache.delete(k);
  }
}

/**
 * 提交成功后把新写入的值并入缓存：同一会话内再次填写相同值也能判重
 * （否则刚提交过的值不在缓存里，会被误判为「可用」）。
 */
export function noteSubmittedValues(tableId: string, fieldId: string, raws: unknown[]): void {
  const p = cache.get(cacheKey(tableId, fieldId));
  if (!p) return; // 没缓存过就无需维护（下次会重新全量拉）
  p
    .then((s) => {
      if (!s.ok) return;
      for (const r of raws) {
        const n = normalizeForCompare(r);
        if (n) s.values.add(n);
      }
    })
    .catch(() => {
      /* 缓存加载失败则忽略 */
    });
}

/** 比较用归一化：转文本 → trim → 小写。非文本结构（对象）取 text/name。 */
export function normalizeForCompare(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim().toLowerCase();
  if (Array.isArray(v)) {
    return v
      .map((i) => normalizeForCompare(i))
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.trim().toLowerCase();
    if (typeof o.name === 'string') return o.name.trim().toLowerCase();
    return '';
  }
  return String(v).trim().toLowerCase();
}

/** 该字段是否开启了唯一性校验（配置开启 + 类型支持 + 未隐藏） */
export function isUniqueChecked(
  field: FieldConfig,
  cond: ConditionalState,
  tableId: string,
  rowIndex?: number
): boolean {
  if (!field.unique?.enabled) return false;
  if (!UNIQUE_CHECKABLE_TYPES.includes(field.fieldType)) return false;
  if (isHiddenField(cond, tableId, field.fieldId, rowIndex)) return false;
  return true;
}

/**
 * 分页全量拉取某字段在数据表内的已有取值。
 * 同一「表+字段」的并发调用复用同一个 Promise（不会重复拉表）。
 */
export function loadAllExistingValues(
  tableId: string,
  fieldId: string,
  label?: string
): Promise<ExistingSet> {
  const key = cacheKey(tableId, fieldId);
  const hit = cache.get(key);
  if (hit) return hit;

  const p = (async (): Promise<ExistingSet> => {
    try {
      const table = await getBase().getTableById(tableId);
      const values = new Set<string>();
      let scanned = 0;
      let truncated = false;
      let pageToken: string | undefined;

      do {
        const res = await table.getRecords({
          pageSize: PAGE_SIZE,
          ...(pageToken ? { pageToken: pageToken as any } : {}),
        });
        const records = res.records ?? [];
        if (records.length === 0 && !res.hasMore) break;
        for (const rec of records) {
          scanned += 1;
          const n = normalizeForCompare(
            (rec.fields as Record<string, unknown> | undefined)?.[fieldId]
          );
          if (n) values.add(n);
          if (scanned >= MAX_RECORDS) {
            truncated = true;
            break;
          }
        }
        pageToken = res.hasMore && !truncated ? (res.pageToken as string | undefined) : undefined;
      } while (pageToken);

      if (truncated) {
        console.warn(
          `[uniqueCheck] 字段「${label ?? fieldId}」已有记录超过 ${MAX_RECORDS} 条，只扫描前 ${MAX_RECORDS} 条，唯一性校验可能不完整`
        );
      }
      console.log(
        `[uniqueCheck] 全量扫描完成：字段「${label ?? fieldId}」共 ${scanned} 条记录，${values.size} 个不同取值${truncated ? '（已截断）' : ''}`
      );
      return { ok: true, values, scanned, truncated };
    } catch (e) {
      // 权限不足是最常见原因，分类后给出可操作提示（而不是笼统的「读取失败」）
      const c = classifySdkError(e, label || '该字段的已有数据');
      cache.delete(key); // 失败不缓存，允许下次重试
      return {
        ok: false,
        values: new Set<string>(),
        scanned: 0,
        truncated: false,
        reason: c.title,
        action: c.action,
      };
    }
  })();

  cache.set(key, p);
  return p;
}

/**
 * 失焦时校验单个值是否与已有数据重复。
 * 空值直接返回 ok（不提示、不查表）。
 */
export async function checkOneValue(
  tableId: string,
  fieldId: string,
  raw: unknown,
  message?: string
): Promise<SingleCheckResult> {
  if (isEmptyValue(raw)) return { status: 'ok', message: '' };
  const n = normalizeForCompare(raw);
  if (!n) return { status: 'ok', message: '' };

  const set = await loadAllExistingValues(tableId, fieldId);
  if (!set.ok) {
    return {
      status: 'error',
      message: '无法校验',
      detail: `${set.reason ?? '读取已有数据失败'}${set.action ? `。${set.action}` : ''}`,
    };
  }
  if (set.values.has(n)) {
    return {
      status: 'dup',
      message: message?.trim() || '已存在，请更换',
      truncated: set.truncated,
    };
  }
  return { status: 'ok', message: '可用', truncated: set.truncated };
}

/**
 * 提交前兜底查重（命中缓存，不重新拉表）：
 * 与表内已有数据比对 + 子表本次提交多行之间互查。
 * 用户在输入框失焦时已校验过的值会命中同一份缓存，开销可忽略。
 */
export async function checkDuplicates(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>,
  cond: ConditionalState
): Promise<DuplicateCheckResult> {
  const errors: FieldError[] = [];
  const failures: DuplicateFailure[] = [];
  const labelOf = (f: FieldConfig) => f.label || f.fieldName || f.fieldId;

  // —— 1. 主表：与表内已有数据比对 ——
  const mainTableId = config.mainTable.tableId;
  for (const field of config.mainTable.fields) {
    if (!isUniqueChecked(field, cond, mainTableId)) continue;
    const raw = mainValues[field.fieldId];
    if (isEmptyValue(raw)) continue;
    const set = await loadAllExistingValues(mainTableId, field.fieldId, labelOf(field));
    if (!set.ok) {
      failures.push({
        tableId: mainTableId,
        fieldId: field.fieldId,
        label: labelOf(field),
        reason: `${set.reason ?? '读取已有数据失败'}${set.action ? `。${set.action}` : ''}`,
      });
      continue;
    }
    const n = normalizeForCompare(raw);
    if (n && set.values.has(n)) {
      errors.push({
        tableId: mainTableId,
        fieldId: field.fieldId,
        message: field.unique?.message?.trim() || '该值在数据表中已存在，请更换',
      });
    }
  }

  // —— 2. 子表：与表内已有数据比对 + 本次提交多行互查 ——
  for (const sub of config.subTables) {
    // 本次提交每行的取值（用于行间互查）
    const pending = new Map<string, { value: string; rowIndex: number }>();
    const rows = subValues[sub.tableId] ?? [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      for (const field of sub.fields) {
        if (!isUniqueChecked(field, cond, sub.tableId, rowIndex)) continue;
        const raw = row[field.fieldId];
        if (isEmptyValue(raw)) continue;
        const n = normalizeForCompare(raw);
        if (!n) continue;

        // 2.1 本次提交行间互查（报在后出现的行）
        const prev = pending.get(field.fieldId);
        if (prev && prev.value === n) {
          errors.push({
            tableId: sub.tableId,
            fieldId: field.fieldId,
            rowIndex,
            message: `与第 ${prev.rowIndex + 1} 条填写重复，请更换`,
          });
          continue;
        }
        pending.set(field.fieldId, { value: n, rowIndex });

        // 2.2 与表内已有数据比对
        const set = await loadAllExistingValues(sub.tableId, field.fieldId, labelOf(field));
        if (!set.ok) {
          if (!failures.some((f) => f.tableId === sub.tableId && f.fieldId === field.fieldId)) {
            failures.push({
              tableId: sub.tableId,
              fieldId: field.fieldId,
              label: labelOf(field),
              reason: `${set.reason ?? '读取已有数据失败'}${set.action ? `。${set.action}` : ''}`,
            });
          }
          continue;
        }
        if (set.values.has(n)) {
          errors.push({
            tableId: sub.tableId,
            fieldId: field.fieldId,
            rowIndex,
            message: field.unique?.message?.trim() || '该值在数据表中已存在，请更换',
          });
        }
      }
    }
  }

  return { errors, failures };
}
