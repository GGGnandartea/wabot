// UserInvalidFallback & ARIA synchronization for :user-invalid / :user-valid
const UserInvalidFallback = (() => {
  const dirtyState = new WeakMap();

  const updateState = (input) => {
    const isValid = input.checkValidity();
    input.classList.toggle('user-invalid-fallback', !isValid);
    input.classList.toggle('user-valid-fallback', isValid);

    if (!isValid) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  };

  const handleEvent = (event) => {
    const input = event.target;

    if (event.type === 'reset') {
      const controls = input.elements || [];
      for (const control of controls) {
        dirtyState.delete(control);
        control.classList.remove('user-invalid-fallback');
        control.classList.remove('user-valid-fallback');
        control.removeAttribute('aria-invalid');
      }
      return;
    }

    if (!input.checkValidity) return;

    if (event.type === 'input' || event.type === 'change') {
      const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
      state.hasInteracted = true;
      dirtyState.set(input, state);
      if (state.hasBlurred) {
        updateState(input);
      }
    } else if (event.type === 'blur') {
      const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
      state.hasBlurred = true;
      dirtyState.set(input, state);
      if (state.hasInteracted) {
        updateState(input);
      }
    }
  };

  const init = (root = document) => {
    if (CSS.supports('selector(:user-invalid)')) return;
    root.addEventListener('blur', handleEvent, true);
    root.addEventListener('input', handleEvent);
    root.addEventListener('change', handleEvent);
    root.addEventListener('reset', handleEvent, true);
  };

  return { init };
})();

UserInvalidFallback.init(document);

// Sync aria-invalid with native CSS :user-invalid state
const syncAria = (el) => {
  if (!el || typeof el.matches !== 'function') return;
  try {
    if (CSS.supports('selector(:user-invalid)')) {
      el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
    }
  } catch {
    // Ignore unsupported selector
  }
};

document.addEventListener('blur', (e) => syncAria(e.target), true);
document.addEventListener('input', (e) => {
  if (e.target?.hasAttribute?.('aria-invalid')) syncAria(e.target);
});

// DOM Elements
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const botNumberText = document.getElementById('bot-number-text');

const statWaStatus = document.getElementById('stat-wa-status');
const statWaHint = document.getElementById('stat-wa-hint');
const statMentionTag = document.getElementById('stat-mention-tag');
const statNotesCount = document.getElementById('stat-notes-count');
const statMessagesCount = document.getElementById('stat-messages-count');

const qrContainer = document.getElementById('qr-container');
const qrLoading = document.getElementById('qr-loading');
const qrReady = document.getElementById('qr-ready');
const qrImage = document.getElementById('qr-image');
const pairingSection = document.getElementById('pairing-section');
const connectedContainer = document.getElementById('connected-container');
const guideMentionCode = document.getElementById('guide-mention-code');

const activityList = document.getElementById('activity-list');
const savedNotesList = document.getElementById('saved-notes-list');
const noteGroupSelect = document.getElementById('note-group-select');
const simGroupSelect = document.getElementById('sim-group-select');
const explorerGroupSelect = document.getElementById('explorer-group-select');
const explorerSearch = document.getElementById('explorer-search');
const messagesViewer = document.getElementById('messages-viewer');

