/**
 * 目标表记录加载服务（关联字段选择器 / 引用选项选择器共用）。
 *
 * 设计目标（对应真实痛点）：
 * 1. **懒加载**：不挂载即拉，而是下拉展开那一刻才启动（`ensureLoaded`），避免打开表单就并发拉表；
 * 2. **全量加载**：分页一直拉到 hasMore=false，不再有 2000 条硬截断（旧版第 2000 条之后的记录
 *    根本不进候选集，导致「明明存在的选项却搜不到」——这不是慢，是没加载）；
 * 3. **渐进式**：第一页立即回调（秒出），后台继续翻页，订阅者通过 onProgress 增量拿到数据；
 * 4. **缓存复用**：同一「表（+列）」只拉一次，多个关联字段/多次展开共享同一份结果。
 *
 * 权限（重要）：本服务一律使用 `getBase()`（当前打开者身份）读取数据，
 * 飞书服务端只会返回该用户在该多维表格里有权限看到的记录 ——
 * 即「只加载用户权限内的数据」，与多维表格自身的权限体系完全一致，插件层不做也不应做提权。
 */
import { getBase } from './appContext';
import { stringifyCellValue } from '../utils/cellText';

/** 分页大小：飞书 SDK 单次上限就是 200，传更大值非法 */
const PAGE_SIZE = 200;
/** 全量加载的安全上限（达到才截断并告警，正常表不会触及） */
export const DEFAULT_MAX_RECORDS = 200_000;
/** 翻页次数保护（200000 / 200 = 1000 页） */
const MAX_PAGES = 3000;

export interface LoadProgress {
  /** 已加载条数 */
  loaded: number;
  /** 表内总条数（服务端返回时才有） */
  total?: number;
  /** 是否已结束（成功或失败） */
  done: boolean;
  /** 是否因达到上限被截断 */
  truncated: boolean;
  /** 失败原因 */
  error?: string;
}

export type ProgressListener<T> = (p: LoadProgress, data: T[]) => void;

/** 整列取值（关联字段只需 recordId + 主字段文本，用这个最轻） */
export interface FieldRow {
  recordId: string;
  text: string;
}

/** 整行记录（引用选项需要多个字段做联动过滤） */
export interface FullRow {
  recordId: string;
  fields: Record<string, unknown>;
}

interface Task<T> {
  key: string;
  data: T[];
  loaded: number;
  total?: number;
  done: boolean;
  truncated: boolean;
  error?: string;
  promise?: Promise<T[]>;
  subscribers: Set<ProgressListener<T>>;
}

const tasks = new Map<string, Task<any>>();

/** 任务键：列级 `col:<tableId>:<fieldId>`，行级 `row:<tableId>` */
export function taskKey(tableId: string, kind: 'col' | 'row', fieldId?: string): string {
  return fieldId ? `${kind}:${tableId}:${fieldId}` : `${kind}:${tableId}`;
}

function snapshot(t: Task<any>): LoadProgress {
  return {
    loaded: t.loaded,
    total: t.total,
    done: t.done,
    truncated: t.truncated,
    error: t.error,
  };
}

function notify(t: Task<any>) {
  const s = snapshot(t);
  t.subscribers.forEach((cb) => {
    try {
      cb(s, t.data);
    } catch {
      /* 订阅者自身异常不影响加载 */
    }
  });
}

/**
 * 订阅某任务的加载进度（若任务已存在会立即回调当前快照）。
 * @returns 取消订阅函数
 */
export function subscribeProgress<T>(key: string, cb: ProgressListener<T>): () => void {
  const t = tasks.get(key);
  if (!t) return () => {};
  cb(snapshot(t), t.data);
  t.subscribers.add(cb);
  return () => {
    t.subscribers.delete(cb);
  };
}

/** 读取已完成的缓存结果（未完成/失败返回 undefined） */
export function getLoaded<T>(key: string): T[] | undefined {
  const t = tasks.get(key);
  return t && t.done && !t.error ? (t.data as T[]) : undefined;
}

