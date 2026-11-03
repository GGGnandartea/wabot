import { GoogleGenAI } from '@google/genai';
import { getConfig, normalizeGeminiModel, GEMINI_FALLBACK_ORDER } from './config.js';
import { getRelevantGroupContext, formatTimestamp } from './chatStore.js';
import { getSavedNotesForGroup } from './notesStore.js';
import { gatherExternalKnowledge } from './externalInfoService.js';

function formatMessageLine(m) {
  const timeStr = m.formattedTime || formatTimestamp(m.timestamp);
  const roleTag = m.isBot ? ' [BOT]' : '';
  const quotePart = m.quotedText
    ? ` (Membalas ${m.quotedSender || 'pesan'}: "${m.quotedText.slice(0, 120)}")`
    : '';
  return `[${timeStr}] ${m.senderName}${roleTag}${quotePart}: ${m.text}`;
}

function formatSavedNoteLine(n) {
  let docTag = '';
  if (n.fileInfo?.originalName) {
    const loc = n.fileInfo.driveFileId ? 'Google Drive' : 'Server Lokal';
    docTag = ` [Lampiran File (${loc}): "${n.fileInfo.originalName}"]`;
  }
  return `[ID #${n.id}] (${n.category.toUpperCase()} - Disimpan oleh ${n.savedBy} pada ${n.formattedTime})${docTag}\nJudul: ${n.title}\nIsi: ${n.content}`;
}

/**
 * Calls an OpenAI-compatible API or Pollinations Free No-Key AI
 */