let currentGroups = [];
let logsCache = [];
let backupPresets = {
  pollinations: {
    baseUrl: 'https://text.pollinations.ai/openai',
    defaultModel: 'openai-fast',
    requiresKey: false,
    docsUrl: ''
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresKey: true,
    docsUrl: 'https://console.groq.com/keys'
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    requiresKey: true,
    docsUrl: 'https://openrouter.ai/keys'
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  custom: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: false,
    docsUrl: ''
  }
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBotState(bot) {
  if (!bot) return;
  const { status, qrDataUrl, botInfo, totalMessages, savedNotesCount, groupsCount, logs } = bot;

  statusDot.className = 'dot ' + (status || 'disconnected');
  if (statNotesCount) {
    statNotesCount.textContent = `${savedNotesCount ?? 0} Catatan`;
  }
  statMessagesCount.textContent = `${totalMessages ?? 0} Pesan (${groupsCount ?? 0} Grup)`;

  if (status === 'connected') {
    const phone = botInfo?.phoneNumber ? `${botInfo.phoneNumber}` : '';
    const displayNum = phone ? `+${phone}` : 'Terhubung';
    statusText.textContent = 'Terhubung';
    botNumberText.textContent = `${displayNum} (${botInfo?.name || 'Bot'})`;
    statWaStatus.textContent = 'Aktif / Online';
    statWaHint.textContent = `Akun: ${botInfo?.name || displayNum}`;
    statMentionTag.textContent = phone ? `@${phone}` : '@nomor_bot';
    guideMentionCode.textContent = phone ? `@${phone}` : '@nomor_bot';

    qrContainer.classList.add('hidden');
    pairingSection.classList.add('hidden');
    connectedContainer.classList.remove('hidden');
  } else if (status === 'qr' && qrDataUrl) {
    statusText.textContent = 'Menunggu Scan QR';
    botNumberText.textContent = 'Belum ditautkan';
    statWaStatus.textContent = 'Menunggu Scan QR';
    statWaHint.textContent = 'Scan QR di bawah via WA HP';
    statMentionTag.textContent = '@nomor_bot';

    qrContainer.classList.remove('hidden');
    qrLoading.classList.add('hidden');
    qrReady.classList.remove('hidden');
    qrImage.src = qrDataUrl;
    pairingSection.classList.remove('hidden');
    connectedContainer.classList.add('hidden');
  } else {
    statusText.textContent = status === 'connecting' ? 'Menghubungkan...' : 'Terputus';
    botNumberText.textContent = 'Belum terhubung';
    statWaStatus.textContent = status === 'connecting' ? 'Menghubungkan...' : 'Terputus';
    statWaHint.textContent = 'Menyiapkan soket WhatsApp';

    qrContainer.classList.remove('hidden');
    qrLoading.classList.remove('hidden');
    qrReady.classList.add('hidden');
    pairingSection.classList.remove('hidden');
    connectedContainer.classList.add('hidden');
  }

  if (Array.isArray(logs)) {
    logsCache = logs;
    renderLogs();
  }
}

function renderLogs() {
  if (!logsCache || logsCache.length === 0) {
    activityList.innerHTML = '<p class="empty-text">Belum ada aktivitas.</p>';
    return;
  }
  activityList.innerHTML = logsCache
    .map(
      (item) => `
      <div class="log-item ${escapeHtml(item.type)}">
        <div class="log-header">
          <span>${escapeHtml(item.title)}</span>
          <span class="log-time">${escapeHtml(item.time)}</span>
        </div>
        ${item.detail ? `<div class="log-detail">${escapeHtml(item.detail)}</div>` : ''}
      </div>
    `
    )
    .join('');
}

function renderSavedNotes(notes) {
  if (!savedNotesList) return;
  const list = Array.isArray(notes) ? notes : [];
  if (statNotesCount) {
    statNotesCount.textContent = `${list.length} Catatan`;
  }
  if (list.length === 0) {
    savedNotesList.innerHTML =
      '<p class="empty-text">Belum ada catatan penting yang di-save. Ketik di grup WA: <code>@bot tolong save kan jadwal ini ya...</code> atau tambah manual di atas.</p>';
    return;
  }

  savedNotesList.innerHTML = list
    .map(
      (n) => `
      <div class="msg-bubble bot">
        <div class="msg-meta">
          <span>
            <strong class="msg-sender">#${escapeHtml(n.id)} — ${escapeHtml(n.title)}</strong>
            <span class="note-badge">${escapeHtml(n.category || 'catatan')}</span>
          </span>
          <button type="button" class="btn btn-sm btn-danger btn-delete-note" data-id="${escapeHtml(n.id)}" title="Hapus catatan permanen ini">🗑️ Hapus</button>
        </div>
        <div class="msg-quote">
          Grup: <strong>${escapeHtml(n.groupName || 'Semua Grup')}</strong> • Disimpan oleh: ${escapeHtml(n.savedBy)} (${escapeHtml(n.formattedTime)})
        </div>
        <div class="msg-text" style="white-space: pre-wrap;">${escapeHtml(n.content)}</div>
        ${
          n.fileInfo?.driveViewUrl
            ? `<div style="margin-top: 0.45rem;">
                <a href="${escapeHtml(n.fileInfo.driveViewUrl)}" target="_blank" rel="noopener noreferrer" class="link-ext">
                  ☁️ Buka di Google Drive: ${escapeHtml(n.fileInfo.originalName || 'File')} ↗
                </a>
              </div>`
            : n.fileInfo?.savedFileName
            ? `<div style="margin-top: 0.45rem;">
                <a href="/saved-docs/${encodeURIComponent(n.fileInfo.savedFileName)}" target="_blank" rel="noopener noreferrer" class="link-ext">
                  📎 Unduh Dokumen Tersimpan: ${escapeHtml(n.fileInfo.originalName || n.fileInfo.savedFileName)} ↗
                </a>
              </div>`
            : ''
        }
      </div>
    `
    )
    .join('');

  savedNotesList.querySelectorAll('.btn-delete-note').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!confirm(`Hapus catatan permanen #${id}?`)) return;
      const res = await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.notes) renderSavedNotes(data.notes);
    });
  });
}

