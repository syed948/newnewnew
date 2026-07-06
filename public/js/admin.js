(function () {
  const user = Auth.requireAdmin();
  if (!user) return;

  document.getElementById('userName').textContent = user.name;
  document.getElementById('userRole').textContent = user.role;
  document.getElementById('avatarInitial').textContent = (user.name || '?').slice(0, 1).toUpperCase();
  document.getElementById('callerIdHint').textContent = user.caller_id || 'the Brandigade line';
  document.getElementById('logoutBtn').addEventListener('click', () => Auth.logout());

  // ---------- View switching ----------
  const navItems = document.querySelectorAll('.nav-item');
  const loaders = { calls: loadCalls, sms: loadMessages, team: loadUsers, settings: loadSettings };
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      navItems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach((v) => (v.style.display = 'none'));
      document.getElementById(`view-${btn.dataset.view}`).style.display = 'block';
      if (loaders[btn.dataset.view]) loaders[btn.dataset.view]();
    });
  });

  // ================= DIALER (identical mechanics to the rep view) =================
  const keys = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['*', ''], ['0', '+'], ['#', '']
  ];
  const keypad = document.getElementById('keypad');
  const numberDisplay = document.getElementById('numberDisplay');
  keys.forEach(([digit, sub]) => {
    const btn = document.createElement('button');
    btn.className = 'key';
    btn.innerHTML = `${digit}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    btn.addEventListener('click', () => {
      numberDisplay.textContent += digit;
      if (activeCall) activeCall.sendDigits(digit);
    });
    keypad.appendChild(btn);
  });
  document.getElementById('backspaceBtn').addEventListener('click', () => {
    numberDisplay.textContent = numberDisplay.textContent.slice(0, -1);
  });

  let device = null;
  let activeCall = null;
  const callBtn = document.getElementById('callBtn');
  const hangupBtn = document.getElementById('hangupBtn');
  const callStatus = document.getElementById('callStatus');
  const setupWarning = document.getElementById('setupWarning');

  function setStatus(text, cls) {
    callStatus.textContent = text;
    callStatus.className = `call-status ${cls || ''}`;
  }

  async function initDevice() {
    try {
      const { token } = await api('/calls/token');
      device = new Twilio.Device(token, { logLevel: 'error' });
      device.on('registered', () => setStatus('Ready'));
      device.on('error', (err) => { setStatus('Error'); showToast(err.message || 'Voice connection error', 'error'); });
      device.on('tokenWillExpire', async () => {
        const { token: fresh } = await api('/calls/token');
        device.updateToken(fresh);
      });
      await device.register();
    } catch (err) {
      setupWarning.style.display = 'block';
      setupWarning.textContent = err.message || 'Twilio Voice is not configured yet. Add credentials below in Settings.';
      callBtn.disabled = true;
    }
  }
  initDevice();

  callBtn.addEventListener('click', async () => {
    const to = numberDisplay.textContent.trim();
    if (!to) return showToast('Enter a number to call', 'error');
    if (!device) return showToast('Voice connection is not ready yet', 'error');
    try {
      setStatus('Calling…', 'ringing');
      callBtn.style.display = 'none';
      hangupBtn.style.display = 'flex';
      activeCall = await device.connect({ params: { To: to } });
      activeCall.on('accept', () => setStatus('Connected', 'connected'));
      activeCall.on('disconnect', resetCallUI);
      activeCall.on('cancel', resetCallUI);
      activeCall.on('reject', resetCallUI);
      activeCall.on('error', (err) => { showToast(err.message || 'Call error', 'error'); resetCallUI(); });
    } catch (err) {
      showToast(err.message || 'Could not place the call', 'error');
      resetCallUI();
    }
  });
  hangupBtn.addEventListener('click', () => { if (activeCall) activeCall.disconnect(); resetCallUI(); });
  function resetCallUI() {
    setStatus('Ready');
    callBtn.style.display = 'flex';
    hangupBtn.style.display = 'none';
    activeCall = null;
  }

  // ================= ORG-WIDE RECENT CALLS =================
  async function loadCalls() {
    const body = document.getElementById('callsBody');
    const empty = document.getElementById('callsEmpty');
    try {
      const { calls } = await api('/admin/calls');
      if (!calls.length) { body.innerHTML = ''; empty.style.display = 'block'; return; }
      empty.style.display = 'none';
      body.innerHTML = calls.map((c) => `
        <tr>
          <td>${escapeHtml(c.user_name)}</td>
          <td><span class="badge ${c.direction}">${c.direction}</span></td>
          <td>${escapeHtml(c.direction === 'outbound' ? c.to_number : c.from_number)}</td>
          <td><span class="badge ${c.status}">${escapeHtml(c.status || '—')}</span></td>
          <td>${formatDuration(c.duration)}</td>
          <td>${timeAgo(c.created_at)}</td>
        </tr>
      `).join('');
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ================= SMS (send + org-wide history) =================
  const smsBodyInput = document.getElementById('smsBody');
  const smsCharCount = document.getElementById('smsCharCount');
  smsBodyInput.addEventListener('input', () => { smsCharCount.textContent = `${smsBodyInput.value.length} / 1600`; });

  document.getElementById('smsSendBtn').addEventListener('click', async () => {
    const to = document.getElementById('smsTo').value.trim();
    const body = smsBodyInput.value.trim();
    if (!to || !body) return showToast('Add a destination number and message', 'error');
    const btn = document.getElementById('smsSendBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await api('/sms/send', { method: 'POST', body: JSON.stringify({ to, body }) });
      showToast('Message sent', 'success');
      smsBodyInput.value = ''; smsCharCount.textContent = '0 / 1600';
      loadMessages();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Send message'; }
  });

  async function loadMessages() {
    const body = document.getElementById('smsBody_table');
    const empty = document.getElementById('smsEmpty');
    try {
      const { messages } = await api('/admin/messages');
      if (!messages.length) { body.innerHTML = ''; empty.style.display = 'block'; return; }
      empty.style.display = 'none';
      body.innerHTML = messages.map((m) => `
        <tr>
          <td>${escapeHtml(m.user_name || 'Inbox')}</td>
          <td><span class="badge ${m.direction}">${m.direction}</span></td>
          <td>${escapeHtml(m.direction === 'outbound' ? m.to_number : m.from_number)}</td>
          <td style="max-width:260px; white-space:normal;">${escapeHtml(m.body)}</td>
          <td><span class="badge ${m.status}">${escapeHtml(m.status || '—')}</span></td>
          <td>${timeAgo(m.created_at)}</td>
        </tr>
      `).join('');
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ================= TEAM =================
  let editingUserId = null;
  const userModalBackdrop = document.getElementById('userModalBackdrop');
  const tempPasswordBox = document.getElementById('tempPasswordBox');

  async function loadUsers() {
    const body = document.getElementById('usersBody');
    try {
      const { users } = await api('/admin/users');
      body.innerHTML = users.map((u) => `
        <tr>
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td><span class="badge ${u.role === 'admin' ? 'in-progress' : 'outbound'}">${u.role}</span></td>
          <td>${escapeHtml(u.caller_id || '—')}</td>
          <td><span class="badge ${u.active ? 'completed' : 'failed'}">${u.active ? 'active' : 'disabled'}</span></td>
          <td class="row-actions">
            <button class="btn-secondary" data-action="toggle" data-id="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>
            <button class="btn-secondary" data-action="reset" data-id="${u.id}">Reset pw</button>
            <button class="btn-secondary" data-action="delete" data-id="${u.id}">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) { showToast(err.message, 'error'); }
  }

  document.getElementById('usersBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;

    try {
      if (action === 'toggle') {
        const active = btn.dataset.active === '1';
        await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ active: !active }) });
        showToast(active ? 'User disabled' : 'User enabled', 'success');
        loadUsers();
      } else if (action === 'reset') {
        const { temporary_password } = await api(`/admin/users/${id}/reset-password`, { method: 'POST' });
        showToast(`New temporary password: ${temporary_password}`, 'success');
      } else if (action === 'delete') {
        if (!confirm('Remove this teammate? This cannot be undone.')) return;
        await api(`/admin/users/${id}`, { method: 'DELETE' });
        showToast('User removed', 'success');
        loadUsers();
      }
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('addUserBtn').addEventListener('click', () => {
    editingUserId = null;
    document.getElementById('userModalTitle').textContent = 'Add teammate';
    document.getElementById('m_name').value = '';
    document.getElementById('m_email').value = '';
    document.getElementById('m_role').value = 'user';
    document.getElementById('m_caller_id').value = '';
    tempPasswordBox.style.display = 'none';
    userModalBackdrop.style.display = 'flex';
  });

  document.getElementById('userModalCancel').addEventListener('click', () => { userModalBackdrop.style.display = 'none'; });

  document.getElementById('userModalSave').addEventListener('click', async () => {
    const name = document.getElementById('m_name').value.trim();
    const email = document.getElementById('m_email').value.trim();
    const role = document.getElementById('m_role').value;
    const caller_id = document.getElementById('m_caller_id').value.trim();
    if (!name || !email) return showToast('Name and email are required', 'error');

    try {
      const { temporary_password } = await api('/admin/users', {
        method: 'POST',
        body: JSON.stringify({ name, email, role, caller_id })
      });
      tempPasswordBox.style.display = 'block';
      tempPasswordBox.innerHTML = `Account created. Share this temporary password with ${escapeHtml(name)}:<br><strong>${escapeHtml(temporary_password)}</strong>`;
      loadUsers();
    } catch (err) { showToast(err.message, 'error'); }
  });

  // ================= SETTINGS =================
  async function loadSettings() {
    try {
      const { settings } = await api('/admin/settings');
      document.getElementById('s_account_sid').value = settings.twilio_account_sid || '';
      document.getElementById('s_auth_token').value = '';
      document.getElementById('s_auth_token').placeholder = settings.twilio_auth_token
        ? `Current: ${settings.twilio_auth_token} (leave blank to keep)`
        : 'Leave blank to keep the current value';
      document.getElementById('s_api_key').value = settings.twilio_api_key || '';
      document.getElementById('s_api_secret').value = '';
      document.getElementById('s_api_secret').placeholder = settings.twilio_api_secret
        ? `Current: ${settings.twilio_api_secret} (leave blank to keep)`
        : 'Leave blank to keep the current value';
      document.getElementById('s_twiml_app_sid').value = settings.twilio_twiml_app_sid || '';
      document.getElementById('s_caller_id').value = settings.twilio_caller_id || '';
    } catch (err) { showToast(err.message, 'error'); }
  }

  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const payload = {
      twilio_account_sid: document.getElementById('s_account_sid').value.trim(),
      twilio_auth_token: document.getElementById('s_auth_token').value.trim(),
      twilio_api_key: document.getElementById('s_api_key').value.trim(),
      twilio_api_secret: document.getElementById('s_api_secret').value.trim(),
      twilio_twiml_app_sid: document.getElementById('s_twiml_app_sid').value.trim(),
      twilio_caller_id: document.getElementById('s_caller_id').value.trim()
    };
    try {
      await api('/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Settings saved', 'success');
      loadSettings();
    } catch (err) { showToast(err.message, 'error'); }
  });
})();
