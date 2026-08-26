import React, { useEffect, useState } from 'react';
import { useConfig } from './hooks/useConfig';
import { ConfigPanel } from './components/ConfigPanel';
import { FormRenderer } from './components/FormRenderer';
import { FormPluginConfig } from './types';
import { toast } from './utils/toast';

type Mode = 'config' | 'fill';

/** 品牌顶栏：插件名 + 当前模式 */
function PluginHeader({ mode }: { mode: Mode }) {
  return (
    <div className="plugin-header">
      <div className="logo">📋</div>
      <div className="title-box">
        <h1>多维联填表单</h1>
        <div className="sub">主表 + 多子表 · 一次录入 · 条件联动</div>
      </div>
      <span className={`mode-badge ${mode === 'fill' ? 'mode-fill' : ''}`}>
        {mode === 'fill' ? '● 填写模式' : '⚙ 配置模式'}
      </span>
    </div>
  );
}

export default function App() {
  const { config, loading, load, save } = useConfig();
  const [mode, setMode] = useState<Mode>('config');

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!loading) {
      setMode(config && config.mainTable ? 'fill' : 'config');
    }
  }, [loading, config]);

  const handleSave = async (c: FormPluginConfig) => {
    try {
      const r = await save(c);
      if (r.storage === 'bridge') {
        toast('配置已保存', 'success');
      } else {
        // dev 模式回退到 localStorage
        if (r.warning) console.warn('[App]', r.warning);
        toast('配置已保存到本地（开发模式，发布后自动用云端）', 'warning');
      }
      console.log('[App] 配置已保存 (storage=' + r.storage + ')，切换到填写模式');
      setMode('fill');
    } catch (e) {
      console.error('[App] 保存配置失败:', e);
      toast(`保存失败：${(e as Error)?.message ?? String(e)}`, 'error');
    }
  };

  if (loading) {
    return (
      <div>
        <PluginHeader mode="config" />
        <div className="page-loading">正在初始化…</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh' }}>
      <PluginHeader mode={mode} />
      <div className="plugin-content">
        {mode === 'config' ? (
          <ConfigPanel
            initialConfig={config}
            onSave={handleSave}
            onCancel={() => {
              if (config) setMode('fill');
            }}
          />
        ) : (
          <FormRenderer config={config!} onBackToConfig={() => setMode('config')} />
        )}
      </div>
    </div>
  );
}
