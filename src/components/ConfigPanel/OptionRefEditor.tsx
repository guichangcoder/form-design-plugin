import React, { useEffect, useState } from 'react';
import { Modal, Select, Input, Button, Typography, Switch } from '@douyinfe/semi-ui';
import { IconPlus, IconDelete } from '@douyinfe/semi-icons';
import { FieldConfig, OptionRefCondition, OptionReference } from '../../types';
import { FieldType } from '@lark-base-open/js-sdk';
import {
  FieldMetaLite,
  TableMetaLite,
  getFieldMetaList,
  getTableMetaList,
} from '../../services/baseService';

interface Props {
  visible: boolean;
  /** 正在编辑的字段（单选/多选） */
  field: FieldConfig;
  /** 同区块的全部字段（联动条件中「表单字段」的候选；主表字段→主表字段，子表字段→同行字段） */
  siblingFields: FieldConfig[];
  onCancel: () => void;
  /** optionRef 为 undefined 表示关闭引用选项 */
  onSave: (optionRef: OptionReference | undefined) => void;
}

const labelOf = (list: { id: string; name: string }[], id?: string) =>
  list.find((x) => x.id === id)?.name ?? '';

/**
 * 选项引用编辑器（参考多维表格原生「引用选项」）：
 * 选项来源 = 源表某字段的记录值；可加引用条件（源表字段 = 固定值 / 当前记录某字段值），
 * 条件引用表单字段时即实现「省-市」级联。
 */
