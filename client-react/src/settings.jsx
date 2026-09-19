import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './App.css';
import './accessibility.css';
import MainNav from './components/MainNav.jsx';
import SettingsPage from './components/SettingsPage.jsx';

const host = (import.meta.env.VITE_API_URL || 'http://localhost:9000').replace(/\/+$/, '');

ReactDOM.createRoot(document.getElementById('settings-root')).render(
  <React.StrictMode>
    <div className="settings-app">
      <MainNav />
      <SettingsPage host={host} />
    </div>
  </React.StrictMode>
);
