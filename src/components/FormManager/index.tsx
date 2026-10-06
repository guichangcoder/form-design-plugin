import React from 'react';
import { Button, Typography, Tag } from '@douyinfe/semi-ui';
import { IconPlus, IconEdit, IconDelete, IconTick } from '@douyinfe/semi-icons';
import { FormPluginConfig, PluginData } from '../../types';
import { HostContext } from '../../services/configService';
import { toast } from '../../utils/toast';

interface Props {
  data: PluginData | null;
  context: HostContext;
  onEditForm: (form: FormPluginConfig | null) => void;
  onSaveData: (data: PluginData) => Promise<void>;
}

/** 统计一个表单的字段总数（主表 + 各子表） */
function countFields(f: FormPluginConfig): number {
  const main = f.mainTable?.fields?.length ?? 0;
  const sub = (f.subTables ?? []).reduce((s, st) => s + (st.fields?.length ?? 0), 0);
  return main + sub;
}

/**
 * 配置态：表单管理面板。
 * 展示本页面/本表下所有相互独立的表单，支持新建、编辑、删除、设为默认。
 */
export function FormManager({ data, context, onEditForm, onSaveData }: Props) {
  const forms = data?.forms ?? [];
  const defaultId = data?.defaultFormId;

  const setDefault = async (id: string) => {
    if (!data) return;
    try {
      await onSaveData({ ...data, defaultFormId: id });
      toast('已设为默认表单', 'success');
    } catch {
      // 父层已展示具体保存错误，这里只消费 Promise，避免触发 unhandledrejection。
    }
  };

  const remove = async (f: FormPluginConfig) => {
    if (!data) return;
    if (!window.confirm(`确定删除表单「${f.formTitle}」？此操作不可恢复。`)) return;
    const forms2 = data.forms.filter((x) => x.id !== f.id);
    const defaultFormId = defaultId === f.id ? forms2[0]?.id : defaultId;
    try {
      await onSaveData({ forms: forms2, defaultFormId });
      toast('表单已删除', 'success');
    } catch {
      // 父层已展示具体保存错误，这里只消费 Promise，避免触发 unhandledrejection。
    }
  };

  return (
    <div>
      <div className="section-card">
        <div className="sec-head">
          <span className="sec-num">🗂</span>
          <span className="sec-title">表单管理</span>
          <span className="sec-desc">
            {context === 'dashboard' ? '本仪表盘页面的表单资产' : '可创建多个相互独立的表单'}
          </span>
        </div>
        <div className="sec-body">
          {forms.length === 0 && (
            <div className="empty-tip" style={{ marginBottom: 12 }}>
              还没有表单。点击下方「新建表单」开始配置字段、校验规则与子表。
            </div>
          )}
          <div className="fm-list">
            {forms.map((f) => (
              <div className={`fm-item ${defaultId === f.id ? 'is-default' : ''}`} key={f.id}>
                <div className="fm-info">
                  <div className="fm-title">
                    {f.formTitle}
                    {defaultId === f.id && (
                      <Tag size="small" color="green" style={{ marginLeft: 8 }}>
                        默认
                      </Tag>
                    )}
                  </div>
                  <div className="fm-meta">
                    {f.mainTable?.tableName || '未选主表'} · {countFields(f)} 个字段
                    {f.subTables?.length ? ` · ${f.subTables.length} 个子表` : ''}
                  </div>
                </div>
                <div className="fm-actions">
                  {defaultId !== f.id && (
                    <Button theme="borderless" size="small" icon={<IconTick />} onClick={() => setDefault(f.id)}>
                      设默认
                    </Button>
                  )}
                  <Button theme="borderless" size="small" icon={<IconEdit />} onClick={() => onEditForm(f)}>
                    编辑
                  </Button>
                  <Button
                    theme="borderless"
                    size="small"
                    type="danger"
                    icon={<IconDelete />}
                    onClick={() => remove(f)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Button
            theme="solid"
            type="primary"
            icon={<IconPlus />}
            block
            className="save-config-btn"
            onClick={() => onEditForm(null)}
          >
            新建表单
          </Button>
        </div>
      </div>
      <Typography.Text type="tertiary" style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 12 }}>
        表单保存在{context === 'dashboard' ? '本仪表盘页面' : '当前多维表格'}中，多人共享、互不干扰
      </Typography.Text>
    </div>
  );
}
