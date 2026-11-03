import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadMediaMessage,
  Browsers
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { getConfig } from './config.js';
import {
  addGroupMessage,
  upsertGroupMetadata,
  getTotalMessagesCount,
  getGroupsSummary
} from './chatStore.js';
import {
  addSavedNote,
  deleteSavedNoteByQuery,
  findSavedFileNoteToSend,
  getAllSavedNotes,
  formatNotesListText,
  parseNoteCommand,
  SAVED_DOCS_DIR
} from './notesStore.js';
import {
  uploadBufferToGoogleDrive,
  downloadBufferFromGoogleDrive,
  MAX_FILE_SIZE_BYTES
} from './driveService.js';
import {
  createWhatsAppSticker,
  parseStickerCommand
} from './stickerService.js';
import { generateGroupAIReply } from './aiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = path.join(__dirname, '..', 'data', 'auth_info');

export const botEvents = new EventEmitter();

let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr' | 'connected'
let qrDataUrl = null;
let qrRaw = null;
let botInfo = {
  phoneNumber: null,
  jid: null,
  lid: null,
  name: null
};
let reconnectTimer = null;
let isStarting = false;

// Caches for readable names
const groupNamesCache = new Map();
const contactNamesCache = new Map();
const activityLogs = [];
const processedMsgIds = new Set();

export function addActivityLog(type, title, detail = '') {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }),
    timestamp: Date.now(),
    type, // 'info' | 'mention' | 'reply' | 'error' | 'message' | 'save'
    title,
    detail
  };
  activityLogs.unshift(item);
  if (activityLogs.length > 100) {
    activityLogs.pop();
  }
  botEvents.emit('activity', item);
  return item;
}

export function getBotState() {
  return {
    status: connectionStatus,
    qrDataUrl,
    botInfo,
    totalMessages: getTotalMessagesCount(),
    savedNotesCount: getAllSavedNotes().length,
    groupsCount: getGroupsSummary().length,
    logs: activityLogs.slice(0, 50)
  };
}

export function emitStatusUpdate() {
  botEvents.emit('status', getBotState());
}

/**
 * Unwraps ephemeral (disappearing), viewOnce, or edited message wrappers
 */
function unwrapMessageContent(msgContent) {
  if (!msgContent) return null;
  if (msgContent.ephemeralMessage?.message) {
    return unwrapMessageContent(msgContent.ephemeralMessage.message);
  }
  if (msgContent.viewOnceMessage?.message) {
    return unwrapMessageContent(msgContent.viewOnceMessage.message);
  }
  if (msgContent.viewOnceMessageV2?.message) {
    return unwrapMessageContent(msgContent.viewOnceMessageV2.message);
  }
  if (msgContent.viewOnceMessageV2Extension?.message) {
    return unwrapMessageContent(msgContent.viewOnceMessageV2Extension.message);
  }
  if (msgContent.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(msgContent.documentWithCaptionMessage.message);
  }
  if (msgContent.editedMessage?.message?.protocolMessage?.editedMessage) {
    return unwrapMessageContent(msgContent.editedMessage.message.protocolMessage.editedMessage);
  }
  return msgContent;
}

/**
 * Extracts text, contextInfo, and media descriptor from an unwrapped Baileys message object
 */
