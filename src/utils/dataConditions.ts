/**
 * 应用模式 `dataConditions` 的「数据表声明集」计算（纯函数，可被回归测试真实调用）。
 *
 * 🔴 为什么必须声明**全部**被引用的表（2026-10-30 线上缺陷）：
 * 用户反馈「条件引用选项保存后第一次生效，刷新后配置还在但选不到选项」，控制台报：
 *   [tableRecords] 读取字段选项域失败：表=tblcUCBkIHqTtvet 错误=table permission denied error
 *   Error: partial_view_api_error
 *   [tableRecords] 本地扫描兜底失败：表=tblcUCBkIHqTtvet 错误=getRecordsByPage error, code: 12
 *
 * 根因：`saveConfig` 的 `dataConditions` **只声明了主表一条**。
 *   应用插件在 View 态的可访问数据表 = `dataConditions` 声明的集合（授予的是「声明的数据源」）。
 *   选项引用的**源表**既不是主表也不是子表 → 不在声明集里 → View 态整表读不到
 *   （meta 与 records 两条链路同时失败，正好对上上面两条报错）。
 *   配置态保存的那一刻插件仍在配置面板上下文中，所以「第一次生效」，刷新进 View 态就失效。
 *
 * 项目里 2026-10-06 的实测记录（见 git b33053f 的注释）早已给出同一结论：
 *   「宿主 View 态校验 customConfig 引用的每张表都必须在 dataConditions 里 …
 *     校验的是声明集，不是字符串扫描」「只传 1 个主表 → 纯主表表单可用，但带子表必失败」。
 *   后来迁移到 Workspace/baseToken 时把这段退化成「只传主表」，且 REFERENCE.md 写成了
 *   「只传一条」，于是这个坑在**选项引用源表**上又复现了一次。
 *
 * ⚠️ 与「只传一条」旧结论的关系：
 *   官方历史版本 `dataConditions` 只支持一组统计条件（groups/series 是图表聚合语义）。
 *   这里声明多张表时，每张表都带 `dataRange: ALL`，统计语义（COUNTA）只挂在主表上，
 *   其余表仅作为「数据源声明」——这正是 b33053f 版本实测可用的形态。
 */

/** 与 Feature 无关的最小表引用形态 */
export interface TableRefLike {
  mainTable?: { tableId?: string; fields?: FieldRefLike[] } | null;
  subTables?: { tableId?: string; fields?: FieldRefLike[] }[] | null;
}

export interface FieldRefLike {
  optionRef?: { tableId?: string; fieldId?: string } | null;
}

/**
 * 收集一份表单实际引用到的**全部数据表 id**（去重、保序）。
 *
 * 覆盖三类引用：
 *   ① 主表；
 *   ② 子表（写入目标）；
 *   ③ **选项引用的源表**（只读，但 View 态同样需要授权）——这是本次缺陷漏掉的一类。
 *
 * @param forms 全部表单（多表单共用同一份 dataConditions 声明集）
 */
export function collectDeclaredTableIds(
  forms: (TableRefLike | null | undefined)[] | null | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id?: string | null) => {
    const v = typeof id === 'string' ? id.trim() : '';
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  for (const form of forms ?? []) {
    if (!form) continue;
    const main = form.mainTable;
    push(main?.tableId);
    // 主表字段上的选项引用
    for (const f of main?.fields ?? []) push(f?.optionRef?.tableId);
    // 子表本身 + 子表字段上的选项引用
    for (const sub of form.subTables ?? []) {
      push(sub?.tableId);
      for (const f of sub?.fields ?? []) push(f?.optionRef?.tableId);
    }
  }
  return out;
}

/** dataConditions 单条目（与 SDK IDataCondition 对齐的最小形态） */
export interface DataConditionEntry {
  tableId: string;
  baseToken?: string;
  dataRange: { type: 'ALL' };
  groups: unknown[];
  series?: 'COUNTA';
}

/**
 * 构造完整的 `dataConditions` 声明集。
 *
 * - 主表：带 `series: 'COUNTA'`（保留原统计语义，与历史单条声明一致）；
 * - 其余表（子表 / 选项引用源表）：**仅作数据源声明**，不带 series
 *   （它们不参与图表聚合，带 series 反而可能被宿主当成一张要聚合的表）。
 *
 * @param forms     全部表单
 * @param primaryTableId 主表单的主表 id（优先用它当「统计主体」）
 * @param baseToken 配置所属多维表格（非空时必须带上，否则宿主拒绝声明）
 */
export function buildDataConditions(
  forms: (TableRefLike | null | undefined)[] | null | undefined,
  primaryTableId?: string | null,
  baseToken?: string | null
): DataConditionEntry[] {
  const ids = collectDeclaredTableIds(forms);
  if (ids.length === 0) return [];
  // 统计主体：优先调用方指定的主表；否则取声明集首个（即第一份表单的主表）
  const primary = (primaryTableId && ids.includes(primaryTableId)) ? primaryTableId : ids[0];
  const tok = typeof baseToken === 'string' && baseToken ? baseToken : undefined;

  return ids.map((tableId) => {
    const entry: DataConditionEntry = {
      tableId,
      ...(tok ? { baseToken: tok } : {}),
      dataRange: { type: 'ALL' },
      groups: [],
    };
    if (tableId === primary) entry.series = 'COUNTA';
    return entry;
  });
}

/**
 * 诊断用：列出「配置引用了、但旧版只声明主表时会被漏掉」的表。
 * 仅用于日志与回归测试，不参与运行时分支。
 */
export function findUndeclaredTables(
  forms: (TableRefLike | null | undefined)[] | null | undefined,
  declaredTableIds: string[]
): string[] {
  const declared = new Set(declaredTableIds);
  return collectDeclaredTableIds(forms).filter((id) => !declared.has(id));
}