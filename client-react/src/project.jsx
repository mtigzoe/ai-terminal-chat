import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import './index.css';
import './App.css';
import './accessibility.css';
import MainNav from './components/MainNav.jsx';
import ProjectExplorer from './components/ProjectExplorer.jsx';

const host = (import.meta.env.VITE_API_URL || 'http://localhost:9000').replace(/\/+$/, '');

function ProjectPage() {
  const [projectRoot, setProjectRoot] = useState('');
  const previousRootRef = useRef('');

  const refreshProjectRoot = useCallback(() => {
    axios
      .get(`${host}/project-root`)
      .then((response) => {
        const next = response.data.path || '';
        setProjectRoot(next);
      })
      .catch(() => setProjectRoot(''));
  }, []);

  useEffect(() => {
    refreshProjectRoot();
  }, [refreshProjectRoot]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshProjectRoot();
    };
    const onFocus = () => refreshProjectRoot();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshProjectRoot]);

  useEffect(() => {
    const oldRoot = previousRootRef.current;
    if (oldRoot && oldRoot !== projectRoot) {
      try {
        localStorage.removeItem(`project-explorer:${oldRoot}:expanded`);
        localStorage.removeItem(`project-explorer:${oldRoot}:selected`);
      } catch { /* ignore */ }
    }
    previousRootRef.current = projectRoot;
  }, [projectRoot]);

  const isMemoryEnabled = () => {
    try {
      const raw = localStorage.getItem('ai-terminal-chat:memory-enabled');
      return raw ? raw !== 'false' : true;
    } catch {
      return true;
    }
  };

  const handleUseSelectedFiles = (files) => {
    if (!Array.isArray(files)) return;
    const storage = isMemoryEnabled() ? localStorage : sessionStorage;
    try {
      storage.setItem('ai-terminal-chat:pending-files', JSON.stringify(files));
      const otherStorage = storage === localStorage ? sessionStorage : localStorage;
      otherStorage.removeItem('ai-terminal-chat:pending-files');
      const paths = files.map((f) => f.path).filter(Boolean);
      storage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(paths));
      otherStorage.removeItem('ai-terminal-chat:allowed-paths');
    } catch {
      // storage may be unavailable
    }
    window.location.assign('./index.html');
  };

  const handleInsertPathIntoTerminal = (path) => {
    const storage = isMemoryEnabled() ? localStorage : sessionStorage;
    try {
      storage.setItem('ai-terminal-chat:pending-terminal-path', path);
      (storage === localStorage ? sessionStorage : localStorage)
        .removeItem('ai-terminal-chat:pending-terminal-path');
    } catch {
      // ignore
    }
    window.location.assign('./index.html');
  };

  return (
    <div className="project-page">
      <MainNav />
      <main aria-labelledby="project-heading">
        <h1 id="project-heading">Project</h1>
        <div id="project-region" data-focus-region="project">
          <ProjectExplorer
            key={projectRoot || 'default'}
            host={host}
            projectRoot={projectRoot}
            onUseSelectedFiles={handleUseSelectedFiles}
            onInsertPathIntoTerminal={handleInsertPathIntoTerminal}
          />
        </div>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('project-root')).render(
  <React.StrictMode>
    <ProjectPage />
  </React.StrictMode>
);