function extractTextAndContext(rawMsgContent) {
  const m = unwrapMessageContent(rawMsgContent);
  if (!m) return { text: '', contextInfo: null, mediaInfo: null, unwrapped: null };

  const docMsg = m.documentMessage;
  const imgMsg = m.imageMessage;

  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    imgMsg?.caption ||
    m.videoMessage?.caption ||
    docMsg?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    '';

  if (!text && docMsg?.fileName) {
    text = `[Dokumen: ${docMsg.fileName}]`;
  }

  const contextInfo =
    m.extendedTextMessage?.contextInfo ||
    imgMsg?.contextInfo ||
    m.videoMessage?.contextInfo ||
    docMsg?.contextInfo ||
    null;

  let mediaInfo = null;
  if (docMsg) {
    mediaInfo = {
      mediaType: 'document',
      originalName: docMsg.fileName || `dokumen-${Date.now()}.bin`,
      mimeType: docMsg.mimetype || 'application/octet-stream',
      fileLength: Number(docMsg.fileLength || 0)
    };
  } else if (imgMsg) {
    const ext = (imgMsg.mimetype || 'image/jpeg').split('/')[1]?.split(';')[0] || 'jpg';
    mediaInfo = {
      mediaType: 'image',
      originalName: `foto-${Date.now()}.${ext}`,
      mimeType: imgMsg.mimetype || 'image/jpeg',
      fileLength: Number(imgMsg.fileLength || 0)
    };
  }

  return { text: text.trim(), contextInfo, mediaInfo, unwrapped: m };
}

async function downloadRawMediaBuffer(messageWrapper) {
  if (!messageWrapper) return null;
  const buffer = await downloadMediaMessage(
    messageWrapper,
    'buffer',
    {},
    {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock?.updateMediaMessage
    }
  );
  return buffer || null;
}

/**
 * Downloads media from WhatsApp, uploads to Google Drive if configured (and deletes local temporary buffer),
 * or stores in local data/saved_docs/ if Google Drive is not configured.
 */
async function downloadAndSaveMedia(messageWrapper, mediaInfo) {
  if (!messageWrapper || !mediaInfo) return null;

  if (mediaInfo.fileLength && mediaInfo.fileLength > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Ukuran file terlalu besar (${(mediaInfo.fileLength / (1024 * 1024)).toFixed(
        1
      )} MB). Bot hanya menyimpan file ringan maksimal 15 MB.`
    );
  }

  const buffer = await downloadRawMediaBuffer(messageWrapper);
  if (!buffer) return null;

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Ukuran file (${(buffer.length / (1024 * 1024)).toFixed(
        1
      )} MB) melebihi batas maksimal 15 MB.`
    );
  }

  const config = getConfig();
  const safeOriginal = String(mediaInfo.originalName || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-80);
  const tempFileName = `${Date.now()}-${safeOriginal}`;
  const tempFilePath = path.join(SAVED_DOCS_DIR, tempFileName);

  // Save temporarily on disk first
  fs.writeFileSync(tempFilePath, buffer);

  // If Google Drive is enabled & Script URL is configured, upload to Google Drive and delete local temp file!
  if (config.googleDriveEnabled !== false && (config.googleDriveScriptUrl || '').trim()) {
    try {
      const driveResult = await uploadBufferToGoogleDrive({
        buffer,
        fileName: mediaInfo.originalName || tempFileName,
        mimeType: mediaInfo.mimeType
      });

      if (driveResult?.driveFileId) {
        // Delete temporary local file immediately after uploading to Google Drive
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {
          // Ignore unlink error
        }

        return {
          mediaType: mediaInfo.mediaType || 'document',
          originalName: mediaInfo.originalName || tempFileName,
          mimeType: mediaInfo.mimeType,
          sizeBytes: buffer.length,
          storage: 'gdrive',
          driveFileId: driveResult.driveFileId,
          driveViewUrl: driveResult.driveViewUrl,
          driveDownloadUrl: driveResult.driveDownloadUrl,
          savedFileName: null
        };
      }
    } catch (err) {
      console.error('[WABot] Gagal upload ke Google Drive, menyimpan di lokal sebagai cadangan:', err.message);
      addActivityLog('error', 'Upload Google Drive Gagal (Disimpan Lokal)', err.message);
    }
  }

  return {
    mediaType: mediaInfo.mediaType || 'document',
    originalName: mediaInfo.originalName || tempFileName,
    mimeType: mediaInfo.mimeType,
    sizeBytes: buffer.length,
    storage: 'local',
    savedFileName: tempFileName
  };
}