function updateBackupKeyFieldUI(provider) {
  const preset = backupPresets[provider || 'pollinations'];
  const linkEl = document.getElementById('backup-key-link');
  const labelText = document.getElementById('backup-key-label-text');
  const keyInput = document.getElementById('backup-ai-key');

  if (provider === 'pollinations') {
    if (labelText) labelText.textContent = 'API Key Backup (Kosongkan saja — 100% Gratis Tanpa Key!)';
    if (keyInput) keyInput.placeholder = 'Tidak perlu diisi untuk Pollinations AI Gratis!';
  } else {
    if (labelText) labelText.textContent = 'API Key Backup AI';
    if (keyInput) keyInput.placeholder = 'Masukkan API Key (gsk_... / sk-...)';
  }

  if (linkEl && preset?.docsUrl) {
    linkEl.href = preset.docsUrl;
    linkEl.classList.remove('hidden');
  } else if (linkEl) {
    linkEl.classList.add('hidden');
  }
}

function populateConfigForm(config) {
  if (!config) return;
  document.getElementById('gemini-api-key').value = config.geminiApiKey || '';
  document.getElementById('gemini-model').value = config.geminiModel || 'gemini-3.8-flash';
  document.getElementById('auto-fallback-gemini').checked = config.autoFallbackGemini !== false;

  const prov = config.backupAiProvider || 'pollinations';
  document.getElementById('backup-ai-enabled').checked = config.backupAiEnabled !== false;
  document.getElementById('backup-ai-provider').value = prov;
  document.getElementById('backup-ai-model').value = config.backupAiModel || 'openai-fast';
  document.getElementById('backup-ai-base-url').value = config.backupAiBaseUrl || 'https://text.pollinations.ai/openai';
  document.getElementById('backup-ai-key').value = config.backupAiApiKey || '';
  updateBackupKeyFieldUI(prov);

  const gdEnabledEl = document.getElementById('google-drive-enabled');
  if (gdEnabledEl) gdEnabledEl.checked = config.googleDriveEnabled !== false;
  const gdUrlEl = document.getElementById('google-drive-url');
  if (gdUrlEl) gdUrlEl.value = config.googleDriveScriptUrl || '';
  const gdFolderEl = document.getElementById('google-drive-folder');
  if (gdFolderEl) gdFolderEl.value = config.googleDriveFolderName || 'WabotAI_Files';

  document.getElementById('bot-name').value = config.botName || 'NANBOT';
  document.getElementById('max-messages').value = config.maxMessagesPerGroup || 500;
  document.getElementById('recent-context').value = config.recentContextCount || 80;
  document.getElementById('custom-prefixes').value = Array.isArray(config.customPrefixes)
    ? config.customPrefixes.join(', ')
    : '@bot, !ai, /ai';
  document.getElementById('reply-on-mention').checked = config.replyOnMention !== false;
  document.getElementById('reply-on-quote').checked = config.replyOnQuoteBot !== false;
  document.getElementById('allow-private').checked = Boolean(config.allowPrivateChat);
  document.getElementById('system-prompt').value = config.systemPrompt || '';
}

