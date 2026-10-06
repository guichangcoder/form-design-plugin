import React, { useEffect, useState } from 'react';
import { FormPluginConfig, FormValues } from '../../types';
import { useConditional } from '../../hooks/useConditional';
import { validateForm } from '../../utils/validator';
import { submitForm } from '../../services/recordService';
import { toast } from '../../utils/toast';
import { applyThemeColor } from '../../utils/theme';
import { Button, Typography } from '@douyinfe/semi-ui';
import { MainForm } from './MainForm';
import { SubForm } from './SubForm';
import { IconSend } from '@douyinfe/semi-icons';

interface Props {
  config: FormPluginConfig;
  onBackToConfig: () => void;
}

function initialValues(fields: FormPluginConfig['mainTable']['fields']): FormValues {
  return fields.reduce<FormValues>((values, field) => {
    if (field.defaultValue !== undefined) {
      values[field.fieldId] = Array.isArray(field.defaultValue)
        ? [...field.defaultValue]
        : field.defaultValue;
    }
    return values;
  }, {});
}

function initMainValues(config: FormPluginConfig): FormValues {
  return initialValues(config.mainTable.fields);
}

function initSubValues(config: FormPluginConfig): Record<string, FormValues[]> {
  const o: Record<string, FormValues[]> = {};
  config.subTables.forEach((s) => {
    o[s.tableId] = [initialValues(s.fields)];
  });
  return o;
}

/** 分区卡片头（填写态不传 num/desc，只显示区块名称） */
function SectionHead({ num, title, desc }: { num?: string; title: string; desc?: string }) {
  return (
    <div className="sec-head">
      {num ? <span className="sec-num">{num}</span> : null}
      <span className="sec-title">{title}</span>
      {desc && <span className="sec-desc">{desc}</span>}
    </div>
  );
}

export function FormRenderer({ config, onBackToConfig }: Props) {
  const [mainValues, setMainValues] = useState<FormValues>(() => initMainValues(config));
  const [subValues, setSubValues] = useState<Record<string, FormValues[]>>(() =>
    initSubValues(config)
  );
  const [submitting, setSubmitting] = useState(false);
  const cond = useConditional(config, mainValues, subValues);

  // 应用配置的主题色
  useEffect(() => {
    applyThemeColor(config.themeColor);
  }, [config.themeColor]);

  const handleSubmit = async () => {
    const res = validateForm(config, mainValues, subValues, cond);
    if (!res.valid) {
      toast(res.errors[0] ?? '校验未通过', 'error');
      return;
    }
    setSubmitting(true);
    const r = await submitForm(config, mainValues, subValues);
    setSubmitting(false);
    if (r.success) {
      toast('提交成功', 'success');
      setMainValues(initMainValues(config));
      setSubValues(initSubValues(config));
    } else {
      toast(`提交失败：${r.error ?? '未知错误'}`, 'error');
    }
  };

  return (
    <div className="fill-form">
      {/* 表单标题区：网页表单风格，居中标题 + 描述，右上角保留配置入口 */}
      <div className="fill-head">
        <div className="fill-title">{config.formTitle || '未命名表单'}</div>
        {config.formDescription && <div className="fill-desc">{config.formDescription}</div>}
        <Button theme="borderless" size="small" className="fill-config-btn" onClick={onBackToConfig}>
          ⚙ 配置
        </Button>
      </div>

      {/* 主表 */}
      <div className="section-card">
        <SectionHead title={config.mainTable.sectionName || config.mainTable.tableName || '主表信息'} />
        <div className="sec-body">
          <MainForm config={config} values={mainValues} onChange={setMainValues} cond={cond} />
        </div>
      </div>

      {/* 子表 */}
      {config.subTables.map((sub, i) => (
        <div className="section-card" key={sub.tableId}>
          <SectionHead title={sub.sectionName || sub.tableName || `子表${i + 1}`} />
          <div className="sec-body">
            <SubForm
              sub={sub}
              rows={subValues[sub.tableId] ?? [{}]}
              onChange={(rows) => setSubValues((o) => ({ ...o, [sub.tableId]: rows }))}
              cond={cond}
            />
          </div>
        </div>
      ))}

      {/* 提交 */}
      <Button
        theme="solid"
        type="primary"
        className="submit-btn"
        loading={submitting}
        icon={!submitting ? <IconSend /> : undefined}
        onClick={handleSubmit}
      >
        {submitting ? '正在提交…' : '提交'}
      </Button>
      <Typography.Text type="tertiary" style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 12 }}>
        提交后主表与各子表将自动关联写入
      </Typography.Text>
    </div>
  );
}
