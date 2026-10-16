import React, { useEffect, useState } from 'react';
import { Modal, Select, InputNumber, Typography, Switch } from '@douyinfe/semi-ui';
import { FieldType } from '@lark-base-open/js-sdk';
import { DateAutoFillConfig, FieldConfig } from '../../types';
import { describeOffset } from '../../utils/dateCalc';

interface Props {
  visible: boolean;
  /** 正在编辑的目标日期字段 */
  field: FieldConfig;
  /** 同区块的全部字段（来源字段候选：主表→主表字段，子表→同行字段） */
  siblingFields: FieldConfig[];
  onCancel: () => void;
  /** undefined 表示关闭联动预填 */
  onSave: (cfg: DateAutoFillConfig | undefined) => void;
}

const DEFAULT_CFG: DateAutoFillConfig = {
  sourceFieldId: '',
  direction: 'plus',
  amount: 1,
  unit: 'year',
};

/**
 * 日期联动预填编辑器：挂在「目标日期字段」上。
 * 例：合同到期日 ← 合同起始日 + 1 年。
 * 预填后用户仍可手动修改，改过之后不再被自动覆盖。
 */
export function DateAutoFillEditor({ visible, field, siblingFields, onCancel, onSave }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [cfg, setCfg] = useState<DateAutoFillConfig>({ ...DEFAULT_CFG });
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (!visible) return;
    const c = field.dateAutoFill;
    setEnabled(!!c?.sourceFieldId);
    setCfg(c ? { ...c } : { ...DEFAULT_CFG });
    setSaveError('');
  }, [visible, field]);

  // 来源字段候选：同区块内除自身外的日期字段
  const sourceCandidates = siblingFields.filter(
    (f) => f.fieldId !== field.fieldId && f.fieldType === FieldType.DateTime
  );

  const patch = (p: Partial<DateAutoFillConfig>) => setCfg((c) => ({ ...c, ...p }));

  const handleSave = () => {
    if (!enabled) {
      onSave(undefined);
      return;
    }
    if (!cfg.sourceFieldId) {
      setSaveError('请选择来源日期字段');
      return;
    }
    const amount = Number(cfg.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      setSaveError('偏移量必须是非负整数');
      return;
    }
    onSave({ ...cfg, amount: Math.floor(amount) });
  };

  const sourceName =
    sourceCandidates.find((f) => f.fieldId === cfg.sourceFieldId)?.label ||
    sourceCandidates.find((f) => f.fieldId === cfg.sourceFieldId)?.fieldName ||
    '';

  return (
    <Modal
      title={`日期联动预填 — ${field.label || field.fieldName}`}
      visible={visible}
      onCancel={onCancel}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      width={480}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Switch checked={enabled} onChange={(v: boolean) => setEnabled(v)} />
        <Typography.Text strong>启用联动预填</Typography.Text>
      </div>

      {enabled ? (
        <>
          <div className="optionref-label">来源日期字段（同一表单区块内）</div>
          <Select
            style={{ width: '100%', marginBottom: 12 }}
            filter
            placeholder={sourceCandidates.length ? '选择来源字段' : '本区块没有其他日期字段'}
            disabled={!sourceCandidates.length}
            value={cfg.sourceFieldId || undefined}
            onChange={(v) => patch({ sourceFieldId: v as string })}
            optionList={sourceCandidates.map((f) => ({
              value: f.fieldId,
              label: f.label || f.fieldName,
            }))}
          />

          <div className="optionref-label">偏移量</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select
              style={{ width: 92 }}
              value={cfg.direction}
              onChange={(v) => patch({ direction: v as 'plus' | 'minus' })}
              optionList={[
                { value: 'plus', label: '之后' },
                { value: 'minus', label: '之前' },
              ]}
            />
            <InputNumber
              style={{ width: 92 }}
              min={0}
              precision={0}
              value={cfg.amount}
              onChange={(v) => patch({ amount: Number(v ?? 0) })}
            />
            <Select
              style={{ width: 92 }}
              value={cfg.unit}
              onChange={(v) => patch({ unit: v as 'day' | 'month' | 'year' })}
              optionList={[
                { value: 'day', label: '天' },
                { value: 'month', label: '个月' },
                { value: 'year', label: '年' },
              ]}
            />
          </div>

          <Typography.Text
            type="tertiary"
            size="small"
            style={{ display: 'block', marginTop: 12, lineHeight: 1.7 }}
          >
            {sourceName
              ? `填写「${sourceName}」后，本字段自动填入 ${describeOffset(cfg)} 的日期（如 2026-03-01 → ${
                  cfg.unit === 'year'
                    ? `${2026 + (cfg.direction === 'minus' ? -1 : 1) * Math.floor(cfg.amount || 0)}-03-01`
                    : '…'
                }）。`
              : '选择来源字段后可见预填示例。'}
            <br />
            用户仍可手动修改本字段；一旦手动改过，再改来源字段也不会覆盖用户输入。
            按「月/年」偏移时，若目标月没有这一天（如 1/31 + 1 个月），自动取该月最后一天。
          </Typography.Text>
        </>
      ) : (
        <Typography.Text type="tertiary" size="small">
          未启用：本字段完全由用户手填
        </Typography.Text>
      )}

      {saveError && (
        <Typography.Text type="danger" size="small" style={{ display: 'block', marginTop: 8 }}>
          {saveError}
        </Typography.Text>
      )}
    </Modal>
  );
}
