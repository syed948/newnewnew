(function () {
  // Already logged in? send them to the right place.
  const existing = Auth.getUser();
  if (existing && Auth.getToken()) {
    window.location.href = existing.role === 'admin' ? '/admin.html' : '/app.html';
    return;
  }

  const form = document.getElementById('loginForm');
  const errorBox = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      Auth.setSession(data.token, data.user, data.refreshToken);
      window.location.href = data.user.role === 'admin' ? '/admin.html' : '/app.html';
    } catch (err) {
      errorBox.textContent = err.message || 'Could not sign in';
      errorBox.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
})();
