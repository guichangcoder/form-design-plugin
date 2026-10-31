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
import { getBase, getBaseStrict, getBaseToken, getDashboard, getTableStrict, BASE_NOT_BOUND_MSG } from './appContext';
import { stringifyCellValue, extractOptionTexts } from '../utils/cellText';

/**
 * 🔴 读表统一入口：先做「数据源绑定」校验，再取表实例。
 *
 * 为什么必须统一（2026-10-30 第五轮真根因）：
 * `getBase()` 在绑定失败时会**静默回退宿主默认 base**。此时拿默认 base 去
 * `getTableById(配置里的源表)` 必然查不到，宿主抛出的是一句被降级、无 message 的低层错误
 * （`getRecordsByPage error, msg: undefined code: 12`）——
 * 真实原因是「根本没连上配置所选的 base」，却表现得像「表权限/表不存在」。
 *
 * 这里改成：绑定没成功就**立即抛一个说人话的错误**，
 * 让上层（以及用户看到的错误框）直接显示「未能连接所选多维表格」，
 * 而不是把宿主那句无意义的 `code: 12` 原样透出去。
 */
// ⚠️ 文案只在 appContext 定义一份，这里转出以免两处文案漂移（用户会看到不同说法）。
export { BASE_NOT_BOUND_MSG };

async function getTableForRead(tableId: string): Promise<any> {
  // 统一到 appContext.getTableStrict，避免两套「严格取表」实现各自漂移。
  return await getTableStrict(tableId);
}

/** 分页大小：飞书 SDK 单次上限就是 200，传更大值非法 */
export const PAGE_SIZE = 200;
/** 首屏只加载这么多（最新的一批），不做全量 */
export const HEAD_SIZE = 200;
/** 用户在搜索里最多逐页翻这么多，防止极端表拖死（200 * 1000 = 20 万） */
export const SEARCH_MAX_PAGES = 1000;
/** 搜索累计命中上限 */
export const SEARCH_MAX_HITS = 2000;
/**
 * 条件取数（引用选项联动 / 无条件穷举）的分页上限。
 * 旧值为 50（1 万条），对「上万条符合条件」的场景会静默截断；提到 250 页 = 5 万条。
 * （注：飞书 API 单次 pageSize 上限 200，此处为累计页数。）
 */
export const COND_MAX_PAGES = 250;
/** 只取一列穷举时的分页上限（同 5 万条） */
export const COLUMN_MAX_PAGES = 250;
/** 渐进扫描的时间预算（毫秒）：超过即停并如实标记「可能不全」，避免用户无限等待 */
export const SCAN_TIME_BUDGET_MS = 8000;
/**
 * ★ 选项「渐进全量」扫描的默认上限。
 * 这是**唯一能在所有宿主上都可用**的穷举引擎（基于 getRecordsByPage，
 * 与关联字段选择器同源，实测可用）—— 故选得宽一些，覆盖「上万条源记录」。
 * 200×250 = 5 万条。
 */
export const DISTINCT_SCAN_MAX_PAGES = 250;
/**
 * 渐进全量扫描的时间预算。设得较宽是因为它是**后台渐进**的：
 * 首屏第一页即出结果，用户不必等它跑完；超时只影响「是否标完整」。
 */
export const DISTINCT_SCAN_TIME_BUDGET_MS = 20000;

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

/**
 * 条件取数结果（在 HeadResult 基础上补充「完整性」回报）。
 *
 * ★ 为什么要这些字段：旧实现把 `hasMore` 写死为 false，导致「达到分页上限、
 *   结果其实不全」与「已翻到底、就是这么多」**无法区分** —— 上万条源记录时
 *   会静默丢弃上限之外的数据，界面却显示「全部」。这正是引用选项选项不全的根因。
 */
export interface CondFetchResult extends HeadResult<FullRow> {
  /** 服务端过滤是否真实生效（返回记录经本地自证满足全部条件） */
  filterEffective: boolean;
  /** 是否因达到分页上限而**截断**（true 表示结果可能不完整，需要继续扫描/提高上限） */
  truncated: boolean;
  /** 本次实际扫描过的记录条数（含被条件筛掉的） */
  scanned: number;
  /** 服务端报告的匹配总条数（宿主返回 total 时才有，可用于精确判断是否翻完） */
  serverTotal?: number;
}

/* ---------------- 首屏 200 条（一次请求） ---------------- */

const headCache = new Map<string, Promise<HeadResult<any>>>();
/** 任务键：按「表 + 列 / 行 / 条件 / 选项穷举」维度生成，供缓存查询与测试使用 */
export const taskKey = (tableId: string, kind: 'col' | 'row' | 'cond' | 'optval', fieldId?: string) =>
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
    resolved.clear();
    fieldOptionsCache.clear();
    distinctScanCache.clear();
    return;
  }
  for (const k of [...headCache.keys()]) {
    if (k.split(':').includes(tableId)) headCache.delete(k);
  }
  for (const k of [...resolved.keys()]) {
    if (k.split(':').includes(tableId)) resolved.delete(k);
  }
  for (const k of [...fieldOptionsCache.keys()]) {
    if (k.split(':').includes(tableId)) fieldOptionsCache.delete(k);
  }
  for (const k of [...distinctScanCache.keys()]) {
    if (k.split(':').includes(tableId)) distinctScanCache.delete(k);
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
        const table = await getTableForRead(tableId);
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
        const table = await getTableForRead(tableId);
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
  /**
   * 源表该条件字段的类型。服务端 filter 的「单选」等于条件必须显式带上
   * fieldType 才能正确解析（否则可能被按其它类型处理 → 稳定返回 0 条，
   * 表现为「已按联动条件取回全部 0 条」，即本插件的级联选项空下拉根因）。
   * 缺失时退化为纯文本 is 条件。
   */
  fieldType?: number;
}

/** 由 ConditionSpec 生成服务端 filter 条件（随字段类型选择 operator 与是否带 fieldType） */
function specToFilterCondition(c: ConditionSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { fieldId: c.fieldId, value: c.text };
  if (typeof c.fieldType === 'number') base.fieldType = c.fieldType;
  // 多选：等于语义必须用 contains（一个单元格含多个选项，is 不会命中）
  if (c.fieldType === 4 /* MultiSelect */) {
    return { ...base, operator: 'contains' };
  }
  return { ...base, operator: 'is' };
}

/**
 * 宽松条件：去掉 fieldType、operator 统一用 contains（文本子串）。
 * 当「带类型的 is 条件」返回 0 条时用它复核 —— 若宽松条件能取回记录、
 * 且经本地自证确实满足条件，说明原 typed 条件被宿主误解析（假空），
 * 采用复核结果；若仍为 0 条，才认定为「该条件下确实无记录」。
 */
function specToLooseCondition(c: ConditionSpec): Record<string, unknown> {
  return { fieldId: c.fieldId, operator: 'contains', value: c.text };
}

/** 本地自证：该记录的条件字段文本是否满足该条件（不依赖 filter 是否生效） */
function recordSatisfiesCondition(fields: Record<string, unknown>, c: ConditionSpec): boolean {
  const got = stringifyCellValue(fields[c.fieldId]).trim();
  const want = c.text.trim();
  if (!want) return false;
  if (got === want) return true;
  // 多选单元格文本形如「A B」→ 用包含判断「含该选项」。
  // ★ 类型**未记录**（旧配置 / 多选条件字段未持久化 sourceFieldType）时同样走分词：
  //   对单值等价（"企企云" → ["企企云"]），对多值正确 —— 否则多选条件字段会让
  //   所有记录都被筛掉 → 假空（下拉显示「已按条件穷举全部 0 个选项」）。
  if (c.fieldType === 4 /* MultiSelect */ || c.fieldType === undefined) {
    const parts = got.split(/\s+/).filter(Boolean);
    return parts.includes(want);
  }
  return false;
}

/**
 * 本地**宽松**自证：单元格文本「包含」期望值。
 *
 * 与 `specToLooseCondition` 配对使用：宽松条件在服务端就是 contains，
 * 若这里仍用严格相等，会把「contains 命中的近似行」误判成「过滤未生效」。
 */
function recordSatisfiesLoose(fields: Record<string, unknown>, c: ConditionSpec): boolean {
  const got = stringifyCellValue(fields[c.fieldId]).trim();
  const want = c.text.trim();
  if (!want) return false;
  return got.includes(want);
}

/**
 * 按给定的 filter 条件拉取整行（分页到底，带上限保护）。
 *
 * ★ 关键修复：明确区分「翻到底」与「撞上限」——
 *   - stopReason='end'        → 服务端已无更多（结果完整）
 *   - stopReason='maxPages'   → 达到页数上限被截断（结果可能不全，须如实上报）
 *   - stopReason='stalled'    → pageToken 不再前进（宿主异常，按截断处理）
 * @returns { rows, filterEffective, total, scanned, truncated }
 */