export function OptionRefEditor({ visible, field, siblingFields, onCancel, onSave }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [tableId, setTableId] = useState('');
  const [fieldId, setFieldId] = useState('');
  const [fieldType, setFieldType] = useState<FieldType | undefined>(undefined);
  const [conditions, setConditions] = useState<OptionRefCondition[]>([]);
  const [tables, setTables] = useState<TableMetaLite[]>([]);
  const [sourceFields, setSourceFields] = useState<FieldMetaLite[]>([]);
  const [saveError, setSaveError] = useState('');

  // 打开时用字段已有配置初始化
  useEffect(() => {
    if (!visible) return;
    const ref = field.optionRef;
    setEnabled(!!ref);
    setTableId(ref?.tableId ?? '');
    setFieldId(ref?.fieldId ?? '');
    setFieldType(ref?.fieldType);
    setConditions(ref?.conditions ? ref.conditions.map((c) => ({ ...c })) : []);
    setSaveError('');
  }, [visible, field]);

  // 加载 base 内的表列表
  useEffect(() => {
    if (!visible) return;
    getTableMetaList()
      .then(setTables)
      .catch(() => setTables([]));
  }, [visible]);

  // 源表变化时加载其字段列表
  useEffect(() => {
    if (!visible || !tableId) {
      setSourceFields([]);
      return;
    }
    getFieldMetaList(tableId)
      .then(setSourceFields)
      .catch(() => setSourceFields([]));
  }, [visible, tableId]);

  const updateCond = (idx: number, patch: Partial<OptionRefCondition>) =>
    setConditions(conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)));

  const addCond = () =>
    setConditions([
      ...conditions,
      { sourceFieldId: '', valueSource: 'static', staticValue: '' },
    ]);

  const removeCond = (idx: number) => setConditions(conditions.filter((_, i) => i !== idx));

  /** 选择源表条件字段时，同步记录其字段类型（服务端 is 条件需要 fieldType 才能正确解析） */
  const pickSourceField = (idx: number, fieldId: string) => {
    const meta = sourceFields.find((f) => f.id === fieldId);
    updateCond(idx, { sourceFieldId: fieldId, sourceFieldType: meta?.type });
  };

  const handleSave = () => {
    if (!enabled) {
      onSave(undefined);
      return;
    }
    if (!tableId || !fieldId) {
      setSaveError('请选择源表和取值字段');
      return;
    }
    for (const c of conditions) {
      if (!c.sourceFieldId) {
        setSaveError('存在未选择「源表字段」的引用条件');
        return;
      }
      if (c.valueSource === 'static' && !(c.staticValue ?? '').trim()) {
        setSaveError('存在未填写固定值的引用条件');
        return;
      }
      if (c.valueSource === 'field' && !c.formFieldId) {
        setSaveError('存在未选择「表单字段」的引用条件');
        return;
      }
    }
    onSave({ tableId, fieldId, fieldType, conditions });
  };

  // 联动候选：同区块内除自身外的字段
  const linkCandidates = siblingFields.filter((f) => f.fieldId !== field.fieldId);

  return (
    <Modal
      title={`引用选项 — ${field.label || field.fieldName}`}
      visible={visible}
      onCancel={onCancel}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      width={560}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Switch checked={enabled} onChange={(v: boolean) => setEnabled(v)} />
        <Typography.Text strong>启用引用选项</Typography.Text>
      </div>
      {enabled ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <div className="optionref-label">选项来源表</div>
            <Select
              style={{ width: '100%' }}
              filter
              placeholder="选择数据表"
              value={tableId || undefined}
              onChange={(v) => {
                setTableId(v as string);
                setFieldId('');
                setFieldType(undefined);
                setConditions([]);
              }}
              optionList={tables.map((t) => ({ value: t.id, label: t.name }))}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <div className="optionref-label">取值字段（其记录值作为选项）</div>
            <Select
              style={{ width: '100%' }}
              filter
              placeholder={tableId ? '选择字段' : '请先选择源表'}
              disabled={!tableId}
              value={fieldId || undefined}
              onChange={(v) => {
                setFieldId(v as string);
                // ★ 记录取值字段类型：多选需按单元格拆成多个独立选项（可引用到单选）
                setFieldType(sourceFields.find((f) => f.id === (v as string))?.type);
              }}
              optionList={sourceFields.map((f) => ({ value: f.id, label: f.name }))}
            />
            {fieldType === FieldType.MultiSelect && (
              <Typography.Text type="tertiary" size="small" style={{ display: 'block', marginTop: 4 }}>
                ⓘ 取值字段是多选：单元格里的多个选项会**拆成多条独立选项**，
                因此也能被引用到单选字段（不会把「A B」当成一个选项）。
              </Typography.Text>
            )}
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="optionref-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>引用条件（全部满足的记录才纳入选项）</span>
              <Button size="small" icon={<IconPlus />} theme="borderless" onClick={addCond}>
                添加条件
              </Button>
            </div>
            {conditions.length === 0 && (
              <Typography.Text type="tertiary" size="small">
                无条件：引用源表全部记录的去重取值
              </Typography.Text>
            )}
            {conditions.map((c, idx) => (
              <div key={idx} className="optionref-cond-row">
                <Select
                  size="small"
                  style={{ flex: 1.2, minWidth: 0 }}
                  filter
                  placeholder="源表字段"
                  value={c.sourceFieldId || undefined}
                  onChange={(v) => pickSourceField(idx, v as string)}
                  optionList={sourceFields.map((f) => ({ value: f.id, label: f.name }))}
                />
                <span className="optionref-eq">=</span>
                <Select
                  size="small"
                  style={{ width: 96, flexShrink: 0 }}
                  value={c.valueSource}
                  onChange={(v) =>
                    updateCond(idx, {
                      valueSource: v as 'static' | 'field',
                      staticValue: '',
                      formFieldId: '',
                    })
                  }
                  optionList={[
                    { value: 'static', label: '固定值' },
                    { value: 'field', label: '表单字段' },
                  ]}
                />
                {c.valueSource === 'static' ? (
                  <Input
                    size="small"
                    style={{ flex: 1.2, minWidth: 0 }}
                    placeholder="输入固定值"
                    value={c.staticValue ?? ''}
                    onChange={(v: string) => updateCond(idx, { staticValue: v })}
                  />
                ) : (
                  <Select
                    size="small"
                    style={{ flex: 1.2, minWidth: 0 }}
                    filter
                    placeholder="本表单字段"
                    value={c.formFieldId || undefined}
                    onChange={(v) => updateCond(idx, { formFieldId: v as string })}
                    optionList={linkCandidates.map((f) => ({
                      value: f.fieldId,
                      label: f.label || f.fieldName,
                    }))}
                  />
                )}
                <Button
                  size="small"
                  theme="borderless"
                  type="danger"
                  icon={<IconDelete />}
                  onClick={() => removeCond(idx)}
                />
              </div>
            ))}
          </div>
          <Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>
            启用后，字段原有的固定选项不再使用；条件选「表单字段」时，
            选项会随该字段的填写值实时过滤（如「省-市」级联）。
            <br />
            ⚡ 选项在**下拉展开时才加载**，打开表单与配置面板都不卡顿，且**完整穷举、不受源表行数限制**：
            <br />
            · 取值字段是**单选/多选** → 直接取其配置的选项域（1 次请求即完整）；有引用条件时，
            对每个选项做一次「是否存在满足条件的记录」探测 —— **成本只与选项个数有关，与表有几万行无关**，
            所以上万人数据也不会「只出前 200 条」；
            <br />
            · 取值字段是**其它类型**（文本等，没有固定选项域）→ 按该一列分页取回去重（单列负载最小，可按条件过滤）。
            <br />
            若源表极大导致穷举达到上限，底部会**如实提示「已达上限，可能不全」**（不会静默截断）。
            输入关键字时仍会按批向服务端翻页补充命中项。
            <br />
            ⚠️ 发布后所有填写者都要能查看源数据表，否则他们看不到选项——
            插件一律以**填写者本人**的账号权限读取，只加载其权限内的数据，
            与多维表格自身的权限体系一致（无权限的记录不会出现，这是预期行为）。
          </Typography.Text>
        </>
      ) : (
        <Typography.Text type="tertiary" size="small">
          未启用：使用字段在多维表格中配置的固定选项
          {labelOf(tables, field.optionRef?.tableId) ? '（保存后将清除原引用配置）' : ''}
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
