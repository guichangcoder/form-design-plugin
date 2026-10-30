/**
 * 数据源可访问性自检（诊断用）。
 *
 * 为什么需要它：
 * 「选项选不到」有**两种完全不同的根因**，但在旧代码里表现一致（都是 0 个选项）：
 *   ① 声明范围问题：源表没有被声明进 `dataConditions` → View 态整表不可读；
 *   ② 权限问题：表已声明，但当前打开者对该表没有读权限。
 * 两者处置方式不同（① 改代码/重新保存，② 找管理员授权），
 * 所以必须能把它们**区分开**并如实报出来，而不是让用户对着一句「没有可用选项」猜。
 *
 * 本模块只做「纯判定」，不发起请求 —— 真正的探测在调用方完成后再传进来，
 * 这样判定逻辑可以被回归测试真实调用（项目铁律：UI/逻辑缺陷必须抽纯函数）。
 */

/** 单张表的可访问性探测结果 */
export interface TableAccessProbe {
  tableId: string;
  /** meta（getFieldMetaList）是否读成功 */
  metaOk: boolean;
  /** records（getRecordsByPage/getRecords）是否读成功 */
  recordsOk: boolean;
  /** 第一次失败的原始错误文案 */
  error?: string;
}

/** 单张表的可访问性结论 */
export interface TableAccessVerdict {
  tableId: string;
  level: 'ok' | 'blocked';
  /** 给用户看的一句话（不含技术细节） */
  message: string;
  /** 给开发者看的建议处置 */
  action: string;
}

/** 把宿主抛出的原始错误归类成一类可读原因（不依赖具体错误码字符串是否稳定） */
export function classifyAccessError(err?: string): {
  kind: 'permission' | 'partial' | 'timeout' | 'unknown';
  label: string;
} {
  const s = String(err ?? '').toLowerCase();
  if (!s) return { kind: 'unknown', label: '未知错误' };
  if (s.includes('permission') || s.includes('denied') || s.includes('forbidden')) {
    return { kind: 'permission', label: '无读取权限' };
  }
  // partial_view_api_error：宿主「部分视图」接口失败，通常也源于该表不在当前视图的数据源内
  if (s.includes('partial_view')) {
    return { kind: 'partial', label: '不在当前视图的数据源范围内' };
  }
  if (s.includes('timed out') || s.includes('timeout') || s.includes('超时')) {
    return { kind: 'timeout', label: '请求超时' };
  }
  return { kind: 'unknown', label: '读取失败' };
}

/**
 * 判定一张表是否可访问。
 *
 * 关键判据（本项目 2026-10-30 实证）：**meta 与 records 两条独立链路同时失败 ⇒
 * 整表不可访问**，而不是某个字段权限问题。只失败一条则可能是字段级/单接口抖动。
 */
export function judgeTableAccess(probe: TableAccessProbe): TableAccessVerdict {
  const tableId = probe.tableId;
  const ok = probe.metaOk && probe.recordsOk;
  if (ok) {
    return {
      tableId,
      level: 'ok',
      message: `表 ${tableId} 可正常读取`,
      action: '',
    };
  }
  const { kind, label } = classifyAccessError(probe.error);
  const bothFailed = !probe.metaOk && !probe.recordsOk;
  if (bothFailed) {
    const action =
      kind === 'permission'
        ? `表 ${tableId}：当前账号对该表没有读权限。请让多维表格管理员为该表开放「可阅读」，或把它从表单的数据源中移除。`
        : kind === 'partial'
          ? `表 ${tableId}：不在当前视图的数据源范围内。这通常是该表未被声明为应用的数据源 —— 请在配置态重新保存一次（会重新声明数据源）。`
          : `表 ${tableId}：整表读取失败（${label}）。请重试；若持续失败，检查该表是否仍存在、以及当前账号的权限。`;
    return { tableId, level: 'blocked', message: `表 ${tableId} 整表不可读（${label}）`, action };
  }
  // 只有一条链路失败：不足以断定整表不可读，提示重试
  const failedSide = !probe.metaOk ? '字段结构' : '记录';
  return {
    tableId,
    level: 'blocked',
    message: `表 ${tableId} 的${failedSide}读取失败（${label}）`,
    action: `表 ${tableId}：${failedSide}接口失败，可能是瞬时抖动。请重试；若持续失败再检查权限。`,
  };
}

