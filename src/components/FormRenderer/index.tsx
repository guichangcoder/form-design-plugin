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

function initSubValues(config: FormPluginConfig): Record<string, FormValues[]> {
  const o: Record<string, FormValues[]> = {};
  config.subTables.forEach((s) => {
    o[s.tableId] = [{}];
  });
  return o;
}

/** 分区卡片头 */
function SectionHead({ num, title, desc }: { num: string; title: string; desc?: string }) {
  return (
    <div className="sec-head">
      <span className="sec-num">{num}</span>
      <span className="sec-title">{title}</span>
      {desc && <span className="sec-desc">{desc}</span>}
    </div>
  );
}

export function FormRenderer({ config, onBackToConfig }: Props) {
  const [mainValues, setMainValues] = useState<FormValues>({});
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
      setMainValues({});
      setSubValues(initSubValues(config));
    } else {
      toast(`提交失败：${r.error ?? '未知错误'}`, 'error');
    }
  };

  return (
    <div>
      {/* 表单标题区 */}
      <div className="section-card">
        <div className="sec-head">
          <span className="sec-num">📝</span>
          <span className="sec-title">{config.formTitle || '未命名表单'}</span>
          {config.formDescription && <span className="sec-desc">{config.formDescription}</span>}
        </div>
        <div className="sec-body" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
            <span style={{ color: '#dc2626' }}>*</span> 为必填项 · 带条件规则时按实际情况显隐
          </Typography.Text>
          <Button theme="borderless" size="small" onClick={onBackToConfig}>
            ⚙ 配置
          </Button>
        </div>
      </div>

      {/* 主表 */}
      <div className="section-card">
        <SectionHead num="01" title="主表信息" desc="必填" />
        <div className="sec-body">
          <MainForm config={config} values={mainValues} onChange={setMainValues} cond={cond} />
        </div>
      </div>

      {/* 子表 */}
      {config.subTables.map((sub, i) => (
        <div className="section-card" key={sub.tableId}>
          <SectionHead num={String(i + 2).padStart(2, '0')} title={sub.tableName} desc={sub.allowMultiple ? '可多条' : '单条'} />
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
