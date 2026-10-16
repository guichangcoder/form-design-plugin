/**
 * 目标表记录加载服务（关联字段选择器 / 引用选项选择器共用）。
 *
 * 核心策略（按用户实际痛点定型）：
 * 1. **展开只取最新 200 条**：下拉打开时只发 **1 次请求**（按更新时间倒序取前 200 条），
 *    秒出、不阻塞 —— 彻底解决「仅等加载就要等很久」。
 * 2. **搜索才逐页翻**：用户输入关键字后，才按 200/页 向服务端逐页查询，命中立即并进候选，
 *    可随时停止、无需等待全量（`searchAllPages`，带取消）。
 * 3. **保留 20 万安全上限**：逐页搜索累计到 20 万即停，防极端表把页面拖死。
 * 4. **任务级缓存**：同一「表+列」的首屏 200 条只拉一次；多字段/多次展开共享。
 *
 * 权限（重要）：一律使用 `getBase()`（当前打开者身份）读取，
 * 飞书服务端只会返回该用户在该多维表格里有权限看到的记录 —— 即「只加载用户权限内的数据」，
 * 与多维表格自身的权限体系完全一致；插件层不做也不应做提权。
 */
import { getBase } from './appContext';
import { stringifyCellValue } from '../utils/cellText';

/** 分页大小：飞书 SDK 单次上限就是 200，传更大值非法 */
export const PAGE_SIZE = 200;
/** 首屏只加载这么多（最新的一批），不做全量 */
export const HEAD_SIZE = 200;
/** 用户在搜索里最多逐页翻这么多，防止极端表拖死（200 * 1000 = 20 万） */
export const SEARCH_MAX_PAGES = 1000;
/** 搜索累计命中上限 */
export const SEARCH_MAX_HITS = 2000;

export interface FieldRow {
  recordId: string;
  text: string;
}
export interface FullRow {
  recordId: string;
  fields: Record<string, unknown>;
}

/** 首屏加载结果 */
export interface HeadResult<T> {
  rows: T[];
  /** 表内总条数（服务端返回时才有） */
  total?: number;
  /** 是否还有更多（首屏未取完，可搜索翻页补） */
  hasMore: boolean;
  error?: string;
}

/* ---------------- 首屏 200 条（一次请求） ---------------- */

const headCache = new Map<string, Promise<HeadResult<any>>>();
/** 任务键：按「表 + 列 / 行 / 条件」维度生成，供缓存查询与测试使用 */
export const taskKey = (tableId: string, kind: 'col' | 'row' | 'cond', fieldId?: string) =>
  fieldId ? `${kind}:${tableId}:${fieldId}` : `${kind}:${tableId}`;

/**
 * 首屏取一页记录，**sort 失败自动降级**为不排序重试。
 * 部分宿主对 `sort` 支持不完整，若直接抛错会导致下拉全空 —— 降级可保底可用。
 */
async function fetchPage(
  table: any,
  params: any,
  useByPage: boolean
): Promise<any> {
  const call = (p: any) =>
    useByPage ? (table as any).getRecordsByPage(p) : (table as any).getRecords(p);
  try {
    return await call(params);
  } catch (e) {
    if (params?.sort) {
      const { sort: _s, ...rest } = params;
      console.warn('[tableRecords] 排序参数不被宿主支持，降级为默认顺序重试');
      return await call(rest);
    }
    throw e;
  }
}

export function invalidateTableRecords(tableId?: string): void {
  if (!tableId) {
    headCache.clear();
    return;
  }
  for (const k of [...headCache.keys()]) {
    if (k.split(':').includes(tableId)) headCache.delete(k);
  }
}

/** 读取已缓存的「首屏结果」 */
export function getHeadCache<T>(key: string): HeadResult<T> | undefined {
  const p = headCache.get(key);
  if (!p) return undefined;
  // 同步读取：缓存里存的是已 resolve 的结果包装
  const box = resolved.get(key);
  return box as HeadResult<T> | undefined;
}

/** 已完成任务的同步快照（避免返回 Promise） */
const resolved = new Map<string, HeadResult<any>>();

/** 排序字段 id 的缓存（避免每次展开都多花 1 次 getFieldMetaList） */
const sortFieldCache = new Map<string, Promise<string | undefined>>();

/** 找「更新时间」字段 id（用于倒序取最新）；找不到则不排序 */
function findSortFieldId(table: any, tableId: string): Promise<string | undefined> {
  let p = sortFieldCache.get(tableId);
  if (!p) {
    p = (async () => {
      try {
        const metas: any[] = await table.getFieldMetaList();
        const m = metas.find(
          (x) => x?.type === 1002 /* ModifiedTime */ || x?.type === 1001 /* CreatedTime */
        );
        return m?.id as string | undefined;
      } catch {
        return undefined;
      }
    })();
    sortFieldCache.set(tableId, p);
  }
  return p;
}