function renderGroupSelects(groups) {
  currentGroups = Array.isArray(groups) ? groups : [];
  const prevSim = simGroupSelect.value;
  const prevExp = explorerGroupSelect.value;

  const optionsHtml = currentGroups
    .map(
      (g) =>
        `<option value="${escapeHtml(g.groupId)}">${escapeHtml(g.groupName)} (${g.messageCount} pesan)</option>`
    )
    .join('');

  simGroupSelect.innerHTML =
    `<option value="">-- Tanpa Konteks Grup (Pertanyaan Umum) --</option>` + optionsHtml;
  explorerGroupSelect.innerHTML =
    `<option value="">-- Pilih Grup untuk Melihat Riwayat Chat --</option>` + optionsHtml;
  if (noteGroupSelect) {
    noteGroupSelect.innerHTML =
      `<option value="global">🌐 Semua Grup (Global)</option>` + optionsHtml;
  }

  if (prevSim && currentGroups.some((g) => g.groupId === prevSim)) {
    simGroupSelect.value = prevSim;
  } else if (currentGroups.length > 0 && !prevSim) {
    simGroupSelect.value = currentGroups[0].groupId;
  }

  if (prevExp && currentGroups.some((g) => g.groupId === prevExp)) {
    explorerGroupSelect.value = prevExp;
  } else if (currentGroups.length > 0 && !prevExp) {
    explorerGroupSelect.value = currentGroups[0].groupId;
    loadGroupMessages(currentGroups[0].groupId, explorerSearch.value);
  }
}

async function loadGroupMessages(groupId, query = '') {
  if (!groupId) {
    messagesViewer.innerHTML =
      '<p class="empty-text">Pilih grup di atas untuk menampilkan atau mencari riwayat chat yang tersimpan.</p>';
    return;
  }
  try {
    const res = await fetch(
      `/api/groups/${encodeURIComponent(groupId)}/messages?q=${encodeURIComponent(query)}&limit=100`
    );
    const data = await res.json();
    const list = data.messages || [];
    if (list.length === 0) {
      messagesViewer.innerHTML =
        '<p class="empty-text">Tidak ada pesan yang cocok atau riwayat grup masih kosong.</p>';
      return;
    }
    messagesViewer.innerHTML = list
      .map(
        (m) => `
        <div class="msg-bubble ${m.isBot ? 'bot' : ''}">
          <div class="msg-meta">
            <span class="msg-sender">${escapeHtml(m.senderName)}${m.isBot ? ' 🤖' : ''}</span>
            <span>${escapeHtml(m.formattedTime || '')}</span>
          </div>
          ${
            m.quotedText
              ? `<div class="msg-quote">Membalas ${escapeHtml(m.quotedSender || 'pesan')}: "${escapeHtml(
                  m.quotedText.slice(0, 100)
                )}"</div>`
              : ''
          }
          <div class="msg-text">${escapeHtml(m.text)}</div>
        </div>
      `
      )
      .join('');
  } catch (err) {
    messagesViewer.innerHTML = `<p class="empty-text">Gagal memuat pesan: ${escapeHtml(err.message)}</p>`;
  }
}

async function fetchInitialState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    if (data.presets) backupPresets = data.presets;
    if (data.driveScriptTemplate) {
      const tplEl = document.getElementById('drive-script-template');
      if (tplEl) tplEl.value = data.driveScriptTemplate;
    }
    renderBotState(data.bot);
    populateConfigForm(data.config);
    renderGroupSelects(data.groups);
    renderSavedNotes(data.notes);
  } catch (err) {
    console.error('Gagal mengambil state awal:', err);
  }
}

// Setup SSE for real-time updates
function connectSSE() {
  const evtSource = new EventSource('/api/events');
  evtSource.addEventListener('status', (e) => {
    try {
      const state = JSON.parse(e.data);
      renderBotState(state);
    } catch {
      // Ignore parse error
    }
  });
  evtSource.addEventListener('activity', (e) => {
    try {
      const item = JSON.parse(e.data);
      logsCache.unshift(item);
      if (logsCache.length > 50) logsCache.pop();
      renderLogs();
      if (item.type === 'save' || item.title?.includes('Catatan Permanen')) {
        fetch('/api/notes')
          .then((r) => r.json())
          .then((d) => {
            if (d.notes) renderSavedNotes(d.notes);
          })
          .catch(() => {});
      }
    } catch {
      // Ignore
    }
  });
}

// Backup AI Provider Preset Selector
document.getElementById('backup-ai-provider').addEventListener('change', (e) => {
  const provider = e.target.value;
  const preset = backupPresets[provider];
  if (preset) {
    document.getElementById('backup-ai-base-url').value = preset.baseUrl;
    document.getElementById('backup-ai-model').value = preset.defaultModel;
    updateBackupKeyFieldUI(provider);
  }
});

// Toggle password visibility
document.getElementById('btn-toggle-key').addEventListener('click', () => {
  const input = document.getElementById('gemini-api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('btn-toggle-backup-key').addEventListener('click', () => {
  const input = document.getElementById('backup-ai-key');
  input.type = input.type === 'password' ? 'text' : 'password';
});

// Test Gemini API
document.getElementById('btn-test-key').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test-key');
  const banner = document.getElementById('test-key-feedback');
  const apiKey = document.getElementById('gemini-api-key').value.trim();
  const model = document.getElementById('gemini-model').value;

  banner.classList.remove('hidden', 'ok', 'err');
  banner.textContent = '⏳ Menghubungi Google Gemini API...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/test-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, model })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Gagal menghubungi Gemini API');
    }
    banner.classList.add('ok');
    if (data.autoSwitched) {
      banner.textContent = `✅ Berhasil! Model ${data.requestedModel} sedang penuh, sistem otomatis memakai ${data.model}: "${data.reply}"`;
    } else {
      banner.textContent = `✅ Berhasil (${data.model}): "${data.reply}"`;
    }
  } catch (err) {
    banner.classList.add('err');
    banner.textContent = `❌ Gagal: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// Test Backup AI
