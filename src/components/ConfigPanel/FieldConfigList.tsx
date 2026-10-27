import React, { useState } from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { DateAutoFillConfig, FieldConfig, FormFieldRef, OptionReference, UNIQUE_CHECKABLE_TYPES } from '../../types';
import { FIELD_TYPE_LABEL } from '../../utils/fieldMapper';
import { FieldTypeIcon } from '../../utils/fieldTypeIcons';
import { describeOffset } from '../../utils/dateCalc';
import { Button, Input, Switch, Typography } from '@douyinfe/semi-ui';
import { IconSearch, IconLink, IconCalendar, IconLayers } from '@douyinfe/semi-icons';
import { canConfigFormRef, canConfigOptionRef } from '../../utils/configEntry';
import { OptionRefEditor } from './OptionRefEditor';
import { DateAutoFillEditor } from './DateAutoFillEditor';
import { FormRefEditor, RefBlockOption } from './FormRefEditor';

interface Props {
  fields: FieldConfig[];
  onChange: (fields: FieldConfig[]) => void;
  /**
   * ★ 本字段所在区块的 tableId（用于「表单取值」的来源候选里排除自身区块）。
   * 未传时「表单取值」入口不显示 —— 保证未接入的调用方行为完全不变。
   */
  currentTableId?: string;
  /**
   * ★ 本表单中的其它区块（主表 + 其它子表），供「表单取值」选择来源。
   * 未传 / 为空时「表单取值」入口不显示。
   */
  otherBlocks?: RefBlockOption[];
}

/**
 * 高级配置区入口判定（isSelectField / canConfigOptionRef / canConfigFormRef）
 * 已抽到 `src/utils/configEntry.ts` —— 纯函数，回归测试可真实调用，
 * 避免「只靠源码正则证明字样存在、证明不了运行时产出」的假绿。
 */
/** 可配置「唯一性校验」的字段类型（可转文本比较的单值字段） */
function canUniqueCheck(t: FieldType): boolean {
  return UNIQUE_CHECKABLE_TYPES.includes(t);
}

/** 可配置「日期联动预填」的字段类型 */
function isDateField(t: FieldType): boolean {
  return t === FieldType.DateTime;
}

/**
 * 可配置「默认值＝当前用户」的字段类型：**仅人员字段**。
 * 查找引用 / 公式的字段类型是 Lookup / Formula（≠ User），天然不在此列 ——
 * 与「排除查找引用或公式字段」的要求一致，无需额外判断。
 */
function isUserField(t: FieldType): boolean {
  return t === FieldType.User;
}

