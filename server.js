import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, saveConfig, BACKUP_AI_PRESETS } from './src/config.js';
import {
  getGroupsSummary,
  searchMessagesInGroup,
  clearGroupMessages,
  addGroupMessage
} from './src/chatStore.js';
import {
  getAllSavedNotes,
  addSavedNote,
  deleteSavedNoteById,
  deleteSavedNoteByQuery,
  formatNotesListText,
  parseNoteCommand,
  SAVED_DOCS_DIR
} from './src/notesStore.js';
import {
  testGoogleDriveConnection,
  GOOGLE_APPS_SCRIPT_TEMPLATE
} from './src/driveService.js';
import {
  generateGroupAIReply,
  testGeminiConnection,
  testBackupAIConnection
} from './src/aiService.js';
import {
  startWhatsAppBot,
  logoutWhatsAppBot,
  requestPairingCodeForNumber,
  getBotState,
  botEvents,
  addActivityLog,
  emitStatusUpdate
} from './src/waBot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/saved-docs', express.static(SAVED_DOCS_DIR));

// SSE Clients for real-time dashboard updates
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

botEvents.on('status', (state) => {
  broadcastSSE('status', state);
});

botEvents.on('activity', (logItem) => {
  broadcastSSE('activity', logItem);
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`event: status\ndata: ${JSON.stringify(getBotState())}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/api/state', (req, res) => {
  res.json({
    bot: getBotState(),
    config: getConfig(),
    presets: BACKUP_AI_PRESETS,
    driveScriptTemplate: GOOGLE_APPS_SCRIPT_TEMPLATE,
    groups: getGroupsSummary(),
    notes: getAllSavedNotes()
  });
});

app.post('/api/config', (req, res) => {
  try {
    const body = req.body || {};
    const customPrefixes = Array.isArray(body.customPrefixes)
      ? body.customPrefixes.flatMap((s) => String(s || '').split(/[,;\s]+/)).filter(Boolean)
      : String(body.customPrefixes || '@bot, !ai, /ai, ai')
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);

    const updated = saveConfig({
      geminiApiKey: body.geminiApiKey !== undefined ? String(body.geminiApiKey).trim() : undefined,
      geminiModel: body.geminiModel || 'gemini-3.8-flash',
      autoFallbackGemini: body.autoFallbackGemini !== undefined ? Boolean(body.autoFallbackGemini) : true,
      backupAiEnabled: body.backupAiEnabled !== undefined ? Boolean(body.backupAiEnabled) : true,
      backupAiProvider: body.backupAiProvider || 'pollinations',
      backupAiBaseUrl: body.backupAiBaseUrl ? String(body.backupAiBaseUrl).trim() : 'https://text.pollinations.ai/openai',
      backupAiApiKey: body.backupAiApiKey !== undefined ? String(body.backupAiApiKey).trim() : undefined,
      backupAiModel: body.backupAiModel ? String(body.backupAiModel).trim() : 'openai-fast',
      googleDriveEnabled: body.googleDriveEnabled !== undefined ? Boolean(body.googleDriveEnabled) : true,
      googleDriveScriptUrl: body.googleDriveScriptUrl !== undefined ? String(body.googleDriveScriptUrl).trim() : undefined,
      googleDriveFolderName: body.googleDriveFolderName ? String(body.googleDriveFolderName).trim() : 'WabotAI_Files',
      botName: body.botName || 'NANBOT',
      maxMessagesPerGroup: Number(body.maxMessagesPerGroup) || 500,
      recentContextCount: Number(body.recentContextCount) || 80,
      searchMatchLimit: Number(body.searchMatchLimit) || 40,
      replyOnMention: Boolean(body.replyOnMention),
      replyOnQuoteBot: Boolean(body.replyOnQuoteBot),
      allowPrivateChat: Boolean(body.allowPrivateChat),
      customPrefixes,
      systemPrompt: body.systemPrompt || getConfig().systemPrompt
    });

    addActivityLog(
      'info',
      'Konfigurasi Disimpan',
      `Model Utama: ${updated.geminiModel} | Google Drive: ${updated.googleDriveScriptUrl ? 'Aktif' : 'Lokal'}`
    );
    res.json({ ok: true, config: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/test-ai', async (req, res) => {
  try {
    const { apiKey, model } = req.body || {};
    const result = await testGeminiConnection(apiKey, model);
    addActivityLog('info', 'Tes Koneksi Gemini Berhasil', `Model ${result.model}: "${result.reply}"`);
    res.json(result);
  } catch (err) {
    addActivityLog('error', 'Tes Koneksi Gemini Gagal', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/test-backup-ai', async (req, res) => {
  try {
    const { provider, baseUrl, apiKey, model } = req.body || {};
    const result = await testBackupAIConnection({ provider, baseUrl, apiKey, model });
    addActivityLog('info', 'Tes Backup AI Berhasil', `Model ${result.model}: "${result.reply}"`);
    res.json(result);
  } catch (err) {
    addActivityLog('error', 'Tes Backup AI Gagal', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/test-drive', async (req, res) => {
  try {
    const { scriptUrl } = req.body || {};
    const result = await testGoogleDriveConnection(scriptUrl);
    addActivityLog('info', 'Tes Google Drive Berhasil', result.message);
    res.json(result);
  } catch (err) {
    addActivityLog('error', 'Tes Google Drive Gagal', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/ask-test', async (req, res) => {
  try {
    const { groupId, question, senderName } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ ok: false, error: 'Pertanyaan tidak boleh kosong.' });
    }
    const cleanQ = String(question).trim();
    const groups = getGroupsSummary();
    const foundGroup = groups.find((g) => g.groupId === groupId);
    const gName = foundGroup?.groupName || 'Simulasi Dashboard';

    const noteCmd = parseNoteCommand(cleanQ, '', false);
    let noteActionInfo = '';
    if (noteCmd.action === 'list') {
      const reply = `Halo! Saya ${getConfig().botName || 'Nanbot'} siap membantu.\n\n${formatNotesListText(
        groupId || 'global'
      )}`;
      return res.json({ ok: true, reply, notes: getAllSavedNotes() });
    } else if (noteCmd.action === 'save') {
      const savedNote = addSavedNote({
        groupId: groupId || 'global',
        groupName: gName,
        title: noteCmd.titleToSave,
        content: noteCmd.contentToSave,
        savedBy: senderName || 'Admin (Dashboard)'
      });
      noteActionInfo = `Catatan baru saja disimpan dengan nama "${savedNote.title}". Cukup konfirmasikan singkat dan natural bahwa sudah disimpan dengan nama *${savedNote.title}*.`;
      addActivityLog('save', `📌 Disimpan #${savedNote.id}: ${savedNote.title}`, savedNote.title);
      emitStatusUpdate();
    } else if (noteCmd.action === 'delete') {
      const deleted = await deleteSavedNoteByQuery(groupId || 'global', noteCmd.targetQuery);
      if (deleted) {
        noteActionInfo = `Catatan "${deleted.title}" (#${deleted.id}) sudah berhasil dihapus. Sampaikan singkat dan natural bahwa *${deleted.title}* sudah dihapus.`;
        addActivityLog('info', `🗑️ Dihapus #${deleted.id}: ${deleted.title}`, deleted.title);
        emitStatusUpdate();
      }
    }

    const reply = await generateGroupAIReply({
      groupId: groupId || null,
      groupName: gName,
      senderName: senderName || 'Admin (Dashboard)',
      question: cleanQ,
      noteActionInfo,
      onFallbackLog: (msg) => addActivityLog('info', '🔄 Auto-Fallback Model AI', msg)
    });
    res.json({ ok: true, reply, notes: getAllSavedNotes() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Permanent Notes API
app.get('/api/notes', (req, res) => {
  const { groupId = '' } = req.query;
  res.json({ ok: true, notes: getAllSavedNotes(String(groupId)) });
});

app.post('/api/notes', (req, res) => {
  try {
    const { groupId, groupName, title, content, category, savedBy } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ ok: false, error: 'Isi catatan tidak boleh kosong.' });
    }
    const groups = getGroupsSummary();
    const foundGroup = groups.find((g) => g.groupId === groupId);
    const note = addSavedNote({
      groupId: groupId || 'global',
      groupName: groupName || foundGroup?.groupName || 'Semua Grup (Global)',
      title: title || '',
      content: String(content).trim(),
      category: category || '',
      savedBy: savedBy || 'Admin (Dashboard)'
    });
    addActivityLog('save', `📌 Catatan Permanen #${note.id} Ditambahkan`, note.title);
    emitStatusUpdate();
    res.json({ ok: true, note, notes: getAllSavedNotes() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  const removed = await deleteSavedNoteById(req.params.id);
  if (removed) {
    addActivityLog('info', `🗑️ Catatan Permanen #${removed.id} Dihapus`, removed.title);
    emitStatusUpdate();
  }
  res.json({ ok: Boolean(removed), notes: getAllSavedNotes() });
});

app.post('/api/pairing-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    const code = await requestPairingCodeForNumber(phoneNumber);
    res.json({ ok: true, code });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    await logoutWhatsAppBot(true);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/reconnect', async (req, res) => {
  try {
    startWhatsAppBot();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/groups', (req, res) => {
  res.json({ ok: true, groups: getGroupsSummary() });
});

app.get('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const { q = '', limit = 100 } = req.query;
  const messages = searchMessagesInGroup(groupId, String(q), Number(limit) || 100);
  res.json({ ok: true, messages });
});

app.delete('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const cleared = clearGroupMessages(groupId);
  addActivityLog('info', 'Riwayat Grup Dihapus', `Riwayat chat sementara grup ${groupId} telah dikosongkan.`);
  res.json({ ok: cleared });
});

app.post('/api/seed-demo', (req, res) => {
  const demoGroupId = '120363000999888777@g.us';
  const demoGroupName = 'Grup Tongkrongan & Proyek (Demo)';
  const now = Date.now();
  const sampleMessages = [
    { senderName: 'Budi', text: 'Eh guys, jadwal futsal minggu ini jadi hari Jumat jam 8 malam di Lapangan Champion ya.', offsetMin: -180 },
    { senderName: 'Rina', text: 'Siap Bud! Jangan lupa patungan sewa lapangan Rp 25.000 per orang transfer ke BCA Budi 1234567890.', offsetMin: -175 },
    { senderName: 'Dimas', text: 'Eh link dokumen desain UI proyek kita tadi ditaruh mana ya?', offsetMin: -120 },
    { senderName: 'Siti', text: 'Ini Dim link Figma proyek kita: https://figma.com/file/xyz123-desain-app jangan sampai hilang lagi ya.', offsetMin: -115 },
    { senderName: 'Andi', text: 'Besok meeting sprint jam 10 pagi via Google Meet, password ruangannya: kopi-susu-2026', offsetMin: -60 },
    { senderName: 'Budi', text: 'Oke siap Andi, nanti malam aku beresin modul login dulu.', offsetMin: -45 }
  ];

  for (const item of sampleMessages) {
    addGroupMessage({
      id: `demo-${Math.abs(item.offsetMin)}`,
      groupId: demoGroupId,
      groupName: demoGroupName,
      senderJid: '62811111111@s.whatsapp.net',
      senderName: item.senderName,
      text: item.text,
      timestamp: now + item.offsetMin * 60 * 1000
    });
  }

  addActivityLog('info', 'Data Demo Grup Ditambahkan', `6 pesan contoh berhasil dimasukkan ke "${demoGroupName}" untuk uji coba pencarian AI.`);
  res.json({ ok: true, groupId: demoGroupId, groups: getGroupsSummary() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 WabotAI Server berjalan di http://0.0.0.0:${PORT}`);
  console.log(`====================================================`);
  startWhatsAppBot();
});
