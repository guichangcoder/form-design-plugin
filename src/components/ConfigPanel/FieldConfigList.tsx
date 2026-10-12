import React, { useState } from 'react';
import { FieldConfig } from '../../types';
import { FIELD_TYPE_LABEL } from '../../utils/fieldMapper';
import { FieldTypeIcon } from '../../utils/fieldTypeIcons';
import { Input, Switch, Typography } from '@douyinfe/semi-ui';
import { IconSearch } from '@douyinfe/semi-icons';

interface Props {
  fields: FieldConfig[];
  onChange: (fields: FieldConfig[]) => void;
}

export function FieldConfigList({ fields, onChange }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // P2-10：字段搜索（大表下快速定位字段）。搜索时禁用拖拽排序，避免索引错乱。
  const [keyword, setKeyword] = useState('');

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
          </div>
        );
      })}
      <Typography.Text type="tertiary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        拖拽左侧把手可调整字段显示顺序 · 隐藏字段不参与录入与必填校验
      </Typography.Text>
    </div>
  );
}
