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
 * 构造完整的 `dataConditions` 声明集。
 *
 * 🔴 2026-10-30 修正：**结构必须与 `b33053f` 实测可用的形态一致**，即
 *   `{ tableId, dataRange: { type: 'ALL' } }`，不要额外塞 `groups` / `series`。
 *
 * 背景：`b33053f` 注释明确记着那次是**实测跑通**的（多表声明可用）；
 * 而 02c9ac2 我给它加了 `groups: []` 与 `series: 'COUNTA'`，结果三轮修复
 * 全部无效、宿主仍报 `getRecordsByPage error, msg: undefined code: 12`
 * ——`msg` 为 undefined 说明错误对象在宿主侧被降级，这是「宿主不认这个
 * payload」的特征，而不是「表没权限」。多出的字段很可能让整个声明被丢弃。
 *
 * 所以这里只保留两个必需的键：声明哪张表 + 取全表数据。
 * `baseToken` 仅在明确传入时附加（应用模式 1:N 场景需要它来指明 base）。
 *
 * ⚠️ 若将来确实需要图表聚合语义（`series`），必须先在真机上验证宿主接受度，
 *    不要凭 SDK 类型定义想当然（类型允许 ≠ 宿主接受）。
 *
 * @param forms     全部表单
 * @param primaryTableId 主表单的主表 id（保留参数以兼容既有调用，当前不参与构造）
 * @param baseToken 配置所属多维表格（非空时附加）
 */
export function buildDataConditions(
  forms: (TableRefLike | null | undefined)[] | null | undefined,
  primaryTableId?: string | null,
  baseToken?: string | null
): DataConditionEntry[] {
  const ids = collectDeclaredTableIds(forms);
  if (ids.length === 0) return [];
  const tok = typeof baseToken === 'string' && baseToken ? baseToken : undefined;
  void primaryTableId;

  return ids.map((tableId) => ({
    tableId,
    ...(tok ? { baseToken: tok } : {}),
    dataRange: { type: 'ALL' as const },
  }));
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
 *
 * 那份 payload 是「上一次保存那一刻」的快照，可能早于声明逻辑的升级。
 * 例如旧版本只声明主表一条，若原样重放，等于把「已扩大的声明集」又缩回去 →
 * 选项引用源表再次不在声明集里 → 刷新后依然整表不可读
 * （2026-10-30 实测：`02c9ac2` 修好了 saveConfig，但 App 的 View 态自动修复
 *   每次加载都重放旧 payload，把修复覆盖掉，用户端表现完全没变）。
 *
 * 正解：声明集一律**按当前 customConfig 重新推导**，只把 customConfig 当数据用。
 * 这样重放天然带上最新的声明逻辑，与真实 saveConfig 的产出一致。
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

  const savedIds = saved.map((d) => d?.tableId).filter(Boolean);
  const newIds = rebuilt.map((d) => d.tableId);
  const sameSet =
    savedIds.length === newIds.length && newIds.every((id) => savedIds.includes(id));
  if (sameSet) {
    // 声明集等价 → 仍用重建结果（补上 baseToken/COUNTA 等最新形态），但不算升级
    return { dataConditions: rebuilt, upgraded: false, reason: 'same-set' };
  }
  return {
    dataConditions: rebuilt,
    upgraded: true,
    reason: savedIds.length === 0 ? 'rebuilt-from-empty' : 'expanded-from-stale-payload',
  };
}