function getIdNumber(jid) {
  if (!jid) return '';
  const norm = jidNormalizedUser(jid);
  return norm.split('@')[0].split(':')[0];
}

function resolveSenderName(jid, pushName) {
  if (pushName && pushName.trim()) {
    if (jid) contactNamesCache.set(jidNormalizedUser(jid), pushName.trim());
    return pushName.trim();
  }
  if (!jid) return 'Anggota';
  const norm = jidNormalizedUser(jid);
  if (contactNamesCache.has(norm)) {
    return contactNamesCache.get(norm);
  }
  const num = getIdNumber(norm);
  return num ? `+${num}` : 'Anggota';
}

async function resolveGroupName(groupId) {
  if (!groupId || !groupId.endsWith('@g.us')) return groupId;
  if (groupNamesCache.has(groupId)) {
    return groupNamesCache.get(groupId);
  }
  if (sock) {
    try {
      const meta = await sock.groupMetadata(groupId);
      if (meta?.subject) {
        groupNamesCache.set(groupId, meta.subject);
        upsertGroupMetadata(groupId, meta.subject);
        return meta.subject;
      }
    } catch {
      // Ignore metadata fetch error
    }
  }
  return groupId;
}

/**
 * Checks if the message mentions or triggers the bot, and returns the cleaned question
 */
function checkBotTrigger(text, contextInfo) {
  const config = getConfig();
  const botPhoneNum = getIdNumber(botInfo.jid);
  const botLidNum = getIdNumber(botInfo.lid);

  const mentionedJids = contextInfo?.mentionedJid || [];
  const normalizedMentions = mentionedJids.map((j) => getIdNumber(j)).filter(Boolean);

  // 1. Check @mention in mentionedJid array or @number in text
  let isMentioned = false;
  if (config.replyOnMention !== false) {
    if (botPhoneNum && (normalizedMentions.includes(botPhoneNum) || text.includes(`@${botPhoneNum}`))) {
      isMentioned = true;
    }
    if (botLidNum && (normalizedMentions.includes(botLidNum) || text.includes(`@${botLidNum}`))) {
      isMentioned = true;
    }
  }

  // 2. Check if user replied/quoted the bot's own message
  let isQuotingBot = false;
  if (config.replyOnQuoteBot !== false && contextInfo?.participant) {
    const quotedAuthorNum = getIdNumber(contextInfo.participant);
    if (
      (botPhoneNum && quotedAuthorNum === botPhoneNum) ||
      (botLidNum && quotedAuthorNum === botLidNum)
    ) {
      isQuotingBot = true;
    }
  }

  // 3. Check custom prefixes (e.g. @bot, !ai, /ai)
  let matchedPrefix = null;
  const prefixes = Array.isArray(config.customPrefixes) ? config.customPrefixes : ['@bot', '!ai', '/ai'];
  const lowerText = text.toLowerCase();
  for (const p of prefixes) {
    const cleanP = (p || '').trim().toLowerCase();
    if (!cleanP) continue;
    if (
      lowerText === cleanP ||
      lowerText.startsWith(`${cleanP} `) ||
      lowerText.startsWith(`${cleanP}\n`) ||
      lowerText.startsWith(`${cleanP}:`) ||
      lowerText.startsWith(`${cleanP},`)
    ) {
      matchedPrefix = cleanP;
      break;
    }
  }

  // 4. Also allow direct "stiker" / ".stiker" / "!stiker" command when sending or replying to a photo!
  const isDirectStickerCmd = /^(?:[.!/])?(?:stik?ker|sticker)\b/i.test(text.trim());

  const triggered = isMentioned || isQuotingBot || Boolean(matchedPrefix) || isDirectStickerCmd;
  if (!triggered) {
    return { triggered: false, cleanQuestion: '' };
  }

  // Strip @botPhoneNum, @botLidNum, and custom prefix from the question text
  let cleaned = text;
  if (botPhoneNum) {
    cleaned = cleaned.replace(new RegExp(`@${botPhoneNum}\\b`, 'gi'), '');
  }
  if (botLidNum) {
    cleaned = cleaned.replace(new RegExp(`@${botLidNum}\\b`, 'gi'), '');
  }
  if (matchedPrefix) {
    const escaped = matchedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`^${escaped}[\\s:,]*`, 'i'), '');
  }
  cleaned = cleaned.replace(/^[.!/](?=stik?ker|sticker\b)/i, '').trim();

  return {
    triggered: true,
    cleanQuestion: cleaned,
    triggerType: isMentioned
      ? 'mention'
      : isQuotingBot
      ? 'reply'
      : matchedPrefix
      ? 'prefix'
      : 'sticker'
  };
}