async function fetchRowsWithFilter(
  table: any,
  useByPage: boolean,
  conditions: ConditionSpec[],
  toCondition: (c: ConditionSpec) => Record<string, unknown>,
  maxPages: number
): Promise<{
  rows: FullRow[];
  filterEffective: boolean;
  total?: number;
  scanned: number;
  truncated: boolean;
}> {
  const rows: FullRow[] = [];
  let token: any;
  let guard = 0;
  let filterEffective = false;
  let total: number | undefined;
  let scanned = 0;
  let truncated = false;
  for (;;) {
    const params: any = {
      pageSize: PAGE_SIZE,
      filter: { conjunction: 'and', conditions: conditions.map(toCondition) },
      ...(token !== undefined ? { pageToken: token } : {}),
    };
    const res: any = useByPage
      ? await (table as any).getRecordsByPage(params)
      : await (table as any).getRecords(params);
    if (typeof res?.total === 'number') total = res.total;
    const records: any[] = res?.records ?? [];
    scanned += records.length;
    for (const rec of records) {
      const fields = (rec.fields ?? {}) as Record<string, unknown>;
      if (conditions.every((c) => recordSatisfiesCondition(fields, c))) filterEffective = true;
      rows.push({ recordId: rec.recordId, fields });
    }
    guard += 1;
    const next = res?.hasMore ? res?.pageToken : undefined;
    if (next === undefined) break; // 翻到底：结果完整
    if (next === token) {
      // pageToken 不前进 → 宿主异常，按截断处理（否则会死循环）
      truncated = true;
      break;
    }
    if (guard >= maxPages) {
      truncated = true; // 撞上限：**必须标记截断**，调用方据此继续扫描或提示
      break;
    }
    token = next;
  }
  return { rows, filterEffective, total, scanned, truncated };
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
): { key: string; promise: Promise<CondFetchResult> } {
  // ★ 缓存 key 用 JSON 编码：条件文本里若含 = / & 时，字符串拼接会解析错位（历史坑）。
  const key = taskKey(tableId, 'cond', JSON.stringify(conditions.map((c) => [c.fieldId, c.fieldType, c.text])));
  let p = headCache.get(key) as Promise<CondFetchResult> | undefined;
  if (!p) {
    p = (async (): Promise<CondFetchResult> => {
      // 上限从旧的 50 页（1 万）提高到 COND_MAX_PAGES（5 万），覆盖「上万条符合条件」的场景；
      // 仍保留熔断，避免极端表把页面拖死。
      const maxPages = opts?.maxPages ?? COND_MAX_PAGES;
      try {
        const table = await getTableForRead(tableId);
        const useByPage = typeof (table as any).getRecordsByPage === 'function';

        // —— 第一级：带字段类型的精确条件（单选 is / 多选 contains）——
        let { rows, filterEffective, total, scanned, truncated } = await fetchRowsWithFilter(
          table,
          useByPage,
          conditions,
          specToFilterCondition,
          maxPages
        );

        // —— 第二级：第一级 0 条时的宽松复核 ——
        // 关键：宿主可能因条件格式（fieldType/operator）不匹配而稳定返回 0 条，
        // 若直接采信就会「假空」——正是级联选项下拉为空的根因。
        // 用去掉类型、统一 contains 的宽松条件重试；只有宽松条件也 0 条，
        // 才认定「该条件下确实无记录」。
        if (rows.length === 0) {
          const loose = await fetchRowsWithFilter(
            table,
            useByPage,
            conditions,
            specToLooseCondition,
            maxPages
          );
          if (loose.rows.length > 0 && loose.filterEffective) {
            console.warn(
              '[tableRecords] 精确条件返回 0 条但宽松条件命中，采用复核结果（条件格式兼容回退）'
            );
            rows = loose.rows;
            filterEffective = true;
            total = loose.total;
            scanned = loose.scanned;
            truncated = loose.truncated;
          } else if (loose.rows.length === 0) {
            // 两级都空 → 该条件下确实无记录（正常业务态，非缺陷）
            total = total ?? loose.total ?? 0;
            scanned = loose.scanned;
            truncated = false;
          }
        }

        if (rows.length > 0 && !filterEffective) {
          console.warn('[tableRecords] 条件过滤未生效（返回记录不满足条件）');
        }
        if (truncated) {
          console.warn(
            `[tableRecords] 条件取数达到上限被截断：表=${tableId} 已取 ${rows.length} 条 / 上限 ${maxPages} 页，结果可能不完整`
          );
        }
        const out: CondFetchResult = {
          rows,
          hasMore: truncated, // ★ 如实反映：截断了才算「还有更多」，不再写死 false
          filterEffective,
          truncated,
          scanned,
          serverTotal: typeof total === 'number' ? total : undefined,
          total: rows.length,
        };
        resolved.set(key, out);
        return out;
      } catch (e) {
        headCache.delete(key);
        // ★ 条件被宿主拒绝（如 operator/fieldType 不适用于该字段）→ 不缓存，
        //   让调用方按 filterEffective=false 回退「首屏 + 内存过滤」，功能不至于整体失效。
        const err = (e as Error)?.message ?? String(e);
        console.warn(
          `[tableRecords] 条件加载失败（将回退本地过滤）：表=${tableId} 条件=${opts?.label ?? conditions.length} 错误=${err}`
        );
        return {
          rows: [],
          hasMore: false,
          filterEffective: false,
          truncated: false,
          scanned: 0,
          error: err,
          total: 0,
        };
      }
    })();
    headCache.set(key, p);
  }
  return { key, promise: p };
}

/* ---------------- 有条件「直接查询」穷举（引用选项的快速路径） ---------------- */

/** 有条件直接查询穷举的结果 */
export interface QueryDistinctResult {
  /** 去重后的取值（保序） */
  values: string[];
  /** 是否已完整（翻到底 / 选项域已找齐） */
  complete: boolean;
  /** 是否撞页数/时间上限（true = 结果可能不全） */
  truncated: boolean;
  /** 已读取的记录数（= 满足条件的行数） */
  scanned: number;
  /** 服务端报告的匹配总行数（宿主返回时才有） */
  total?: number;
  /** 是否可信（服务端过滤经本地自证生效）。false → 调用方必须回退扫描 */
  trusted: boolean;
  error?: string;
}

/**
 * ★ 有条件时的**快速路径**：带条件「直接查询」匹配行，本地自证后取去重取值。
 *
 * 为什么需要（2026-10-21 用户实测反馈）：
 * 症状 = 选中上级字段后，子级下拉长时间停在「正在穷举选项…已扫描 0 条」，很久才出选项。
 * 根因 = 旧实现在有条件下**首选逐项存在性探测**，其请求次数 = **选项域大小**：
 *        200 个模组 → 200 次请求（并发 8，按 200ms/请求 ≈ 5s）；
 *        若宿主对 typed 条件「假空」，还要再跑 200 次宽松复核才回退 → 400 次请求 ≈ 10s；
 *        且探测阶段**没有任何扫描进度回调** → UI 全程显示「已扫描 0 条」，用户以为卡死。
 * 而用户的直觉是对的：**有了条件直接查一次就够了** ——
 *        「命中 30 行」= 1 页即完（1 次请求），比 200 次探测快两个数量级。
 *
 * 做法：
 *   - filter 只放**条件字段**（我们要的是「该条件下出现过的全部取值」），不带取值字段；
 *   - 每页取回后**逐行本地自证**（必须满足全部条件），任一返回行不满足 → 判定宿主
 *     忽略/误解析 filter → `trusted:false`，交由调用方回退扫描（绝不采信伪命中）；
 *   - 逐页 `onValue` 渐进产出 + `onProgress` 上报进度（UI 底部灰字即时推进，不再「0 条」）；
 *   - **早退**：取值字段是单选/多选时取值必属选项域，declared 全部找齐即判完整；
 *   - 精确条件 0 条 → 用宽松条件（去 fieldType、统一 contains）复核一次；
 *     两级都 0 条仍**不采信**（防「假空」），交由调用方回退扫描确认。
 */
export function queryDistinctByConditions(
  tableId: string,
  valueFieldId: string,
  conditions: ConditionSpec[],
  opts?: {
    valueFieldType?: number;
    /** 已知的取值字段选项域（用于「找齐即完整」早退） */
    declaredOptions?: string[];
    /** 渐进回调：每发现一个新取值即回调 */
    onValue?: (v: string) => void;
    /** 进度回调：已读取行数 / 匹配总行数 */
    onProgress?: (scanned: number, total?: number) => void;
    maxPages?: number;
    timeBudgetMs?: number;
  }
): { key: string; cancel: () => void; promise: Promise<QueryDistinctResult> } {
  let cancelled = false;
  const maxPages = opts?.maxPages ?? COND_MAX_PAGES;
  const timeBudgetMs = opts?.timeBudgetMs ?? DISTINCT_SCAN_TIME_BUDGET_MS;
  const declared = opts?.declaredOptions ?? [];
  const seen = new Set<string>();
  const startedAt = Date.now();

  const promise = (async (): Promise<QueryDistinctResult> => {
    try {
      const table = await getTableForRead(tableId);
      const useByPage = typeof (table as any).getRecordsByPage === 'function';

      /** 按给定条件构造方式与自证方式拉取（strict / loose 共用） */
      const pull = async (
        toCond: (c: ConditionSpec) => Record<string, unknown>,
        selfTest: (fields: Record<string, unknown>, c: ConditionSpec) => boolean
      ): Promise<QueryDistinctResult> => {
        const out: QueryDistinctResult = {
          values: [],
          complete: false,
          truncated: false,
          scanned: 0,
          trusted: false,
        };
        let token: any;
        let guard = 0;
        let truncated = false;
        for (;;) {
          if (cancelled) break;
          const params: any = {
            pageSize: PAGE_SIZE,
            filter: { conjunction: 'and', conditions: conditions.map(toCond) },
            ...(token !== undefined ? { pageToken: token } : {}),
          };
          const res: any = useByPage
            ? await (table as any).getRecordsByPage(params)
            : await (table as any).getRecords(params);
          if (cancelled) break;
          if (typeof res?.total === 'number') out.total = res.total;
          const records: any[] = res?.records ?? [];
          out.scanned += records.length;
          // ★ 整页先校验、再提交：避免「不可信页」的取值已经被 onValue 发出去（UI 污染）
          const pageTexts: string[] = [];
          let pageOk = true;
          for (const rec of records) {
            const fields = (rec.fields ?? {}) as Record<string, unknown>;
            if (!conditions.every((c) => selfTest(fields, c))) {
              pageOk = false;
              break;
            }
            for (const t of extractOptionTexts(fields[valueFieldId], opts?.valueFieldType)) {
              if (t) pageTexts.push(t);
            }
          }
          if (!pageOk) {
            console.warn('[tableRecords] 直接查询返回的行不满足条件 → 判定宿主未按条件过滤，回退扫描');
            return { ...out, values: [], trusted: false, error: 'filter-ineffective' };
          }
          for (const t of pageTexts) {
            if (!seen.has(t)) {
              seen.add(t);
              opts?.onValue?.(t);
            }
          }
          opts?.onProgress?.(out.scanned, out.total);
          // ★ 早退：单选/多选取值字段的取值必属选项域 → declared 全部找齐即完整
          if (declared.length > 0 && declared.every((o) => seen.has(o))) {
            return { ...out, values: Array.from(seen), complete: true, truncated: false, trusted: true };
          }
          guard += 1;
          const next = res?.hasMore ? res?.pageToken : undefined;
          if (next === undefined || next === token) break; // 翻到底 → 完整
          if (guard >= maxPages) {
            truncated = true;
            break;
          }
          if (Date.now() - startedAt > timeBudgetMs) {
            truncated = true;
            break;
          }
          token = next;
        }
        if (cancelled) {
          return { ...out, values: Array.from(seen), complete: false, truncated: true, trusted: true };
        }
        return { ...out, values: Array.from(seen), complete: !truncated, truncated, trusted: true };
      };

      // 第一级：带字段类型的精确条件
      const strict = await pull(specToFilterCondition, recordSatisfiesCondition);
      if (!strict.trusted) return strict; // 过滤未生效 → 交由调用方回退扫描
      // 第二级：精确条件 0 条 → 宽松复核（宿主可能对 typed 条件稳定返 0 条 = 假空）
      if (strict.scanned === 0) {
        const loose = await pull(specToLooseCondition, recordSatisfiesLoose);
        if (loose.trusted && loose.scanned > 0) {
          console.warn(
            '[tableRecords] 直接查询：精确条件 0 条、宽松条件命中 → 采用复核结果（条件格式兼容回退）'
          );
          return loose;
        }
        // 两级都 0 条：**不采信**（可能是假空）→ 交由调用方回退扫描做最终确认
        console.warn('[tableRecords] 直接查询两级皆 0 条，交由调用方回退扫描确认');
        return { ...strict, trusted: false, error: 'query-empty' };
      }
      return strict;
    } catch (e) {
      const err = (e as Error)?.message ?? String(e);
      console.warn(`[tableRecords] 直接查询穷举失败（将回退扫描）：表=${tableId} 错误=${err}`);
      return { values: [], complete: false, truncated: false, scanned: 0, trusted: false, error: err };
    }
  })();

  const key = taskKey(
    tableId,
    'cond',
    JSON.stringify([
      'querydistinct',
      valueFieldId,
      opts?.valueFieldType ?? 0,
      conditions.map((c) => [c.fieldId, c.fieldType, c.text]),
    ])
  );
  return { key, cancel: () => { cancelled = true; }, promise };
}

