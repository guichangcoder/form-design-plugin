import { bitable } from '@lark-base-open/js-sdk';
import { FormPluginConfig, FormValues } from '../types';
import { convertToSdkFormat } from '../utils/valueConverter';

export interface SubmitResult {
  success: boolean;
  mainRecordId?: string;
  error?: string;
}

const BATCH_SIZE = 200;

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
    // Step 1: 写入主表
    const mainTable = await bitable.base.getTableById(config.mainTable.tableId);
    const mainFields = await convertToSdkFormat(
      config.mainTable.fields,
      mainValues,
      config.mainTable.tableId
    );
    const mainRes = await mainTable.addRecord({ fields: mainFields as any });
    mainRecordId = (mainRes as { recordId?: string }).recordId;
    if (!mainRecordId) {
      throw new Error('主表记录创建失败：未返回 recordId');
    }

    // Step 2: 写入子表（带关联）
    for (const sub of config.subTables) {
      const rows = subValues[sub.tableId] ?? [];
      if (rows.length === 0) continue;

      const subTable = await bitable.base.getTableById(sub.tableId);
      const records: { fields: Record<string, unknown> }[] = [];
      for (const row of rows) {
        const fields = await convertToSdkFormat(sub.fields, row, sub.tableId);
        // 关联字段指向主表记录
        fields[sub.linkFieldId] = {
          recordIds: [mainRecordId],
          text: '',
          tableId: sub.tableId,
        };
        records.push({ fields });
      }

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        await subTable.addRecords(batch as any);
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