export async function startWhatsAppBot() {
  if (isStarting) return;
  isStarting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    connectionStatus = 'connecting';
    emitStatusUpdate();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version = [2, 3000, 1023223821];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) {
        version = latest.version;
      }
    } catch {
      // Fallback to default version
    }

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrRaw = qr;
        connectionStatus = 'qr';
        try {
          qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
        } catch (err) {
          console.error('[WABot] Gagal generate QR Data URL:', err.message);
        }
        addActivityLog('info', 'QR Code Baru Tersedia', 'Silakan scan QR Code di Web Dashboard menggunakan WhatsApp Anda.');
        emitStatusUpdate();
      }

      if (connection === 'open') {
        qrDataUrl = null;
        qrRaw = null;
        connectionStatus = 'connected';

        const rawId = sock.user?.id || '';
        const rawLid = sock.user?.lid || '';
        const normJid = rawId ? jidNormalizedUser(rawId) : null;
        const normLid = rawLid ? jidNormalizedUser(rawLid) : null;

        botInfo = {
          jid: normJid,
          lid: normLid,
          phoneNumber: getIdNumber(normJid),
          name: sock.user?.name || sock.user?.verifiedName || 'Bot WhatsApp'
        };

        addActivityLog(
          'info',
          'WhatsApp Terhubung!',
          `Nomor Bot: +${botInfo.phoneNumber} (${botInfo.name})`
        );
        emitStatusUpdate();

        try {
          const groups = await sock.groupFetchAllParticipating();
          for (const [gId, meta] of Object.entries(groups)) {
            if (meta?.subject) {
              groupNamesCache.set(gId, meta.subject);
              upsertGroupMetadata(gId, meta.subject);
            }
          }
          emitStatusUpdate();
        } catch (err) {
          console.error('[WABot] Gagal memuat daftar grup awal:', err.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        qrDataUrl = null;
        qrRaw = null;
        connectionStatus = 'disconnected';
        emitStatusUpdate();

        if (statusCode === DisconnectReason.loggedOut) {
          addActivityLog('error', 'Sesi WhatsApp Logout', 'Sesi telah keluar. Menghapus sesi lama & menyiapkan QR baru...');
          await logoutWhatsAppBot(true);
        } else if (shouldReconnect) {
          addActivityLog('info', 'Koneksi Terputus Sementara', `Mencoba menghubungkan ulang dalam 4 detik... (Kode: ${statusCode || 'unknown'})`);
          reconnectTimer = setTimeout(() => {
            startWhatsAppBot();
          }, 4000);
        }
      }
    });

    // Sync historical group messages when WhatsApp connects
    sock.ev.on('messaging-history.set', async ({ messages, contacts, chats }) => {
      if (Array.isArray(chats)) {
        for (const c of chats) {
          if (c.id?.endsWith('@g.us') && c.name) {
            groupNamesCache.set(c.id, c.name);
            upsertGroupMetadata(c.id, c.name);
          }
        }
      }
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          const name = c.notify || c.name || c.verifiedName;
          if (c.id && name) {
            contactNamesCache.set(jidNormalizedUser(c.id), name);
          }
        }
      }
      if (Array.isArray(messages)) {
        let importedCount = 0;
        for (const msg of messages) {
          const remoteJid = msg.key?.remoteJid;
          if (!remoteJid || !remoteJid.endsWith('@g.us')) continue;
          const { text, contextInfo } = extractTextAndContext(msg.message);
          if (!text) continue;

          const senderJid = msg.key?.participant || msg.participant || '';
          const senderName = resolveSenderName(senderJid, msg.pushName);
          const groupName = groupNamesCache.get(remoteJid) || remoteJid;
          const { text: quotedText } = extractTextAndContext(contextInfo?.quotedMessage);
          const quotedSender = contextInfo?.participant
            ? resolveSenderName(contextInfo.participant, null)
            : '';

          const added = addGroupMessage({
            id: msg.key?.id,
            groupId: remoteJid,
            groupName,
            senderJid,
            senderName,
            text,
            quotedText,
            quotedSender,
            timestamp: Number(msg.messageTimestamp) || Date.now(),
            isBot: Boolean(msg.key?.fromMe)
          });
          if (added) importedCount++;
        }
        if (importedCount > 0) {
          addActivityLog('info', 'Sinkronisasi Riwayat Grup', `Berhasil menyimpan ${importedCount} pesan riwayat grup dari WhatsApp.`);
          emitStatusUpdate();
        }
      }
    });

    // Listen to incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (!Array.isArray(messages)) return;

      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const remoteJid = msg.key?.remoteJid;
          if (!remoteJid || remoteJid === 'status@broadcast') continue;

          const msgId = msg.key?.id;
          if (msgId && processedMsgIds.has(msgId)) continue;
          if (msgId) {
            processedMsgIds.add(msgId);
            if (processedMsgIds.size > 2000) {
              const first = processedMsgIds.values().next().value;
              processedMsgIds.delete(first);
            }
          }

          const isGroup = remoteJid.endsWith('@g.us');
          const { text, contextInfo, mediaInfo } = extractTextAndContext(msg.message);
          if (!text && !mediaInfo) continue;

          const senderJid = isGroup
            ? msg.key?.participant || msg.participant || ''
            : remoteJid;
          const senderName = resolveSenderName(senderJid, msg.pushName);

          let groupName = remoteJid;
          if (isGroup) {
            groupName = await resolveGroupName(remoteJid);
          }

          const {
            text: quotedText,
            mediaInfo: quotedMediaInfo,
            unwrapped: quotedUnwrapped
          } = extractTextAndContext(contextInfo?.quotedMessage);
          const quotedSender = contextInfo?.participant
            ? resolveSenderName(contextInfo.participant, null)
            : '';

          // 1. Always store group messages into temporary chatStore
          if (isGroup && text) {
            addGroupMessage({
              id: msgId,
              groupId: remoteJid,
              groupName,
              senderJid,
              senderName,
              text,
              quotedText,
              quotedSender,
              timestamp: Number(msg.messageTimestamp) || Date.now(),
              isBot: Boolean(msg.key?.fromMe)
            });
            emitStatusUpdate();
          }

          // Only respond to live incoming messages ('notify') and ignore bot's own messages
          if (type !== 'notify' || msg.key?.fromMe) continue;

          const config = getConfig();

          if (!isGroup && !config.allowPrivateChat) continue;
          if (
            isGroup &&
            Array.isArray(config.allowedGroups) &&
            config.allowedGroups.length > 0 &&
            !config.allowedGroups.includes(remoteJid)
          ) {
            continue;
          }

          const triggerCheck = isGroup
            ? checkBotTrigger(text, contextInfo)
            : { triggered: true, cleanQuestion: text, triggerType: 'private' };

          if (!triggerCheck.triggered) continue;

          const question = triggerCheck.cleanQuestion;
          addActivityLog(
            'mention',
            `Pesan dari ${senderName} di "${groupName}"`,
            question || '(Lampiran / Tanpa teks)'
          );

          try {
            await sock.sendPresenceUpdate('composing', remoteJid);
          } catch {
            // Ignore presence error
          }

          // ==========================================================
          // A. CHECK STICKER COMMAND ("stiker", "stiker <kata-kata>")
          // ==========================================================
          const hasImageMedia =
            mediaInfo?.mediaType === 'image' || quotedMediaInfo?.mediaType === 'image';
          const stickerCmd = parseStickerCommand(question, hasImageMedia);

          if (stickerCmd.isSticker) {
            try {
              let imgBuf = null;
              if (mediaInfo?.mediaType === 'image') {
                imgBuf = await downloadRawMediaBuffer(msg);
              } else if (quotedMediaInfo?.mediaType === 'image' && quotedUnwrapped) {
                const fakeQuotedMsg = {
                  key: {
                    remoteJid,
                    id: contextInfo?.stanzaId || `quoted-${Date.now()}`,
                    participant: contextInfo?.participant
                  },
                  message: quotedUnwrapped
                };
                imgBuf = await downloadRawMediaBuffer(fakeQuotedMsg);
              }

              const stickerBuffer = await createWhatsAppSticker({
                imageBuffer: imgBuf,
                text: stickerCmd.stickerText,
                packName: `${config.botName || 'NANBOT'} Sticker`,
                author: 'Bos Nandar'
              });

              await sock.sendMessage(
                remoteJid,
                { sticker: stickerBuffer },
                { quoted: msg }
              );

              addActivityLog(
                'reply',
                `✨ Stiker Dibuat untuk ${senderName} (${groupName})`,
                imgBuf
                  ? stickerCmd.stickerText
                    ? `Foto + Teks: "${stickerCmd.stickerText}"`
                    : 'Foto -> Stiker'
                  : `Stiker Kata-Kata: "${stickerCmd.stickerText}"`
              );
              emitStatusUpdate();
              continue;
            } catch (stickerErr) {
              await sock.sendMessage(
                remoteJid,
                { text: `⚠️ Maaf, gagal membuat stiker: ${stickerErr.message}` },
                { quoted: msg }
              );
              continue;
            }
          }

          // ==========================================================
          // B. CHECK PERMANENT NOTE / FILE COMMANDS (LIST / SAVE / DELETE)
          // ==========================================================
          const hasAnyMedia = Boolean(mediaInfo || quotedMediaInfo);
          const noteCmd = parseNoteCommand(question, quotedText, hasAnyMedia);
          let noteActionInfo = '';

          if (noteCmd.action === 'list') {
            const listReply = `Halo ${senderName}! Saya ${config.botName || 'Nanbot'} siap membantu.\n\n${formatNotesListText(
              isGroup ? remoteJid : 'global'
            )}`;
            const sentListMsg = await sock.sendMessage(
              remoteJid,
              { text: listReply },
              { quoted: msg }
            );
            if (isGroup) {
              addGroupMessage({
                id: sentListMsg?.key?.id,
                groupId: remoteJid,
                groupName,
                senderJid: botInfo.jid || 'bot',
                senderName: `${config.botName || 'Bot AI'}`,
                text: listReply,
                quotedText: question,
                quotedSender: senderName,
                timestamp: Date.now(),
                isBot: true
              });
            }
            addActivityLog('reply', `Menampilkan List Catatan (${groupName})`, `Diminta oleh ${senderName}`);
            emitStatusUpdate();
            continue;
          } else if (noteCmd.action === 'save') {
            let savedFileInfo = null;
            if (mediaInfo) {
              savedFileInfo = await downloadAndSaveMedia(msg, mediaInfo);
            } else if (quotedMediaInfo && quotedUnwrapped) {
              const fakeQuotedMsg = {
                key: {
                  remoteJid,
                  id: contextInfo?.stanzaId || `quoted-${Date.now()}`,
                  participant: contextInfo?.participant
                },
                message: quotedUnwrapped
              };
              savedFileInfo = await downloadAndSaveMedia(fakeQuotedMsg, quotedMediaInfo);
            }

            const savedNote = addSavedNote({
              groupId: isGroup ? remoteJid : 'global',
              groupName: isGroup ? groupName : 'Chat Pribadi',
              content: noteCmd.contentToSave,
              savedBy: senderName,
              originalSender: quotedText ? quotedSender || senderName : senderName,
              fileInfo: savedFileInfo
            });

            const storageLoc = savedFileInfo
              ? savedFileInfo.driveFileId
                ? `Google Drive (File lokal sementara sudah dihapus otomatis)`
                : `Server Lokal`
              : '';

            noteActionInfo = `BERHASIL DISIMPAN PERMANEN:
- ID Catatan: #${savedNote.id}
- Kategori: ${savedNote.category.toUpperCase()}
- Judul: ${savedNote.title}
- Isi yang disimpan: "${savedNote.content}"
${savedFileInfo ? `- File Tersimpan: "${savedFileInfo.originalName}" di ${storageLoc}` : ''}`;

            addActivityLog(
              'save',
              `📌 Item Permanen #${savedNote.id} Disimpan (${groupName})`,
              `${savedNote.title} — oleh ${senderName}`
            );
            emitStatusUpdate();
          } else if (noteCmd.action === 'delete') {
            const deletedNote = await deleteSavedNoteByQuery(
              isGroup ? remoteJid : 'global',
              noteCmd.targetQuery,
              quotedText
            );
            if (deletedNote) {
              noteActionInfo = `BERHASIL DIHAPUS DARI PENYIMPANAN PERMANEN${
                deletedNote.fileInfo?.driveFileId ? ' & GOOGLE DRIVE' : ''
              }:
- ID Catatan yang dihapus: #${deletedNote.id}
- Judul: ${deletedNote.title}
- Isi: "${deletedNote.content}"`;
              addActivityLog(
                'info',
                `🗑️ Item Permanen #${deletedNote.id} Dihapus (${groupName})`,
                `Dihapus oleh ${senderName}: ${deletedNote.title}`
              );
              emitStatusUpdate();
            } else {
              noteActionInfo = `GAGAL MENGHAPUS: Tidak ditemukan catatan/file permanen yang cocok dengan perintah "${noteCmd.targetQuery}". Sebutkan daftar catatan yang ada saat ini agar pengguna bisa memilih ID # yang ingin dihapus.`;
            }
          }

          // ==========================================================
          // C. GENERATE AI REPLY (WITH WEATHER, WEB INFO, SAVED NOTES & CHAT HISTORY)
          // ==========================================================
          const aiReply = await generateGroupAIReply({
            groupId: isGroup ? remoteJid : null,
            groupName,
            senderName,
            question,
            quotedText,
            quotedSender,
            noteActionInfo,
            onFallbackLog: (fallbackMsg) => {
              addActivityLog('info', '🔄 Auto-Fallback Model AI', fallbackMsg);
            }
          });

          const sentMsg = await sock.sendMessage(
            remoteJid,
            { text: aiReply },
            { quoted: msg }
          );

          // ==========================================================
          // D. SEND SAVED FILE (.docx, .xlsx, .pdf, Photo) BACK IF REQUESTED
          // ==========================================================
          const isRequestingSavedFile =
            noteCmd.action === 'none' &&
            /\b(kirim|kirimin|kirimkan|send|unduh|download|minta|ambil|ambilkan|mana|lihat)\b.*\b(dokumen|file|berkas|pdf|docx|word|excel|xlsx|xls|csv|foto|gambar|lampiran|#\d+)\b/i.test(
              question
            );

          if (isRequestingSavedFile) {
            const targetNote = findSavedFileNoteToSend(isGroup ? remoteJid : 'global', question);
            if (targetNote && targetNote.fileInfo) {
              try {
                let fileBuffer = null;
                if (targetNote.fileInfo.driveFileId) {
                  fileBuffer = await downloadBufferFromGoogleDrive(targetNote.fileInfo.driveFileId);
                } else if (targetNote.fileInfo.savedFileName) {
                  const localPath = path.join(SAVED_DOCS_DIR, targetNote.fileInfo.savedFileName);
                  if (fs.existsSync(localPath)) {
                    fileBuffer = fs.readFileSync(localPath);
                  }
                }

                if (fileBuffer) {
                  const isImg =
                    targetNote.fileInfo.mediaType === 'image' ||
                    (targetNote.fileInfo.mimeType || '').startsWith('image/');
                  const captionText = `📎 *#${targetNote.id} — ${targetNote.title}*\nDisimpan oleh: ${targetNote.savedBy}`;

                  if (isImg) {
                    await sock.sendMessage(
                      remoteJid,
                      {
                        image: fileBuffer,
                        caption: captionText
                      },
                      { quoted: msg }
                    );
                  } else {
                    await sock.sendMessage(
                      remoteJid,
                      {
                        document: fileBuffer,
                        mimetype: targetNote.fileInfo.mimeType || 'application/octet-stream',
                        fileName: targetNote.fileInfo.originalName || 'dokumen',
                        caption: captionText
                      },
                      { quoted: msg }
                    );
                  }
                  addActivityLog(
                    'reply',
                    `📤 Mengirim Ulang File #${targetNote.id} (${groupName})`,
                    targetNote.fileInfo.originalName
                  );
                }
              } catch (sendFileErr) {
                console.error('[WABot] Gagal mengirim ulang file tersimpan:', sendFileErr.message);
              }
            }
          }

          // Store the bot's reply in the temporary group chat history too
          if (isGroup) {
            addGroupMessage({
              id: sentMsg?.key?.id,
              groupId: remoteJid,
              groupName,
              senderJid: botInfo.jid || 'bot',
              senderName: `${config.botName || 'Bot AI'}`,
              text: aiReply,
              quotedText: question,
              quotedSender: senderName,
              timestamp: Date.now(),
              isBot: true
            });
          }

          addActivityLog(
            'reply',
            `Bot Menjawab ke ${senderName} (${groupName})`,
            aiReply.slice(0, 180) + (aiReply.length > 180 ? '...' : '')
          );
          emitStatusUpdate();
        } catch (err) {
          console.error('[WABot] Error memproses pesan:', err);
          addActivityLog('error', 'Gagal Memproses Pesan AI', err.message || String(err));
        }
      }
    });
  } catch (err) {
    console.error('[WABot] Gagal menjalankan WhatsApp Bot:', err);
    addActivityLog('error', 'Error Inisialisasi Bot', err.message);
  } finally {
    isStarting = false;
  }
}

