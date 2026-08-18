import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './accessibility.css';
import App from './App.jsx';
import ProjectTreeContextMenu from './components/ProjectTreeContextMenu.jsx';
import ProjectGitStatusBadges from './components/ProjectGitStatusBadges.jsx';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
    <ProjectTreeContextMenu />
    <ProjectGitStatusBadges />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example, send them to an analytics endpoint).
reportWebVitals();
