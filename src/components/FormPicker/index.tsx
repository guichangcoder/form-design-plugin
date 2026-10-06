import React from 'react';
import { Button, Typography } from '@douyinfe/semi-ui';
import { IconSetting } from '@douyinfe/semi-icons';
import { PluginData } from '../../types';
import { HostContext } from '../../services/configService';

interface Props {
  data: PluginData;
  context: HostContext;
  onPick: (formId: string) => void;
  /** 侧边栏模式下提供「管理表单」入口（应用模式宿主不显示，由平台配置态接管） */
  onManage?: () => void;
}

function countFields(f: PluginData['forms'][number]): number {
  const main = f.mainTable?.fields?.length ?? 0;
  const sub = (f.subTables ?? []).reduce((s, st) => s + (st.fields?.length ?? 0), 0);
  return main + sub;
}

/**
 * 使用态：表单选择面板。
 * 列出本页面/本表下所有表单，用户点击某个进入填写（多人共享查看与使用）。
 */
export function FormPicker({ data, context, onPick, onManage }: Props) {
  const forms = data.forms ?? [];
  return (
    <div>
      <div className="section-card">
        <div className="sec-head">
          <span className="sec-num">📝</span>
          <span className="sec-title">选择表单</span>
          <span className="sec-desc">点击进入填写</span>
        </div>
        <div className="sec-body">
          {forms.length === 0 && <div className="empty-tip">暂无可用表单，请先由管理员配置。</div>}
          <div className="fp-list">
            {forms.map((f) => (
              <button className="fp-item" key={f.id} onClick={() => onPick(f.id)}>
                <div className="fp-title">{f.formTitle}</div>
                {f.formDescription && <div className="fp-desc">{f.formDescription}</div>}
                <div className="fp-meta">
                  {f.mainTable?.tableName || '未选主表'} · {countFields(f)} 个字段
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
      {onManage && context !== 'dashboard' && (
        <Button theme="borderless" icon={<IconSetting />} block style={{ marginTop: 8 }} onClick={onManage}>
          管理表单
        </Button>
      )}
      <Typography.Text type="tertiary" style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 12 }}>
        提交后主表与各子表将自动关联写入
      </Typography.Text>
    </div>
  );
}