/** 清空缓存（数据源切换 / 需要强制刷新时调用） */
export function invalidateTableRecords(tableId?: string): void {
  if (!tableId) {
    tasks.clear();
    return;
  }
  for (const k of [...tasks.keys()]) {
    if (k.split(':').includes(tableId)) tasks.delete(k);
  }
}

/* ---------- 整列取值（关联字段用） ---------- */

async function runFieldColumn(
  t: Task<FieldRow>,
  tableId: string,
  fieldId: string,
  maxRecords: number,
  label?: string
): Promise<FieldRow[]> {
  try {
    const table = await getBase().getTableById(tableId);
    const field: any = await (table as any).getField(fieldId);

    if (typeof field?.getFieldValueListByPage === 'function') {
      let token: any;
      let guard = 0;
      for (;;) {
        const res: any = await field.getFieldValueListByPage({
          pageSize: PAGE_SIZE,
          stringValue: true,
          ...(token !== undefined ? { pageToken: token } : {}),
        });
        if (typeof res?.total === 'number') t.total = res.total;
        for (const fv of res?.fieldValues ?? []) {
          t.data.push({ recordId: fv.recordId, text: stringifyCellValue(fv.value) });
          t.loaded += 1;
          if (t.loaded >= maxRecords) {
            t.truncated = true;
            break;
          }
        }
        notify(t);
        if (t.truncated) break;
        guard += 1;
        const next = res?.hasMore ? res?.pageToken : undefined;
        if (next === undefined || next === token || guard > MAX_PAGES) break;
        token = next;
      }
    } else {
      // 旧宿主没有分页列接口：回退到记录分页，取 recordId + 该列值
      const useByPage = typeof (table as any).getRecordsByPage === 'function';
      let token: any;
      let guard = 0;
      for (;;) {
        const params: any = {
          pageSize: PAGE_SIZE,
          ...(token !== undefined ? { pageToken: token } : {}),
        };
        const res: any = useByPage
          ? await (table as any).getRecordsByPage(params)
          : await (table as any).getRecords(params);
        if (typeof res?.total === 'number') t.total = res.total;
        for (const rec of res?.records ?? []) {
          t.data.push({
            recordId: rec.recordId,
            text: stringifyCellValue((rec.fields ?? {})[fieldId]),
          });
          t.loaded += 1;
          if (t.loaded >= maxRecords) {
            t.truncated = true;
            break;
          }
        }
        notify(t);
        if (t.truncated) break;
        guard += 1;
        const next = res?.hasMore ? res?.pageToken : undefined;
        if (next === undefined || next === token || guard > MAX_PAGES) break;
        token = next;
      }
    }
  } catch (e) {
    t.error = (e as Error)?.message ?? String(e);
    console.warn(`[tableRecords] 加载整列失败：表=${tableId} 字段=${label ?? fieldId} 错误=${t.error}`);
  } finally {
    t.done = true;
    notify(t);
  }
  return t.data;
}

/**
 * 全量加载某表某列（recordId + 取值文本）。同一「表+字段」只拉一次。
 * 返回 key（用于订阅进度）与 promise（全量完成后 resolve）。
 */
export function loadFieldColumn(
  tableId: string,
  fieldId: string,
  opts?: { maxRecords?: number; label?: string; force?: boolean }
): { key: string; promise: Promise<FieldRow[]> } {
  const key = taskKey(tableId, 'col', fieldId);
  if (opts?.force) tasks.delete(key);
  let t = tasks.get(key) as Task<FieldRow> | undefined;
  if (!t) {
    t = {
      key,
      data: [],
      loaded: 0,
      done: false,
      truncated: false,
      subscribers: new Set(),
    };
    tasks.set(key, t);
    t.promise = runFieldColumn(t, tableId, fieldId, opts?.maxRecords ?? DEFAULT_MAX_RECORDS, opts?.label);
  }
  return { key, promise: t.promise! };
}