document.getElementById('btn-test-backup-key').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test-backup-key');
  const banner = document.getElementById('test-backup-feedback');
  const provider = document.getElementById('backup-ai-provider').value;
  const baseUrl = document.getElementById('backup-ai-base-url').value.trim();
  const apiKey = document.getElementById('backup-ai-key').value.trim();
  const model = document.getElementById('backup-ai-model').value.trim();

  banner.classList.remove('hidden', 'ok', 'err');
  banner.textContent = '⏳ Menghubungi Backup AI Gratis...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/test-backup-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, baseUrl, apiKey, model })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Gagal menghubungi Backup AI');
    }
    banner.classList.add('ok');
    banner.textContent = `✅ Backup AI Gratis Aktif (${data.model}): "${data.reply}"`;
  } catch (err) {
    banner.classList.add('err');
    banner.textContent = `❌ Gagal: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// Test Google Drive
const btnTestDrive = document.getElementById('btn-test-drive');
if (btnTestDrive) {
  btnTestDrive.addEventListener('click', async () => {
    const banner = document.getElementById('test-drive-feedback');
    const scriptUrl = document.getElementById('google-drive-url').value.trim();

    banner.classList.remove('hidden', 'ok', 'err');
    banner.textContent = '⏳ Menghubungi Google Drive...';
    btnTestDrive.disabled = true;

    try {
      const res = await fetch('/api/test-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptUrl })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Gagal menghubungi Google Drive');
      }
      banner.classList.add('ok');
      banner.textContent = `✅ ${data.message}`;
    } catch (err) {
      banner.classList.add('err');
      banner.textContent = `❌ Gagal: ${err.message}`;
    } finally {
      btnTestDrive.disabled = false;
    }
  });
}

// Save Config
document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveStatus = document.getElementById('save-status');
  saveStatus.textContent = 'Menyimpan...';

  const payload = {
    geminiApiKey: document.getElementById('gemini-api-key').value.trim(),
    geminiModel: document.getElementById('gemini-model').value,
    autoFallbackGemini: document.getElementById('auto-fallback-gemini').checked,
    backupAiEnabled: document.getElementById('backup-ai-enabled').checked,
    backupAiProvider: document.getElementById('backup-ai-provider').value,
    backupAiBaseUrl: document.getElementById('backup-ai-base-url').value.trim(),
    backupAiApiKey: document.getElementById('backup-ai-key').value.trim(),
    backupAiModel: document.getElementById('backup-ai-model').value.trim(),
    googleDriveEnabled: document.getElementById('google-drive-enabled')?.checked ?? true,
    googleDriveScriptUrl: document.getElementById('google-drive-url')?.value.trim() || '',
    googleDriveFolderName: document.getElementById('google-drive-folder')?.value.trim() || 'WabotAI_Files',
    botName: document.getElementById('bot-name').value.trim(),
    maxMessagesPerGroup: Number(document.getElementById('max-messages').value),
    recentContextCount: Number(document.getElementById('recent-context').value),
    customPrefixes: document.getElementById('custom-prefixes').value,
    replyOnMention: document.getElementById('reply-on-mention').checked,
    replyOnQuoteBot: document.getElementById('reply-on-quote').checked,
    allowPrivateChat: document.getElementById('allow-private').checked,
    systemPrompt: document.getElementById('system-prompt').value
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Gagal menyimpan');
    saveStatus.textContent = '✅ Tersimpan!';
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 3000);
  } catch (err) {
    saveStatus.textContent = `❌ ${err.message}`;
  }
});

// Toggle Manual Add Note Form
document.getElementById('btn-toggle-add-note').addEventListener('click', () => {
  document.getElementById('add-note-form').classList.toggle('hidden');
});

document.getElementById('add-note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const groupId = noteGroupSelect.value || 'global';
  const category = document.getElementById('note-category').value;
  const title = document.getElementById('note-title').value.trim();
  const content = document.getElementById('note-content').value.trim();
  if (!content) return;

  const res = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, category, title, content })
  });
  const data = await res.json();
  if (data.ok) {
    document.getElementById('note-title').value = '';
    document.getElementById('note-content').value = '';
    document.getElementById('add-note-form').classList.add('hidden');
    renderSavedNotes(data.notes);
  }
});

document.getElementById('pairing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phoneInput = document.getElementById('pairing-phone');
  if (!phoneInput.checkValidity()) {
    phoneInput.focus();
    return;
  }
  const resultBox = document.getElementById('pairing-result');
  const btn = document.getElementById('btn-get-pairing');
  btn.disabled = true;
  resultBox.classList.remove('hidden');
  resultBox.textContent = 'Meminta kode pairing ke WhatsApp...';

  try {
    const res = await fetch('/api/pairing-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phoneInput.value.trim() })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Gagal meminta kode');
    resultBox.textContent = `KODE PAIRING ANDA: ${data.code}`;
  } catch (err) {
    resultBox.textContent = `Gagal: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-reconnect').addEventListener('click', async () => {
  await fetch('/api/reconnect', { method: 'POST' });
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('Yakin ingin mereset sesi WhatsApp dan membuat QR Code baru?')) return;
  await fetch('/api/logout', { method: 'POST' });
});

