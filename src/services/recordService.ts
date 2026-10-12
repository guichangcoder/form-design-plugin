import { FormPluginConfig, FormValues, ConditionalState } from '../types';
import { getLinkTargetTableId } from './baseService';
import { convertToSdkFormat } from '../utils/valueConverter';
import { isEmptyValue } from '../utils/validator';
import { getBase } from './appContext';

export interface SubmitResult {
  success: boolean;
  mainRecordId?: string;
  error?: string;
  /**
   * 失败时的补偿结果（飞书官方诊断 P0-2）：
   * - 'none'      ：未发生任何写入（主表就失败了），无需回滚
   * - 'clean'     ：已写入的主表/子表记录全部回滚删除成功
   * - 'partial'   ：部分已写入记录删除失败，可能残留孤立记录（用户需人工核查）
   */
  rollback?: 'none' | 'clean' | 'partial';
  /** 补偿细节（哪些子记录未能删除），用于 UI 提示与人工清理 */
  rollbackDetail?: string;
}

const BATCH_SIZE = 200;

async function getTableOrThrow(tableId: string, label: string) {
  try {
    return await getBase().getTableById(tableId);
  } catch (e) {
    throw new Error(`${label}不可访问（tableId=${tableId}）：${(e as Error)?.message ?? String(e)}`);
  }
}

/** 从 addRecords 的返回值中提取 recordId 列表（兼容 string[] 与对象形态） */
function extractRecordIds(res: unknown): string[] {
  if (!res) return [];
  if (Array.isArray(res)) {
    return res
      .map((r) => {
        if (typeof r === 'string') return r;
        if (r && typeof r === 'object') {
          const o = r as Record<string, unknown>;
          return String(o.recordId ?? o.record_id ?? '');
        }
        return '';
      })
      .filter((id) => !!id);
  }
  return [];
}

/** 判断字段在条件引擎下是否被隐藏（全表级 + 子表行级） */
function isFieldHiddenByCond(
  cond: ConditionalState | undefined,
  tableId: string,
  fieldId: string,
  rowIndex?: number
): boolean {
  if (!cond) return false;
  if (cond.hiddenFields[tableId]?.has(fieldId)) return true;
  if (rowIndex !== undefined && cond.rowHiddenFields[tableId]?.[rowIndex]?.has(fieldId)) {
    return true;
  }
  return false;
}

/**
 * 提交表单：先写主表拿 recordId，再以 recordId 关联写入各子表。
 *
 * 一致性保证（飞书官方诊断 P0-2 修复）：
 * - 每个批次成功创建的子记录 ID 都被记录；
 * - 任一步失败时，按「后写先删」逆序删除所有已创建的子记录，最后删主表记录；
 * - 补偿本身的成败会计入 SubmitResult.rollback，UI 据此区分
 *   「完整成功 / 失败已回滚 / 失败且有残留」三种结果。
 *
 * 条件隐藏语义（P1-3 修复）：提交前按最新 conditional state 过滤掉隐藏字段的值，
 * 隐藏字段的旧值不会写入多维表格（用户重新显示该字段前的输入不会静默入库）。
 */
