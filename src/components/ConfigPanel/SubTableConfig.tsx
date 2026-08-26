import React, { useEffect, useState } from 'react';
import type { SubTableConfig } from '../../types';
import { useFieldMeta } from '../../hooks/useFieldMeta';
import { getLinkFields, metaToFieldConfig } from '../../services/baseService';
import { FieldConfigList } from './FieldConfigList';
import { Select, Switch, InputNumber, Button, Typography } from '@douyinfe/semi-ui';
import { IconClose } from '@douyinfe/semi-icons';

interface Props {
  sub: SubTableConfig;
  index?: number;
  tables: { id: string; name: string }[];
  onChange: (sub: SubTableConfig) => void;
  onRemove: () => void;
}

export function SubTableConfig({ sub, index, tables, onChange, onRemove }: Props) {
  const { fields } = useFieldMeta(sub.tableId || undefined);
  const [linkFields, setLinkFields] = useState<{ fieldId: string; fieldName: string }[]>([]);

  useEffect(() => {
    if (sub.tableId) {
      getLinkFields(sub.tableId)
        .then((list) => setLinkFields(list.map((l) => ({ fieldId: l.fieldId, fieldName: l.fieldName }))))
        .catch(() => setLinkFields([]));
    } else {
      setLinkFields([]);
    }
  }, [sub.tableId]);

  // 子表选择后，自动用其字段初始化表单配置
  useEffect(() => {
    if (fields.length && sub.fields.length === 0 && sub.tableId) {
      onChange({ ...sub, fields: fields.map(metaToFieldConfig) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields]);

  return (
    <div className="subcfg-box">
      <div className="subcfg-top">
        {sub.tableName ? (
          <span className="subcfg-tag">
            {typeof index === 'number' ? `子表 ${index + 1} · ` : ''}
            {sub.tableName}
          </span>
        ) : (
          <span className="subcfg-tag">未选择</span>
        )}
        <Button type="danger" theme="borderless" icon={<IconClose />} onClick={onRemove}>
          移除
        </Button>
      </div>

      <Select
        style={{ width: '100%' }}
        placeholder="选择子表"
        value={sub.tableId || undefined}
        onChange={(v: any) =>
          onChange({
            ...sub,
            tableId: v,
            tableName: tables.find((t) => t.id === v)?.name ?? '',
            fields: [],
          })
        }
        optionList={tables.map((t) => ({ value: t.id, label: t.name }))}
      />

      {sub.tableId && (
        <>
          <div className="subcfg-row">
            <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
              关联字段（子表指向主表）：
            </Typography.Text>
            <Select
              style={{ flex: 1, minWidth: 160 }}
              placeholder="选择关联字段"
              value={sub.linkFieldId || undefined}
              onChange={(v: any) =>
                onChange({
                  ...sub,
                  linkFieldId: v,
                  linkFieldName: linkFields.find((l) => l.fieldId === v)?.fieldName,
                })
              }
              optionList={linkFields.map((l) => ({
                value: l.fieldId,
                label: `${l.fieldName}（关联）`,
              }))}
            />
            {linkFields.length === 0 && (
              <Typography.Text type="warning" style={{ width: '100%', fontSize: 12 }}>
                该子表无关联字段，请先在多维表格中创建指向主表的关联字段
              </Typography.Text>
            )}
          </div>

          <div className="subcfg-row">
            <label className="subcfg-label">
              <Switch
                size="small"
                checked={sub.allowMultiple}
                onChange={(v: boolean) => onChange({ ...sub, allowMultiple: v })}
              />
              允许多条
            </label>
            {sub.allowMultiple && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
                  最多
                </Typography.Text>
                <InputNumber
                  value={sub.maxRows}
                  min={1}
                  size="small"
                  onChange={(v: any) => onChange({ ...sub, maxRows: v ?? undefined })}
                  style={{ width: 80 }}
                />
                <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
                  条
                </Typography.Text>
              </span>
            )}
          </div>

          <div style={{ marginTop: 10, borderTop: '1px dashed #e2e8f0', paddingTop: 10 }}>
            <FieldConfigList
              fields={sub.fields}
              onChange={(f) => onChange({ ...sub, fields: f })}
            />
          </div>
        </>
      )}
    </div>
  );
}
