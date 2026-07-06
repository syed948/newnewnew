const Auth = {
  getToken() { return localStorage.getItem('bg_token'); },
  getRefreshToken() { return localStorage.getItem('bg_refresh'); },
  getUser() {
    try { return JSON.parse(localStorage.getItem('bg_user') || 'null'); }
    catch { return null; }
  },
  setSession(token, user, refreshToken) {
    localStorage.setItem('bg_token', token);
    localStorage.setItem('bg_user', JSON.stringify(user));
    if (refreshToken) localStorage.setItem('bg_refresh', refreshToken);
  },
  clear() {
    localStorage.removeItem('bg_token');
    localStorage.removeItem('bg_user');
    localStorage.removeItem('bg_refresh');
  },
  requireUser() {
    const user = this.getUser();
    if (!this.getToken() || !user) { window.location.href = '/'; return null; }
    return user;
  },
  requireAdmin() {
    const user = this.requireUser();
    if (user && user.role !== 'admin') { window.location.href = '/app.html'; return null; }
    return user;
  },
  async logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* best-effort */ }
    this.clear();
    window.location.href = '/';
  }
};

// Vercel serverless functions return JSON error bodies (never HTML), so this stays simple.
async function api(path, options = {}, _retried = false) {
  const token = Auth.getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }

  if (res.status === 401 && !_retried) {
    // Access token expired - try a silent refresh once before giving up.
    const refreshToken = Auth.getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });
        const refreshData = await refreshRes.json();
        if (refreshRes.ok && refreshData.token) {
          localStorage.setItem('bg_token', refreshData.token);
          return api(path, options, true);
        }
      } catch { /* fall through to logout */ }
    }
    Auth.clear();
    window.location.href = '/';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    throw new Error(data?.message || `Request failed (${res.status})`);
  }
  return data;
}

function showToast(message, type = 'default') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Safely extracts a human-readable message from a caught error, without assuming it's
// always an Error object with a .message property - some libraries (including the Twilio
// Voice SDK, in certain failure paths) reject promises or emit events with undefined or a
// plain string instead, and reading .message off undefined would throw a second error on
// top of the first.
function errMsg(err, fallback = 'Something went wrong. Please try again.') {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function timeAgo(isoString) {
  const d = new Date(isoString);
  const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString();
}

function formatDuration(seconds) {
  seconds = Number(seconds) || 0;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
