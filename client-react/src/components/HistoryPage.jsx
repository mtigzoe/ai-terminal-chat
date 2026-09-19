import React, { useEffect, useState, useRef } from 'react';
import MainNav from './MainNav.jsx';

const STORAGE_KEY = 'ai-terminal-chat:chats';

function HistoryPage() {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameStatus, setRenameStatus] = useState('');
  const [memoryEnabled, setMemoryEnabled] = useState(() => {
    try {
      const raw = localStorage.getItem('ai-terminal-chat:memory-enabled');
      return raw ? raw !== 'false' : true;
    } catch {
      return true;
    }
  });
  const renameButtonRefs = useRef({});
  const searchInputRef = useRef(null);

  const loadChats = () => {
    try {
      const memoryRaw = localStorage.getItem('ai-terminal-chat:memory-enabled');
      if (memoryRaw === 'false') return [];

      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const saveChats = (next) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const normalizeQuery = (value) => String(value || '').trim().toLowerCase();

  const chatMatchesQuery = (chat, query) => {
    if (!query) return true;
    const title = String(chat?.title || '').toLowerCase();
    if (title.includes(query)) return true;
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    return messages.some((msg) => {
      const text = String(msg?.parts?.[0]?.text || msg?.text || '').toLowerCase();
      return text.includes(query);
    });
  };

  const filteredChats = chats.filter((chat) => chatMatchesQuery(chat, normalizeQuery(searchQuery)));

  const handleRestore = (chat) => {
    if (!memoryEnabled) return;
    try {
      localStorage.setItem('ai-terminal-chat:restore-chat-id', chat.id);
    } catch { /* ignore */ }
    window.location.assign('./index.html');
  };

  const handleStartRename = (chat) => {
    setRenamingId(chat.id);
    setRenameValue(String(chat.title || ''));
    setError('');
  };

  const handleCancelRename = () => {
    const chatId = renamingId;
    setRenamingId(null);
    setRenameValue('');
    setRenameStatus('');
    if (chatId && renameButtonRefs.current[chatId]) {
      renameButtonRefs.current[chatId].focus();
    }
  };

  const handleSaveRename = (chat) => {
    if (!memoryEnabled) return;
    const next = loadChats();
    const target = next.find((c) => c.id === chat.id);
    let trimmed = '';
    if (target) {
      trimmed = String(renameValue || '').trim();
      target.title = trimmed || 'Untitled chat';
      saveChats(next);
      setChats(next);
    }
    setRenamingId(null);
    setRenameValue('');
    setRenameStatus(`Renamed to "${trimmed || 'Untitled chat'}"`);
    if (renameButtonRefs.current[chat.id]) {
      renameButtonRefs.current[chat.id].focus();
    }
  };

  useEffect(() => {
    setChats(loadChats());
    setLoading(false);
  }, []);

  useEffect(() => {
    const syncMemory = () => {
      let enabled = true;
      try {
        const raw = localStorage.getItem('ai-terminal-chat:memory-enabled');
        enabled = raw ? raw !== 'false' : true;
      } catch {
        enabled = true;
      }
      setMemoryEnabled(enabled);
      setChats(enabled ? loadChats() : []);
      if (!enabled) {
        setRenamingId(null);
        setRenameValue('');
      }
    };

    const handleStorage = (event) => {
      if (event.key === 'ai-terminal-chat:memory-enabled') syncMemory();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const handleClear = async (event) => {
    event.preventDefault();
    if (clearing) return;
    setClearing(true);
    setClearMessage('');
    setError('');
    try {
      localStorage.removeItem(STORAGE_KEY);
      setChats([]);
      setClearMessage('Chat history cleared.');
    } catch {
      setError('Could not clear chat history.');
    } finally {
      setClearing(false);
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    }
  };

  const formatDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const getTitle = (chat) => {
    if (chat.title && String(chat.title).trim()) return String(chat.title).trim();
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    for (const msg of messages) {
      const text = msg?.parts?.[0]?.text || msg?.text || '';
      const trimmed = String(text).trim();
      if (trimmed) return trimmed.slice(0, 80) + (trimmed.length > 80 ? '…' : '');
    }
    return 'Untitled chat';
  };

  if (loading) {
    return (
      <main className="history-page" aria-labelledby="history-heading">
        <MainNav />
        <h1 id="history-heading">History</h1>
        <p role="status" aria-live="polite">Loading history…</p>
      </main>
    );
  }

  return (
    <main className="history-page" aria-labelledby="history-heading">
      <MainNav />
      <h1 id="history-heading">History</h1>

      <section className="history-section" aria-labelledby="history-list-heading">
        <div className="history-header">
          <h2 id="history-list-heading" className="sr-only">Saved chats</h2>
          <div className="history-actions">
            <label htmlFor="history-search" className="sr-only">Search history</label>
            <input
              id="history-search"
              type="search"
              className="history-search"
              placeholder="Search chats..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              autoComplete="off"
              ref={searchInputRef}
            />
            {chats.length > 0 && (
              <form className="history-clear-form" onSubmit={handleClear}>
                <button
                  type="submit"
                  className="history-clear-button"
                  disabled={clearing}
                  aria-describedby="history-clear-help"
                >
                  {clearing ? 'Clearing…' : 'Clear'}
                </button>
                <span id="history-clear-help" className="sr-only">
                  Remove all saved chats from history.
                </span>
              </form>
            )}
          </div>
        </div>

        {clearMessage && (
          <p className="history-status" role="status" aria-live="polite">
            {clearMessage}
          </p>
        )}

        {error && (
          <p className="history-status history-status--error" role="alert" aria-live="assertive">
            {error}
          </p>
        )}

        {renameStatus && (
          <p className="history-status" role="status" aria-live="polite">
            {renameStatus}
          </p>
        )}

        {filteredChats.length === 0 ? (
          <p className="history-empty">
            {chats.length === 0 ? 'No saved chats yet.' : 'No chats match your search.'}
          </p>
        ) : (
          <ul className="history-list" role="list">
            {filteredChats.map((chat) => {
              const isRenaming = renamingId === chat.id;
              const displayTitle = getTitle(chat);
              return (
                <li key={chat.id} className="history-item">
                  {isRenaming ? (
                    <form
                      className="history-rename-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        handleSaveRename(chat);
                      }}
                    >
                      <input
                        type="text"
                        className="history-rename-input"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') handleCancelRename();
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            handleSaveRename(chat);
                          }
                        }}
                        autoFocus
                        aria-label="Rename chat"
                      />
                    </form>
                  ) : (
                    <div className="history-item-content">
                      <button
                        type="button"
                        className="history-restore-button"
                        onClick={() => handleRestore(chat)}
                        aria-label={`Restore chat: ${displayTitle}, ${(Array.isArray(chat.messages) ? chat.messages.length : 0)} messages${formatDate(chat.date) ? `, ${formatDate(chat.date)}` : ''}`}
                      >
                        <span className="history-item-title">{displayTitle}</span>
                        {formatDate(chat.date) && (
                          <time className="history-item-date" dateTime={chat.date}>
                            {formatDate(chat.date)}
                          </time>
                        )}
                        <span className="history-item-count">
                          {(Array.isArray(chat.messages) ? chat.messages.length : 0)} msg
                        </span>
                      </button>
                      <div className="history-item-actions">
                        <button
                          type="button"
                          className="history-rename-button"
                          ref={(el) => { renameButtonRefs.current[chat.id] = el; }}
                          onClick={() => handleStartRename(chat)}
                          aria-label={`Rename ${displayTitle}`}
                        >
                          Rename
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

export default HistoryPage;
