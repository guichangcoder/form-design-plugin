/**
 * 人员字段「默认值＝当前用户」的纯逻辑（不依赖 React / SDK，回归测试可在 Node 中直接跑）。
 *
 * 语义（**一次性初始化**，与日期联动的「持续联动」不同）：
 * - 打开表单时，配置了该开关的人员字段自动填入**当前填写者**；
 * - 用户可自行改选 / 删除；**改过或清空后不再回填**（用 done 集合守门）；
 * - 字段本就有非空值（如配置了 defaultValue）→ 尊重它，不覆盖，仅登记 done；
 * - 提交成功、开始填写下一条记录时，调用方清空 done 集合 → 新记录重新默认当前用户。
 *
 * ★ 为什么必须运行时取 userId，而不是存进 `defaultValue`：
 *   `defaultValue` 在配置者会话里被写入配置，存下的是**配置者**的 open_id，
 *   所有填写者都会被默认成同一个人。当前用户只能在运行时用
 *   `getBridge().getUserId()` 取「打开者」身份。
 */
import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig, FormValues } from '../types';

/** done 集合的 key：主表 `main:<fieldId>`；子表 `sub:<tableId>:<rowIndex>:<fieldId>` */
export type UserDefaultKeyOf = (fieldId: string) => string;

/**
 * 该字段是否需要「默认当前用户」。
 * 用**显式类型匹配**（`fieldType === User`）而非「非只读」——
 * 查找引用/公式字段的 fieldType 分别是 Lookup / Formula，天然不满足，无需额外排除。
 */
export function hasUserDefault(field: FieldConfig): boolean {
  return field.fieldType === FieldType.User && field.defaultToCurrentUser === true;
}

/** 区块内所有「默认当前用户」字段 */
export function listUserDefaultFields(fields: FieldConfig[]): FieldConfig[] {
  return (fields ?? []).filter(hasUserDefault);
}

/**
 * ★ 零破坏守门（供渲染层判断要不要构建该能力）：
 * 主表与所有子表都没有该配置时为 false —— 调用方据此**完全不发请求、不跑 effect**，
 * 旧配置 / 未使用该功能时行为与今日完全一致。
 */
export function formHasAnyUserDefault(
  mainFields: FieldConfig[],
  subTables: Array<{ fields: FieldConfig[] }>
): boolean {
  if (listUserDefaultFields(mainFields ?? []).length > 0) return true;
  return (subTables ?? []).some((s) => listUserDefaultFields(s?.fields ?? []).length > 0);
}

/** 人员字段值（BitableUser[]）是否为空 */
export function isEmptyPersonValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 应用「当前用户」默认值。
 *
 * @param fields 本区块字段配置
 * @param values 本行当前值
 * @param meId   当前用户 open_id（取不到时传空串 → 不填，等下次拿到再试）
 * @param done   已处理过的 key 集合（**就地修改**）：登记后即不再回填，实现「改过/清空不回填」
 * @param keyOf  生成 key 的函数（引用需稳定；主表用模块级常量，子表按行生成）
 * @returns 变更后的行值；无变化时返回 null（调用方据此跳过 setState，避免死循环）
 */
export function applyUserDefaults(
  fields: FieldConfig[],
  values: FormValues,
  meId: string,
  done: Set<string>,
  keyOf: UserDefaultKeyOf
): FormValues | null {
  if (!meId) return null;
  let next: FormValues | null = null;
  for (const f of fields) {
    if (!hasUserDefault(f)) continue;
    const key = keyOf(f.fieldId);
    if (done.has(key)) continue; // 已处理过（含用户改过/清空）→ 绝不回填
    if (!isEmptyPersonValue(values[f.fieldId])) {
      // 本就有值（例如配置了 defaultValue）：尊重它，只登记以后不再插手
      done.add(key);
      continue;
    }
    next = next ?? { ...values };
    next[f.fieldId] = [{ id: meId }];
    done.add(key);
  }
  return next;
}

/** 清空某个区块（或全部）的 done 标记：提交成功后调用，让下一条记录重新默认当前用户 */
export function resetUserDefaultDone(done: Set<string>, prefix?: string): void {
  if (!prefix) {
    done.clear();
    return;
  }
  for (const k of [...done]) {
    if (k.startsWith(prefix)) done.delete(k);
  }
}