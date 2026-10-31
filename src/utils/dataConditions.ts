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

/** dataConditions 单条目（与 SDK IDataCondition 对齐） */
export interface DataConditionEntry {
  tableId: string;
  baseToken?: string;
  dataRange: { type: 'ALL' };
  groups?: unknown[];
  series?: 'COUNTA';
}

/**
 * 构造 `dataConditions`（应用插件的数据源授权声明）。
 *
 * 🔴🔴 2026-10-30 第八轮·彻底修正方向（此前理解反了）：
 * 官方《App 插件开发指南》明确：
 *   - 「应用模式会根据插件保存的「多维表格」和「数据表」授权当前应用读取该表格数据，
 *     若有读取表格数据诉求需要把 baseToken 和 tableId 存到特定路径」
 *   - 「saveConfig 调用时，若传了非空的 dataConditions，一定要传 baseToken」
 *   - `dataConditions: IDataCondition | IDataCondition[]; // 数据源配置，**当前版本仅支持一组条件**`
 *   - `IDataCondition { baseToken: string; tableId: string; ... }`（两者都是「必须传」）
 *   - 升级指南示例注释：「若需从底表获取数据，一定要在这里传 baseToken」
 *
 * 也就是说：应用插件靠 dataConditions 里的 **baseToken + tableId** 授权「读取这一张表的数据」，
 * 而且**当前版本只支持一组（一张表）**。之前这里把 dataConditions 当成「多表授权声明」，
 * 往里面塞了「主表 + 子表 + 源表」多条 —— 宿主只保留第一条（主表），其余被丢弃
 * （正是线上诊断「宿主持有 1 张表」的来源），于是引用选项的**源表没被授权**，
 * 刷新进 View 态读源表就报 `table permission denied`。
 *
 * 正确做法：dataConditions **只放主表一条**（tableId + baseToken）。子表靠主表的
 * 关联字段（link）连带授权；其余表（引用选项源表等）若需要直接读，也必须以 link
 * 关联主表（飞书原生「引用选项」正是 link + lookup 的模型），否则平台不予授权。
 *
 * `dataRange: { type: 'ALL' }` 表示授权「全部数据范围」，保留之（官方 IDataRange 语义）。
 *
 * @param forms     全部表单（仅用于推导主表；其余表不进 dataConditions）
 * @param primaryTableId 主表单的主表 id（唯一要授权的表）
 * @param baseToken 配置所属多维表格（应用模式必传，否则底表数据读不到）
 */
export function buildDataConditions(
  forms: (TableRefLike | null | undefined)[] | null | undefined,
  primaryTableId?: string | null,
  baseToken?: string | null
): DataConditionEntry[] {
  const tok = typeof baseToken === 'string' && baseToken ? baseToken : undefined;
  const ids = collectDeclaredTableIds(forms);
  if (ids.length === 0) return [];
  // ★ 只授权主表一张表；primaryTableId 必须在收集集里才采用（否则回退第一张，即主表）。
  const mainId =
    typeof primaryTableId === 'string' && primaryTableId.trim() && ids.includes(primaryTableId)
      ? primaryTableId.trim()
      : ids[0];

  return [
    {
      tableId: mainId,
      ...(tok ? { baseToken: tok } : {}),
      dataRange: { type: 'ALL' as const },
    },
  ];
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

/**
 * ★ 构造「重放用的 payload」—— 纯函数，供回归测试真实调用。
 *
 * 🔴 为什么重放不能照抄 localStorage 里存下的 `dataConditions`：
 * 那份 payload 是「上一次保存那一刻」的快照，可能早于声明逻辑的升级
 * （例如旧版本带 `groups`、缺 `baseToken`，或曾塞了多表）。若原样重放，
 * 等于把错误的旧形态重新写回宿主。所以一律**按当前 customConfig 重新推导**
 * （只把 customConfig 当数据用），让重放天然带上最新、正确的声明形态
 * （应用插件：只主表一条 + baseToken）。
 *
 * 边界：若当前配置里一张表都推不出来（空配置/异常形态），退回保存时的声明集，
 * 避免把 payload 变成空声明导致宿主报「配置数据发生变更」。
 */
export function buildReplayPayload(
  savedDataConditions: DataConditionEntry[] | null | undefined,
  customConfig: unknown,
  baseToken?: string | null
): { dataConditions: DataConditionEntry[]; upgraded: boolean; reason: string } {
  const saved = Array.isArray(savedDataConditions) ? savedDataConditions : [];
  const cfg = customConfig as { forms?: (TableRefLike | null | undefined)[] } | null | undefined;
  const forms = Array.isArray(cfg?.forms) ? cfg!.forms! : [];

  const mainTableId = forms.find((f) => f?.mainTable?.tableId)?.mainTable?.tableId;
  const rebuilt = buildDataConditions(forms, mainTableId, baseToken);

  if (rebuilt.length === 0) {
    // 推不出来 → 保留原声明集（不能让 payload 变成「声明 0 张表」）
    return {
      dataConditions: saved,
      upgraded: false,
      reason: saved.length > 0 ? 'keep-saved-empty-config' : 'no-tables',
    };
  }

  // 结构是否等价：比较归一化后的完整结构（tableId/baseToken/dataRange/groups/series），
  // 而不是只看 tableId 集合 —— 旧 payload 若缺 baseToken、或带 groups、或塞了多表，
  // 都属于「需重建为当前正确形态」，要标记 upgraded 供线上日志确认。
  const norm = (arr: DataConditionEntry[] | null | undefined) =>
    (arr ?? [])
      .map((d) => ({
        tableId: d?.tableId ?? '',
        baseToken: d?.baseToken ?? '',
        dataRangeType: d?.dataRange?.type ?? '',
        groupsLen: Array.isArray(d?.groups) ? d.groups.length : 0,
        hasSeries: d?.series != null,
      }))
      .sort((a, b) => (a.tableId < b.tableId ? -1 : 1));
  const sameSet = JSON.stringify(norm(rebuilt)) === JSON.stringify(norm(saved));
  if (sameSet) {
    return { dataConditions: rebuilt, upgraded: false, reason: 'same-set' };
  }
  const savedIds = saved.map((d) => d?.tableId).filter(Boolean);
  return {
    dataConditions: rebuilt,
    upgraded: true,
    reason: savedIds.length === 0 ? 'rebuilt-from-empty' : 'rebuilt-to-current-form',
  };
}