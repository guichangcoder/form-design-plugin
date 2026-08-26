import React from 'react';

interface State {
  error: Error | null;
}

/**
 * 错误边界：捕获子树渲染/副作用中的异常，
 * 用可读文字代替整页白屏，便于把报错发回定位。
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 方便在飞书 webview 控制台或反馈时定位
    console.error('[FormDesignPlugin] 渲染崩溃:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 16,
            fontFamily: 'monospace',
            fontSize: 12,
            color: '#cf1322',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            插件渲染出错（请把下面内容发我）：
          </div>
          <div>{this.state.error.message}</div>
          <div style={{ marginTop: 8, opacity: 0.7 }}>{this.state.error.stack}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