/* ---------------- 有界本地扫描兜底（条件在服务端反复失效时） ---------------- */

/** 本地扫描兜底的分页上限（40 * 200 = 8000 条，覆盖常见字典表且不拖死页面） */
export const LOCAL_SCAN_MAX_PAGES = 40;

/**
 * 按条件做「有界本地扫描」：分页拉取源表记录，本地筛出满足条件的整行。
 *
 * 用途：当带类型的精确条件与宽松条件**都**取不到数据时，若判定为宿主对 filter
 * 支持不完整（假空），用此兜底 —— 只要有权限读表就能拿到该父级下的记录，
 * 使级联选项不至于整体失效。有上限保护（8000 条），到顶即停。
 *
 * ★ 同时被「选项完整枚举」复用（`scanDistinctValues`）：
 *   它用的是**已验证可用**的 `getRecordsByPage`（关联字段选择器就是这个接口，实测可用），
 *   因此是穷举引用选项最可靠的引擎 —— 不依赖 `getFieldValueListByPage` / 字段选项域。
 */
export function scanRowsByConditionsLocal(
  tableId: string,
  conditions: ConditionSpec[],
  opts?: {
    maxPages?: number;
    /** 时间预算（毫秒）：超过即停并标 truncated，避免用户无限等待 */
    timeBudgetMs?: number;
    onRows?: (rows: FullRow[]) => void;
    /** 进度回调：已扫描记录数 / 服务端总数（宿主返回时才有） */
    onProgress?: (scanned: number, total?: number) => void;
  }
): {
  cancel: () => void;
  done: Promise<{ rows: FullRow[]; truncated: boolean; scanned: number; total?: number; error?: string }>;
} {
  const maxPages = opts?.maxPages ?? LOCAL_SCAN_MAX_PAGES;
  const timeBudgetMs = opts?.timeBudgetMs;
  const startedAt = Date.now();
  let cancelled = false;

  const done = (async () => {
    const rows: FullRow[] = [];
    let truncated = false;
    let scanned = 0;
    let total: number | undefined;
    try {
      const table = await getTableForRead(tableId);
      const useByPage = typeof (table as any).getRecordsByPage === 'function';
      let token: any;
      let guard = 0;
      for (;;) {
        if (cancelled) return { rows, truncated, scanned, total };
        const params: any = {
          pageSize: PAGE_SIZE,
          ...(token !== undefined ? { pageToken: token } : {}),
        };
        const res: any = useByPage
          ? await (table as any).getRecordsByPage(params)
          : await (table as any).getRecords(params);
        if (cancelled) return { rows, truncated, scanned, total };
        if (typeof res?.total === 'number') total = res.total;
        const batch: FullRow[] = [];
        for (const rec of res?.records ?? []) {
          const fields = (rec.fields ?? {}) as Record<string, unknown>;
          if (!conditions.every((c) => recordSatisfiesCondition(fields, c))) continue;
          batch.push({ recordId: rec.recordId, fields });
        }
        scanned += (res?.records ?? []).length;
        if (batch.length) {
          rows.push(...batch);
          opts?.onRows?.(batch);
        }
        opts?.onProgress?.(scanned, total);
        guard += 1;
        const next = res?.hasMore ? res?.pageToken : undefined;
        if (next === undefined || next === token) break;
        if (guard >= maxPages) {
          truncated = true;
          break;
        }
        if (timeBudgetMs && Date.now() - startedAt > timeBudgetMs) {
          truncated = true; // 超时：如实标记（不静默）
          break;
        }
        token = next;
      }
      if (truncated) {
        console.warn(
          `[tableRecords] 本地扫描达到上限（${maxPages} 页 / ${timeBudgetMs ?? '-'}ms），结果可能不完整`
        );
      }
      return { rows, truncated, scanned, total };
    } catch (e) {
      console.warn(
        `[tableRecords] 本地扫描兜底失败：表=${tableId} 错误=${(e as Error)?.message ?? e}`
      );
      // ★ 必须把失败如实带出去：第 0 页就抛错时 truncated 仍是 false，
      //   若这里只 return {truncated:false}，上层会判定「complete=true + 0 个选项」
      //   并把这个「空且完整」的结论写进 distinctScanCache（无 TTL），
      //   于是整表不可读 = 该字段永远没有选项，刷新前都不再重试。
      return {
        rows,
        truncated,
        scanned,
        total,
        error: (e as Error)?.message ?? String(e),
      };
    }
  })();

  return { cancel: () => { cancelled = true; }, done };
}

/* ---------------- 选项「渐进全量」扫描（引用选项的完整性引擎） ---------------- */

/** 选项渐进全量扫描结果 */
export interface DistinctScanResult {
  /** 已扫描出的去重取值（保序） */
  values: string[];
  /** 是否翻到底（true = 该条件下取值已穷举完整） */
  complete: boolean;
  /** 是否因页数/时间上限被截断 */
  truncated: boolean;
  /** 已扫描记录数 */
  scanned: number;
  /** 服务端总数（宿主返回时才有） */
  total?: number;
  /** 扫描失败原因（有值即「本次扫描没扫完」，结果不可当作完整空集） */
  error?: string;
}

/**
 * ★ 扫描结果是否「完整」—— 纯函数，供回归测试真实调用。
 *
 * 🔴 判定绝不能等同于 `!truncated`：
 *   扫描第 0 页就抛错（`table permission denied error` / `code:12`）时
 *   `truncated` 仍是 `false`，若用 `!truncated` 会得出「0 个选项，且完整」，
 *   写进无 TTL 的 `distinctScanCache` 后就变成**该字段永远没有选项** ——
 *   用户刷新页面之外无路可退（本项目 2026-10-30 真实缺陷）。
 *
 * 判定顺序：
 *   ① 有 error → 不完整（唯一的「硬否决」，优先于一切）；
 *   ② 找齐即停（选项域全部命中）→ 完整（不受页数/时间预算影响）；
 *   ③ 其余看 truncated。
 */
export function isScanComplete(r: {
  truncated?: boolean;
  error?: string;
  stoppedEarly?: boolean;
} | null | undefined): boolean {
  if (!r) return false;
  if (typeof r.error === 'string' && r.error.length > 0) return false;
  if (r.stoppedEarly === true) return true;
  return r.truncated !== true;
}

/**
 * ★ 扫描结果是否可以进缓存 —— 纯函数，供回归测试真实调用。
 *
 * 🔴 为什么不能只看 `complete`（2026-10-30 第六轮实证缺陷）：
 * 「扫完、没抛错、0 条记录」会被判成 `complete: true`。若把这个**假空**结果
 * 写进 `distinctScanCache`（无 TTL、刷新才清），该字段就会在本次会话内
 * **永久显示 0 个选项** —— 用户重试、重新展开下拉都没用，只能刷页面。
 *
 * 判定规则：
 *   · 未完整 / 有 error → 不缓存（结果不可信）
 *   · 有取值 → 缓存（值本身就是证据）
 *   · 空取值 + 有条件 → 不缓存（"该条件下没匹配行"极易随数据变化而失效）
 *   · 空取值 + 无条件：
 *       - 扫到 0 条且服务端确认总数为 0（或未报总数）→ 可缓存（表确实是空）
 *       - 扫到 0 条但服务端说有 N>0 条 → 不缓存（是读不到，不是真没有）
 *       - 扫到 >0 条却没有值 → 不缓存（字段 ID 可能已失效，重试才有机会恢复）
 */