/**
 * 加载「最新的一批」（默认 200 条），**只发 1 次请求**。
 * 按更新时间倒序（拿不到该字段则按默认顺序）。
 */
export function loadHeadColumn(
  tableId: string,
  fieldId: string,
  opts?: { label?: string; force?: boolean }
): { key: string; promise: Promise<HeadResult<FieldRow>> } {
  const key = taskKey(tableId, 'col', fieldId);
  if (opts?.force) {
    headCache.delete(key);
    resolved.delete(key);
  }
  let p = headCache.get(key) as Promise<HeadResult<FieldRow>> | undefined;
  if (!p) {
    p = (async (): Promise<HeadResult<FieldRow>> => {
      try {
        const table = await getBase().getTableById(tableId);
        const sortFieldId = await findSortFieldId(table, tableId);
        const params: any = {
          pageSize: HEAD_SIZE,
          ...(sortFieldId ? { sort: [{ fieldId: sortFieldId, desc: true }] } : {}),
        };
        const useByPage = typeof (table as any).getRecordsByPage === 'function';
        const res: any = await fetchPage(table, params, useByPage);
        const rows: FieldRow[] = (res?.records ?? []).map((rec: any) => ({
          recordId: rec.recordId,
          text: stringifyCellValue((rec.fields ?? {})[fieldId]),
        }));
        const out: HeadResult<FieldRow> = {
          rows,
          total: typeof res?.total === 'number' ? res.total : undefined,
          hasMore: !!res?.hasMore,
        };
        resolved.set(key, out);
        return out;
      } catch (e) {
        headCache.delete(key); // 失败不缓存，允许重试
        const err = (e as Error)?.message ?? String(e);
        console.warn(`[tableRecords] 首屏加载失败：表=${tableId} 字段=${opts?.label ?? fieldId} 错误=${err}`);
        return { rows: [], hasMore: false, error: err };
      }
    })();
    headCache.set(key, p);
  }
  return { key, promise: p };
}

/** 加载「最新的一批」整行记录（引用选项用），只发 1 次请求 */
export function loadHeadRows(
  tableId: string,
  opts?: { label?: string; force?: boolean }
): { key: string; promise: Promise<HeadResult<FullRow>> } {
  const key = taskKey(tableId, 'row');
  if (opts?.force) {
    headCache.delete(key);
    resolved.delete(key);
  }
  let p = headCache.get(key) as Promise<HeadResult<FullRow>> | undefined;
  if (!p) {
    p = (async (): Promise<HeadResult<FullRow>> => {
      try {
        const table = await getBase().getTableById(tableId);
        const sortFieldId = await findSortFieldId(table, tableId);
        const params: any = {
          pageSize: HEAD_SIZE,
          ...(sortFieldId ? { sort: [{ fieldId: sortFieldId, desc: true }] } : {}),
        };
        const useByPage = typeof (table as any).getRecordsByPage === 'function';
        const res: any = await fetchPage(table, params, useByPage);
        const rows: FullRow[] = (res?.records ?? []).map((rec: any) => ({
          recordId: rec.recordId,
          fields: (rec.fields ?? {}) as Record<string, unknown>,
        }));
        const out: HeadResult<FullRow> = {
          rows,
          total: typeof res?.total === 'number' ? res.total : undefined,
          hasMore: !!res?.hasMore,
        };
        resolved.set(key, out);
        return out;
      } catch (e) {
        headCache.delete(key);
        const err = (e as Error)?.message ?? String(e);
        console.warn(`[tableRecords] 首屏加载失败：表=${opts?.label ?? tableId} 错误=${err}`);
        return { rows: [], hasMore: false, error: err };
      }
    })();
    headCache.set(key, p);
  }
  return { key, promise: p };
}

/* ---------------- 按条件取整行（引用选项的联动过滤用） ---------------- */

/** 服务端过滤条件（单元格精确相等） */
export interface ConditionSpec {
  fieldId: string;
  /** 期望的单元格文本 */
  text: string;
}

/**
 * 按「固定值/联动值」条件从服务端取整行（`is` 精确匹配，AND 连接）。
 *
 * 用途：引用选项的省→市联动。若只加载最新 200 条再内存过滤，子级选项会残缺；
 * 改为把父级值作为服务端条件，直接取回**该父级下的全部记录**（通常远小于 200，
 * 1 次请求即完整），既正确又快。
 *
 * 自证：返回记录若不含条件字段的期望值，说明宿主忽略了 filter
 * → 返回 `filterEffective: false`，调用方应回退到「首屏 + 内存过滤」。
 */