async function callOpenAICompatible({ baseUrl, apiKey, model, systemPrompt, userPrompt }) {
  const cleanBase = String(baseUrl || 'https://text.pollinations.ai/openai').replace(/\/+$/, '');
  const isPollinations = cleanBase.includes('pollinations.ai');
  const url = isPollinations
    ? cleanBase.endsWith('/openai')
      ? cleanBase
      : `${cleanBase}/openai`
    : cleanBase.endsWith('/chat/completions')
    ? cleanBase
    : `${cleanBase}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey && String(apiKey).trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || (isPollinations ? 'openai-fast' : 'llama-3.3-70b-versatile'),
        messages: [
          { role: 'system', content: systemPrompt || 'Kamu adalah asisten AI pintar.' },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.4
      }),
      signal: controller.signal
    });

    const rawText = await res.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      if (res.ok && rawText && rawText.trim()) {
        return rawText.trim();
      }
    }

    if (!res.ok) {
      const errMsg = data?.error?.message || data?.message || rawText.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Respons kosong dari Backup AI.');
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Calls Gemini with automatic model fallback, and if all Gemini models fail,
 * automatically falls back to Backup AI (including 100% Free No-Key Pollinations AI).
 */
async function generateWithFallback({ systemPrompt, userPrompt, onFallbackLog }) {
  const config = getConfig();
  const geminiKey = (config.geminiApiKey || '').trim();
  const primaryModel = normalizeGeminiModel(config.geminiModel);

  const errors = [];

  // 1. PRIORITY 1: Try Google Gemini (Primary Model -> Fallback Gemini Models)
  if (geminiKey) {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const modelsToTry =
      config.autoFallbackGemini !== false
        ? [primaryModel, ...GEMINI_FALLBACK_ORDER.filter((m) => m !== primaryModel)]
        : [primaryModel];

    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = modelsToTry[i];
      try {
        const interaction = await ai.interactions.create({
          model: modelName,
          input: userPrompt,
          system_instruction: systemPrompt,
          generation_config: {
            temperature: 0.4
          }
        });

        const text = interaction?.output_text?.trim();
        if (text) {
          if (i > 0 && typeof onFallbackLog === 'function') {
            onFallbackLog(
              `Model utama (${primaryModel}) sedang sibuk/limit, otomatis dijawab menggunakan model cadangan Gemini: ${modelName}`
            );
          }
          return {
            text,
            usedProvider: 'gemini',
            usedModel: modelName,
            wasFallback: i > 0
          };
        }
      } catch (err) {
        const errMsg = err?.message || String(err);
        errors.push(`Gemini (${modelName}): ${errMsg}`);
        if (/API_KEY_INVALID|invalid api key|PERMISSION_DENIED/i.test(errMsg)) {
          break;
        }
      }
    }
  } else {
    errors.push('Gemini API Key belum diisi.');
  }

  // 2. PRIORITY 2: Try Configured Backup AI (if enabled)
  if (config.backupAiEnabled !== false) {
    const backupProvider = config.backupAiProvider || 'pollinations';
    const backupBaseUrl = (config.backupAiBaseUrl || 'https://text.pollinations.ai/openai').trim();
    const backupKey = (config.backupAiApiKey || '').trim();
    const backupModel = (config.backupAiModel || 'openai-fast').trim();
    const isNoKeyProvider = backupProvider === 'pollinations' || backupBaseUrl.includes('pollinations.ai');

    if (isNoKeyProvider || backupKey) {
      try {
        const text = await callOpenAICompatible({
          baseUrl: backupBaseUrl,
          apiKey: backupKey,
          model: backupModel,
          systemPrompt,
          userPrompt
        });
        if (typeof onFallbackLog === 'function') {
          onFallbackLog(
            `Gemini sedang tidak tersedia, otomatis beralih ke Backup AI Gratis (${backupProvider}: ${backupModel})`
          );
        }
        return {
          text,
          usedProvider: backupProvider,
          usedModel: backupModel,
          wasFallback: true
        };
      } catch (err) {
        errors.push(`Backup AI (${backupModel}): ${err.message}`);
      }
    }

    // 3. PRIORITY 3 (Built-in Free Safety Net): Pollinations Free No-Key AI
    if (!isNoKeyProvider) {
      try {
        const text = await callOpenAICompatible({
          baseUrl: 'https://text.pollinations.ai/openai',
          apiKey: '',
          model: 'openai-fast',
          systemPrompt,
          userPrompt
        });
        if (typeof onFallbackLog === 'function') {
          onFallbackLog(
            `Otomatis beralih ke Backup AI Gratis Bawaan (Pollinations openai-fast — Tanpa API Key)`
          );
        }
        return {
          text,
          usedProvider: 'pollinations',
          usedModel: 'openai-fast',
          wasFallback: true
        };
      } catch (err) {
        errors.push(`Free AI Safety Net: ${err.message}`);
      }
    }
  }

  throw new Error(errors.join(' | '));
}

export async function generateGroupAIReply({
  groupId,
  groupName,
  senderName,
  question,
  quotedText = '',
  quotedSender = '',
  noteActionInfo = '',
  onFallbackLog = null
}) {
  const config = getConfig();

  // 1. Gather Live External Information (Weather, Exchange Rates, News, Wikipedia) if relevant
  let externalInfoSection = '';
  try {
    const extData = await gatherExternalKnowledge(question);
    if (extData) {
      externalInfoSection = `\n=== 🌐 DATA REAL-TIME DARI INTERNET (CUACA / KURS / BERITA / WIKIPEDIA) ===\n${extData}\n`;
    }
  } catch (err) {
    console.error('[AIService] Gagal mengambil data eksternal:', err.message);
  }

  // 2. Load Permanent Saved Notes for this group
  const savedNotes = getSavedNotesForGroup(groupId);
  let savedNotesSection = '';
  if (savedNotes.length > 0) {
    savedNotesSection += `\n=== 📌 CATATAN, JADWAL & FILE PENTING TERSIMPAN PERMANEN (${savedNotes.length} item) ===\n`;
    savedNotesSection += `(Catatan/file di bawah ini disimpan permanen atas permintaan anggota grup):\n`;
    savedNotesSection += savedNotes.map(formatSavedNoteLine).join('\n---\n');
    savedNotesSection += '\n';
  } else {
    savedNotesSection += `\n=== 📌 CATATAN, JADWAL & FILE PENTING TERSIMPAN PERMANEN ===\n(Belum ada catatan/jadwal/file permanen yang disimpan di grup ini)\n`;
  }

  // 3. Load Temporary Group Chat History (search matches + recent context)
  const contextData = groupId
    ? getRelevantGroupContext(groupId, question)
    : { groupName: groupName || 'Chat Pribadi', totalStored: 0, matchedMessages: [], recentMessages: [] };

  const recentIds = new Set(contextData.recentMessages.map((m) => m.id));
  const olderMatched = contextData.matchedMessages.filter((m) => !recentIds.has(m.id));

  let historyPromptSection = '';

  if (olderMatched.length > 0) {
    historyPromptSection += `\n=== HASIL PENCARIAN CHAT LAMA YANG COCOK DENGAN PERTANYAAN (${olderMatched.length} pesan) ===\n`;
    historyPromptSection += olderMatched.map(formatMessageLine).join('\n');
    historyPromptSection += '\n';
  }

  if (contextData.recentMessages.length > 0) {
    historyPromptSection += `\n=== RIWAYAT OBROLAN TERBARU DI GRUP "${contextData.groupName}" (${contextData.recentMessages.length} dari total ${contextData.totalStored} pesan sementara) ===\n`;
    historyPromptSection += contextData.recentMessages.map(formatMessageLine).join('\n');
    historyPromptSection += '\n';
  }

  let quotedSection = '';
  if (quotedText) {
    quotedSection = `\n=== PESAN YANG SEDANG DI-REPLY OLEH PENANYA ===\nPengirim Pesan Asli: ${quotedSender || 'Anggota'}\nIsi Pesan Asli: "${quotedText}"\n`;
  }

  let actionSection = '';
  if (noteActionInfo) {
    actionSection = `\n=== STATUS AKSI PENYIMPANAN CATATAN / FILE BARU SAJA ===\n${noteActionInfo}\n(Konfirmasikan kepada penanya bahwa aksi tersebut sudah berhasil dilakukan!)\n`;
  }

  const nowStr = formatTimestamp(Date.now());
  const fullUserPrompt = `Waktu Sekarang: ${nowStr} WIB
Nama Grup WhatsApp: ${contextData.groupName || groupName || 'Grup Pribadi'}
${externalInfoSection}${savedNotesSection}${historyPromptSection}${quotedSection}${actionSection}
=== PERTANYAAN / PERINTAH SAAT INI ===
Penanya: ${senderName || 'Anggota'}
Pesan: ${question || '(Menyebut bot tanpa teks tambahan)'}

Instruksi Tambahan:
- Jika terdapat [🌐 DATA REAL-TIME DARI INTERNET (CUACA / KURS / BERITA / WIKIPEDIA)], WAJIB gunakan data real-time tersebut untuk menjawab pertanyaan pengguna dengan lengkap, jelas, dan rapi!
- Jika terdapat [STATUS AKSI PENYIMPANAN CATATAN / FILE BARU SAJA], sampaikan konfirmasi bahwa aksi tersebut sudah berhasil dilakukan.
- Jika penanya menanyakan jadwal, dokumen, file, atau chat yang pernah di-save/disimpan, utamakan mengambil data dari bagian [📌 CATATAN, JADWAL & FILE PENTING TERSIMPAN PERMANEN].`;

  const result = await generateWithFallback({
    systemPrompt: config.systemPrompt,
    userPrompt: fullUserPrompt,
    onFallbackLog
  });

  return result.text;
}

export async function testGeminiConnection(customApiKey, customModel) {
  const config = getConfig();
  const apiKey = (customApiKey ?? config.geminiApiKey ?? '').trim();
  const primaryModel = normalizeGeminiModel(customModel || config.geminiModel);

  if (!apiKey) {
    throw new Error('API Key Gemini masih kosong.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const modelsToTry = [primaryModel, ...GEMINI_FALLBACK_ORDER.filter((m) => m !== primaryModel)];

  let lastErr = null;
  for (let i = 0; i < modelsToTry.length; i++) {
    const m = modelsToTry[i];
    try {
      const interaction = await ai.interactions.create({
        model: m,
        input: 'Balas dengan satu kalimat singkat dalam Bahasa Indonesia: "Koneksi Gemini AI berhasil dan siap digunakan!"'
      });
      const reply = interaction?.output_text?.trim() || 'OK';
      return {
        ok: true,
        model: m,
        requestedModel: primaryModel,
        autoSwitched: i > 0,
        reply
      };
    } catch (err) {
      lastErr = err;
      if (/API_KEY_INVALID|invalid api key|PERMISSION_DENIED/i.test(err?.message || '')) {
        break;
      }
    }
  }

  throw lastErr || new Error('Gagal menghubungi semua model Gemini.');
}

export async function testBackupAIConnection({ provider, baseUrl, apiKey, model }) {
  const config = getConfig();
  const prov = provider || config.backupAiProvider || 'pollinations';
  const url = (baseUrl || config.backupAiBaseUrl || 'https://text.pollinations.ai/openai').trim();
  const key = (apiKey ?? config.backupAiApiKey ?? '').trim();
  const mdl = (model || config.backupAiModel || 'openai-fast').trim();

  const isNoKeyProvider = prov === 'pollinations' || url.includes('pollinations.ai');
  if (!isNoKeyProvider && !key) {
    throw new Error('Provider ini membutuhkan API Key. Pilih "🎁 Pollinations AI (100% GRATIS Tanpa API Key)" jika tidak ingin memakai API Key.');
  }

  const reply = await callOpenAICompatible({
    baseUrl: url,
    apiKey: key,
    model: mdl,
    systemPrompt: 'Kamu adalah Nanbot, asisten AI grup WhatsApp.',
    userPrompt: 'Balas dengan satu kalimat singkat dalam Bahasa Indonesia: "Backup AI Gratis siap digunakan tanpa perlu bayar!"'
  });

  return {
    ok: true,
    model: mdl,
    noKeyRequired: isNoKeyProvider,
    reply
  };
}