/* ---------- 整行记录（引用选项用） ---------- */

async function runTableRows(
  t: Task<FullRow>,
  tableId: string,
  maxRecords: number,
  label?: string
): Promise<FullRow[]> {
  try {
    const table = await getBase().getTableById(tableId);
    const useByPage = typeof (table as any).getRecordsByPage === 'function';
    let token: any;
    let guard = 0;
    for (;;) {
      const params: any = {
        pageSize: PAGE_SIZE,
        ...(token !== undefined ? { pageToken: token } : {}),
      };
      const res: any = useByPage
        ? await (table as any).getRecordsByPage(params)
        : await (table as any).getRecords(params);
      if (typeof res?.total === 'number') t.total = res.total;
      for (const rec of res?.records ?? []) {
        t.data.push({ recordId: rec.recordId, fields: (rec.fields ?? {}) as Record<string, unknown> });
        t.loaded += 1;
        if (t.loaded >= maxRecords) {
          t.truncated = true;
          break;
        }
      }
      notify(t);
      if (t.truncated) break;
      guard += 1;
      const next = res?.hasMore ? res?.pageToken : undefined;
      if (next === undefined || next === token || guard > MAX_PAGES) break;
      token = next;
    }
  } catch (e) {
    t.error = (e as Error)?.message ?? String(e);
    console.warn(`[tableRecords] 加载整表失败：表=${label ?? tableId} 错误=${t.error}`);
  } finally {
    t.done = true;
    notify(t);
  }
  return t.data;
}

/** 全量加载某表所有记录（含多字段）。同一表只拉一次。 */
export function loadTableRows(
  tableId: string,
  opts?: { maxRecords?: number; label?: string; force?: boolean }
): { key: string; promise: Promise<FullRow[]> } {
  const key = taskKey(tableId, 'row');
  if (opts?.force) tasks.delete(key);
  let t = tasks.get(key) as Task<FullRow> | undefined;
  if (!t) {
    t = {
      key,
      data: [],
      loaded: 0,
      done: false,
      truncated: false,
      subscribers: new Set(),
    };
    tasks.set(key, t);
    t.promise = runTableRows(t, tableId, opts?.maxRecords ?? DEFAULT_MAX_RECORDS, opts?.label);
  }
  return { key, promise: t.promise! };
}

/* ---------- 服务端关键字补充查询（未加载完也能搜到） ---------- */

/**
 * 用服务端过滤按关键字精确查询（`contains`），把远端命中补进候选。
 * 用途：全量还在后台加载时，用户输入关键字也能立即搜到表内其它位置的记录。
 * @returns 命中的 {recordId, text}；过滤不可用时返回空数组
 */
export async function searchRecordsByKeyword(
  tableId: string,
  fieldId: string,
  keyword: string,
  limit = 50
): Promise<FieldRow[]> {
  const kw = (keyword || '').trim();
  if (!kw) return [];
  try {
    const table = await getBase().getTableById(tableId);
    const useByPage = typeof (table as any).getRecordsByPage === 'function';
    const params: any = {
      pageSize: Math.min(200, Math.max(PAGE_SIZE, limit)),
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId, operator: 'contains', value: kw }],
      },
    };
    const res: any = useByPage
      ? await (table as any).getRecordsByPage(params)
      : await (table as any).getRecords(params);
    const records: any[] = res?.records ?? [];
    // 自证：过滤若生效，命中项必然包含关键字；否则视为宿主忽略 filter → 不采用结果
    const out: FieldRow[] = [];
    let effective = false;
    for (const rec of records.slice(0, limit)) {
      const text = stringifyCellValue((rec.fields ?? {})[fieldId]);
      if (text.toLowerCase().includes(kw.toLowerCase())) effective = true;
      out.push({ recordId: rec.recordId, text });
    }
    return effective ? out : [];
  } catch {
    return [];
  }
}