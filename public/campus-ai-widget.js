/**
 * NJ.AI Floating Copilot Widget
 * The ICFAI University, Himachal Pradesh (IUHP)
 * Name: NJ.AI
 * Ubiquitous assistant embedded into index.html, admin.html, and register.html.
 */

(function () {
  if (document.getElementById('campus-ai-launcher')) return;

  if (!document.querySelector('link[href*="campus-ai-widget.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/campus-ai-widget.css';
    document.head.appendChild(link);
  }

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'campus-ai-backdrop';
  backdrop.className = 'drawer-backdrop';
  document.body.appendChild(backdrop);

  // Launcher Button
  const launcher = document.createElement('button');
  launcher.id = 'campus-ai-launcher';
  launcher.title = 'Open NJ.AI Copilot (Under Development)';
  launcher.innerHTML = `
    <span class="launcher-icon">✨</span>
    <span>NJ.AI</span>
    <span style="font-size:0.62rem;background:rgba(245,158,11,0.25);color:#f59e0b;border:1px solid rgba(245,158,11,0.4);padding:1px 5px;border-radius:999px;font-weight:800;letter-spacing:0.3px;">In Dev</span>
    <span class="launcher-ping"></span>
  `;
  document.body.appendChild(launcher);

  // Drawer
  const drawer = document.createElement('aside');
  drawer.id = 'campus-ai-drawer';
  drawer.innerHTML = `
    <div class="drawer-header">
      <div class="drawer-header-left">
        <div style="width:30px;height:30px;border-radius:8px;background:#ffffff;color:#0f4c5c;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:0.85rem;">NJ</div>
        <div class="drawer-header-title">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <span>NJ.AI Copilot</span>
            <span style="font-size:0.62rem;background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:1px 6px;border-radius:999px;font-weight:700;">Under Development</span>
          </div>
          <span class="drawer-header-sub">IUHP Intelligence Engine • Coming Soon</span>
        </div>
      </div>
      <div class="drawer-header-actions">
        <a href="/campus-ai" class="drawer-btn-icon" title="Expand Fullscreen NJ.AI" target="_blank">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </a>
        <button class="drawer-btn-icon" id="campus-ai-close-btn" title="Close Drawer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- Quick Tool Chips -->
    <div class="drawer-tools-bar">
      <button class="drawer-tool-chip" data-prompt="/faculty FST">💻 /faculty FST</button>
      <button class="drawer-tool-chip" data-prompt="/stats">📊 /stats</button>
      <button class="drawer-tool-chip" data-prompt="/leave 2 days">📝 /leave</button>
      <button class="drawer-tool-chip" data-prompt="/exam">📢 /exam</button>
    </div>

    <!-- Message Stream -->
    <div class="drawer-messages" id="drawer-messages">
      <div class="drawer-msg bot">
        <div class="drawer-msg-avatar">NJ</div>
        <div class="drawer-msg-bubble">
          👋 Hello! <strong>NJ.AI</strong> is currently <strong>under active institutional development</strong> for <strong>The ICFAI University, Himachal Pradesh</strong>.<br><br>
          Our technical team is fine-tuning the campus knowledge models, testing ERP data synchronization, and polishing faculty tools. Stay tuned for the upcoming official release!
        </div>
      </div>
    </div>

    <!-- Composer -->
    <div class="drawer-composer">
      <input type="text" class="drawer-input" id="drawer-input" placeholder="Ask NJ.AI or type '/' (e.g. /faculty, /leave)...">
      <button class="drawer-btn-send" id="drawer-send-btn" title="Send">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(drawer);

  const closeBtn = document.getElementById('campus-ai-close-btn');
  const messagesBox = document.getElementById('drawer-messages');
  const inputEl = document.getElementById('drawer-input');
  const sendBtn = document.getElementById('drawer-send-btn');

  let drawerMessages = [
    { role: 'assistant', content: 'Hello! I am NJ.AI, your institutional copilot for The ICFAI University, Himachal Pradesh.' }
  ];
  let isDrawerStreaming = false;
  let widgetUser = null;

  async function checkWidgetAuth() {
    try {
      const token = localStorage.getItem('nj_ai_token') || '';
      const res = await fetch('/api/campus-ai/auth/me', {
        headers: token ? { 'x-nj-token': token } : {},
        credentials: 'include'
      });
      const data = await res.json();
      const subEl = drawer.querySelector('.drawer-header-sub');
      if (data && data.authenticated && data.user) {
        widgetUser = data.user;
        if (subEl) subEl.textContent = `🛡️ ${data.user.name} (7-Day Active)`;
      } else {
        widgetUser = null;
        if (subEl) subEl.textContent = '🔒 Verification Required';
      }
    } catch (_) {
      widgetUser = null;
    }
  }

  function showAuthGateInWidget() {
    const gateDiv = document.createElement('div');
    gateDiv.className = 'drawer-msg bot';
    gateDiv.innerHTML = `
      <div class="drawer-msg-avatar">NJ</div>
      <div class="drawer-msg-bubble" style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;">
        <strong style="display:block;margin-bottom:6px;font-size:0.9rem;">🔒 Institutional Verification Required</strong>
        Access to NJ.AI is restricted to registered university faculty and staff members with verified accounts.<br><br>
        <a href="/campus-ai" target="_blank" style="display:inline-block;padding:7px 14px;background:#0f4c5c;color:#ffffff;border-radius:8px;font-size:0.8rem;font-weight:700;text-decoration:none;">
          Verify with OTP (Start 7-Day Session) →
        </a>
      </div>
    `;
    messagesBox.appendChild(gateDiv);
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  function openDrawer() {
    drawer.classList.add('open');
    backdrop.classList.add('show');
    checkWidgetAuth();
    inputEl.focus();
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    backdrop.classList.remove('show');
  }

  launcher.addEventListener('click', openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  async function sendDrawerMessage(text) {
    const query = (text || inputEl.value).trim();
    if (!query || isDrawerStreaming) return;

    if (!widgetUser) {
      await checkWidgetAuth();
      if (!widgetUser) {
        showAuthGateInWidget();
        return;
      }
    }

    inputEl.value = '';

    drawerMessages.push({ role: 'user', content: query });
    const userDiv = document.createElement('div');
    userDiv.className = 'drawer-msg user';
    userDiv.innerHTML = `
      <div class="drawer-msg-avatar">👤</div>
      <div class="drawer-msg-bubble">${escapeHtml(query)}</div>
    `;
    messagesBox.appendChild(userDiv);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    const botDiv = document.createElement('div');
    botDiv.className = 'drawer-msg bot';
    botDiv.innerHTML = `
      <div class="drawer-msg-avatar">NJ</div>
      <div class="drawer-msg-bubble"><span style="opacity:0.6;">Thinking...</span></div>
    `;
    messagesBox.appendChild(botDiv);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    const botBubble = botDiv.querySelector('.drawer-msg-bubble');
    isDrawerStreaming = true;

    try {
      const res = await fetch('/api/campus-ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nj-token': localStorage.getItem('nj_ai_token') || ''
        },
        credentials: 'include',
        body: JSON.stringify({
          messages: drawerMessages.map(m => ({ role: m.role, content: m.content })),
          stream: true
        })
      });

      if (res.status === 401 || res.status === 403) {
        widgetUser = null;
        showAuthGateInWidget();
        return;
      }

      if (!res.ok) throw new Error('NJ.AI is reconnecting');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let botContent = '';
      botBubble.innerHTML = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payloadStr = trimmed.slice(5).trim();
          if (payloadStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payloadStr);
            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
              const delta = parsed.choices[0].delta.content || '';
              botContent += delta;
              botBubble.innerHTML = formatSimpleMarkdown(botContent);
              messagesBox.scrollTop = messagesBox.scrollHeight;
            }
          } catch (_) {}
        }
      }

      drawerMessages.push({ role: 'assistant', content: botContent });

    } catch (err) {
      botBubble.innerHTML = `<span style="color:#ef4444;">Notice: ${err.message}</span>`;
    } finally {
      isDrawerStreaming = false;
      messagesBox.scrollTop = messagesBox.scrollHeight;
    }
  }

  sendBtn.addEventListener('click', () => sendDrawerMessage());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendDrawerMessage();
    }
  });

  document.querySelectorAll('.drawer-tool-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt) sendDrawerMessage(prompt);
    });
  });

  function formatSimpleMarkdown(text) {
    if (!text) return '';
    let s = escapeHtml(text);
    s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.*?)\*/g, '<em>$1</em>');
    s = s.replace(/^### (.*$)/gim, '<strong>$1</strong>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
})();