export function shouldCacheScanResult(
  r:
    | {
        values: string[];
        complete: boolean;
        scanned: number;
        total?: number;
        error?: string;
        /** ★ 空结果被定性为「读不到 / 字段失效」时不为空 → 这种情况绝不能缓存 */
        errorCode?: string;
      }
    | null
    | undefined,
  conditionCount: number
): boolean {
  if (!r || r.complete !== true) return false;
  if (typeof r.error === 'string' && r.error.length > 0) return false;
  // ★ 即使调用方没带 error 文案，只要定性过「这不是真没有」就不缓存
  if (typeof r.errorCode === 'string' && r.errorCode.length > 0) return false;
  if (r.values.length > 0) return true;
  // 以下都是「空取值」
  if (conditionCount > 0) return false;
  if (r.scanned > 0) return false; // 有记录却取不到值 → 疑字段失效
  if (typeof r.total === 'number' && r.total > 0) return false; // 服务端说有，却读不到
  return true; // 表确实为空
}

/** 已完成扫描的缓存（键含条件，避免重复全表扫描） */
const distinctScanCache = new Map<string, Promise<DistinctScanResult>>();

/**
 * ★ 引用选项「渐进全量」扫描 —— 本插件穷举选项的**主引擎**。
 *
 * 为什么是它：关联字段选择器（实测满足用户要求）用的就是 `getRecordsByPage` 分页；
 * 本函数沿用**同一套已验证可用**的分页方式，逐页收集「取值字段的去重文本」，
 * 并在本地对每条记录**自证**条件（不信任宿主 filter），因此：
 *   - 只能读到宿主实际返回的记录（= 打开者权限内），多读无害；
 *   - 逐页回调 → **首屏秒出、后台续扫**（不需要用户干等）；
 *   - 翻到 hasMore=false 才是「完整」；撞页数/时间上限则 truncated=true（如实上报）。
 *
 * 无条件时等价于「全表取值去重」；有条件时等价于「该条件下取值去重」。
 */
export function scanDistinctValues(
  tableId: string,
  fieldId: string,
  conditions: ConditionSpec[],
  opts?: {
    onValue?: (v: string) => void;
    onProgress?: (scanned: number, total?: number) => void;
    maxPages?: number;
    timeBudgetMs?: number;
    /** 复用已完成的扫描结果（默认 true） */
    useCache?: boolean;
    /**
     * ★ 取值字段的字段类型：多选（4）时单元格形如 `[{text:'A'},{text:'B'}]` 代表
     * **两个独立选项**，需拆开输出（可被引用到单选控件）；缺省按单值处理。
     */
    valueFieldType?: number;
    /**
     * ★ 取值字段的**选项域**（仅单选/多选有）。给出时启用**找齐即停**优化：
     * 单选/多选的取值必属选项域 → 一旦选项域内每一项都已在扫描中命中，
     * 即证明已完整（继续扫描不可能再产出新取值）→ 立即结束并标 `complete:true`。
     *
     * 为什么重要：宿主对 typed 条件「假空」时必须回退扫描；若命中行的取值恰好
     * 集中在源表前几页，找齐即停能避免把整张大表（上万行）白扫一遍
     * —— 从「秒级到十几秒」降到「一两页」。
     *
     * 不传此参数则行为与之前完全一致（翻到底才算完整）。
     */
    declaredOptions?: string[];
  }
): { key: string; cancel: () => void; promise: Promise<DistinctScanResult> } {
  const key = taskKey(
    tableId,
    'cond',
    JSON.stringify([
      'distinct',
      fieldId,
      opts?.valueFieldType ?? 0,
      conditions.map((c) => [c.fieldId, c.fieldType, c.text]),
    ])
  );
  const useCache = opts?.useCache !== false;
  if (useCache) {
    const cached = distinctScanCache.get(key);
    if (cached) {
      // 命中缓存：同步推一次已缓存值，让 UI 立即完整（避免重复扫表）
      cached.then((r) => r.values.forEach((v) => opts?.onValue?.(v))).catch(() => {});
      return { key, cancel: () => {}, promise: cached };
    }
  }

  const declared = (opts?.declaredOptions ?? []).filter(Boolean);
  const seen = new Set<string>();
  const values: string[] = [];
  let stoppedEarly = false;
  const h = scanRowsByConditionsLocal(tableId, conditions, {
    maxPages: opts?.maxPages,
    timeBudgetMs: opts?.timeBudgetMs,
    onProgress: opts?.onProgress,
    onRows: (rows) => {
      for (const r of rows) {
        // ★ 多选取值字段：一个单元格可含多个选项 → 逐个拆出（否则会被 join 成一个假选项）
        const texts = extractOptionTexts(r.fields[fieldId], opts?.valueFieldType);
        for (const t of texts) {
          if (t && !seen.has(t)) {
            seen.add(t);
            values.push(t);
            opts?.onValue?.(t);
          }
        }
      }
      // ★ 找齐即停：单选/多选取值必属选项域，选项域全部命中 = 已完整
      if (declared.length > 0 && declared.every((o) => seen.has(o))) {
        stoppedEarly = true;
        h.cancel();
      }
    },
  });

  const promise = h.done.then((r) => {
    // 找齐即停时不受页数/时间预算影响，结果本身就是完整的
    const truncated = stoppedEarly ? false : r.truncated;
    const out: DistinctScanResult = {
      values,
      // ★ 必须用纯函数判定：扫描抛错时 truncated=false 但**绝不完整**。
      complete: isScanComplete({ truncated, error: r.error, stoppedEarly }),
      truncated,
      scanned: r.scanned,
      total: r.total,
      error: r.error,
    };
    // ★ 只缓存「真·完整且值得信任」的结果。
    //
    // 🔴 这里曾是「一次读不到 = 该字段永远没有选项」的固化点（2026-10-30 第六轮）：
    //   扫到 0 条但没抛错时 out.complete 为 true → 假空结果被写进无 TTL 的
    //   distinctScanCache → 刷新前无论重试多少次，都直接命中这份「空且完整」。
    //   用户感受就是「怎么试都不行」。
    //   现在改由纯函数 `shouldCacheScanResult` 判定：空结果只有在拿到
    //   「表确实为空」的正面证据时才允许缓存，其余一律不缓存（下次会重扫）。
    if (useCache && shouldCacheScanResult(out, conditions.length)) {
      distinctScanCache.set(key, Promise.resolve(out));
    }
    return out;
  });

  return { key, cancel: h.cancel, promise };
}

/* ---------------- 选项穷举（引用选项「完整枚举」路径） ---------------- */
/**
 * ★ 为什么需要这一层（本轮 Bug 3 的根因修复）：
 *
 * 症状：源表记录数上万，配置引用条件后需要「该条件下全部去重取值」作为选项，
 *      实际只出来了前 200 条对应的选项，选项不全。
 *
 * 根因：旧实现把「候选」等同于「按条件取回的行」——
 *      - 无条件下只读最新 200 行（设计如此）；
 *      - 有条件下按行分页取，旧上限仅 50 页 = 1 万条，且 `hasMore` 被写死 false，
 *        撞上限后**静默丢弃**，界面仍显示「全部」。
 *
 * 关键洞察：**要穷举的是「选项」而不是「记录」**。
 *      当取值字段是单选/多选时，其选项域已由字段配置（property.options）完整定义，
 *      任何记录的取值必然是其中之一 —— 于是「该条件下有哪些选项」
 *      等价于「对选项域中每一项，是否存在一条满足条件的记录」。
 *      用 pageSize=1 的存在性探测（每个候选 1 次轻量请求）即可**完整**回答，
 *      既不扫描全表、也天然无截断风险。
 *
 * 自证：每次探测都取回整行，本地复核「条件全部满足 且 取值确为该选项」；
 *      若返回记录不满足 → 判定宿主忽略了 filter，放弃探测路径并回退按行取数。
 */

/** 值字段的「配置选项域」（仅单选/多选字段有） */
export interface FieldOptionsResult {
  /** 该字段配置的全部选项文本（保序、去重） */
  options: string[];
  /** 字段类型（缺失=未找到该字段） */
  type?: number;
  /** 是否为「单选/多选」字段（false 表示该字段没有可穷举的选项域） */
  found: boolean;
  error?: string;
}

const fieldOptionsCache = new Map<string, Promise<FieldOptionsResult>>();

/**
 * ★ 失败结果是否允许进缓存 —— 纯函数，供回归测试真实调用。
 *
 * 🔴 只缓存「读到了真东西」的结果（`found: true`）。
 *   - `error` 非空 = 整表/字段不可访问（`table permission denied error` /
 *     `partial_view_api_error` / `code:12`）→ **绝不能缓存**。
 *     否则「一次权限抖动」会被固化成「这个字段永远没有选项」，
 *     且本插件的缓存是**进程内、无 TTL** 的 —— 用户之后点刷新/重试都拿不到，
 *     只有整页重载才恢复，表现为「功能时好时坏、只能重开」。
 *   - `found: false` 且无 error = 字段确实不存在 / 不是单选多选 → 这是**稳定事实**，
 *     缓存可省掉重复的元信息请求。
 *   - `found: true` + 空 options = 字段存在但选项域为空，同样是稳定事实。
 *
 * 判断顺序刻意是「先看 error」：`error` 分支同样返回 `found: false`，
 * 若先按 `found === false → 不缓存` 写会漏掉一类，若先按 `found === false → 缓存`
 * 则会把错误长期固化（本项目真实缺陷）。
 */
export function shouldCacheFieldOptions(r: FieldOptionsResult | null | undefined): boolean {
  if (!r || typeof r !== 'object') return false;
  // ① 读取抛错 → 临时性故障，不缓存（下次调用重新尝试）
  if (typeof r.error === 'string' && r.error.length > 0) return false;
  // ② 稳定事实：字段存在且是单选/多选
  if (r.found === true) return true;
  // ③ 稳定事实：字段存在但不是单选/多选（此时 type 一定有值）
  if (typeof r.type === 'number') return true;
  // ④ 字段根本没找到（type 缺失、无 error）→ 可能是 meta 尚未就绪，不缓存
  return false;
}

/**
 * 读取源表某字段「配置的选项域」。
 * 只用 `getFieldMetaList`（1 次请求、0 次记录读取）—— 这是穷举选项的基础。
 *
 * ⚠️ 缓存策略见 `shouldCacheFieldOptions`：失败结果不进缓存。
 */
