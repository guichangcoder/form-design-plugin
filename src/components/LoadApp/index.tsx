import React, { useEffect, useState } from 'react';
import { bitable } from '@lark-base-open/js-sdk';

interface Props {
  children: React.ReactNode;
}

type EnvState = 'checking' | 'ok' | 'bad';

/**
 * 环境检测闸门：阻塞式——只有确认处于飞书多维表格环境内，才渲染子组件。
 * - 浏览器直接打开：显示「请在飞书多维表格中打开」提示页（避免 SDK 无宿主时白屏/报错）。
 * - 飞书扩展脚本内：检测通过后正常渲染。
 */
export function LoadApp({ children }: Props) {
  const [env, setEnv] = useState<EnvState>('checking');

  useEffect(() => {
    let alive = true;
    // 可选链保护：无论 bitable/bridge 是否存在都不抛错
    bitable?.bridge
      ?.getLanguage()
      .then(() => alive && setEnv('ok'))
      .catch(() => alive && setEnv('bad'));
    return () => {
      alive = false;
    };
  }, []);

  if (env === 'checking') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: '#666',
          background: 'var(--semi-color-bg-0, #fff)',
        }}
      >
        <span>正在连接飞书多维表格…</span>
      </div>
    );
  }

  if (env === 'bad') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          fontFamily: 'system-ui, sans-serif',
          background: 'var(--semi-color-bg-0, #f5f6f8)',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6, color: '#333' }}>
            多维联填表单
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12, color: '#555' }}>
            请在飞书多维表格中打开本插件
          </div>
          <div style={{ color: '#888', fontSize: 13, lineHeight: 2 }}>
            本插件必须运行在 <b>飞书多维表格的「自定义插件 / 扩展脚本」</b> 环境中，
            <br />
            浏览器直接访问只能看到本提示页（属正常现象）。
            <br />
            <br />
            打开方式：飞书 → 多维表格 → 右上角「多维表格插件」→
            <br />
            「自定义插件」→ 添加服务地址后加载。
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
