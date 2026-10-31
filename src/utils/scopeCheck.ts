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

/**
 * ★ 解释「引用选项源表读不到」的确切原因（纯函数，可被测试真实调用）。
 *
 * 🔴 为什么必须抽出来（2026-10-30 第五轮）：
 * 用户连续多轮只能贴一句 `getRecordsByPage error, msg: undefined code: 12`。
 * 这个错误信息在跨 iframe 边界时**已被宿主降级**（没有 message、code 也不是 SDK 的），
 * 靠它无法区分三种完全不同的根因，于是每一轮都在猜。
 *
 * 而用户唯一会截图的地方就是 RefOptionSelect 的错误框 ——
 * 所以必须**把结论直接算好塞进那个框**，让一次截图就带回决定性证据。
 *
 * 四种根因，处置方式完全不同：
 *   ① 连不上配置指定的多维表格（base 绑定错位）→ 重新选数据源保存
 *   ② 表在 base 里，但没被声明为插件数据源（dataConditions 未写入宿主）
 *      → 宿主只加载「声明过的数据源」（partial view），未声明的表读记录必失败
 *   ③ 表已声明也读不到 → 当前账号权限 / 视图范围限制 → 找管理员
 *   ④ 连 base 的表清单都拿不到 → 整个 base 不可达
 *
 * @param visibleTableIds 当前实际 base 里可见的表 id（null = 探测本身失败）
 * @param hostDeclaredIds 宿主持有的 dataConditions 声明表 id（null = 拿不到）
 * @returns 用户可读且足以定位的一句结论；空串 = 不适用（无异常）
 */
export function explainRefReadFailure(input: {
  sourceTableId: string;
  baseToken?: string | null;
  /** ★ 是否成功绑定到配置声明的 base（false = 根本没连上，这是首要根因） */
  baseBound?: boolean;
  visibleTableIds?: string[] | null;
  hostDeclaredIds?: string[] | null;
}): string {
  const src = String(input?.sourceTableId ?? '').trim();
  if (!src) return '';
  const token =
    typeof input.baseToken === 'string' && input.baseToken
      ? `...${input.baseToken.slice(-6)}`
      : '(未标记)';
  const visible = Array.isArray(input.visibleTableIds) ? input.visibleTableIds : null;
  const declared = Array.isArray(input.hostDeclaredIds) ? input.hostDeclaredIds : null;

  // ⓪ 绑定失败（最根本的一类）：连配置声明的多维表格都没连上。
  //    此时后面所有探测（表清单、表是否存在、是否登记）全部没有意义，
  //    必须优先报这一条，否则会把用户引向权限/重新保存等错误处置。
  if (input?.baseBound === false) {
    return `插件没有连上配置所指定的多维表格（数据源标记 ${token}），当前使用的是宿主默认的多维表格，因此读不到源表 ${src}。这通常是页面刷新后数据源尚未就绪导致的 —— 请先刷新页面重试；若仍失败，请进入配置模式重新选择数据源并保存。`;
  }
  /**
   * 🔴 visible（getTableMetaList）拿不到时，绝不能直接判「base 不可达」——
   *   应用插件 View 态**只能访问已登记的数据源表、不能列全表**，所以
   *   getTableMetaList 在 View 态几乎必然失败，它不是「base 是否可达」的可靠判据。
   *   此时只要 `declared`（宿主持有的 dataConditions）可读，且明确缺这张源表，
   *   「没登记数据源」才是真正的结论（而 `table permission denied` 正是其典型特征）。
   *   2026-10-30 第八轮实测：code:12 伴生 table permission denied 时，旧逻辑
   *   误报「无法读取数据表清单」，把真正的「没登记」结论吞掉了。
   */
  if (visible === null) {
    if (declared !== null && !declared.includes(src)) {
      return `源表 ${src} 没有被登记为插件的数据源（宿主持有 ${declared.length} 张表，不含该表）。应用模式只会加载登记过的数据源表，因此读不到它的记录 —— 请进入配置模式重新保存一次，让插件重新登记数据源。`;
    }
    // ④ 连表清单都拿不到、且无从用 declared 定位 → 才报「base 不可达」
    return `无法读取当前多维表格的数据表清单（数据源标记 ${token}）。插件可能没有连上任何多维表格，请刷新页面重试；若持续失败，请重新进入配置模式选择数据源并保存。`;
  }
  // ① base 绑定错位：源表根本不在这张多维表格里
  if (!visible.includes(src)) {
    return `当前连接的多维表格里没有这张源表（源表 ${src}，数据源标记 ${token}）。插件没有连上配置时所选的多维表格，而是用了宿主默认的多维表格 —— 请进入配置模式重新选择数据源并保存一次。`;
  }
  // ② 表在 base 里但未声明为数据源 → 宿主 partial view 不加载它
  if (declared !== null && !declared.includes(src)) {
    return `源表 ${src} 存在于当前多维表格，但没有被登记为插件的数据源（宿主持有 ${declared.length} 张表，不含该表）。应用模式只会加载登记过的数据源表，因此读不到它的记录 —— 请进入配置模式重新保存一次，让插件重新登记数据源。`;
  }
  // ③ 表存在、也已声明，仍读不到 → 权限或视图范围
  return `源表 ${src} 已存在于当前多维表格${declared !== null ? '，且已登记为数据源' : ''}，但读取记录仍被拒绝。这通常是当前账号对这张表的查看权限不足，或该表不在你所见的视图范围内 —— 请让多维表格管理员为这张表开放「可阅读」权限。`;
}