export function loadFieldSelectOptions(
  tableId: string,
  fieldId: string,
  opts?: { force?: boolean }
): { key: string; promise: Promise<FieldOptionsResult> } {
  const key = taskKey(tableId, 'optval', `meta:${fieldId}`);
  if (opts?.force) fieldOptionsCache.delete(key);
  let p = fieldOptionsCache.get(key);
  if (!p) {
    p = (async (): Promise<FieldOptionsResult> => {
      try {
        const table = await getTableForRead(tableId);
        const metas: any[] = await table.getFieldMetaList();
        const meta = (metas ?? []).find((m) => m?.id === fieldId);
        if (!meta) return { options: [], found: false };
        // 3=SingleSelect 4=MultiSelect
        const isSelect = meta.type === 3 || meta.type === 4;
        if (!isSelect) return { options: [], type: meta.type, found: false };
        const list: any[] = meta?.property?.options ?? [];
        const names: string[] = [];
        const seen = new Set<string>();
        for (const o of list) {
          const name = typeof o?.name === 'string' ? o.name : '';
          if (name && !seen.has(name)) {
            seen.add(name);
            names.push(name);
          }
        }
        return { options: names, type: meta.type, found: true };
      } catch (e) {
        const err = (e as Error)?.message ?? String(e);
        console.warn(`[tableRecords] 读取字段选项域失败：表=${tableId} 字段=${fieldId} 错误=${err}`);
        return { options: [], found: false, error: err };
      }
    })();
    // ★ 失败不进缓存：结果 resolved 后按纯函数判定是否保留，失败者立即 evict。
    //   用 `.then` 而非直接 set，才能拿到最终结果；evict 时比对同一个 Promise 实例，
    //   避免把并发调用方刚写入的新请求误删。
    fieldOptionsCache.set(key, p);
    p.then((r) => {
      if (!shouldCacheFieldOptions(r) && fieldOptionsCache.get(key) === p) {
        fieldOptionsCache.delete(key);
      }
    }).catch(() => {
      if (fieldOptionsCache.get(key) === p) fieldOptionsCache.delete(key);
    });
  }
  return { key, promise: p };
}

/** 单选项存在性探测结果 */
export interface ProbeResult {
  /** 是否存在「满足全部条件 且 取值等于该选项」的记录 */
  exists: boolean;
  /** 服务端过滤经本地自证是否生效（返回记录确实满足条件与取值） */
  effective: boolean;
  error?: string;
}

/** 「取值字段等于该选项」的服务端条件（随字段类型选择 operator） */
function optionMatchCondition(
  valueFieldId: string,
  optionText: string,
  valueFieldType?: number
): Record<string, unknown> {
  const base: Record<string, unknown> = { fieldId: valueFieldId, value: optionText };
  if (typeof valueFieldType === 'number') base.fieldType = valueFieldType;
  // 多选单元格含多个选项 → 等于语义必须用 contains（is 不会命中）；单选用 is
  if (valueFieldType === 4 /* MultiSelect */) return { ...base, operator: 'contains' };
  return { ...base, operator: 'is' };
}

/**
 * 探测「是否存在满足全部条件、且取值字段等于该选项的记录」。
 * 只取 1 条（pageSize=1），并**取回整行做本地自证**：
 * 既校验该行确实满足全部条件，又校验其取值确实是该选项 → 结果可信、可解释。
 */
export function probeOptionExists(
  tableId: string,
  valueFieldId: string,
  optionText: string,
  conditions: ConditionSpec[],
  valueFieldType?: number,
  opts?: {
    /**
     * 宽松模式（用于「精确条件全未命中」时的复核）：
     * 条件与值字段匹配都**去掉 fieldType、统一用 contains**。
     *
     * 为什么需要：宿主可能因 typed 条件（`is` + fieldType）格式不被支持而**稳定返回 0 条**
     * ——此时逐项探测全部 miss，若直接采信就会「假空」（UI 显示「已按条件穷举全部 0 个选项」）。
     * 与 `loadRowsByConditions` 的第二级「宽松复核」同一思路。
     *
     * 此模式下「过滤是否生效」只由**条件字段**自证（condOk）：
     * contains 会命中「值近似但不相等」的记录（如查 `A` 命中 `AB`），
     * 若仍要求值严格相等会把这种正常近似判成「过滤未生效」而误触发回退。
     * 值的精确匹配另由 `exists` 承担（始终严格），保证结论可信。
     */
    loose?: boolean;
  }
): Promise<ProbeResult> {
  return (async (): Promise<ProbeResult> => {
    try {
      const table = await getTableForRead(tableId);
      const useByPage = typeof (table as any).getRecordsByPage === 'function';
      const loose = opts?.loose === true;
      const filter = {
        conjunction: 'and',
        conditions: [
          ...conditions.map(loose ? specToLooseCondition : specToFilterCondition),
          loose
            ? { fieldId: valueFieldId, operator: 'contains', value: optionText }
            : optionMatchCondition(valueFieldId, optionText, valueFieldType),
        ],
      };
      const params: any = { pageSize: 1, filter };
      const res: any = useByPage
        ? await (table as any).getRecordsByPage(params)
        : await (table as any).getRecords(params);
      const rec = (res?.records ?? [])[0];
      if (!rec) return { exists: false, effective: true }; // 无命中：无从证伪，按有效处理
      const fields = (rec.fields ?? {}) as Record<string, unknown>;
      const condOk = conditions.every((c) => recordSatisfiesCondition(fields, c));
      const cell = stringifyCellValue(fields[valueFieldId]).trim();
      const want = optionText.trim();
      const valueOk =
        valueFieldType === 4 /* MultiSelect */
          ? cell.split(/\s+/).filter(Boolean).includes(want)
          : cell === want;
      // 严格模式：条件与取值都要自证；宽松模式：只自证条件字段（见 opts.loose 注释）
      const effective = loose ? condOk : condOk && valueOk;
      return { exists: condOk && valueOk, effective };
    } catch (e) {
      return { exists: false, effective: false, error: (e as Error)?.message ?? String(e) };
    }
  })();
}

/** 选项穷举结果（供 UI 如实展示「是否完整」） */
export interface OptionEnumResult {
  /** 去重后的选项文本（按源字段配置的选项顺序） */
  values: string[];
  /** 是否已**完整**穷举（false = 可能不全，UI 必须如实提示） */
  complete: boolean;
  /** 是否因达到候选上限被截断（true = 只检查了前 N 项） */
  truncated: boolean;
  /** 实际发出的存在性探测次数 */
  probes: number;
  /** 读到的记录数（存在性命中数 / 扫描命中数） */
  scanned: number;
  /**
   * 选项来源：
   * - `metadata`=源字段配置的选项域（无条件，1 次请求即完整）
   * - `query`=有条件「直接查询」匹配行后本地取去重值（**快速路径**：请求量 ∝ 匹配行数，
   *            通常 1 页即完；选项域找齐即早退。2026-10-21 为「计算慢」问题新增）
   * - `probe`=存在性探测穷举（有条件，成本与表大小无关；已被 `query` 取代为主路径，保留供测试/兜底）
   * - `scan`=渐进全量扫描（getRecordsByPage，翻到底即完整；最通用、必然可用）
   */
  source: 'metadata' | 'query' | 'probe' | 'scan';
  /** 服务端过滤是否经自证生效 */
  filterEffective: boolean;
  /** 服务端报告的记录总数（宿主返回时才有；扫描模式下 = 表内可读总行数） */
  serverTotal?: number;
  /** 扫描模式下已扫描的「源表总记录数」（与 scanned 的「命中数」区分） */
  scannedTotal?: number;
  error?: string;
  /**
   * ★ 错误的**类型**（`error` 有值时才有）。
   *
   * 🔴 为什么必须带类型（2026-10-30 第七轮）：
   * UI 拿到 `error` 后会走 `classifySdkError()` 把文案重新归类一遍，
   * 而它只认 permission / not found 两类关键词 → 我们写好的中文诊断
   * （「读不到源字段的字段结构…这不代表没有选项」）会被降级成一句
   * 无信息量的「读取「引用选项的源数据表」失败」，
   * 于是**辛苦算出的结论在最后一米被丢掉了**。
   *
   * 带类型后 UI 可直接按类型给出结论与处置，不再依赖宿主的错误文案特征。
   */
  errorCode?: OptionErrorCode;
}

/**
 * 选项枚举失败的类型（供 UI 精确给出结论，见 `OptionEnumResult.errorCode`）。
 * - `meta-failed`：读不到源字段的字段结构 → 连字段类型/选项域都没拿到
 * - `field-invalid`：扫到了记录，但该字段取不到任何值 → 字段 ID 很可能已失效
 * - `records-unreadable`：服务端说有 N 条，却一条也读不出来 → 权限/视图范围
 * - `scan-failed`：扫描过程本身抛错（第 0 页就失败时 truncated 仍为 false）
 * - `filter-ineffective` / `query-empty`：直接查询不可信，已回退扫描
 */
export type OptionErrorCode =
  | 'meta-failed'
  | 'field-invalid'
  | 'records-unreadable'
  | 'scan-failed'
  | 'filter-ineffective'
  | 'query-empty';

/**
 * 引用选项的一次失败是否值得自动重试。
 *
 * 只重试「源表/字段结构暂时读不到」且没有任何候选值的情形；字段已失效、
 * 条件无匹配、已有部分结果均不重试，避免无意义请求或覆盖可用选项。
 */
export function shouldRetryOptionEnum(r: OptionEnumResult | null | undefined): boolean {
  if (!r || r.values.length > 0 || !r.error) return false;
  return r.errorCode === 'scan-failed' || r.errorCode === 'meta-failed';
}

/** 存在性探测的并发度（过大易触发限流，8 是稳妥值） */
export const PROBE_CONCURRENCY = 8;
/** 候选选项上限（防止异常字段配置把请求数拖爆） */
export const MAX_PROBE_OPTIONS = 500;