document.getElementById('btn-seed-demo').addEventListener('click', async () => {
  const res = await fetch('/api/seed-demo', { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    renderGroupSelects(data.groups);
    simGroupSelect.value = data.groupId;
    explorerGroupSelect.value = data.groupId;
    loadGroupMessages(data.groupId, '');
    const simQ = document.getElementById('sim-question');
    if (!simQ.value.trim()) {
      simQ.value = 'tolong save kan jadwal ini ya: Futsal rutin setiap hari Jumat jam 20.00 di Lapangan Champion, nanti saya butuh saya panggil kamu';
    }
    const stateRes = await fetch('/api/state');
    const stateData = await stateRes.json();
    renderBotState(stateData.bot);
  }
});

document.getElementById('playground-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const groupId = simGroupSelect.value;
  const question = document.getElementById('sim-question').value.trim();
  if (!question) return;

  const btn = document.getElementById('btn-ask-sim');
  const outBox = document.getElementById('sim-output-box');
  const outText = document.getElementById('sim-output-text');

  btn.disabled = true;
  outBox.classList.remove('hidden');
  outText.textContent = '⏳ Bot AI sedang memproses perintah & membaca catatan/riwayat grup...';

  try {
    const res = await fetch('/api/ask-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, question })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Gagal mendapatkan respons AI');
    outText.textContent = data.reply;
    if (data.notes) {
      renderSavedNotes(data.notes);
    }
  } catch (err) {
    outText.textContent = `❌ Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-refresh-groups').addEventListener('click', async () => {
  const res = await fetch('/api/groups');
  const data = await res.json();
  if (data.ok) {
    renderGroupSelects(data.groups);
    if (explorerGroupSelect.value) {
      loadGroupMessages(explorerGroupSelect.value, explorerSearch.value);
    }
  }
});

explorerGroupSelect.addEventListener('change', () => {
  loadGroupMessages(explorerGroupSelect.value, explorerSearch.value);
});

explorerSearch.addEventListener('input', () => {
  loadGroupMessages(explorerGroupSelect.value, explorerSearch.value);
});

document.getElementById('btn-clear-group').addEventListener('click', async () => {
  const gId = explorerGroupSelect.value;
  if (!gId) return;
  if (!confirm('Kosongkan semua riwayat chat sementara untuk grup ini? (Catatan permanen tidak akan ikut terhapus)')) return;
  await fetch(`/api/groups/${encodeURIComponent(gId)}/messages`, { method: 'DELETE' });
  loadGroupMessages(gId, '');
  fetchInitialState();
});

fetchInitialState();
connectSSE();
