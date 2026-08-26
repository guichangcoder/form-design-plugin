import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LoadApp } from './components/LoadApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import './locales/i18n';
import '@douyinfe/semi-ui/dist/css/semi.min.css';
import './App.css';

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