/**
 * 按「选项域 + 存在性探测」穷举引用选项（**保证完整、无截断风险**）。
 *
 * - 无条件：直接返回源字段配置的选项域（1 次请求、完整），不再只读 200 条记录；
 * - 有条件：对选项域逐项做 pageSize=1 的存在性探测，命中即产出（可渐进回调）；
 * - 任一探测发现「返回了记录但不满足条件」→ 判定宿主忽略 filter，
 *   返回 `complete:false, filterEffective:false`，由调用方回退按行取数。
 *
 * @param onOption 渐进回调（每命中一个选项即回调，UI 可即时展示）
 */
export function enumerateOptionsByProbe(
  tableId: string,
  valueFieldId: string,
  conditions: ConditionSpec[],
  opts?: {
    valueFieldType?: number;
    /** 已知的选项域（省略则内部读取字段元信息） */
    declaredOptions?: string[];
    onOption?: (v: string) => void;
    /** 进度回调：已探测数 / 候选总数 */
    onProgress?: (probes: number, total: number) => void;
    concurrency?: number;
    maxOptions?: number;
  }
): { cancel: () => void; promise: Promise<OptionEnumResult> } {
  let cancelled = false;
  const maxOptions = opts?.maxOptions ?? MAX_PROBE_OPTIONS;
  const concurrency = opts?.concurrency ?? PROBE_CONCURRENCY;
  /** 取值字段类型（调用方传入优先；缺失时从元信息补，多选的「值匹配」判定依赖它） */
  let valueFieldType = opts?.valueFieldType;

  const promise = (async (): Promise<OptionEnumResult> => {
    const empty: OptionEnumResult = {
      values: [],
      complete: false,
      truncated: false,
      probes: 0,
      scanned: 0,
      source: 'probe',
      filterEffective: false,
    };
    try {
      // 1) 取得选项域
      let declared = opts?.declaredOptions;
      if (!declared) {
        const mo = await loadFieldSelectOptions(tableId, valueFieldId).promise;
        if (!mo.found || mo.options.length === 0) {
          return { ...empty, source: 'metadata', error: mo.error ?? 'no-declared-options' };
        }
        declared = mo.options;
        // 顺带补上取值字段类型（调用方未传时），多选取值字段的「值匹配」判定依赖它
        if (opts?.valueFieldType === undefined && typeof mo.type === 'number') {
          valueFieldType = mo.type;
        }
      } else if (opts?.valueFieldType === undefined) {
        // 已给定选项域但缺类型 → 仍读一次元信息补类型（元信息已缓存，代价很小）
        try {
          const mo = await loadFieldSelectOptions(tableId, valueFieldId).promise;
          if (typeof mo.type === 'number') valueFieldType = mo.type;
        } catch {
          /* 读不到就按未记录处理（单值语义） */
        }
      }
      if (cancelled) return empty;
      if (!declared.length) return { ...empty, source: 'metadata', error: 'no-declared-options' };

      // 2) 无条件 → 选项域即答案（完整、0 次记录读取）
      if (conditions.length === 0) {
        return {
          values: declared.slice(),
          complete: true,
          truncated: false,
          probes: 0,
          scanned: 0,
          source: 'metadata',
          filterEffective: true,
        };
      }

      // 3) 有条件 → 逐项存在性探测（并发池，保序输出）
      const truncated = declared.length > maxOptions;
      const candidates = declared.slice(0, maxOptions);
      const found: (string | null)[] = candidates.map(() => null);
      let cursor = 0;
      let probes = 0;
      let scanned = 0;
      let aborted = false;
      let firstError: string | undefined;

      const worker = async () => {
        for (;;) {
          if (cancelled || aborted) return;
          const idx = cursor;
          cursor += 1;
          if (idx >= candidates.length) return;
          const cand = candidates[idx];
          const r = await probeOptionExists(
            tableId,
            valueFieldId,
            cand,
            conditions,
            valueFieldType
          );
          probes += 1;
          opts?.onProgress?.(probes, candidates.length);
          if (cancelled || aborted) return;
          if (r.error) {
            if (!firstError) firstError = r.error;
            continue; // 单次失败不致命，继续其余候选
          }
          if (!r.effective) {
            // 返回了记录却不满足条件 → 宿主忽略 filter，探测路径不可信 → 退出并回退
            console.warn('[tableRecords] 存在性探测发现过滤未生效，放弃探测路径并回退按行取数');
            aborted = true;
            return;
          }
          if (r.exists) {
            found[idx] = cand;
            scanned += 1;
            opts?.onOption?.(cand);
          }
        }
      };
      const n = Math.max(1, Math.min(concurrency, candidates.length));
      await Promise.all(Array.from({ length: n }, worker));

      if (aborted) {
        // 过滤未生效 → 探测路径不可信，交由调用方回退按行取数
        return { ...empty, probes, truncated, error: 'filter-ineffective' };
      }
      // 全部候选都探测失败（有错误、一次都没成功）→ 视为不可用（回退）
      if (probes >= candidates.length && scanned === 0 && firstError) {
        return { ...empty, probes, truncated, error: firstError };
      }

      // ★ 全 miss 复核（与 loadRowsByConditions 的第二级「宽松复核」同思路）
      //   症状：宿主对 typed 条件（is + fieldType）稳定返回 0 条 → 逐项探测全 miss
      //        → 若直接采信，就会「假空」：complete=true 且 values=[]，
      //          UI 显示「已按条件穷举全部 0 个选项」（正是用户报的现象）。
      //   做法：给每个候选做一次**宽松探测**（去 fieldType、统一 contains）。
      //       命中即说明「原条件被误解析」，采用复核结果；仍全空才认「确实无选项」。
      if (!cancelled && !aborted && found.every((v) => !v) && candidates.length > 0) {
        let looseHit = 0;
        const looseFound: (string | null)[] = candidates.map(() => null);
        let lcursor = 0;
        let lprobes = 0;
        const lworker = async () => {
          for (;;) {
            if (cancelled || aborted) return;
            const idx = lcursor;
            lcursor += 1;
            if (idx >= candidates.length) return;
            const r = await probeOptionExists(
              tableId,
              valueFieldId,
              candidates[idx],
              conditions,
              valueFieldType,
              { loose: true }
            );
            lprobes += 1;
            if (cancelled) return;
            if (r.exists) {
              looseFound[idx] = candidates[idx];
              looseHit += 1;
              opts?.onOption?.(candidates[idx]);
            }
          }
        };
        const ln = Math.max(1, Math.min(concurrency, candidates.length));
        await Promise.all(Array.from({ length: ln }, lworker));
        if (looseHit > 0) {
          console.warn(
            '[tableRecords] 精确条件探测全未命中、宽松复核命中 → 采用复核结果（条件格式兼容回退）'
          );
          return {
            values: looseFound.filter((v): v is string => !!v),
            complete: !truncated,
            truncated,
            probes: probes + lprobes,
            scanned: looseHit,
            source: 'probe',
            filterEffective: true,
          };
        }
        // 宽松也全空 → 该条件下确实无记录（正常业务态）。仍按「未知」上报：
        // 不声称探测可信，交由调用方在「0 结果」时回退扫描做最终确认（双保险）。
        if (!cancelled) {
          console.warn('[tableRecords] 条件探测两级皆空，交由调用方回退扫描确认');
          return { ...empty, probes: probes + lprobes, truncated, error: 'probe-all-miss' };
        }
      }

      return {
        values: found.filter((v): v is string => !!v),
        complete: !truncated,
        truncated,
        probes,
        scanned,
        source: 'probe',
        filterEffective: true,
      };
    } catch (e) {
      const err = (e as Error)?.message ?? String(e);
      console.warn(`[tableRecords] 选项穷举失败：表=${tableId} 字段=${valueFieldId} 错误=${err}`);
      return { ...empty, error: err };
    }
  })();

  return { cancel: () => { cancelled = true; }, promise };
}

/**
 * 按「取值列穷举」取回满足条件的去重取值（**单列负载，最小化**）。
 *
 * 用途：取值字段不是单选/多选（没有配置选项域）时，无法用「选项域 + 存在性探测」，
 * 改为直接对**该一列**分页取值 —— `getFieldValueListByPage({ stringValue:true })`
 * 只返回这一列的字符串，负载远小于整行；且支持 `filter`，可按条件精确取回。
 *
 * 完整性：翻到 hasMore=false 才是完整；撞 COLUMN_MAX_PAGES 上限则 truncated=true（如实上报）。
 */
export function enumerateFieldValuesByColumn(
  tableId: string,
  fieldId: string,
  conditions: ConditionSpec[],
  opts?: { onValue?: (v: string) => void; maxPages?: number; valueFieldType?: number }
): { cancel: () => void; promise: Promise<OptionEnumResult> } {
  let cancelled = false;
  const maxPages = opts?.maxPages ?? COLUMN_MAX_PAGES;
  const promise = (async (): Promise<OptionEnumResult> => {
    const seen = new Set<string>();
    const values: string[] = [];
    let probes = 0;
    let scanned = 0;
    let truncated = false;
    let filterEffective = false;
    try {
      const table = await getTableForRead(tableId);
      const field = await (table as any).getFieldById?.(fieldId);
      if (!field || typeof field.getFieldValueListByPage !== 'function') {
        return {
          values: [],
          complete: false,
          truncated: false,
          probes: 0,
          scanned: 0,
          source: 'probe',
          filterEffective: false,
          error: 'value-list-api-unavailable',
        };
      }
      let token: any;
      let guard = 0;
      for (;;) {
        if (cancelled) break;
        const params: any = {
          pageSize: PAGE_SIZE,
          stringValue: true,
          ...(conditions.length
            ? { filter: { conjunction: 'and', conditions: conditions.map(specToFilterCondition) } }
            : {}),
          ...(token !== undefined ? { pageToken: token } : {}),
        };
        const res: any = await field.getFieldValueListByPage(params);
        probes += 1;
        scanned += (res?.fieldValues ?? []).length;
        for (const fv of res?.fieldValues ?? []) {
          // ★ 多选取值字段：单列返回值同样可能是数组 → 拆成多个独立选项
          const texts = extractOptionTexts(fv?.value, opts?.valueFieldType);
          if (conditions.length) {
            // 单列返回不含条件字段 → 无法本地自证条件；只能凭 hasMore 判完整，
            // 故此处不对 filterEffective 作断言（保持 false，由调用方按 returns 处理）
          }
          for (const text of texts) {
            if (text && !seen.has(text)) {
              seen.add(text);
              values.push(text);
              opts?.onValue?.(text);
            }
          }
        }
        guard += 1;
        const next = res?.hasMore ? res?.pageToken : undefined;
        if (next === undefined || next === token) break;
        if (guard >= maxPages) {
          truncated = true;
          break;
        }
        token = next;
      }
      if (conditions.length === 0) filterEffective = true; // 无条件下不存在「过滤失效」
      return {
        values,
        complete: !truncated,
        truncated,
        probes,
        scanned,
        source: 'probe',
        filterEffective,
      };
    } catch (e) {
      const err = (e as Error)?.message ?? String(e);
      console.warn(`[tableRecords] 取值列穷举失败：表=${tableId} 字段=${fieldId} 错误=${err}`);
      return {
        values,
        complete: false,
        truncated,
        probes,
        scanned,
        source: 'probe',
        filterEffective,
        error: err,
      };
    }
  })();
  return { cancel: () => { cancelled = true; }, promise };
}

