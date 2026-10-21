import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Select, InputNumber, Typography, Switch } from '@douyinfe/semi-ui';
import { FieldType } from '@lark-base-open/js-sdk';
import { DateAutoFillConfig, FieldConfig } from '../../types';
import { describeOffset, applyDateOffset, formatYmd } from '../../utils/dateCalc';
import { wouldCreateAutoFillCycle } from '../../utils/dateAutoFill';

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

  /**
   * ★ 成环预防：把候选里「会让联动依赖成环」的字段标出来并禁用。
   * 例：A 已经配了「A ← B」，此时编辑 B 时若再选 A 作来源，就形成 A↔B 死循环，
   * 填写态会无限互相覆盖（受控日期面板反复重置 → 频闪、选不中日期）。
   */
  const cyclicCandidateIds = new Set(
    sourceCandidates
      .filter((f) => wouldCreateAutoFillCycle(siblingFields, field.fieldId, f.fieldId))
      .map((f) => f.fieldId)
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
    // 成环拦截：互相引用会导致填写态反复覆盖，必须挡住
    if (wouldCreateAutoFillCycle(siblingFields, field.fieldId, cfg.sourceFieldId)) {
      setSaveError('该来源字段与本字段会形成循环联动（互相引用），请改选其他字段');
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

  /**
   * ★ 示例文案必须「算出来」而不是「拼出来」。
   * 旧实现是 `${2026 + n}-03-01` 硬拼年份，既忽略「减一天」的口径，
   * 又与实际 `applyDateOffset` 各写一套逻辑 —— 一旦算法调整，示例就会撒谎。
   * 这里直接用示例日期 2026-03-01 喂给同一个 `applyDateOffset`，
   * 示例 = 实际计算的真实结果，永远同步。
   */
  const sample = useMemo(() => {
    const base = new Date(2026, 2, 1); // 2026-03-01
    const result = applyDateOffset(base, { ...cfg, sourceFieldId: cfg.sourceFieldId || '__sample__' });
    return { base: formatYmd(base), result: formatYmd(result) || '…' };
  }, [cfg]);

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
            style={{ width: '100%', marginBottom: 4 }}
            filter
            placeholder={sourceCandidates.length ? '选择来源字段' : '本区块没有其他日期字段'}
            disabled={!sourceCandidates.length}
            value={cfg.sourceFieldId || undefined}
            onChange={(v) => patch({ sourceFieldId: v as string })}
            optionList={sourceCandidates.map((f) => ({
              value: f.fieldId,
              label: cyclicCandidateIds.has(f.fieldId)
                ? `${f.label || f.fieldName}（会形成循环，不可选）`
                : f.label || f.fieldName,
              disabled: cyclicCandidateIds.has(f.fieldId),
            }))}
          />
          {cfg.sourceFieldId && cyclicCandidateIds.has(cfg.sourceFieldId) && (
            <Typography.Text type="danger" size="small" style={{ display: 'block', marginBottom: 12 }}>
              该字段与本字段已互相引用，会形成循环联动导致无法填写，请换一个来源字段。
            </Typography.Text>
          )}
          {!cfg.sourceFieldId && cyclicCandidateIds.size > 0 && (
            <Typography.Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 12 }}>
              标注「会形成循环」的字段不可选：它与本字段已互相引用，会互相覆盖导致填写时反复跳动。
            </Typography.Text>
          )}
          <div style={{ height: cfg.sourceFieldId && cyclicCandidateIds.has(cfg.sourceFieldId) ? 0 : 8 }} />

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
              ? `填写「${sourceName}」后，本字段自动填入 ${describeOffset(cfg)} 的日期（如 ${sample.base} → ${sample.result}）。`
              : '选择来源字段后可见预填示例。'}
            <br />
            用户仍可手动修改本字段；一旦手动改过，再改来源字段也不会覆盖用户输入。
            按「月/年」偏移时按「期间末日」计算（如 2026-10-21 + 1 年 → 2027-10-20，即一年有效期的最后一天）；
            若目标月没有这一天（如 1/31 + 1 个月），自动取该月最后一天。
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