/** 汇总多张表：返回所有不可访问的表（空数组 = 全部正常） */
export function collectBlockedTables(probes: TableAccessProbe[]): TableAccessVerdict[] {
  return (probes ?? []).map(judgeTableAccess).filter((v) => v.level === 'blocked');
}

/** 拼一句可展示的汇总文案（无问题时返回空串，调用方据此决定是否展示） */
export function describeBlockedTables(verdicts: TableAccessVerdict[]): string {
  const list = (verdicts ?? []).filter((v) => v.level === 'blocked');
  if (list.length === 0) return '';
  if (list.length === 1) return list[0].action || list[0].message;
  return `有 ${list.length} 张数据表读取不到：\n` + list.map((v) => `· ${v.action || v.message}`).join('\n');
}

/**
 * ★ base 绑定校验：配置引用的表，在当前**实际用于读取的 base** 里是否都存在。
 *
 * 为什么单列一条判定（2026-10-30 第四轮根因）：
 * `appContext.getBase()` 的实现是 `currentApp?.base ?? bitable.base` ——
 * 一旦配置声明了 baseToken 但 `selectBase()` 失败（Workspace.getBitable 抛错、
 * 该 base 未对插件授权、或 baseToken 已失效），它会**静默回退到宿主默认 base**，
 * 不抛错、不打日志。
 *
 * 而应用模式允许「数据源 ≠ 宿主所在多维表格」（1:N 设计），此时：
 *   · 保存那一刻刚 selectBase 成功过 → 配置态一切正常（所以"第一次生效"）；
 *   · 刷新后 View 态重新加载，若绑定失败 → 用默认 base 去查源表 id → 查不到
 *     → 宿主返回一句没有 message 的低层错误（`msg: undefined code: 12`）。
 *
 * 这能**同时**解释「第一次生效、刷新后全空」，以及在配置态从未复现。
 * 因此必须显式判定并把结论告诉用户，而不是继续猜 dataConditions 的结构。
 *
 * @param configuredTableIds 配置引用的全部表 id
 * @param actualBaseTableIds 当前实际 base 里可见的全部表 id
 * @returns 在当前 base 里查不到的表 id（空数组 = 绑定正确）
 */
export function findTablesOutsideActualBase(
  configuredTableIds: string[] | null | undefined,
  actualBaseTableIds: string[] | null | undefined
): string[] {
  const actual = new Set((actualBaseTableIds ?? []).filter(Boolean) as string[]);
  // actual 为空有两种含义：base 里真没表，或整个 base 读不到。
  // 后者由调用方在 catch 里单独处理，这里按「全都查不到」如实返回，不吞掉。
  return ((configuredTableIds ?? []).filter(Boolean) as string[]).filter((id) => !actual.has(id));
}

/**
 * 拼「base 绑定错位」的用户可见结论（无问题时返回空串）。
 *
 * 与 `describeBlockedTables` 的区别：那个讲「某张表读不到」，
 * 这个讲「**读的是另一张多维表格**」——处置动作完全不同
 * （前者找管理员授权，后者重新选数据源并保存）。
 */
export function describeBaseMismatch(
  missingTableIds: string[],
  baseToken?: string | null
): string {
  const missing = (missingTableIds ?? []).filter(Boolean);
  if (missing.length === 0) return '';
  const token = typeof baseToken === 'string' && baseToken ? `（配置的数据源标记 ...${baseToken.slice(-6)}）` : '（配置未标记数据源）';
  return (
    `当前读取的多维表格里找不到配置引用的 ${missing.length} 张数据表（${missing.join('、')}）。` +
    `这通常说明插件没能连上配置所指定的多维表格${token}，` +
    `而是退回了宿主默认的多维表格。请进入配置模式重新选择数据源并保存。`
  );
}