export function loadRowsByConditions(
  tableId: string,
  conditions: ConditionSpec[],
  opts?: { label?: string; maxPages?: number }
): { key: string; promise: Promise<HeadResult<FullRow> & { filterEffective: boolean }> } {
  const key = taskKey(tableId, 'cond', conditions.map((c) => `${c.fieldId}=${c.text}`).join('&'));
  let p = headCache.get(key) as
    | Promise<HeadResult<FullRow> & { filterEffective: boolean }>
    | undefined;
  if (!p) {
    p = (async () => {
      const maxPages = opts?.maxPages ?? 50; // 50 * 200 = 1 万，联动字典表足够
      try {
        const table = await getBase().getTableById(tableId);
        const useByPage = typeof (table as any).getRecordsByPage === 'function';
        const rows: FullRow[] = [];
        let token: any;
        let guard = 0;
        let filterEffective = false;
        for (;;) {
          const params: any = {
            pageSize: PAGE_SIZE,
            filter: {
              conjunction: 'and',
              conditions: conditions.map((c) => ({
                fieldId: c.fieldId,
                operator: 'is',
                value: c.text,
              })),
            },
            ...(token !== undefined ? { pageToken: token } : {}),
          };
          const res: any = useByPage
            ? await (table as any).getRecordsByPage(params)
            : await (table as any).getRecords(params);
          const records: any[] = res?.records ?? [];
          for (const rec of records) {
            const fields = (rec.fields ?? {}) as Record<string, unknown>;
            const ok = conditions.every(
              (c) => stringifyCellValue(fields[c.fieldId]).trim() === c.text.trim()
            );
            if (ok) filterEffective = true;
            rows.push({ recordId: rec.recordId, fields });
          }
          guard += 1;
          const next = res?.hasMore ? res?.pageToken : undefined;
          if (next === undefined || next === token || guard >= maxPages) break;
          token = next;
        }
        if (rows.length > 0 && !filterEffective) {
          console.warn('[tableRecords] 条件过滤未生效（返回记录不满足条件）');
        }
        const out = { rows, hasMore: false, filterEffective, total: rows.length };
        resolved.set(key, out);
        return out;
      } catch (e) {
        headCache.delete(key);
        const err = (e as Error)?.message ?? String(e);
        console.warn(
          `[tableRecords] 条件加载失败：表=${tableId} 条件=${opts?.label ?? conditions.length} 错误=${err}`
        );
        return { rows: [], hasMore: false, filterEffective: false, error: err, total: 0 };
      }
    })();
    headCache.set(key, p);
  }
  return { key, promise: p };
}

/* ---------------- 逐页搜索（用户输入关键字时才启动） ---------------- */

export interface SearchHandle<T> {
  /** 取消搜索（组件卸载/关键字变化时调用） */
  cancel: () => void;
  /** 全流程完成（含被取消） */
  done: Promise<void>;
}

export interface SearchOptions {
  /** 命中一批就回调（增量并入候选） */
  onHits: (rows: FieldRow[]) => void;
  /** 进度回调（已翻页数 / 已扫描数） */
  onProgress?: (scanned: number, total?: number) => void;
  /** 最多翻多少页（默认 SEARCH_MAX_PAGES） */
  maxPages?: number;
  /** 附加精确条件（如引用选项的省→市联动），与关键字 AND 组合 */
  extraConditions?: ConditionSpec[];
}

/** 把「附加精确条件」转成服务端 filter 片段 */
function extraCondToFilter(extra?: ConditionSpec[]) {
  return (extra ?? [])
    .filter((c) => c && c.fieldId && (c.text ?? '') !== '')
    .map((c) => ({ fieldId: c.fieldId, operator: 'is', value: c.text }));
}

/**
 * 用服务端关键字过滤逐页查询（`contains`），命中立即回调。
 * - 每页 200 条，翻到 hasMore=false 或达到上限为止；
 * - 可随时 cancel（用户改关键字/关闭下拉）；
 * - **自证**：若某页返回项全都不含关键字，说明该宿主忽略 filter → 立即停止并回退（不采用伪命中）。
 * @returns 搜索句柄（cancel / done）
 */