export async function submitForm(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>,
  cond?: ConditionalState
): Promise<SubmitResult> {
  let mainRecordId: string | undefined;
  // 已创建的子记录（按写入顺序）：失败补偿时逆序删除
  const createdSubRecords: { tableId: string; tableName: string; ids: string[] }[] = [];

  try {
    const mainTableId = config.mainTable.tableId;
    if (!mainTableId) throw new Error('主表未配置：mainTable.tableId 为空');

    // Step 1: 写入主表（隐藏字段不提交）
    const mainTable = await getTableOrThrow(mainTableId, '主表');
    const visibleMainFields = config.mainTable.fields.filter(
      (f) => !isFieldHiddenByCond(cond, mainTableId, f.fieldId)
    );
    const mainFields = await convertToSdkFormat(visibleMainFields, mainValues, mainTableId);
    let mainRes;
    try {
      mainRes = await mainTable.addRecord({ fields: mainFields as any });
    } catch (e) {
      throw new Error(`主表写入失败（tableId=${mainTableId}）：${(e as Error)?.message ?? String(e)}`);
    }
    // 当前 SDK 类型直接返回 recordId 字符串；兼容旧宿主可能返回 { recordId } 的形态。
    mainRecordId =
      typeof mainRes === 'string'
        ? mainRes
        : (mainRes as unknown as { recordId?: string }).recordId;
    if (!mainRecordId) {
      throw new Error('主表记录创建失败：未返回 recordId');
    }

    // Step 2: 写入子表（带关联）
    for (const sub of config.subTables) {
      const rows = (subValues[sub.tableId] ?? []).filter((row) =>
        sub.fields.some((field) => !isEmptyValue(row[field.fieldId]))
      );
      if (rows.length === 0) continue;

      if (!sub.tableId) throw new Error('子表 tableId 为空：请重新保存配置');

      const subTable = await getTableOrThrow(sub.tableId, `子表「${sub.tableName || sub.tableId}」`);

      // 关联字段元信息里的 property.tableId 才是宿主认定的目标表。
      // 它必须等于主表，否则后面把主表 recordId 写进去会触发 table/record not found。
      const linkTargetTableId = await getLinkTargetTableId(sub.tableId, sub.linkFieldId);
      if (!linkTargetTableId) {
        throw new Error(
          `子表「${sub.tableName || sub.tableId}」的关联字段（${sub.linkFieldId}）不是关联类型`
        );
      }
      if (linkTargetTableId !== mainTableId) {
        throw new Error(
          `子表「${sub.tableName || sub.tableId}」的关联字段指向了 ${linkTargetTableId}，而不是主表 ${mainTableId}；请在配置里重新选择指向主表的关联字段`
        );
      }

      const records: { fields: Record<string, unknown> }[] = [];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        // ★ 行级隐藏过滤：该行被条件隐藏的字段不提交（P1-3）
        const visibleSubFields = sub.fields.filter(
          (f) => !isFieldHiddenByCond(cond, sub.tableId, f.fieldId, rowIndex)
        );
        const fields = await convertToSdkFormat(visibleSubFields, row, sub.tableId);
        // 关联字段指向主表记录
        fields[sub.linkFieldId] = {
          type: 'text',
          recordIds: [mainRecordId],
          text: '',
          // link 字段的 tableId 是被关联的目标表，即主表，而不是当前子表。
          tableId: linkTargetTableId,
          record_ids: [mainRecordId],
          table_id: linkTargetTableId,
        };
        records.push({ fields });
      }

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        try {
          const res = await subTable.addRecords(batch as any);
          // ★ 记录本批成功创建的子记录 ID，供失败补偿删除（P0-2）
          const ids = extractRecordIds(res);
          if (ids.length > 0) {
            createdSubRecords.push({
              tableId: sub.tableId,
              tableName: sub.tableName || sub.tableId,
              ids,
            });
          } else {
            console.warn(
              `[recordService] 子表「${sub.tableName || sub.tableId}」第 ${i / BATCH_SIZE + 1} 批写入成功但未返回 recordId，该批将无法自动回滚`
            );
          }
        } catch (e) {
          throw new Error(
            `子表写入失败（tableId=${sub.tableId}，关联字段=${sub.linkFieldId}，目标表=${linkTargetTableId}）：${(e as Error)?.message ?? String(e)}`
          );
        }
      }
    }

    return { success: true, mainRecordId };
  } catch (err) {
    // —— 失败补偿：逆序删除已创建的子记录，再删主表记录（P0-2 修复）——
    const failedCleanups: string[] = [];
    if (createdSubRecords.length > 0 || mainRecordId) {
      // 逆序：后写入的子表先删
      for (let i = createdSubRecords.length - 1; i >= 0; i -= 1) {
        const created = createdSubRecords[i];
        try {
          const table = await getBase().getTableById(created.tableId);
          for (let j = 0; j < created.ids.length; j += BATCH_SIZE) {
            await table.deleteRecords(created.ids.slice(j, j + BATCH_SIZE));
          }
        } catch (ce) {
          console.error(`[recordService] 回滚子表「${created.tableName}」失败:`, ce);
          failedCleanups.push(
            `子表「${created.tableName}」${created.ids.length} 条（${(ce as Error)?.message ?? String(ce)}）`
          );
        }
      }
      if (mainRecordId) {
        try {
          const mainTable = await getBase().getTableById(config.mainTable.tableId);
          await mainTable.deleteRecords([mainRecordId]);
        } catch (ce) {
          console.error('[recordService] 回滚主表记录失败:', ce);
          failedCleanups.push(`主表记录（${(ce as Error)?.message ?? String(ce)}）`);
        }
      }
    }
    const hadWrites = createdSubRecords.length > 0 || !!mainRecordId;
    return {
      success: false,
      error: (err as Error).message,
      rollback: !hadWrites ? 'none' : failedCleanups.length === 0 ? 'clean' : 'partial',
      rollbackDetail: failedCleanups.length > 0 ? failedCleanups.join('；') : undefined,
    };
  }
}
