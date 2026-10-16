/**
 * 唯一性校验（失焦实时校验 + 提交前兜底）。
 *
 * 判定策略（两级，先准后全）：
 * 1. **服务端精确过滤**（主路径，与表大小无关）：用 getRecords 的 filter 让飞书服务端按「等于」筛出命中记录，
 *    再对返回的记录做本地归一化严格比对确认 —— 2 万条、20 万条的表都是一次请求，不会因为扫描上限漏判。
 *    - 返回的记录里能找到严格相等的值 → 判重复；
 *    - 返回的记录只是「包含」该值 → 说明过滤生效但无精确重复 → 判不重复；
 *    - 返回的记录与该值毫无关系（或接口报错）→ 判定为该环境不支持过滤 → 回退第 2 路。
 * 2. **整列分页全量拉取**（兜底）：优先 `field.getFieldValueListByPage`（只取这一列，payload 最小，
 *    且 `stringValue:true` 直接拿字符串，避免单元格结构差异导致解析为空），失败再回退
 *    `getRecordsByPage` / `getRecords`。结果按「表+字段」缓存。
 *
 * 历史坑（勿回退）：
 * - SDK 的 `getRecords` 单次 pageSize **最大 200**，传 500 属非法参数；
 * - 曾经的 `MAX_RECORDS = 20000` 扫描上限会让 2 万+ 行的表漏判（现已改为 20 万，且主路径不依赖扫描）。
 *
 * 比较规则：转文本 → 去首尾空格 → 不区分大小写。
 *
 * 已知边界：并发提交仍存在极小概率重复（飞书无事务锁，插件层无法杜绝）。
 */
import { FieldType } from '@lark-base-open/js-sdk';
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

/** 分页大小（飞书 SDK 单次上限就是 200，不可超过） */
const PAGE_SIZE = 200;
/** 全量扫描的条数上限（兜底路径的安全阀；主路径不依赖它） */
export const MAX_RECORDS = 200_000;
/** 预加载探测阈值：表记录数超过这个值就不预先全量拉取，直接用服务端过滤判定 */
export const FULL_SCAN_TOTAL_LIMIT = 5_000;

