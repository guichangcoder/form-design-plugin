import { bitable } from '@lark-base-open/js-sdk';
import { FormPluginConfig, FormValues } from '../types';
import { getLinkTargetTableId } from './baseService';
import { convertToSdkFormat } from '../utils/valueConverter';
import { isEmptyValue } from '../utils/validator';

export interface SubmitResult {
  success: boolean;
  mainRecordId?: string;
  error?: string;
}

const BATCH_SIZE = 200;

async function getTableOrThrow(tableId: string, label: string) {
  try {
    return await bitable.base.getTableById(tableId);
  } catch (e) {
    throw new Error(`${label}不可访问（tableId=${tableId}）：${(e as Error)?.message ?? String(e)}`);
  }
}

/**
 * 提交表单：先写主表拿 recordId，再以 recordId 关联写入各子表。
 * 若子表写入失败，回滚删除已写入的主表记录，保证最终一致性。
 */
export async function submitForm(
  config: FormPluginConfig,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>
): Promise<SubmitResult> {
  let mainRecordId: string | undefined;

  try {
    const mainTableId = config.mainTable.tableId;
    if (!mainTableId) throw new Error('主表未配置：mainTable.tableId 为空');

    // Step 1: 写入主表
    const mainTable = await getTableOrThrow(mainTableId, '主表');
    const mainFields = await convertToSdkFormat(
      config.mainTable.fields,
      mainValues,
      mainTableId
    );
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
      for (const row of rows) {
        const fields = await convertToSdkFormat(sub.fields, row, sub.tableId);
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
          await subTable.addRecords(batch as any);
        } catch (e) {
          throw new Error(
            `子表写入失败（tableId=${sub.tableId}，关联字段=${sub.linkFieldId}，目标表=${linkTargetTableId}）：${(e as Error)?.message ?? String(e)}`
          );
        }
      }
    }

    return { success: true, mainRecordId };
  } catch (err) {
    // 回滚：删除已写入的主表记录
    if (mainRecordId) {
      try {
        const mainTable = await bitable.base.getTableById(config.mainTable.tableId);
        await mainTable.deleteRecords([mainRecordId]);
      } catch {
        /* 回滚失败仅记录，不影响错误返回 */
      }
    }
    return { success: false, error: (err as Error).message };
  }
}
