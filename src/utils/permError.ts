/**
 * SDK 错误分类：把「读不到数据」的原因区分成权限 / 目标不存在 / 其他，
 * 给用户可操作的提示，而不是一句笼统的「加载失败」。
 *
 * 背景：插件以当前打开者的身份调用 SDK，受其多维表格权限约束。
 * 同一个人能看到、别人看不到的现象，绝大多数是权限问题（而不是配置丢失）。
 */
export type ErrorKind = 'permission' | 'notfound' | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  /** 用户可见的一句话结论 */
  title: string;
  /** 建议动作 */
  action: string;
}

const PERM_PATTERN =
  /permission|forbidden|403|unauthor|denied|no\s*access|not\s*allowed|权限|无查看|不可见|越权/i;
const MISSING_PATTERN =
  /not\s*found|not\s*exist|404|不存在|已删除|已移除|deleted|invalid\s*param|参数错误/i;

export function classifySdkError(e: unknown, target: string): ClassifiedError {
  const raw = String((e as Error)?.message ?? e ?? '');
  const lower = raw.toLowerCase();
  if (PERM_PATTERN.test(lower)) {
    return {
      kind: 'permission',
      title: `没有「${target}」的查看权限`,
      action: '请联系该多维表格的管理员为你开通查看权限，或让配置者改用你有权限的数据表',
    };
  }
  if (MISSING_PATTERN.test(lower)) {
    return {
      kind: 'notfound',
      title: `「${target}」不存在或已被删除`,
      action: '请让配置者重新配置（数据表/字段可能已被重命名或删除）',
    };
  }
  return {
    kind: 'unknown',
    title: `读取「${target}」失败`,
    action: raw ? `错误信息：${raw}` : '请稍后重试；若持续失败，请联系配置者检查数据源配置',
  };
}
