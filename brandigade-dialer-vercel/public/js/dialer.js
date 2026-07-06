(function () {
  const user = Auth.requireUser();
  if (!user) return;

  document.getElementById('userName').textContent = user.name;
  document.getElementById('userRole').textContent = user.role;
  document.getElementById('avatarInitial').textContent = (user.name || '?').slice(0, 1).toUpperCase();
  document.getElementById('callerIdHint').textContent = user.caller_id || 'the Brandigade line';
  document.getElementById('logoutBtn').addEventListener('click', () => Auth.logout());

  // ---------- View switching ----------
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      navItems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach((v) => (v.style.display = 'none'));
      document.getElementById(`view-${btn.dataset.view}`).style.display = 'block';
      if (btn.dataset.view === 'calls') loadCalls();
      if (btn.dataset.view === 'sms') loadMessages();
    });
  });

  // ---------- Keypad ----------
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

  // ---------- Twilio Voice Device ----------
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
      device.on('error', (err) => {
        setStatus('Error');
        showToast(errMsg(err, 'Voice connection error'), 'error');
      });
      device.on('tokenWillExpire', async () => {
        const { token: fresh } = await api('/calls/token');
        device.updateToken(fresh);
      });

      await device.register();
    } catch (err) {
      setupWarning.style.display = 'block';
      setupWarning.textContent = errMsg(err, 'Twilio Voice is not configured yet.');
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

      activeCall = await device.connect({ params: { To: to, destination: to } });

      activeCall.on('accept', () => setStatus('Connected', 'connected'));
      activeCall.on('disconnect', resetCallUI);
      activeCall.on('cancel', resetCallUI);
      activeCall.on('reject', resetCallUI);
      activeCall.on('error', (err) => {
        showToast(errMsg(err, 'Call error'), 'error');
        resetCallUI();
      });
    } catch (err) {
      showToast(errMsg(err, 'Could not place the call'), 'error');
      resetCallUI();
    }
  });

  hangupBtn.addEventListener('click', () => {
    if (activeCall) activeCall.disconnect();
    resetCallUI();
  });

  function resetCallUI() {
    setStatus('Ready');
    callBtn.style.display = 'flex';
    hangupBtn.style.display = 'none';
    activeCall = null;
  }

  // ---------- Recent calls ----------
  async function loadCalls() {
    const body = document.getElementById('callsBody');
    const empty = document.getElementById('callsEmpty');
    try {
      const { calls } = await api('/calls/list');
      if (!calls.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      body.innerHTML = calls.map((c) => `
        <tr>
          <td><span class="badge ${c.direction}">${c.direction}</span></td>
          <td>${escapeHtml(c.direction === 'outbound' ? c.to_number : c.from_number)}</td>
          <td><span class="badge ${c.status}">${escapeHtml(c.status || '—')}</span></td>
          <td>${formatDuration(c.duration)}</td>
          <td>${timeAgo(c.created_at)}</td>
        </tr>
      `).join('');
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  // ---------- SMS ----------
  const smsBodyInput = document.getElementById('smsBody');
  const smsCharCount = document.getElementById('smsCharCount');
  smsBodyInput.addEventListener('input', () => {
    smsCharCount.textContent = `${smsBodyInput.value.length} / 1600`;
  });

  document.getElementById('smsSendBtn').addEventListener('click', async () => {
    const to = document.getElementById('smsTo').value.trim();
    const body = smsBodyInput.value.trim();
    if (!to || !body) return showToast('Add a destination number and message', 'error');

    const btn = document.getElementById('smsSendBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await api('/sms/send', { method: 'POST', body: JSON.stringify({ to, body }) });
      showToast('Message sent', 'success');
      smsBodyInput.value = '';
      smsCharCount.textContent = '0 / 1600';
      loadMessages();
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send message';
    }
  });

  async function loadMessages() {
    const body = document.getElementById('smsBody_table');
    const empty = document.getElementById('smsEmpty');
    try {
      const { messages } = await api('/sms/list');
      if (!messages.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      body.innerHTML = messages.map((m) => `
        <tr>
          <td><span class="badge ${m.direction}">${m.direction}</span></td>
          <td>${escapeHtml(m.direction === 'outbound' ? m.to_number : m.from_number)}</td>
          <td style="max-width:280px; white-space:normal;">${escapeHtml(m.body)}</td>
          <td><span class="badge ${m.status}">${escapeHtml(m.status || '—')}</span></td>
          <td>${timeAgo(m.created_at)}</td>
        </tr>
      `).join('');
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }
})();
