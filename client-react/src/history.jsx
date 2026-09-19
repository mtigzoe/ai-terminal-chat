import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './App.css';
import './accessibility.css';
import HistoryPage from './components/HistoryPage.jsx';

function HistoryApp() {
  return (
    <div className="history-app">
        <HistoryPage />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('history-root')).render(
  <React.StrictMode>
    <HistoryApp />
  </React.StrictMode>
);