/**
 * ★ 引用选项「完整穷举」统一入口（UI 只需调用这一个）。
 *
 * 引擎选择原则：**优先用「已验证在所有宿主上都可用」的接口**
 * （即关联字段选择器同源的 `getRecordsByPage` 分页），
 * 元信息选项域 / 直接查询 / 存在性探测都只作为**更快的可选优化**，
 * 任一环节不可用都**不影响完整性**（最终都收敛到扫描引擎）。
 *
 * 策略（2026-10-21 调整：有条件下改为「直接查询」优先）：
 *  ① 取值字段是单选/多选 + **无条件** → 直接用字段选项域（1 次请求、更快）；
 *  ② 有条件 → **直接查询**（带条件取匹配行，请求量 ∝ 匹配行数，通常 1 页即完；
 *     选项域找齐即早退）→ 不可信 / 0 条时转 ③；
 *  ③ **渐进全量扫描**（`scanDistinctValues`，getRecordsByPage，翻到底即完整）—— 兜底且必然可用。
 *
 * 任何情况下都不会「静默只给 200 条」：要么返回完整，要么如实带 truncated / complete=false。
 */
export function enumerateRefOptions(
  tableId: string,
  valueFieldId: string,
  conditions: ConditionSpec[],
  opts?: {
    valueFieldType?: number;
    onOption?: (v: string) => void;
    onProgress?: (probes: number, total: number) => void;
    maxProbeOptions?: number;
    maxColumnPages?: number;
    /** 渐进扫描上限（页） */
    maxScanPages?: number;
    /** 渐进扫描时间预算（毫秒） */
    scanTimeBudgetMs?: number;
    /** 扫描进度回调：已扫描记录数 / 总数 */
    onScanProgress?: (scanned: number, total?: number) => void;
    /**
     * 引擎偏好（测试用）：
     * - `'auto'`（默认）= 先直接查询、不可信再回退扫描；
     * - `'probe'` = 强制走存在性探测（覆盖旧行为）；
     * - `'scan'` = 跳过优化、直接扫描。
     */
    engine?: 'auto' | 'probe' | 'scan';
  }
): { cancel: () => void; promise: Promise<OptionEnumResult> } {
  let cancelled = false;
  let inner: { cancel: () => void } | null = null;

  const promise = (async (): Promise<OptionEnumResult> => {
    // 读字段元信息（可能失败 → 直接走扫描）
    let mo: FieldOptionsResult = { options: [], found: false };
    try {
      const r = await loadFieldSelectOptions(tableId, valueFieldId).promise;
      mo = r;
    } catch {
      /* 忽略：走扫描 */
    }
    if (cancelled) {
      return { values: [], complete: false, truncated: false, probes: 0, scanned: 0, source: 'scan', filterEffective: false };
    }
    // ★ 取值字段类型：配置侧记录的值优先，缺失则用元信息里的类型。
    //   多选（4）需要把单元格拆成多个独立选项（可被引用到单选控件）。
    const valueFieldType = opts?.valueFieldType ?? mo.type;
    const engine = opts?.engine ?? 'auto';
    /**
     * 🔴 字段结构（getFieldMetaList）是否读取失败 —— 这个事实以前被**直接丢弃**，
     * 于是「读不到字段结构」与「字段就是没有选项」在 UI 上完全同形。
     * 保留它只用于「结果为空时的定性与报错」，不影响任何有值的正常路径。
     */
    const metaFailed = typeof mo.error === 'string' && mo.error.length > 0;

    /**
     * ★ 字段结构读**成功**了，但字段清单里没有这个 fieldId
     *   —— 这是最硬的证据：配置指向的源字段已不存在（被删除 / 重建 / 换了表）。
     *
     * 🔴 为什么必须单列一条（2026-10-30 第七轮审计）：
     * `loadFieldSelectOptions` 在「字段不存在」时返回 `{ found:false, type:undefined, 无 error }`，
     * 与「字段存在但不是单选/多选」共用同一形态，于是被当成「正常的无选项域」继续走扫描。
     * 扫描当然取不到值 → 空结果 → 若表恰好没记录（`scanned=0, total=0`）就判成
     * 「complete:true，确实没有选项」→ UI 显示「已加载全部 0 个选项」。
     * 用户看到的是「加载成功只是没有选项」，真相是**配置已经坏了**。
     *
     * 判据用 `type === undefined`（而不是 `found === false`）：后者还包含
     * 「字段存在但不是单选/多选」，那种情况下选项本来就该从记录里取，不能报错。
     */
    const fieldMissing = !metaFailed && typeof mo.type !== 'number';

    /**
     * ★ 给「空结果」定性：**没报错 ≠ 真的有结果**。
     *
     * 这是本缺陷的核心（2026-10-30 第六轮复现确证）：
     * 扫描「跑完了、没抛错、0 条记录」时会被判成 `complete: true`，
     * 于是 UI 显示「已加载全部 0 个选项，输入关键字可搜索」——
     * 用户看到的是「加载成功，只是没有选项」，而真实情况往往是**根本读不到**。
     * 两者语义完全相反却共用同一句话，用户因此「怎么试都不行」。
     *
     * ⚠️ 但**不能反过来一律报错**，否则「该条件下确实没有匹配行」这种合法状态
     *    会被误报成故障，同样是骗人。所以只在**拿到正面证据**时才定性为错误：
     *      ① 字段结构读取失败 → 连源字段是什么都不知道，无权声称「没有选项」
     *      ② 扫到了记录却取不到该字段的值 → 字段 ID 极可能已失效（删了/重建了）
     *      ③ 服务端说有 N 条、却一条没返回 → 读不到记录（权限/视图）
     *    其余情形（表真的是空、条件真的没匹配）保持「空且完整」——这才是真话。
     *
     * @returns error 有值 = 属于「读不到」，UI 必须报错；无 error = 真的没有
     */
    const describeEmpty = (
      scannedRecords: number,
      serverTotal?: number
    ): { error?: string; complete: boolean; errorCode?: OptionErrorCode } => {
      if (metaFailed) {
        return {
          error:
            `读不到源字段的字段结构（${mo.error}）。` +
            `这不代表「没有选项」—— 插件连源字段的类型和选项域都没拿到。`,
          complete: false,
          errorCode: 'meta-failed',
        };
      }
      // ★ 字段已不存在：与「没有选项」是两件事，但旧行为完全同形 → 必须优先报出来。
      //   放在条件判断**之前**：字段都没了，讨论「该条件下有没有记录」没有意义。
      if (fieldMissing) {
        return {
          error:
            `源数据表里找不到配置所指向的源字段（字段 ID ${valueFieldId} 已不存在于表 ${tableId}）。` +
            `这通常说明该字段被删除或重建过。请进入配置模式重新选择「选项来源字段」并保存。`,
          complete: false,
          errorCode: 'field-invalid',
        };
      }
      // 有条件时「0 个」可能完全正常（没有记录满足条件），不做故障定性
      if (conditions.length > 0) {
        return { complete: true };
      }
      if (scannedRecords > 0) {
        return {
          error:
            `扫描到 ${scannedRecords} 条源表记录，但没有一条能取到该字段的值。` +
            `通常说明配置里记录的源字段已被删除或重建（字段 ID 已失效），请重新选择源字段并保存。`,
          complete: false,
          errorCode: 'field-invalid',
        };
      }
      if (typeof serverTotal === 'number' && serverTotal > 0) {
        return {
          error:
            `服务端报告源表有 ${serverTotal} 条记录，但一条也没能读出来。` +
            `这通常是当前账号读不到该表的记录（权限/视图范围），或该表未被登记为插件的数据源。`,
          complete: false,
          errorCode: 'records-unreadable',
        };
      }
      // 表确实是空的（或宿主没报总数且确实 0 条）→ 如实为「空且完整」
      return { complete: true };
    };

    // 渐进全量扫描 = 最终兜底引擎（getRecordsByPage，必然可用）
    const runScan = async (): Promise<OptionEnumResult> => {
      const h = scanDistinctValues(tableId, valueFieldId, conditions, {
        onValue: opts?.onOption,
        onProgress: opts?.onScanProgress,
        maxPages: opts?.maxScanPages ?? DISTINCT_SCAN_MAX_PAGES,
        timeBudgetMs: opts?.scanTimeBudgetMs ?? DISTINCT_SCAN_TIME_BUDGET_MS,
        valueFieldType,
        // ★ 单选/多选有选项域 → 传给扫描引擎「找齐即停」：
        //   假空回退扫描时，避免把整张大表白扫一遍（选项域小、命中集中在前面几页时尤其明显）
        declaredOptions: mo.found && mo.options.length > 0 ? mo.options : undefined,
      });
      inner = h;
      const r = await h.promise;
      // ★ 有值 → 照原样返回（值本身就是证据，不需要定性）
      if (r.values.length > 0) {
        return {
          values: r.values,
          complete: r.complete,
          truncated: r.truncated,
          probes: 0, // 扫描模式的「探测次数」以扫描页数计；此处不计
          scanned: r.scanned,
          source: 'scan',
          filterEffective: true, // 本地自证筛过，必然生效
          serverTotal: r.total,
          scannedTotal: r.total,
          // ★ 把扫描失败如实上报（UI 才能提示「源表不可读」而不是「没有选项」）
          ...(r.error ? { error: r.error, errorCode: 'scan-failed' as OptionErrorCode } : {}),
        };
      }
      // ★ 空结果 → 必须定性，绝不能把「读不到」当成「真没有」
      const verdict = describeEmpty(r.scanned, r.total);
      const errText = r.error || verdict.error;
      const errCode: OptionErrorCode | undefined = r.error
        ? 'scan-failed'
        : verdict.errorCode;
      return {
        values: [],
        complete: verdict.complete,
        truncated: r.truncated,
        probes: 0,
        scanned: r.scanned,
        source: 'scan',
        filterEffective: true,
        serverTotal: r.total,
        scannedTotal: r.total,
        ...(errText ? { error: errText } : {}),
        ...(errCode ? { errorCode: errCode } : {}),
      };
    };

    // ① 单选/多选 + 无条件 → 选项域即答案（更快，1 次请求）
    //    注意：选项域是「字段配置的候选集」，比「记录实际出现的取值」更大；
    //    对引用选项而言这正是期望语义（原生引用选项同样来自字段配置的选项）。
    if (mo.found && mo.options.length > 0 && conditions.length === 0) {
      return {
        values: mo.options.slice(),
        complete: true,
        truncated: false,
        probes: 0,
        scanned: 0,
        source: 'metadata',
        filterEffective: true,
      };
    }

    // ② 有条件 → **优先「直接查询」**（请求量 ∝ 匹配行数，选项域找齐即早退）
    if (conditions.length > 0 && engine !== 'scan') {
      // ②a（engine==='probe' 时）→ 强制走存在性探测（仅测试/兼容用）
      if (engine === 'probe' && mo.found && mo.options.length > 0) {
        const hp = enumerateOptionsByProbe(tableId, valueFieldId, conditions, {
          valueFieldType,
          declaredOptions: mo.options,
          onOption: opts?.onOption,
          onProgress: opts?.onProgress,
          maxOptions: opts?.maxProbeOptions,
        });
        inner = hp;
        const rp = await hp.promise;
        if (rp.filterEffective && !rp.error) return rp;
        console.warn('[tableRecords] 存在性探测不可用，改用渐进全量扫描');
        if (cancelled) return rp;
        return await runScan();
      }
      // ②b 默认：带条件直接查询
      const hq = queryDistinctByConditions(tableId, valueFieldId, conditions, {
        valueFieldType,
        declaredOptions: mo.found ? mo.options : undefined,
        onValue: opts?.onOption,
        // ★ 复用扫描进度回调：UI 底部「已扫描 N 条」在同一处渲染，直接查询也必须有进度
        onProgress: opts?.onScanProgress,
        maxPages: opts?.maxColumnPages,
        timeBudgetMs: opts?.scanTimeBudgetMs,
      });
      inner = hq;
      const rq = await hq.promise;
      if (rq.trusted) {
        return {
          values: rq.values,
          complete: rq.complete,
          truncated: rq.truncated,
          probes: 0,
          scanned: rq.scanned,
          source: 'query',
          filterEffective: true,
          serverTotal: rq.total,
          scannedTotal: rq.total,
        };
      }
      console.warn('[tableRecords] 直接查询不可信（过滤未生效 / 两级空 / 出错），改用渐进全量扫描');
      if (cancelled) {
        return {
          values: [],
          complete: false,
          truncated: false,
          probes: 0,
          scanned: 0,
          source: 'query',
          filterEffective: false,
          error: rq.error,
        };
      }
      // 回退扫描。注意：直接查询可能已产出部分选项（onOption 已回调），扫描会去重补充。
      return await runScan();
    }

    // ③ 其它情形（无选项域 / 元信息不可用 / 引擎指定扫描）→ 渐进全量扫描
    //    这是唯一必然可用的路径，保证「永不静默只给 200 条」。
    return await runScan();
  })();

  return {
    cancel: () => {
      cancelled = true;
      inner?.cancel();
    },
    promise,
  };
}

