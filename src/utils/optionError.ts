/**
 * 引用选项「读不到」的精确结论（纯函数，供回归测试真实调用）。
 *
 * 🔴 为什么必须单列一个模块（2026-10-30 第七轮）：
 * 枚举层（`tableRecordCache.enumerateRefOptions`）其实**已经算出了确切原因**
 * —— 字段结构读不到 / 字段 ID 已失效 / 服务端说有记录却读不出来。
 * 但 UI 拿到 `error` 文案后又会走一遍 `classifySdkError()`，
 * 而它只按 `permission|forbidden|not found...` 这类**英文关键词**归类，
 * 我们写的中文诊断一个都命中不了 → 统一降级成
 * 「读取「引用选项的源数据表」失败」+「请稍后重试」。
 *
 * 结果就是：**诊断结论在最后一米被丢掉**，用户连续多轮只能看到
 * 「字段结构接口失败，可能是瞬时抖动」这种既不准确、也不可操作的提示，
 * 于是反复重试、始终无效。
 *
 * 正解：由枚举层给出 `errorCode`，UI 按码给结论，不再依赖宿主文案的特征。
 * 分类器只在没有 code（纯意外异常）时兜底。
 */
import { ClassifiedError } from './permError';

/** 与 `tableRecordCache.OptionErrorCode` 对齐（此处独立声明，避免 utils 反向依赖 services） */
export type OptionErrorCodeLike =
  | 'meta-failed'
  | 'field-invalid'
  | 'records-unreadable'
  | 'scan-failed'
  | 'filter-ineffective'
  | 'query-empty';

/**
 * 把 `errorCode` 翻成「结论 + 处置」。
 *
 * @param code 枚举层给出的错误类型（缺失 → 返回 null，交由分类器兜底）
 * @param raw  枚举层给出的原始文案（用于「详情」行，必须先于重试建议展示）
 * @returns null = 无法按码判定，调用方应退回 `classifySdkError`
 */
export function describeOptionError(
  code: OptionErrorCodeLike | string | undefined | null,
  raw?: string
): ClassifiedError | null {
  const detail = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  switch (code) {
    /**
     * 字段结构（getFieldMetaList）读不到。
     * 语义关键：**这不等于「没有选项」**，所以绝不能给「请稍后重试」这种
     * 会让用户原地打转的建议 —— 要明确告诉他当前无法判断，并给出唯一可行路径。
     */
    case 'meta-failed':
      return {
        kind: 'unknown',
        title: '读不到源字段的字段结构，无法确认有哪些选项',
        action:
          '这不代表「没有选项」。请刷新页面重试；若仍如此，' +
          '请进入配置模式重新选择「选项来源表 / 来源字段」并保存一次。' +
          (detail ? `（详情：${detail}）` : ''),
      };
    /**
     * 字段 ID 在源表里已不存在，或扫到了记录但取不到该字段任何值。
     * 这是**配置已失效**，重试没有任何意义 → 必须明确指向「重新配置」。
     */
    case 'field-invalid':
      return {
        kind: 'notfound',
        title: '配置引用的源字段已失效（字段可能被删除或重建）',
        action:
          '重试无效。请进入配置模式重新选择「选项来源字段」并保存；' +
          '若源表本身被替换过，请重新选择来源数据表。' +
          (detail ? `（详情：${detail}）` : ''),
      };
    /** 服务端说有记录，却一条也没读出来 → 权限 / 视图范围 / 未登记数据源 */
    case 'records-unreadable':
      return {
        kind: 'permission',
        title: '读不到源表的记录',
        action:
          '这通常是当前账号对源表没有查看权限，或源表不在你的视图范围内。' +
          '请让该多维表格的管理员为你开放「可阅读」权限；' +
          '若是刚改过配置，请进入配置模式重新保存一次以重新登记数据源。' +
          (detail ? `（详情：${detail}）` : ''),
      };
    /** 扫描过程本身抛错（第 0 页即失败时 truncated 仍是 false，必须靠 code 区分） */
    case 'scan-failed':
      return {
        kind: 'unknown',
        title: '读取源表记录时出错',
        action:
          '请稍后重试；若持续失败，请检查源表是否仍存在、以及当前账号是否还能打开它。' +
          (detail ? `（详情：${detail}）` : ''),
      };
    /** 宿主未按条件过滤（返回的行不满足条件）→ 已回退扫描，属过程信息 */
    case 'filter-ineffective':
      return {
        kind: 'unknown',
        title: '源表不支持按条件过滤，已改为全表扫描',
        action:
          '这通常不影响使用（插件会自动改用全量扫描以取全选项）。' +
          '若结果仍不完整，请稍后重试。' +
          (detail ? `（详情：${detail}）` : ''),
      };
    /** 直接查询两级都 0 条，不可采信 → 已回退扫描确认 */
    case 'query-empty':
      return {
        kind: 'unknown',
        title: '按条件没查到记录，已改为全表扫描确认',
        action:
          '若上级字段确实填了值却仍无选项，请确认源表里存在与之匹配的记录。' +
          (detail ? `（详情：${detail}）` : ''),
      };
    default:
      return null;
  }
}

