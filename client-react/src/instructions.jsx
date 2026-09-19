import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './App.css';
import './accessibility.css';
import MainNav from './components/MainNav.jsx';
import InstructionsPage from './components/InstructionsPage.jsx';

function InstructionsApp() {
  return (
    <div className="instructions-app">
      <MainNav />
      <InstructionsPage />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('instructions-root')).render(
  <React.StrictMode>
    <InstructionsApp />
  </React.StrictMode>
);
