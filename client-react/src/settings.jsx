import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './App.css';
import './accessibility.css';
import SettingsPage from './components/SettingsPage.jsx';
import ProjectRootManager from './components/ProjectRootManager.jsx';

const host = (import.meta.env.VITE_API_URL || 'http://localhost:9000').replace(/\/+$/, '');

ReactDOM.createRoot(document.getElementById('settings-root')).render(
  <React.StrictMode>
    <ProjectRootManager host={host} />
    <SettingsPage host={host} />
  </React.StrictMode>
);