/**
 * ★ 底部状态栏文案（纯函数，供回归测试真实调用）。
 *
 * 🔴 抽出来的原因（本项目铁律：UI 类缺陷必须抽纯函数、测试真实调用它）：
 * 用户截图里最关键的一处误导就是底部那句
 *   「已加载全部 0 个选项，输入关键字可搜索」
 * —— 它把「根本读不到」说成了「加载成功，只是没有选项」。
 * 这句话写死在组件内联三元里，正则断言证明不了运行时产出，所以抽成纯函数。
 *
 * @param input 渲染所需的全部状态
 * @returns 底部要显示的文案（不含空串）
 */
export function buildRefFooterText(input: {
  searching: boolean;
  inSearch: boolean;
  searchHitCount: number;
  searchDone?: boolean;
  searchScanned: number;
  hasPendingCond: boolean;
  enumRunning: boolean;
  scanned: number;
  total?: number;
  done: boolean;
  valueCount: number;
  complete?: boolean;
  condApplied: boolean;
  source?: string;
  /** ★ 枚举层是否给出了「读不到」的结论（有值 = 绝不是「真的没有选项」） */
  hasError: boolean;
  /** ★ 当前选项是否来自「源表读不到 → 本字段静态选项」的降级 */
  degraded?: boolean;
}): string {
  if (input.searching) return `正在按关键字翻页查询…已扫描 ${input.searchScanned} 条`;
  if (input.inSearch) {
    if (input.searchHitCount > 0) {
      return `搜索命中 ${input.searchHitCount} 个选项${input.searching ? '（仍在翻页补充…）' : ''}`;
    }
    if (input.searching || (input.searchDone === false && input.searchScanned === 0)) return '正在搜索…';
    return '未找到匹配的引用选项';
  }
  if (input.hasPendingCond) return '请先填写上级字段';
  if (input.enumRunning) {
    return `正在穷举选项…已扫描 ${input.scanned}${input.total ? ` / 共 ${input.total}` : ''} 条`;
  }
  if (!input.done) return '正在加载选项…';

  /**
   * ★ 降级态：选项可用，但不是源表实时值 —— 必须说清楚，不能让用户以为
   * 「源表里就这几个」。这既保证能填完表单，又不撒谎。
   */
  if (input.degraded) {
    return `⚠️ 源表暂时读不到，已改用本字段自带的 ${input.valueCount} 个选项（非实时值）`;
  }

  /**
   * 🔴 关键分支：**取不到 ≠ 没有选项**。
   * 一个选项都没拿到、且枚举层已定性为「读不到」时，
   * 绝不能说「已加载全部 0 个」，也不能说「已达上限，可能不全」
   * （那是「扫了很多但撞了限制」的语义，用户会误以为数据太多）。
   * 必须直接说「读不到」，并把视线引到上方的错误框。
   */
  if (input.valueCount === 0 && input.hasError) {
    return '⚠️ 没能读到选项（不是「没有选项」）—— 请看上方错误说明';
  }
  if (input.complete === false) {
    return input.condApplied
      ? `已按条件取到 ${input.valueCount} 个选项（已达上限，可能不全）`
      : `已取到 ${input.valueCount} 个选项（已达上限，可能不全）`;
  }
  if (input.condApplied) return `已按条件穷举全部 ${input.valueCount} 个选项`;
  if (input.source === 'metadata') return `已加载全部 ${input.valueCount} 个选项（源字段选项域）`;
  return `已加载全部 ${input.valueCount} 个选项，输入关键字可搜索`;
}