export function searchAllPages(
  tableId: string,
  fieldId: string,
  keyword: string,
  opts: SearchOptions
): SearchHandle<FieldRow> {
  const kw = (keyword || '').trim();
  let cancelled = false;
  const maxPages = opts.maxPages ?? SEARCH_MAX_PAGES;
  const extraFilter = extraCondToFilter(opts.extraConditions);

  const done = (async () => {
    if (!kw) return;
    let token: any;
    let guard = 0;
    let scanned = 0;
    let hits = 0;
    let sawEffective = false;

    try {
      const table = await getBase().getTableById(tableId);
      const useByPage = typeof (table as any).getRecordsByPage === 'function';
      for (;;) {
        if (cancelled) return;
        const params: any = {
          pageSize: PAGE_SIZE,
          filter: {
            conjunction: 'and',
            conditions: [
              { fieldId, operator: 'contains', value: kw },
              ...extraFilter,
            ],
          },
          ...(token !== undefined ? { pageToken: token } : {}),
        };
        const res: any = useByPage
          ? await (table as any).getRecordsByPage(params)
          : await (table as any).getRecords(params);
        if (cancelled) return;

        const records: any[] = res?.records ?? [];
        const batch: FieldRow[] = [];
        let effectiveThisPage = false;
        for (const rec of records) {
          const text = stringifyCellValue((rec.fields ?? {})[fieldId]);
          if (text.toLowerCase().includes(kw.toLowerCase())) effectiveThisPage = true;
          batch.push({ recordId: rec.recordId, text });
        }
        scanned += records.length;

        if (records.length > 0 && effectiveThisPage) {
          sawEffective = true;
          opts.onHits(batch);
          hits += batch.length;
        } else if (records.length > 0 && !sawEffective) {
          // 首屏就完全不含关键字 → 宿主忽略 filter，停止（避免把全表当命中刷给用户）
          console.warn('[tableRecords] 服务端过滤未生效（返回记录不含关键字），已停止搜索');
          return;
        }

        opts.onProgress?.(scanned, typeof res?.total === 'number' ? res.total : undefined);

        if (hits >= SEARCH_MAX_HITS) return;
        guard += 1;
        const next = res?.hasMore ? res?.pageToken : undefined;
        if (next === undefined || next === token || guard >= maxPages) return;
        token = next;
      }
    } catch (e) {
      console.warn(`[tableRecords] 搜索失败：表=${tableId} 字段=${fieldId} 错误=${(e as Error)?.message ?? e}`);
    }
  })();

  return { cancel: () => { cancelled = true; }, done };
}

/**
 * 引用选项用的「整行」逐页搜索（关键字命中某字段）。
 * 引用选项的联动过滤需要多个字段，故按整行取回。
 */
export function searchAllRows(
  tableId: string,
  fieldId: string,
  keyword: string,
  opts: {
    onHits: (rows: FullRow[]) => void;
    onProgress?: (scanned: number, total?: number) => void;
    maxPages?: number;
    /** 附加精确条件（引用选项联动），与关键字 AND 组合 */
    extraConditions?: ConditionSpec[];
  }
): SearchHandle<FullRow> {
  const kw = (keyword || '').trim();
  let cancelled = false;
  const maxPages = opts.maxPages ?? SEARCH_MAX_PAGES;
  const extraFilter = extraCondToFilter(opts.extraConditions);

  const done = (async () => {
    if (!kw) return;
    let token: any;
    let guard = 0;
    let scanned = 0;
    let hits = 0;
    let sawEffective = false;
    try {
      const table = await getBase().getTableById(tableId);
      const useByPage = typeof (table as any).getRecordsByPage === 'function';
      for (;;) {
        if (cancelled) return;
        const params: any = {
          pageSize: PAGE_SIZE,
          filter: {
            conjunction: 'and',
            conditions: [
              { fieldId, operator: 'contains', value: kw },
              ...extraFilter,
            ],
          },
          ...(token !== undefined ? { pageToken: token } : {}),
        };
        const res: any = useByPage
          ? await (table as any).getRecordsByPage(params)
          : await (table as any).getRecords(params);
        if (cancelled) return;
        const records: any[] = res?.records ?? [];
        const batch: FullRow[] = [];
        let effectiveThisPage = false;
        for (const rec of records) {
          const fields = (rec.fields ?? {}) as Record<string, unknown>;
          const text = stringifyCellValue(fields[fieldId]);
          // 自证：关键字命中 **且** 附加条件全部满足，才算真命中
          const condOk = (opts.extraConditions ?? []).every(
            (c) => stringifyCellValue(fields[c.fieldId]).trim() === c.text.trim()
          );
          if (text.toLowerCase().includes(kw.toLowerCase()) && condOk) effectiveThisPage = true;
          batch.push({ recordId: rec.recordId, fields });
        }
        scanned += records.length;
        if (records.length > 0 && effectiveThisPage) {
          sawEffective = true;
          opts.onHits(batch);
          hits += batch.length;
        } else if (records.length > 0 && !sawEffective) {
          console.warn('[tableRecords] 服务端过滤未生效（返回记录不含关键字），已停止搜索');
          return;
        }
        opts.onProgress?.(scanned, typeof res?.total === 'number' ? res.total : undefined);
        if (hits >= SEARCH_MAX_HITS) return;
        guard += 1;
        const next = res?.hasMore ? res?.pageToken : undefined;
        if (next === undefined || next === token || guard >= maxPages) return;
        token = next;
      }
    } catch (e) {
      console.warn(`[tableRecords] 搜索失败：表=${tableId} 错误=${(e as Error)?.message ?? e}`);
    }
  })();

  return { cancel: () => { cancelled = true; }, done };
}