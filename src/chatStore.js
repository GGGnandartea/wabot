import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const CHATS_FILE = path.join(DATA_DIR, 'group_chats.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Structure: { [groupId]: { groupId, groupName, updatedAt, messages: [ { id, senderJid, senderName, text, quotedText, quotedSender, timestamp } ] } }
let groupStore = {};
let saveTimer = null;

const INDONESIAN_STOPWORDS = new Set([
  'yang', 'di', 'ke', 'dari', 'ini', 'itu', 'dan', 'atau', 'tapi', 'untuk',
  'dengan', 'pada', 'adalah', 'ada', 'tidak', 'గా', 'bisa', 'mau', 'akan',
  'sudah', 'belum', 'lagi', 'juga', 'saja', 'aja', 'kok', 'sih', 'dong',
  'deh', 'nih', 'tuh', 'ya', 'yah', 'apa', 'siapa', 'kapan', 'dimana',
  'gimana', 'bagaimana', 'kenapa', 'mengapa', 'berapa', 'tolong', 'coba',
  'cari', 'carikan', 'cariin', 'lihat', 'cek', 'tanya', 'bot', 'min', 'kak',
  'bang', 'bro', 'sis', 'grup', 'group', 'chat', 'pesan', 'bahas', 'bilang',
  'tentang', 'soal', 'kemarin', 'tadi', 'hari', 'sama', 'oleh', 'kalo', 'kalau'
]);

export function loadChatStore() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      const raw = fs.readFileSync(CHATS_FILE, 'utf-8');
      groupStore = JSON.parse(raw) || {};
    }
  } catch (err) {
    console.error('[ChatStore] Gagal memuat group_chats.json:', err.message);
    groupStore = {};
  }
  return groupStore;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushChatStore();
  }, 1500);
}

export function flushChatStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CHATS_FILE, JSON.stringify(groupStore, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ChatStore] Gagal menyimpan group_chats.json:', err.message);
  }
}

export function formatTimestamp(tsSecondsOrMs) {
  const ms = tsSecondsOrMs < 1e12 ? tsSecondsOrMs * 1000 : tsSecondsOrMs;
  const d = new Date(ms);
  return d.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function upsertGroupMetadata(groupId, groupName) {
  if (!groupId || !groupId.endsWith('@g.us')) return;
  if (!groupStore[groupId]) {
    groupStore[groupId] = {
      groupId,
      groupName: groupName || groupId,
      updatedAt: Date.now(),
      messages: []
    };
    scheduleSave();
  } else if (groupName && groupStore[groupId].groupName !== groupName) {
    groupStore[groupId].groupName = groupName;
    scheduleSave();
  }
}

export function addGroupMessage({
  id,
  groupId,
  groupName,
  senderJid,
  senderName,
  text,
  quotedText = '',
  quotedSender = '',
  timestamp = Date.now(),
  isBot = false
}) {
  if (!groupId || !groupId.endsWith('@g.us') || !text || !text.trim()) return null;

  const config = getConfig();
  const maxMessages = config.maxMessagesPerGroup || 500;
  const tsMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;

  if (!groupStore[groupId]) {
    groupStore[groupId] = {
      groupId,
      groupName: groupName || groupId,
      updatedAt: tsMs,
      messages: []
    };
  } else if (groupName && groupName !== groupId) {
    groupStore[groupId].groupName = groupName;
  }

  const group = groupStore[groupId];

  // Prevent duplicate message IDs
  if (id && group.messages.some((m) => m.id === id)) {
    return null;
  }

  const entry = {
    id: id || `${tsMs}-${Math.random().toString(36).slice(2, 8)}`,
    senderJid: senderJid || 'unknown',
    senderName: senderName || 'Anggota',
    text: text.trim(),
    quotedText: quotedText ? quotedText.trim() : '',
    quotedSender: quotedSender || '',
    timestamp: tsMs,
    formattedTime: formatTimestamp(tsMs),
    isBot: Boolean(isBot)
  };

  group.messages.push(entry);
  // Keep sorted by timestamp
  group.messages.sort((a, b) => a.timestamp - b.timestamp);

  // Trim to maxMessagesPerGroup
  if (group.messages.length > maxMessages) {
    group.messages = group.messages.slice(group.messages.length - maxMessages);
  }

  group.updatedAt = Math.max(group.updatedAt || 0, tsMs);
  scheduleSave();
  return entry;
}

/**
 * Searches messages in a group by keywords and combines with recent context
 * so the AI can both search older group messages and understand recent chat flow.
 */
export function getRelevantGroupContext(groupId, query = '') {
  const group = groupStore[groupId];
  if (!group || !Array.isArray(group.messages) || group.messages.length === 0) {
    return {
      groupName: group?.groupName || groupId,
      totalStored: 0,
      matchedMessages: [],
      recentMessages: []
    };
  }

  const config = getConfig();
  const recentLimit = config.recentContextCount || 80;
  const matchLimit = config.searchMatchLimit || 40;

  // Extract meaningful search keywords from user query
  const keywords = (query || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !INDONESIAN_STOPWORDS.has(w));

  let matchedMessages = [];
  if (keywords.length > 0) {
    const scored = [];
    for (const msg of group.messages) {
      const haystack = `${msg.senderName} ${msg.text} ${msg.quotedText || ''} ${msg.formattedTime || ''}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (haystack.includes(kw)) {
          score += kw.length >= 4 ? 2 : 1;
        }
      }
      if (score > 0) {
        scored.push({ msg, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || b.msg.timestamp - a.msg.timestamp);
    matchedMessages = scored.slice(0, matchLimit).map((s) => s.msg);
    matchedMessages.sort((a, b) => a.timestamp - b.timestamp);
  }

  const recentMessages = group.messages.slice(-recentLimit);

  return {
    groupName: group.groupName || groupId,
    totalStored: group.messages.length,
    matchedMessages,
    recentMessages
  };
}

export function searchMessagesInGroup(groupId, searchText = '', limit = 100) {
  const group = groupStore[groupId];
  if (!group) return [];
  const q = (searchText || '').trim().toLowerCase();
  const list = group.messages || [];
  if (!q) {
    return list.slice(-limit).reverse();
  }
  return list
    .filter(
      (m) =>
        m.text.toLowerCase().includes(q) ||
        (m.senderName && m.senderName.toLowerCase().includes(q)) ||
        (m.quotedText && m.quotedText.toLowerCase().includes(q))
    )
    .slice(-limit)
    .reverse();
}

export function getGroupsSummary() {
  return Object.values(groupStore)
    .map((g) => ({
      groupId: g.groupId,
      groupName: g.groupName || g.groupId,
      messageCount: g.messages?.length || 0,
      updatedAt: g.updatedAt || 0,
      lastMessage: g.messages?.length ? g.messages[g.messages.length - 1] : null
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearGroupMessages(groupId) {
  if (groupId && groupStore[groupId]) {
    groupStore[groupId].messages = [];
    scheduleSave();
    return true;
  }
  return false;
}

export function getTotalMessagesCount() {
  return Object.values(groupStore).reduce((acc, g) => acc + (g.messages?.length || 0), 0);
}

loadChatStore();