/**
 * ★ 下拉框内「空状态」文案（纯函数，同上理由）。
 * 旧行为在「读不到」时也显示「没有可用的引用选项」，与底部那句一起构成完整的误导链。
 */
export function buildRefEmptyContent(input: {
  opened: boolean;
  searching: boolean;
  keyword: string;
  hasPendingCond: boolean;
  done: boolean;
  condApplied: boolean;
  /** ★ 枚举层是否已定性为「读不到」 */
  hasError: boolean;
}): string {
  if (!input.opened) return '点击展开后将加载选项';
  if (input.searching) return '正在搜索…';
  if (input.keyword) return '未找到匹配的引用选项';
  if (input.hasPendingCond) return '请先填写上级字段';
  if (!input.done) return '加载中…';
  // ★ 读不到时不能说「没有可用的选项」
  if (input.hasError) return '读取选项失败，详见上方错误说明';
  if (input.condApplied) return '上级未选择或该条件下无选项';
  return '没有可用的引用选项';
}

/**
 * ★ 枚举失败时的**降级候选**（纯函数，供回归测试真实调用）。
 *
 * 🔴 为什么需要降级（2026-10-30 第七轮 —— 换思路的核心）：
 * 前六轮都在修「怎么把源表读出来」。但用户的目标不是「把表读出来」，
 * 而是**「能选到选项、把表单填完」**。只要源表一时读不到（权限、抖动、
 * 视图范围、字段被重建），无论怎么修读取路径，用户都会卡在「0 个选项」。
 *
 * 而这个字段**本身就带着一份选项域**（`field.options`，来自该字段的
 * `property.options`，由 hydrateConfig 从 base 元信息补回）。对「单选/多选」
 * 字段来说，这份选项域是本字段固有的、不依赖源表记录读取的。
 * 源表读不到时用它兜底，用户至少能完成填写。
 *
 * ⚠️ 只在**语义安全**的三重前提下降级（否则宁可不给，也不能给错）：
 *   ① 本字段确实有静态选项域（`options` 非空）；
 *   ② **无联动条件** —— 有条件时选项必须随上级筛选，用全量静态选项会
 *      放出不该出现的值（如「省」选了浙江却列出全国所有市），比空更危险；
 *   ③ 枚举确实一个值都没取到（有部分值时不该丢弃已有结果）。
 *
 * 调用方必须**如实标注这是降级结果**，不能伪装成「源表实时值」。
 *
 * @returns 降级候选文本（空数组 = 不适合降级，应保持错误态）
 */
export function resolveFallbackOptions(input: {
  /** 本字段自身的静态选项（`FieldConfig.options`） */
  staticOptions?: { name?: string }[] | null;
  /** 条件个数（>0 时禁止降级） */
  conditionCount: number;
  /** 已枚举到的选项数（>0 时禁止降级） */
  valueCount: number;
}): string[] {
  if (input.valueCount > 0) return [];
  if (input.conditionCount > 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of input.staticOptions ?? []) {
    const name = typeof o?.name === 'string' ? o.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}