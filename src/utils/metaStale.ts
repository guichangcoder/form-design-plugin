import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig } from '../types';
import { isWritableFieldType } from './fieldMapper';

/**
 * 元数据「失效」判定（纯函数，测试可真实调用）。
 *
 * 背景：线上出现「偶发 主表写入失败（not support）」，只有个别用户偶发、
 * 隔一会儿又自己好了。根因之一是**字段类型漂移**：
 * 配置时字段是文本，之后有人把它改成公式 / 查找引用 / 自动编号 / 群聊等
 * 不可写类型；字段 id 仍然存在，所以原来「只查字段在不在」的校验完全放行，
 * 提交按钮依旧可点，直到写入被宿主整条拒绝、只回一句 `not support`。
 *
 * 而这类改动往往是临时的（改回原类型、或权限态恢复后 API 返回的类型不再是
 * Denied），于是表现为「同一用户过一会儿又正常」。这里提前识别并暂停提交，
 * 把不可诊断的服务端报错换成可操作的「请先重新载入」。
 */
export interface UnwritableFieldHit {
  /** 命中的表 id */
  tableId: string;
  /** 命中的字段 id */
  fieldId: string;
  /** 字段展示名（用于提示） */
  label: string;
  /** 表里当前的真实类型 */
  liveType: FieldType;
  /** 原因：字段已不存在 / 类型不可写 */
  reason: 'missing' | 'unwritable';
}

/**
 * 检查一批「配置项 ↔ 当前字段元信息」是否仍然可用。
 *
 * @param configured 配置里声明的字段（主表或某张子表的 fields）
 * @param metas      当前从宿主拿到的字段元信息
 * @param tableId    归属表 id（仅用于回传定位）
 * @returns 第一个命中的问题字段；全部正常则返回 null
 */
export function findStaleConfiguredField(
  configured: FieldConfig[],
  metas: { id: string; type: FieldType }[],
  tableId: string
): UnwritableFieldHit | null {
  const byId = new Map(metas.map((m) => [m.id, m.type]));

  // ① 字段彻底消失（被删除 / 被重命名导致 id 变了）
  for (const f of configured) {
    if (!byId.has(f.fieldId)) {
      return {
        tableId,
        fieldId: f.fieldId,
        label: f.label || f.fieldName || f.fieldId,
        liveType: FieldType.NotSupport,
        reason: 'missing',
      };
    }
  }

  // ② 字段还在，但类型已不可写（漂移成公式/查找引用/自动编号/群聊/Denied…）
  for (const f of configured) {
    const live = byId.get(f.fieldId) as FieldType;
    if (!isWritableFieldType(live)) {
      return {
        tableId,
        fieldId: f.fieldId,
        label: f.label || f.fieldName || f.fieldId,
        liveType: live,
        reason: 'unwritable',
      };
    }
  }

  return null;
}

/** 把命中结果转成给用户看的一句话（区分「字段没了」与「类型变了」） */
export function describeStaleHit(hit: UnwritableFieldHit): string {
  if (hit.reason === 'missing') {
    return `字段「${hit.label}」已被删除或重命名`;
  }
  return `字段「${hit.label}」的类型已变成不可写入的类型`;
}