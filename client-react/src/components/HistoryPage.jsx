import React, { useEffect, useState } from 'react';
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

  const loadChats = () => {
    try {
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
    setRenamingId(null);
    setRenameValue('');
  };

  const handleSaveRename = (chat) => {
    const next = loadChats();
    const target = next.find((c) => c.id === chat.id);
    if (target) {
      const trimmed = String(renameValue || '').trim();
      target.title = trimmed || 'Untitled chat';
      saveChats(next);
      setChats(next);
    }
    setRenamingId(null);
    setRenameValue('');
  };

  useEffect(() => {
    setChats(loadChats());
    setLoading(false);
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
                        onBlur={() => handleSaveRename(chat)}
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
                        aria-label={`Restore chat: ${displayTitle}`}
                      >
                        <span className="history-item-title">{displayTitle}</span>
                        {formatDate(chat.date) && (
                          <time className="history-item-date" dateTime={chat.date}>
                            {formatDate(chat.date)}
                          </time>
                        )}
                        <span className="history-item-count" aria-label={`${(Array.isArray(chat.messages) ? chat.messages.length : 0)} messages`}>
                          {(Array.isArray(chat.messages) ? chat.messages.length : 0)} msg
                        </span>
                      </button>
                      <div className="history-item-actions">
                        <button
                          type="button"
                          className="history-rename-button"
                          onClick={() => handleStartRename(chat)}
                          aria-label={`Rename ${displayTitle}`}
                          title="Rename"
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
