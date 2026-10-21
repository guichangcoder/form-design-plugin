import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Select, Switch, Typography } from '@douyinfe/semi-ui';
import { FieldConfig, FormFieldRef } from '../../types';
import { canBeRefSource } from '../../utils/formFieldRef';

/** 可作为「来源区块」的候选（本表单内的主表或其它子表） */
export interface RefBlockOption {
  tableId: string;
  label: string;
  fields: FieldConfig[];
}

interface Props {
  visible: boolean;
  /** 正在编辑的字段（单选/多选） */
  field: FieldConfig;
  /** 所在区块的 tableId（用于把自己从来源候选中排除，避免自引用） */
  currentTableId: string;
  /** 其它可作为来源的区块（不含当前区块） */
  otherBlocks: RefBlockOption[];
  onCancel: () => void;
  /** formRef 为 undefined 表示关闭该功能 */
  onSave: (formRef: FormFieldRef | undefined) => void;
}

/**
 * 「表单取值」编辑器 —— 选项来自**同一张表单中另一个区块已录入的值**。
 *
 * 与「引用选项」的区别（面向用户的语义差异，必须讲清）：
 * - 引用选项：选项来自**源数据表的历史记录** → 读服务端、受权限约束、可能需要等待加载；
 * - 表单取值：选项来自**本表单此刻正在填的其它区块** → **零请求、即时联动**，
 *   不需要填写者有任何源表读权限。
 */
export function FormRefEditor({
  visible,
  field,
  currentTableId,
  otherBlocks,
  onCancel,
  onSave,
}: Props) {
  const [enabled, setEnabled] = useState(false);
  const [sourceTableId, setSourceTableId] = useState('');
  const [sourceFieldId, setSourceFieldId] = useState('');
  const [aggregate, setAggregate] = useState<'distinctSet' | 'single'>('distinctSet');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (!visible) return;
    const ref = field.formRef;
    setEnabled(!!ref);
    setSourceTableId(ref?.sourceTableId ?? '');
    setSourceFieldId(ref?.sourceFieldId ?? '');
    setAggregate(ref?.aggregate ?? 'distinctSet');
    setSaveError('');
  }, [visible, field]);

  /** 来源候选区块：排除当前区块本身（自引用无意义且会死循环） */
  const blockOptions = useMemo(
    () => (otherBlocks ?? []).filter((b) => b.tableId && b.tableId !== currentTableId),
    [otherBlocks, currentTableId]
  );

  const sourceBlock = blockOptions.find((b) => b.tableId === sourceTableId);
  /** 来源字段候选：只保留「能产出选项文本」的类型，并排除与待配置字段同 ID 的情况 */
  const sourceFieldOptions = useMemo(
    () =>
      (sourceBlock?.fields ?? []).filter(
        (f) => f.visible && f.fieldId !== field.fieldId && canBeRefSource(f.fieldType)
      ),
    [sourceBlock, field.fieldId]
  );

  const handleSave = () => {
    if (!enabled) {
      onSave(undefined);
      return;
    }
    if (!sourceTableId || !sourceFieldId) {
      setSaveError('请选择来源区块与来源字段');
      return;
    }
    const meta = sourceBlock?.fields.find((f) => f.fieldId === sourceFieldId);
    onSave({
      sourceTableId,
      sourceFieldId,
      sourceFieldType: meta?.fieldType,
      aggregate,
    });
  };

  return (
    <Modal
      title={`表单取值 — ${field.label || field.fieldName}`}
      visible={visible}
      onCancel={onCancel}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      width={520}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Switch checked={enabled} onChange={(v: boolean) => setEnabled(v)} />
        <Typography.Text strong>启用「表单取值」（选项来自本表单其他区块已录入的值）</Typography.Text>
      </div>

      {enabled ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <div className="optionref-label">来源区块</div>
            <Select
              style={{ width: '100%' }}
              filter
              placeholder="选择本表单中的另一个区块"
              value={sourceTableId || undefined}
              onChange={(v) => {
                setSourceTableId(v as string);
                setSourceFieldId('');
              }}
              optionList={blockOptions.map((b) => ({ value: b.tableId, label: b.label }))}
              emptyContent="本表单暂无可作为来源的其它区块"
            />
            {blockOptions.length === 0 && (
              <Typography.Text type="tertiary" size="small" style={{ display: 'block', marginTop: 4 }}>
                需要先在表单里添加另一个区块（主表之外的子表，或子表之外的主表）才能使用。
              </Typography.Text>
            )}
          </div>

          <div style={{ marginBottom: 12 }}>
            <div className="optionref-label">来源字段（其在来源区块内已录入的值即选项）</div>
            <Select
              style={{ width: '100%' }}
              filter
              placeholder={sourceTableId ? '选择字段' : '请先选择来源区块'}
              disabled={!sourceTableId}
              value={sourceFieldId || undefined}
              onChange={(v) => setSourceFieldId(v as string)}
              optionList={sourceFieldOptions.map((f) => ({
                value: f.fieldId,
                label: f.label || f.fieldName,
              }))}
              emptyContent="该区块没有可作为取值来源的字段"
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div className="optionref-label">取值方式</div>
            <Select
              style={{ width: '100%' }}
              value={aggregate}
              onChange={(v) => setAggregate(v as 'distinctSet' | 'single')}
              optionList={[
                { value: 'distinctSet', label: '取来源区块全部行的值（去重）— 推荐' },
                { value: 'single', label: '只取来源区块的第一个非空值' },
              ]}
            />
          </div>

          <Typography.Text type="tertiary" size="small" style={{ display: 'block', lineHeight: 1.8 }}>
            ⚡ **纯本地计算、零网络请求**：选项直接取自用户在本表单其它区块已填的内容，
            随填写**实时更新**，不需要等待加载，也不要求填写者有源数据表的查看权限。
            <br />
            例：主表下建 3 条「产品明细」，本字段的选项就只会有这 3 条明细里填过的产品
            （去重后的集合），用户为每条收款计划各选一个。
            <br />
            ⓘ 若来源字段是**多选**，单元格里的多个选项会拆成多条独立选项。
            <br />
            ⚠️ 本功能与「引用选项」互斥：两者都配置时**以本功能优先**（更即时、更贴合本次录入）。
          </Typography.Text>
        </>
      ) : (
        <Typography.Text type="tertiary" size="small">
          未启用：选项沿用「引用选项」配置（若已配置），否则使用字段在多维表格中配置的固定选项。
          {field.formRef ? '（保存后将清除原表单取值配置）' : ''}
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