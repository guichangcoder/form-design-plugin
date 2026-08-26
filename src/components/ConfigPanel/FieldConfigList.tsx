import React from 'react';
import { FieldConfig } from '../../types';
import { FIELD_TYPE_LABEL } from '../../utils/fieldMapper';
import { Input, Switch, Typography } from '@douyinfe/semi-ui';

interface Props {
  fields: FieldConfig[];
  onChange: (fields: FieldConfig[]) => void;
}

export function FieldConfigList({ fields, onChange }: Props) {
  const update = (idx: number, patch: Partial<FieldConfig>) => {
    onChange(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  if (!fields.length) {
    return <div className="empty-tip">请先选择数据表，字段将自动载入</div>;
  }

  return (
    <div>
      {fields.map((f, idx) => (
        <div key={f.fieldId} className={`cfg-field-row ${f.visible ? '' : 'hidden'}`}>
          <span className="f-name" title={f.fieldName}>
            {f.fieldName}
          </span>
          <span className="f-type">{FIELD_TYPE_LABEL[f.fieldType] ?? f.fieldType}</span>
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
      ))}
      <Typography.Text type="tertiary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        隐藏字段不参与录入与必填校验
      </Typography.Text>
    </div>
  );
}
