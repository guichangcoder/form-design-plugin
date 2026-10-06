import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LoadApp } from './components/LoadApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import './locales/i18n';
import '@douyinfe/semi-ui/dist/css/semi.min.css';
import './App.css';

// 全局错误捕获：把插件自身的未捕获异常/未处理 Promise 拒绝打上 [plugin-error] 前缀，
// 方便在飞书混杂的主机日志里一眼筛出「插件自己的问题」。
window.addEventListener('error', (e) => {
  console.error('[plugin-error] window error:', e.message, e.error ?? '');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[plugin-error] unhandledrejection:', e.reason ?? '');
});

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <LoadApp>
          <App />
        </LoadApp>
      </ErrorBoundary>
    </React.StrictMode>
  );
}
