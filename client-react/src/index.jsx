import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './accessibility.css';
import App from './App.jsx';
import GitStatusPanel from './components/GitStatusPanel.jsx';
import ProjectTreeContextMenu from './components/ProjectTreeContextMenu.jsx';
import reportWebVitals from './reportWebVitals';

const host = (import.meta.env.VITE_API_URL || "http://localhost:9000").replace(/\/+$/, "");

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
    <GitStatusPanel host={host} />
    <ProjectTreeContextMenu />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example, send the data to an analytics endpoint).
reportWebVitals();
