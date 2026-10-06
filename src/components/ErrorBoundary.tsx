import React from 'react';

interface State {
  error: Error | null;
}

/**
 * 错误边界：捕获子树渲染/副作用中的异常，用可读文字代替整页白屏。
 *
 * 飞书仪表盘 widget 里任何 React 渲染抛错都会被宿主兜底成「配置数据发生变更，请重新配置」，
 * 这就把真实错误吞了。这里捕获后用我们的诊断条显示根因，让用户截图即可定位。
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; hint?: string },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // [plugin-error] 全局前缀，便于在 console 里筛选本插件错误
    console.error('[plugin-error] RenderError:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div
          data-plugin-error
          style={{
            padding: 16,
            fontFamily: 'monospace',
            fontSize: 12,
            color: '#cf1322',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            lineHeight: 1.6,
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            margin: 12,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#991b1b' }}>
            插件渲染异常（被本错误边界捕获；宿主看到的是「配置数据发生变更，请重新配置」）
          </div>
          <div style={{ marginBottom: 4 }}>{this.props.hint ?? '请按下面提示操作后再截图发我：'}</div>
          <ol style={{ margin: '4px 0 8px 16px', padding: 0, color: '#374151' }}>
            <li>截图这一整块红框区域</li>
            <li>截图诊断条</li>
            <li>截图飞书宿主 Console（如果有）</li>
          </ol>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>异常消息：</div>
          <div style={{ background: '#fff', padding: 8, borderRadius: 4 }}>{this.state.error.message}</div>
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', color: '#6b7280' }}>查看堆栈</summary>
            <div style={{ marginTop: 6, padding: 8, background: '#fff', borderRadius: 4, fontSize: 11, opacity: 0.85 }}>
              {this.state.error.stack}
            </div>
          </details>
          <button
            onClick={this.reset}
            style={{
              marginTop: 12,
              padding: '6px 14px',
              background: '#fff',
              border: '1px solid #fca5a5',
              borderRadius: 4,
              color: '#991b1b',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          >
            🔄 重渲染（数据没问题时才会恢复）
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