export async function requestPairingCodeForNumber(phoneInput) {
  if (!sock) {
    throw new Error('Socket WhatsApp belum siap. Tunggu beberapa detik lalu coba lagi.');
  }
  if (connectionStatus === 'connected') {
    throw new Error('WhatsApp sudah terhubung.');
  }
  let cleaned = String(phoneInput || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('08')) {
    cleaned = '62' + cleaned.slice(1);
  }
  if (cleaned.length < 9) {
    throw new Error('Nomor WhatsApp tidak valid. Gunakan format 628xxxxxxxxxx.');
  }
  const code = await sock.requestPairingCode(cleaned);
  addActivityLog('info', 'Pairing Code Dibuat', `Nomor: +${cleaned} | Kode: ${code}`);
  return code;
}

export async function logoutWhatsAppBot(autoRestart = true) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock.end(undefined);
      sock = null;
    }
  } catch {
    // Ignore logout errors
  }

  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('[WABot] Gagal menghapus folder auth_info:', err.message);
  }

  connectionStatus = 'disconnected';
  qrDataUrl = null;
  qrRaw = null;
  botInfo = { phoneNumber: null, jid: null, lid: null, name: null };
  emitStatusUpdate();

  if (autoRestart) {
    setTimeout(() => {
      startWhatsAppBot();
    }, 1500);
  }
}
