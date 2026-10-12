/**
 * Campus AI Floating Copilot Widget
 * The ICFAI University, Himachal Pradesh (IUHP)
 * Ubiquitous assistant embedded into index.html, admin.html, and register.html.
 */

(function () {
  // Prevent duplicate insertion
  if (document.getElementById('campus-ai-launcher')) return;

  // Dynamically load widget CSS if not present
  if (!document.querySelector('link[href*="campus-ai-widget.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/campus-ai-widget.css';
    document.head.appendChild(link);
  }

  // Create Backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'campus-ai-backdrop';
  backdrop.className = 'drawer-backdrop';
  document.body.appendChild(backdrop);

  // Create Launcher Button
  const launcher = document.createElement('button');
  launcher.id = 'campus-ai-launcher';
  launcher.title = 'Open Campus AI Copilot';
  launcher.innerHTML = `
    <span class="launcher-icon">✨</span>
    <span>Campus AI</span>
    <span class="launcher-ping"></span>
  `;
  document.body.appendChild(launcher);

  // Create Drawer Modal
  const drawer = document.createElement('aside');
  drawer.id = 'campus-ai-drawer';
  drawer.innerHTML = `
    <div class="drawer-header">
      <div class="drawer-header-left">
        <span style="font-size:1.3rem;">✨</span>
        <div class="drawer-header-title">
          <span>Campus AI Copilot</span>
          <span class="drawer-header-sub">The ICFAI University, HP</span>
        </div>
      </div>
      <div class="drawer-header-actions">
        <a href="/campus-ai" class="drawer-btn-icon" title="Open Fullscreen ChatGPT Mode" target="_blank">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </a>
        <button class="drawer-btn-icon" id="campus-ai-close-btn" title="Close Drawer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- Quick Tools Bar -->
    <div class="drawer-tools-bar">
      <button class="drawer-tool-chip" data-prompt="Show all professors in FST department">💻 FST Faculty</button>
      <button class="drawer-tool-chip" data-prompt="Give me live campus department statistics">📊 Campus Stats</button>
      <button class="drawer-tool-chip" data-prompt="Draft a Casual Leave application for 2 days">📝 Draft Leave</button>
      <button class="drawer-tool-chip" data-prompt="Draft an End-Term Exam duty circular">📢 Exam Circular</button>
    </div>

    <!-- Messages Container -->
    <div class="drawer-messages" id="drawer-messages">
      <div class="drawer-msg bot">
        <div class="drawer-msg-avatar">✨</div>
        <div class="drawer-msg-bubble">
          Hello! I am <strong>Campus AI</strong>, your institutional copilot for <strong>The ICFAI University, Himachal Pradesh</strong>.<br><br>
          Ask me to search faculty members, draft university leave memos, or view real-time department statistics!
        </div>
      </div>
    </div>

    <!-- Input Composer -->
    <div class="drawer-composer">
      <input type="text" class="drawer-input" id="drawer-input" placeholder="Ask Campus AI or perform an action...">
      <button class="drawer-btn-send" id="drawer-send-btn" title="Send">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(drawer);

  // Elements
  const closeBtn = document.getElementById('campus-ai-close-btn');
  const messagesBox = document.getElementById('drawer-messages');
  const inputEl = document.getElementById('drawer-input');
  const sendBtn = document.getElementById('drawer-send-btn');

  let drawerMessages = [
    { role: 'assistant', content: 'Hello! I am Campus AI, your institutional copilot for The ICFAI University, Himachal Pradesh.' }
  ];
  let isDrawerStreaming = false;

  // Toggle Drawer Open/Close
  function openDrawer() {
    drawer.classList.add('open');
    backdrop.classList.add('show');
    inputEl.focus();
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    backdrop.classList.remove('show');
  }

  launcher.addEventListener('click', openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  // Send message from drawer
  async function sendDrawerMessage(text) {
    const query = (text || inputEl.value).trim();
    if (!query || isDrawerStreaming) return;

    inputEl.value = '';

    // Add user message to UI
    drawerMessages.push({ role: 'user', content: query });
    const userDiv = document.createElement('div');
    userDiv.className = 'drawer-msg user';
    userDiv.innerHTML = `
      <div class="drawer-msg-avatar">👤</div>
      <div class="drawer-msg-bubble">${escapeHtml(query)}</div>
    `;
    messagesBox.appendChild(userDiv);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    // Add placeholder bot message
    const botDiv = document.createElement('div');
    botDiv.className = 'drawer-msg bot';
    botDiv.innerHTML = `
      <div class="drawer-msg-avatar">✨</div>
      <div class="drawer-msg-bubble"><span style="opacity:0.6;">Thinking...</span></div>
    `;
    messagesBox.appendChild(botDiv);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    const botBubble = botDiv.querySelector('.drawer-msg-bubble');
    isDrawerStreaming = true;

    try {
      const res = await fetch('/api/campus-ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: drawerMessages.map(m => ({ role: m.role, content: m.content })),
          stream: true
        })
      });

      if (!res.ok) throw new Error('Model temporarily unavailable');

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
      botBubble.innerHTML = `<span style="color:#ef4444;">Error: ${err.message}</span>`;
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

  // Tool chips in drawer
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