type RefEnumerateOptions = NonNullable<Parameters<typeof enumerateRefOptions>[3]>;

/**
 * 引用选项专用的有界恢复读取。
 *
 * 刷新进入 View 态时，Base 实例可能已创建，但宿主尚未把声明源表的记录
 * 准备完成；此时第一次 getRecordsByPage 会抛 `msg: undefined code: 12`。
 * 原实现只读一次，且下拉关闭再打开也不会重新执行 effect，导致一次早期
 * 失败永久留在界面。这里仅在「零候选 + 明确的读取故障」时做短退避重试，
 * 成功或遇到配置类错误立即停止，不影响其他选择器与提交路径。
 */
export function enumerateRefOptionsWithRecovery(
  tableId: string,
  valueFieldId: string,
  conditions: ConditionSpec[],
  opts?: RefEnumerateOptions,
  recovery?: {
    /** 总尝试次数（含首次），默认 3 */
    maxAttempts?: number;
    /** 第一次重试前的基准延迟，后续按 2 倍递增；默认 400ms */
    baseDelayMs?: number;
    /** 测试可注入假 sleep，生产无需传 */
    sleep?: (ms: number) => Promise<void>;
  }
): { cancel: () => void; promise: Promise<OptionEnumResult> } {
  let cancelled = false;
  let inner: { cancel: () => void } | null = null;
  const maxAttempts = Math.max(1, Math.floor(recovery?.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, recovery?.baseDelayMs ?? 400);
  const sleep = recovery?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const promise = (async (): Promise<OptionEnumResult> => {
    let last: OptionEnumResult | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const h = enumerateRefOptions(tableId, valueFieldId, conditions, opts);
      inner = h;
      last = await h.promise;
      if (cancelled || !shouldRetryOptionEnum(last) || attempt >= maxAttempts - 1) return last;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(
        `[tableRecords] 引用选项读取未就绪，${delay}ms 后重试（第 ${attempt + 2}/${maxAttempts} 次）：表=${tableId}`
      );
      await sleep(delay);
      if (cancelled) return last;
    }
    // maxAttempts 最小为 1，循环必然至少执行一次；仅作类型兜底。
    return last!;
  })();

  return {
    cancel: () => {
      cancelled = true;
      inner?.cancel();
    },
    promise,
  };
}

/* ---------------- 源表读取失败的现场诊断（给错误框直接用） ---------------- */

/**
 * ★ 读取「源表读不到」时的一次性现场信息，供错误框展示。
 *
 * 🔴 为什么需要它（2026-10-30 第五轮）：
 * 用户能截给我的唯一画面就是 RefOptionSelect 的错误框。而
 * `getRecordsByPage error, msg: undefined code: 12` 在跨 iframe 时被宿主降级，
 * 既无 message 也没真 code，无法区分根因。所以在**报错的那一刻**顺手采集：
 *   ① 当前实际 base 里有哪些表（判断是不是连错了多维表格）
 *   ② 宿主持有的 dataConditions 声明表（判断是不是没登记数据源）
 * 这两条足以把「重启保存/改代码/找管理员」三种处置彻底分开。
 *
 * 全程 try/catch，任何一步失败都不影响主流程（诊断绝不能反过来把功能搞挂）。
 */
export interface RefReadContext {
  baseToken: string;
  /** ★ 是否成功绑定到配置声明的 base（false = 回退了/未绑定，这才是首要根因） */
  baseBound?: boolean;
  /** 当前实际 base 可见的表 id；null = 探测失败 */
  visibleTableIds: string[] | null;
  /** 宿主持有的 dataConditions 声明表 id；null = 拿不到 */
  hostDeclaredIds: string[] | null;
  /** 便于排查：宿主持有的声明原始条目 */
  hostDeclaredRaw?: unknown;
}

export async function collectRefReadContext(): Promise<RefReadContext> {
  const ctx: RefReadContext = {
    baseToken: '',
    visibleTableIds: null,
    hostDeclaredIds: null,
  };
  try {
    ctx.baseToken = getBaseToken() || '';
  } catch {
    /* ignore */
  }
  // ★ 先记录「到底有没有绑定成功」——这才是区分根因的第一判据。
  //   （上一版直接调 getTableMetaList，绑定失败时它同样失败，
  //     结果只能报「无法读取数据表清单」，把根因藏在后面。）
  let base: ReturnType<typeof getBase> | undefined;
  try {
    const strict = getBaseStrict();
    ctx.baseBound = strict.bound;
    base = strict.base;
  } catch {
    ctx.baseBound = false;
  }
  if (base) {
    try {
      const metas = await base.getTableMetaList();
      ctx.visibleTableIds = (metas ?? []).map((t: any) => t.id).filter(Boolean);
    } catch {
      ctx.visibleTableIds = null;
    }
  }
  try {
    const cfg: any = await (getDashboard() as any).getConfig();
    const dc: any[] = Array.isArray(cfg?.dataConditions) ? cfg.dataConditions : [];
    ctx.hostDeclaredRaw = dc.map((d: any) => (d && typeof d === 'object' ? { tableId: d.tableId } : d));
    ctx.hostDeclaredIds = dc.map((d: any) => d?.tableId).filter(Boolean);
  } catch {
    ctx.hostDeclaredIds = null;
  }
  return ctx;
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

/** 把「附加精确条件」转成服务端 filter 片段（随字段类型选择 operator 与 fieldType） */
function extraCondToFilter(extra?: ConditionSpec[]) {
  return (extra ?? [])
    .filter((c) => c && c.fieldId && (c.text ?? '') !== '')
    .map(specToFilterCondition);
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
      const table = await getTableForRead(tableId);
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
      const table = await getTableForRead(tableId);
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
          // 自证：关键字命中 **且** 附加条件全部满足，才算真命中（单选/多选按选项文本判定）
          const condOk = (opts.extraConditions ?? []).every((c) =>
            recordSatisfiesCondition(fields, c)
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