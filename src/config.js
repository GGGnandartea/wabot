import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const GEMINI_FALLBACK_ORDER = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-4-argon',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it'
];

const VALID_MODELS = new Set(GEMINI_FALLBACK_ORDER);

export function normalizeGeminiModel(model) {
  const m = String(model || '').trim();
  if (!m) return 'gemini-3.8-flash';
  if (/^gemini-(1\.5|2\.0|2\.5)/i.test(m)) {
    return 'gemini-3.8-flash';
  }
  return VALID_MODELS.has(m) ? m : 'gemini-3.8-flash';
}

export const BACKUP_AI_PRESETS = {
  pollinations: {
    name: '🎁 Pollinations AI (100% GRATIS Tanpa API Key & Tanpa Daftar)',
    baseUrl: 'https://text.pollinations.ai/openai',
    defaultModel: 'openai-fast',
    requiresKey: false,
    docsUrl: ''
  },
  groq: {
    name: 'Groq Cloud (Gratis dengan API Key — Llama 3.3)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresKey: true,
    docsUrl: 'https://console.groq.com/keys'
  },
  openrouter: {
    name: 'OpenRouter (Model Gratis :free dengan API Key)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    requiresKey: true,
    docsUrl: 'https://openrouter.ai/keys'
  },
  openai: {
    name: 'OpenAI Resmi (ChatGPT Berbayar)',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  custom: {
    name: 'Custom OpenAI-Compatible API',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: false,
    docsUrl: ''
  }
};

const DEFAULT_CONFIG = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: normalizeGeminiModel(process.env.GEMINI_MODEL || 'gemini-3.8-flash'),
  autoFallbackGemini: true,
  backupAiEnabled: true,
  backupAiProvider: 'pollinations',
  backupAiBaseUrl: 'https://text.pollinations.ai/openai',
  backupAiApiKey: process.env.BACKUP_AI_API_KEY || '',
  backupAiModel: 'openai-fast',
  googleDriveEnabled: true,
  googleDriveScriptUrl: process.env.GOOGLE_DRIVE_SCRIPT_URL || '',
  googleDriveFolderName: 'WabotAI_Files',
  botName: 'NANBOT',
  maxMessagesPerGroup: 500,
  recentContextCount: 80,
  searchMatchLimit: 40,
  replyOnMention: true,
  replyOnQuoteBot: true,
  customPrefixes: ['@bot', '!ai', '/ai', 'ai'],
  allowedGroups: [],
  allowPrivateChat: false,
  systemPrompt: `Kamu adalah asisten AI pintar di dalam grup WhatsApp.
Tugas utamamu:
1. Menjawab pertanyaan anggota grup dengan akurat, ramah, ringkas, dan menggunakan Bahasa Indonesia yang natural.
2. Jika anggota bertanya tentang isi obrolan grup (misalnya "siapa yang tadi bahas...", "cari link/info...", "rangkum obrolan", "kapan jadwal..."), cari jawabannya dari [RIWAYAT CHAT GRUP] atau [CATATAN & DOKUMEN PENTING TERSIMPAN PERMANEN] yang diberikan, lalu sebutkan detailnya secara jelas.
3. Jika diberikan data di bagian [🌐 DATA REAL-TIME DARI INTERNET (CUACA / KURS / BERITA / WIKIPEDIA)], gunakan data tersebut untuk menjawab pertanyaan cuaca, berita terkini, kurs mata uang, atau pengetahuan umum secara lengkap dan informatif.
4. Gunakan format teks WhatsApp yang rapi bila perlu (*tebal* dengan satu bintang, _miring_ dengan underscore, dan daftar poin).
5. Jika di tag atau apapun maka kamu akan menjawab terlebih dahulu kamu adalah Nanbot siap membantu.
6. Jika pengguna meminta fitur eksternal khusus yang datanya benar-benar tidak tersedia di [🌐 DATA REAL-TIME DARI INTERNET], jawab dengan kalimat: "Bos nandar belum menambahkan fitur tersebut maaf ya, minta dia nambahin aja dia pedit soalnya"`
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let currentConfig = { ...DEFAULT_CONFIG };

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);

      if ((!parsed.backupAiProvider || parsed.backupAiProvider === 'groq') && !parsed.backupAiApiKey) {
        parsed.backupAiProvider = 'pollinations';
        parsed.backupAiBaseUrl = 'https://text.pollinations.ai/openai';
        parsed.backupAiModel = 'openai-fast';
      }

      // Upgrade old rule #6 that blocked weather so the AI now answers weather & live info using [🌐 DATA REAL-TIME DARI INTERNET]
      if (
        parsed.systemPrompt &&
        parsed.systemPrompt.includes('misalnya info cuaca saat ini')
      ) {
        parsed.systemPrompt = DEFAULT_CONFIG.systemPrompt;
      }

      if (Array.isArray(parsed.customPrefixes)) {
        parsed.customPrefixes = parsed.customPrefixes
          .flatMap((p) => String(p || '').split(/[,;\s]+/))
          .map((p) => p.trim())
          .filter(Boolean);
      }

      currentConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        geminiModel: normalizeGeminiModel(parsed.geminiModel)
      };
      if (!currentConfig.geminiApiKey && process.env.GEMINI_API_KEY) {
        currentConfig.geminiApiKey = process.env.GEMINI_API_KEY;
      }
      saveConfig(currentConfig);
    } else {
      saveConfig(currentConfig);
    }
  } catch (err) {
    console.error('[Config] Gagal membaca config.json, menggunakan default:', err.message);
  }
  return currentConfig;
}

export function getConfig() {
  return currentConfig;
}

export function saveConfig(newValues) {
  currentConfig = {
    ...currentConfig,
    ...newValues,
    geminiModel: normalizeGeminiModel(newValues.geminiModel ?? currentConfig.geminiModel),
    autoFallbackGemini:
      newValues.autoFallbackGemini !== undefined
        ? Boolean(newValues.autoFallbackGemini)
        : currentConfig.autoFallbackGemini,
    backupAiEnabled:
      newValues.backupAiEnabled !== undefined
        ? Boolean(newValues.backupAiEnabled)
        : currentConfig.backupAiEnabled,
    googleDriveEnabled:
      newValues.googleDriveEnabled !== undefined
        ? Boolean(newValues.googleDriveEnabled)
        : currentConfig.googleDriveEnabled,
    maxMessagesPerGroup: Math.max(
      50,
      Math.min(5000, Number(newValues.maxMessagesPerGroup ?? currentConfig.maxMessagesPerGroup) || 500)
    ),
    recentContextCount: Math.max(
      10,
      Math.min(300, Number(newValues.recentContextCount ?? currentConfig.recentContextCount) || 80)
    ),
    searchMatchLimit: Math.max(
      10,
      Math.min(100, Number(newValues.searchMatchLimit ?? currentConfig.searchMatchLimit) || 40)
    )
  };

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Config] Gagal menyimpan config.json:', err.message);
  }
  return currentConfig;
}

loadConfig();