export function FieldConfigList({ fields, onChange, currentTableId, otherBlocks }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // P2-10：字段搜索（大表下快速定位字段）。搜索时禁用拖拽排序，避免索引错乱。
  const [keyword, setKeyword] = useState('');
  // 引用选项编辑器：正在编辑的字段索引（null = 关闭）
  const [refEditIndex, setRefEditIndex] = useState<number | null>(null);
  // 表单取值编辑器：正在编辑的字段索引（null = 关闭）
  const [formRefEditIndex, setFormRefEditIndex] = useState<number | null>(null);
  // 日期联动预填编辑器：正在编辑的字段索引（null = 关闭）
  const [dateEditIndex, setDateEditIndex] = useState<number | null>(null);

  /** 是否可用「表单取值」：调用方提供了其它区块候选（旧调用方不传 → 入口不出现，零变化） */
  const formRefAvailable = (otherBlocks?.length ?? 0) > 0;

  const update = (idx: number, patch: Partial<FieldConfig>) => {
    onChange(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  // —— 拖拽排序 ——
  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIndex(idx);
    e.dataTransfer.effectAllowed = 'move';
    // 兼容 Firefox：必须设置 dataTransfer.setData 才能触发拖拽
    e.dataTransfer.setData('text/plain', String(idx));
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overIndex !== idx) {
      setOverIndex(idx);
    }
  };

  const handleDragLeave = () => {
    setOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === targetIdx) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = [...fields];
    const [removed] = next.splice(dragIndex, 1);
    next.splice(targetIdx, 0, removed);
    onChange(next);
    setDragIndex(null);
    setOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  if (!fields.length) {
    return <div className="empty-tip">请先选择数据表，字段将自动载入</div>;
  }

  const kw = keyword.trim().toLowerCase();
  // 搜索时按关键字过滤展示；索引仍对应原始 fields，保证 update 正确
  const visibleIndexes = fields
    .map((f, idx) => ({ f, idx }))
    .filter(({ f }) => !kw || (f.fieldName ?? '').toLowerCase().includes(kw) || (f.label ?? '').toLowerCase().includes(kw));

  return (
    <div>
      {fields.length >= 8 && (
        <Input
          size="small"
          prefix={<IconSearch />}
          placeholder={`搜索字段（共 ${fields.length} 个）`}
          value={keyword}
          onChange={(v: string) => setKeyword(v)}
          style={{ marginBottom: 8 }}
          showClear
        />
      )}
      {visibleIndexes.length === 0 && (
        <div className="empty-tip">没有匹配「{keyword}」的字段</div>
      )}
      {visibleIndexes.map(({ f, idx }) => {
        const isDragging = dragIndex === idx;
        const isOver = overIndex === idx;
        return (
          <div
            key={f.fieldId}
            className={`cfg-field-row ${f.visible ? '' : 'hidden'} ${isDragging ? 'dragging' : ''} ${isOver ? 'drag-over' : ''}`}
            draggable={!kw}
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, idx)}
            onDragEnd={handleDragEnd}
          >
            {/* 第一行：拖拽把手 + 类型图标 + 字段名 + 类型徽标 */}
            <div className="cfg-field-main">
              <span className="drag-handle" title="拖拽调整顺序">
                <span className="drag-dots" />
              </span>
              <span className="f-type-icon" title={FIELD_TYPE_LABEL[f.fieldType] ?? String(f.fieldType)}>
                <FieldTypeIcon type={f.fieldType} />
              </span>
              <span className="f-name" title={f.fieldName}>
                {f.fieldName}
              </span>
              <span className="f-type">{FIELD_TYPE_LABEL[f.fieldType] ?? f.fieldType}</span>
            </div>
            {/* 第二行：显示标签输入 + 显示/必填开关（窄面板下保证全部可见可配） */}
            <div className="cfg-field-controls">
              <div className="f-label-input">
                <Input
                  placeholder="显示标签"
                  value={f.label}
                  onChange={(v: string) => update(idx, { label: v })}
                  size="small"
                />
              </div>
              <label className="f-toggle">
                <Switch
                  size="small"
                  checked={f.visible}
                  onChange={(v: boolean) => update(idx, { visible: v })}
                />
                显示
              </label>
              <label className="f-toggle">
                <Switch
                  size="small"
                  checked={f.required}
                  disabled={!f.visible}
                  onChange={(v: boolean) => update(idx, { required: v })}
                />
                必填
              </label>
            </div>
            {/* 第三行：字段级高级配置 —— 唯一性校验 / 日期联动 / 引用选项 */}
            {(canUniqueCheck(f.fieldType) || isDateField(f.fieldType) || canConfigOptionRef(f) || canConfigFormRef(f) || isUserField(f.fieldType)) && (
              <div className="cfg-field-optionref">
                {canUniqueCheck(f.fieldType) && (
                  <label
                    className="f-toggle"
                    title="输入完成（失焦）时全量校验该值在数据表中是否已存在，并在输入框右侧提示；重复时阻止提交"
                  >
                    <Switch
                      size="small"
                      checked={!!f.unique?.enabled}
                      disabled={!f.visible}
                      onChange={(v: boolean) =>
                        update(idx, { unique: { ...(f.unique ?? { enabled: false }), enabled: v } })
                      }
                    />
                    唯一性校验
                  </label>
                )}
                {isDateField(f.fieldType) && (
                  <Button
                    size="small"
                    theme="borderless"
                    type={f.dateAutoFill ? 'primary' : 'tertiary'}
                    icon={<IconCalendar />}
                    onClick={() => setDateEditIndex(idx)}
                  >
                    {f.dateAutoFill
                      ? `联动预填 ${describeOffset(f.dateAutoFill)}`
                      : '联动预填…'}
                  </Button>
                )}
                {canConfigOptionRef(f) && (
                  <Button
                    size="small"
                    theme="borderless"
                    type={f.optionRef && !f.formRef ? 'primary' : 'tertiary'}
                    icon={<IconLink />}
                    onClick={() => setRefEditIndex(idx)}
                    title="选项来自源数据表的历史记录（读服务端，需源表查看权限）"
                  >
                    {f.optionRef
                      ? `已启用引用选项${(f.optionRef.conditions ?? []).length ? `（${(f.optionRef.conditions ?? []).length} 个条件）` : ''}`
                      : '引用选项…'}
                  </Button>
                )}
                {canConfigFormRef(f) && formRefAvailable && (
                  <Button
                    size="small"
                    theme="borderless"
                    type={f.formRef ? 'primary' : 'tertiary'}
                    icon={<IconLayers />}
                    onClick={() => setFormRefEditIndex(idx)}
                    title="选项来自本表单其他区块已录入的值（纯本地、零请求、实时联动）"
                  >
                    {f.formRef ? '已启用表单取值' : '表单取值…'}
                  </Button>
                )}
                {isUserField(f.fieldType) && (
                  <label
                    className="f-toggle"
                    title="打开表单时该人员字段自动填入当前填写者；填写人可自行改选或删除，改过后不再回填"
                  >
                    <Switch
                      size="small"
                      checked={!!f.defaultToCurrentUser}
                      disabled={!f.visible}
                      onChange={(v: boolean) => update(idx, { defaultToCurrentUser: v || undefined })}
                    />
                    默认当前用户
                  </label>
                )}
              </div>
            )}
          </div>
        );
      })}
      <Typography.Text type="tertiary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        拖拽左侧把手可调整字段显示顺序 · 隐藏字段不参与录入与必填校验
      </Typography.Text>
      {dateEditIndex !== null && fields[dateEditIndex] && (
        <DateAutoFillEditor
          visible
          field={fields[dateEditIndex]}
          siblingFields={fields}
          onCancel={() => setDateEditIndex(null)}
          onSave={(cfg: DateAutoFillConfig | undefined) => {
            update(dateEditIndex, { dateAutoFill: cfg });
            setDateEditIndex(null);
          }}
        />
      )}
      {refEditIndex !== null && fields[refEditIndex] && (
        <OptionRefEditor
          visible
          field={fields[refEditIndex]}
          siblingFields={fields}
          onCancel={() => setRefEditIndex(null)}
          onSave={(optionRef: OptionReference | undefined) => {
            update(refEditIndex, { optionRef });
            setRefEditIndex(null);
          }}
        />
      )}
      {formRefEditIndex !== null && fields[formRefEditIndex] && (
        <FormRefEditor
          visible
          field={fields[formRefEditIndex]}
          currentTableId={currentTableId ?? ''}
          otherBlocks={otherBlocks ?? []}
          onCancel={() => setFormRefEditIndex(null)}
          onSave={(formRef: FormFieldRef | undefined) => {
            update(formRefEditIndex, { formRef });
            setFormRefEditIndex(null);
          }}
        />
      )}
    </div>
  );
}
