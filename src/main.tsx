// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './webmcp/polyfill';

import { callWorker } from './engine/workerClient';
import { registerGovernanceTools } from './webmcp/toolRegistry';

// Гарантируем наличие modelContext
if (!(document as any).modelContext) {
  (document as any).modelContext = {
    tools: new Map(),
    registerTool(tool: any) {
      this.tools.set(tool.name, tool);
    }
  };
}

// 1. Инициализируем SQLite WASM и сканируем базу данных при запуске
callWorker('INIT')
  .then((res) => {
    console.log('[SQLite WASM Worker] Initialized successfully. Datasets discovered:', res.datasets);
  })
  .catch((err) => {
    console.warn('[SQLite WASM Worker] Init error (fallback active):', err.message);
  });

// 2. Регистрируем WebMCP-инструменты
registerGovernanceTools(callWorker);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);