export interface ExistingSet {
  ok: boolean;
  /** 归一化后的已有取值集合 */
  values: Set<string>;
  /** 实际扫描的记录数 */
  scanned: number;
  /** 是否因达到上限被截断（截断后校验可能不完整） */
  truncated: boolean;
  /** 表太大、未做全量扫描（走服务端过滤判定） */
  skipped?: boolean;
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
/** 服务端过滤判定结果缓存（同一值不重复请求） */
const filterCache = new Map<string, Promise<boolean | undefined>>();
const FILTER_CACHE_MAX = 500;

const cacheKey = (tableId: string, fieldId: string) => `${tableId}::${fieldId}`;
const filterCacheKey = (tableId: string, fieldId: string, n: string) =>
  `${tableId}::${fieldId}::${n}`;

/** 清空缓存（切换数据源 / 需要强制刷新时调用） */
export function invalidateExistingCache(tableId?: string, fieldId?: string): void {
  filterCache.clear();
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
 * 提交成功后：① 清掉过滤判定缓存；② 把新写入的值并入全量集合。
 * 否则刚提交过的值会被判为「可用」。
 */
export function noteSubmittedValues(tableId: string, fieldId: string, raws: unknown[]): void {
  for (const k of [...filterCache.keys()]) {
    if (k.startsWith(`${tableId}::${fieldId}::`)) filterCache.delete(k);
  }
  const p = cache.get(cacheKey(tableId, fieldId));
  if (!p) return; // 没缓存过就无需维护（下次会重新全量拉）
  p.then((s) => {
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
    if (typeof o.value === 'string') return o.value.trim().toLowerCase();
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

/** 可用服务端「等于」过滤判重的字段类型（数值类过滤语义差异大，走全量兜底） */
const FILTERABLE_TYPES: FieldType[] = [
  FieldType.Text,
  FieldType.Phone,
  FieldType.Email,
  FieldType.Url,
  FieldType.Barcode,
];

function supportsFilter(fieldType?: FieldType): boolean {
  if (!fieldType) return true; // 未传类型时按文本过滤尝试
  return FILTERABLE_TYPES.includes(fieldType);
}

function filterValueOf(raw: unknown, fieldType?: FieldType): string | number | null {
  if (fieldType === FieldType.Number || fieldType === FieldType.Currency) {
    const num = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    return Number.isFinite(num) ? num : null;
  }
  return String(raw ?? '');
}

/**
 * 服务端精确过滤查重：一次请求，与表大小无关。
 * @returns true=已存在；false=不存在；undefined=该环境过滤不可用（需回退全量）
 */
async function filterFindDup(
  tableId: string,
  fieldId: string,
  n: string,
  raw: unknown,
  fieldType?: FieldType
): Promise<boolean | undefined> {
  const fv = filterValueOf(raw, fieldType);
  if (fv === null) return undefined;
  try {
    const table = await getBase().getTableById(tableId);
    const res: any = await table.getRecords({
      pageSize: 20,
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId, operator: 'is', value: fv }],
      },
    } as any);
    const records: any[] = res?.records ?? [];
    if (records.length === 0) return false; // 服务端没筛到 → 无重复

    // 自证：过滤若生效，返回的记录必然「等于 / 包含」该值
    let contains = false;
    for (const rec of records) {
      const v = normalizeForCompare((rec?.fields as Record<string, unknown> | undefined)?.[fieldId]);
      if (v === n) return true; // 严格相等 → 确认重复
      if (n && v.includes(n)) contains = true;
    }
    // 有「包含」但无「相等」→ 过滤生效，只是没有精确重复
    // 返回的记录与该值毫无关系 → 过滤未生效，交给全量兜底
    return contains ? false : undefined;
  } catch (e) {
    console.warn(
      `[uniqueCheck] 服务端过滤查重不可用，回退全量扫描：${(e as Error)?.message ?? String(e)}`
    );
    return undefined;
  }
}

/** 分页遍历的通用循环：统一处理 hasMore / pageToken / 死循环保护 */
async function paginate(
  fetchPage: (token?: any) => Promise<{
    items: unknown[];
    hasMore: boolean;
    pageToken?: any;
    total?: number;
  }>,
  collect: (item: any) => void,
  opts?: { shouldAbort?: (total: number | undefined) => boolean }
): Promise<{ scanned: number; truncated: boolean; total?: number; aborted?: boolean }> {
  let scanned = 0;
  let truncated = false;
  let total: number | undefined;
  let pageToken: any;
  let guard = 0;

  do {
    const res = await fetchPage(pageToken);
    if (typeof res.total === 'number') total = res.total;
    // 拿到总数后发现超过阈值 → 立即停止，不再翻页（否则 2 万条要发上百次请求，
    // 还会把用户的失焦校验请求堵在队列后面 —— 这正是「第一次校验等很久」的根因）
    if (opts?.shouldAbort?.(total)) {
      return { scanned, truncated: false, total, aborted: true };
    }
    const items = res.items ?? [];
    if (items.length === 0) break;
    for (const it of items) {
      scanned += 1;
      collect(it);
      if (scanned >= MAX_RECORDS) {
        truncated = true;
        break;
      }
    }
    const next = res.hasMore && !truncated ? res.pageToken : undefined;
    guard += 1;
    // 死循环保护：token 没推进，或翻页次数异常多（>1000 页 = 20 万条）
    if (next !== undefined && (next === pageToken || guard > 1000)) {
      truncated = true;
      console.warn('[uniqueCheck] 分页游标未推进，已提前结束扫描（校验可能不完整）');
      break;
    }
    pageToken = next;
  } while (pageToken);

  return { scanned, truncated, total };
}

/**
 * 全量拉取某字段在数据表内的已有取值。
 * - 优先「整列取值」接口（payload 最小 + stringValue 直接拿字符串）；
 * - 逐级回退到 getRecordsByPage / getRecords（旧宿主兼容）。
 * - 同一「表+字段」并发调用复用同一个 Promise。
 */
export function loadAllExistingValues(
  tableId: string,
  fieldId: string,
  label?: string,
  opts?: { force?: boolean; totalLimit?: number }
): Promise<ExistingSet> {
  const key = cacheKey(tableId, fieldId);
  if (!opts?.force) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const p = (async (): Promise<ExistingSet> => {
    const values = new Set<string>();
    const shouldSkip = (total: number | undefined) =>
      !!opts?.totalLimit && typeof total === 'number' && total > opts.totalLimit;

    const finish = (scanned: number, truncated: boolean, total?: number): ExistingSet => {
      // 表太大：不缓存空集合，标记为 skipped，改走服务端过滤
      if (shouldSkip(total)) {
        console.log(
          `[uniqueCheck] 字段「${label ?? fieldId}」共 ${total} 条记录，超过预加载阈值 ${opts?.totalLimit}，改用服务端过滤判定`
        );
        return { ok: true, values: new Set(), scanned: 0, truncated: false, skipped: true };
      }
      console.log(
        `[uniqueCheck] 全量扫描完成：字段「${label ?? fieldId}」共扫描 ${scanned} 条，${values.size} 个不同取值${truncated ? '（已截断，校验可能不完整）' : ''}`
      );
      return { ok: true, values, scanned, truncated };
    };

    try {
      const table = await getBase().getTableById(tableId);

      // —— 路径 1：整列取值（推荐）——
      try {
        const field: any = await (table as any).getField(fieldId);
        if (field?.getFieldValueListByPage) {
          const r = await paginate(
            async (token) => {
              const res: any = await field.getFieldValueListByPage({
                pageSize: PAGE_SIZE,
                stringValue: true,
                ...(token !== undefined ? { pageToken: token } : {}),
              });
              return {
                items: (res?.fieldValues ?? []) as Array<{ value: unknown }>,
                hasMore: !!res?.hasMore,
                pageToken: res?.pageToken,
                total: typeof res?.total === 'number' ? res.total : undefined,
              };
            },
            (item) => {
              const n = normalizeForCompare(item?.value);
              if (n) values.add(n);
            },
            { shouldAbort: shouldSkip }
          );
          return finish(r.scanned, r.truncated, r.total);
        }
      } catch (e) {
        console.warn(
          `[uniqueCheck] 整列取值接口不可用，回退记录分页：${(e as Error)?.message ?? String(e)}`
        );
      }

      // —— 路径 2/3：记录分页 ——
      const byPage: boolean = typeof (table as any).getRecordsByPage === 'function';
      const r = await paginate(
        async (token) => {
          const params: any = {
            pageSize: PAGE_SIZE,
            ...(token !== undefined ? { pageToken: token } : {}),
          };
          const res: any = byPage
            ? await (table as any).getRecordsByPage(params)
            : await (table as any).getRecords(params);
          return {
            items: (res?.records ?? []) as Array<{ fields?: Record<string, unknown> }>,
            hasMore: !!res?.hasMore,
            pageToken: res?.pageToken,
            total: typeof res?.total === 'number' ? res.total : undefined,
          };
        },
        (rec) => {
          const n = normalizeForCompare(rec?.fields?.[fieldId]);
          if (n) values.add(n);
        },
        { shouldAbort: shouldSkip }
      );
      return finish(r.scanned, r.truncated, r.total);
    } catch (e) {
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
 * 判定单个值是否与已有数据重复。
 * 先走服务端过滤（准确、与表大小无关）；过滤不可用再回退全量集合。
 */
async function isDuplicate(
  tableId: string,
  fieldId: string,
  raw: unknown,
  fieldType?: FieldType
): Promise<{ dup: boolean; truncated?: boolean; error?: { reason: string; action?: string } }> {
  const n = normalizeForCompare(raw);
  if (!n) return { dup: false };

  if (supportsFilter(fieldType)) {
    const fk = filterCacheKey(tableId, fieldId, n);
    let fp = filterCache.get(fk);
    if (!fp) {
      fp = filterFindDup(tableId, fieldId, n, raw, fieldType);
      if (filterCache.size >= FILTER_CACHE_MAX) filterCache.clear();
      filterCache.set(fk, fp);
    }
    const r = await fp.catch(() => undefined);
    if (r === true) return { dup: true };
    if (r === false) return { dup: false };
    // undefined → 过滤不可用，继续走全量
  }

  let set = await loadAllExistingValues(tableId, fieldId);
  if (set.ok && set.skipped) {
    // 之前因表太大跳过全量，而过滤又不可用 → 强制全量拉一次
    set = await loadAllExistingValues(tableId, fieldId, undefined, { force: true });
  }
  if (!set.ok) {
    return {
      dup: false,
      error: { reason: set.reason ?? '读取已有数据失败', action: set.action },
    };
  }
  return { dup: set.values.has(n), truncated: set.truncated };
}

/**
 * 失焦时校验单个值是否与已有数据重复。
 * 空值直接返回 ok（不提示、不查表）。
 */
export async function checkOneValue(
  tableId: string,
  fieldId: string,
  raw: unknown,
  message?: string,
  fieldType?: FieldType
): Promise<SingleCheckResult> {
  if (isEmptyValue(raw)) return { status: 'ok', message: '' };

  const r = await isDuplicate(tableId, fieldId, raw, fieldType);
  if (r.error) {
    return {
      status: 'error',
      message: '无法校验',
      detail: `${r.error.reason}${r.error.action ? `。${r.error.action}` : ''}`,
    };
  }
  if (r.dup) {
    return {
      status: 'dup',
      message: message?.trim() || '已存在，请更换',
      truncated: r.truncated,
    };
  }
  return { status: 'ok', message: '可用', truncated: r.truncated };
}

/**
 * 提交前兜底查重：与表内已有数据比对 + 子表本次提交多行互查。
 * 与失焦校验共用同一判定逻辑（优先服务端过滤）。
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

    const r = await isDuplicate(mainTableId, field.fieldId, raw, field.fieldType);
    if (r.error) {
      failures.push({
        tableId: mainTableId,
        fieldId: field.fieldId,
        label: labelOf(field),
        reason: `${r.error.reason}${r.error.action ? `。${r.error.action}` : ''}`,
      });
      continue;
    }
    if (r.dup) {
      errors.push({
        tableId: mainTableId,
        fieldId: field.fieldId,
        message: field.unique?.message?.trim() || '该值在数据表中已存在，请更换',
      });
    }
  }

  // —— 2. 子表：与表内已有数据比对 + 本次提交多行互查 ——
  for (const sub of config.subTables) {
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
        const r = await isDuplicate(sub.tableId, field.fieldId, raw, field.fieldType);
        if (r.error) {
          if (!failures.some((f) => f.tableId === sub.tableId && f.fieldId === field.fieldId)) {
            failures.push({
              tableId: sub.tableId,
              fieldId: field.fieldId,
              label: labelOf(field),
              reason: `${r.error.reason}${r.error.action ? `。${r.error.action}` : ''}`,
            });
          }
          continue;
        }
        if (r.dup) {
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
