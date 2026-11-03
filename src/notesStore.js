import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatTimestamp } from './chatStore.js';
import { deleteFileFromGoogleDrive } from './driveService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const NOTES_FILE = path.join(DATA_DIR, 'saved_notes.json');
export const SAVED_DOCS_DIR = path.join(DATA_DIR, 'saved_docs');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(SAVED_DOCS_DIR)) {
  fs.mkdirSync(SAVED_DOCS_DIR, { recursive: true });
}

// Structure: { nextId: 1, notes: [ { id, groupId, groupName, title, content, category, savedBy, originalSender, createdAt, formattedTime, fileInfo } ] }
let notesData = {
  nextId: 1,
  notes: []
};

/**
 * Strips bot greeting or command prefixes from a note title/content so titles look realistic
 * e.g. "🖼️ Foto: tolong bantu save file ini judulnya jadwal dinas Nandar" -> "jadwal dinas Nandar"
 */
export function cleanRealisticNoteTitle(rawText = '', fileInfo = null) {
  let s = String(rawText || '').trim();

  // Remove old emoji prefixes if present
  s = s.replace(/^(?:📌\s*Catatan|🖼️\s*Foto|📅\s*Jadwal|📄\s*File|📄\s*Dokumen)\s*:\s*/i, '').trim();

  // Remove bot greeting if user accidentally quoted a bot message
  s = s
    .replace(/^Halo[^!\n]*!\s*Saya\s+[a-zA-Z0-9_-]+\s+siap\s+membantu\.?\s*/i, '')
    .replace(/^Saya\s+[a-zA-Z0-9_-]+\s+siap\s+membantu\.?\s*/i, '')
    .trim();

  // 1. If text explicitly contains "judulnya ...", "kasih judul ...", "namanya ...", "kasih nama ...", "dengan judul ..."
  const explicitTitleMatch = s.match(
    /\b(?:judul(?:nya)?|nama(?:nya)?|kasih\s+(?:judul|nama)|beri\s+(?:judul|nama)|dengan\s+(?:judul|nama))\s*[:=-]?\s*([^\n]+)$/i
  );
  if (explicitTitleMatch && explicitTitleMatch[1]) {
    const extracted = explicitTitleMatch[1]
      .replace(/[\s.!?]+$/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (extracted.length >= 2) {
      return extracted;
    }
  }

  // 2. Otherwise strip leading save command phrases ("tolong bantu save file ini", "savekan catatan", etc.)
  s = s
    .replace(
      /^(?:halo\s+|hai\s+|ai\s+|@?bot\s+|nanbot\s+)*(?:tolong\s+|bantu\s+|coba\s+|minta\s+)*(?:bantu\s+|tolong\s+)*(?:save\s*kan|save|simpan\s*kan|simpan|catat\s*kan|catat|masukkan\s+ke\s+catatan)\s*(?:file\s+ini|foto\s+ini|gambar\s+ini|dokumen\s+ini|berkas\s+ini|jadwal\s+ini|catatan\s+ini|chat\s+ini|pesan\s+ini|file|foto|gambar|dokumen|berkas|catatan|ini)?\s*(?:ya|dong|deh|nih|bot)?[\s:,-]*/i,
      ''
    )
    .replace(
      /^(?:judul(?:nya)?|nama(?:nya)?|kasih\s+(?:judul|nama)|beri\s+(?:judul|nama)|dengan\s+(?:judul|nama))\s*[:=-]?\s*/i,
      ''
    )
    .replace(
      /\s*(?:nanti\s+(?:kalo|kalau)?\s*(?:saya|aku|kita)\s+(?:butuh|tanya|perlu|minta|panggil).*)$/i,
      ''
    )
    .trim();

  let firstLine = s.split('\n')[0].trim();
  firstLine = firstLine.replace(/^["']|["']$/g, '').trim();

  if (
    (!firstLine ||
      firstLine.startsWith('[Dokumen:') ||
      firstLine.startsWith('(Lampiran')) &&
    fileInfo?.originalName
  ) {
    firstLine = fileInfo.originalName.replace(/\.[^.]+$/, '');
  }

  if (firstLine.length > 60) {
    firstLine = firstLine.slice(0, 57).trim() + '...';
  }

  return firstLine || 'Catatan Penting';
}

function inferCategoryAndTitle(text, fileInfo, explicitTitle = '') {
  const combinedLower = `${explicitTitle || ''} ${text || ''}`.toLowerCase();
  let category = 'catatan';
  if (fileInfo) {
    category = fileInfo.mediaType === 'image' ? 'foto' : 'dokumen';
  } else if (
    /(jadwal|agenda|meeting|rapat|dinas|shift|jam\s+\d|senin|selasa|rabu|kamis|jumat|sabtu|minggu|tanggal)/i.test(
      combinedLower
    )
  ) {
    category = 'jadwal';
  }

  const title = cleanRealisticNoteTitle(explicitTitle || text, fileInfo);
  return { category, title };
}

export function loadNotesStore() {
  try {
    if (fs.existsSync(NOTES_FILE)) {
      const raw = fs.readFileSync(NOTES_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.notes)) {
        let modified = false;
        const cleanedNotes = parsed.notes.map((n) => {
          const cleanedTitle = cleanRealisticNoteTitle(n.title, n.fileInfo);
          const cleanedContent = cleanRealisticNoteTitle(n.content, n.fileInfo);
          if (cleanedTitle !== n.title) {
            modified = true;
            return {
              ...n,
              title: cleanedTitle,
              content:
                n.content && n.content.toLowerCase().includes('tolong')
                  ? cleanedContent
                  : n.content
            };
          }
          return n;
        });

        notesData = {
          nextId:
            Number(parsed.nextId) ||
            cleanedNotes.reduce((max, n) => Math.max(max, Number(n.id) || 0), 0) + 1,
          notes: cleanedNotes
        };
        if (modified) {
          saveNotesStore();
        }
      }
    } else {
      saveNotesStore();
    }
  } catch (err) {
    console.error('[NotesStore] Gagal memuat saved_notes.json:', err.message);
  }
  return notesData;
}

export function saveNotesStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf-8');
  } catch (err) {
    console.error('[NotesStore] Gagal menyimpan saved_notes.json:', err.message);
  }
}

export function addSavedNote({
  groupId = 'global',
  groupName = 'Semua Grup',
  title = '',
  content = '',
  category = '',
  savedBy = 'Anggota',
  originalSender = '',
  fileInfo = null
}) {
  const now = Date.now();
  const inferred = inferCategoryAndTitle(content, fileInfo, title);

  const note = {
    id: notesData.nextId++,
    groupId: groupId || 'global',
    groupName: groupName || groupId || 'Grup',
    title: inferred.title,
    content: (content || inferred.title).trim(),
    category: category || inferred.category,
    savedBy: savedBy || 'Anggota',
    originalSender: originalSender || savedBy || 'Anggota',
    createdAt: now,
    formattedTime: formatTimestamp(now),
    fileInfo: fileInfo || null
  };

  notesData.notes.unshift(note);
  saveNotesStore();
  return note;
}

export function getSavedNotesForGroup(groupId) {
  if (!groupId) {
    return notesData.notes;
  }
  return notesData.notes.filter((n) => n.groupId === groupId || n.groupId === 'global');
}

export function getAllSavedNotes(groupIdFilter = '') {
  if (!groupIdFilter) return notesData.notes;
  return notesData.notes.filter((n) => n.groupId === groupIdFilter);
}

export async function deleteSavedNoteById(id) {
  const numId = Number(id);
  const idx = notesData.notes.findIndex((n) => Number(n.id) === numId);
  if (idx === -1) return null;

  const [removed] = notesData.notes.splice(idx, 1);

  // 1. Delete from Google Drive if stored there
  if (removed?.fileInfo?.driveFileId) {
    await deleteFileFromGoogleDrive(removed.fileInfo.driveFileId).catch(() => {});
  }

  // 2. Delete from local folder if stored locally
  if (removed?.fileInfo?.savedFileName) {
    const fullPath = path.join(SAVED_DOCS_DIR, removed.fileInfo.savedFileName);
    try {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch {
      // Ignore file deletion error
    }
  }
  saveNotesStore();
  return removed;
}

export async function deleteSavedNoteByQuery(groupId, queryText = '', quotedText = '') {
  const groupNotes = getSavedNotesForGroup(groupId);
  if (groupNotes.length === 0) return null;

  const combinedSearch = `${queryText || ''} ${quotedText || ''}`;

  // 1. Check if user specified #ID or nomor ID in queryText or in the quoted message
  const idMatch =
    String(queryText || '').match(/(?:#|no(?:mor)?\s*|id\s*)(\d+)/i) ||
    String(queryText || '').match(/\b(\d+)\b/) ||
    String(quotedText || '').match(/#(\d+)/);

  if (idMatch) {
    const candidateId = Number(idMatch[1]);
    const found = groupNotes.find((n) => Number(n.id) === candidateId);
    if (found) {
      return await deleteSavedNoteById(found.id);
    }
  }

  // 2. Check if user quoted the exact note content or title
  if (quotedText && quotedText.trim()) {
    const qLower = quotedText.trim().toLowerCase();
    for (const n of groupNotes) {
      const titleLower = (n.title || '').toLowerCase();
      const contentLower = (n.content || '').toLowerCase();
      if (
        (titleLower && qLower.includes(titleLower)) ||
        (contentLower && (qLower.includes(contentLower) || contentLower.includes(qLower)))
      ) {
        return await deleteSavedNoteById(n.id);
      }
    }
  }

  // 3. Check if user said "hapus catatan/file tersebut / ini / tadi / terakhir"
  if (
    /\b(tersebut|tsb|ini|itu|tadi|barusan|terakhir)\b/i.test(queryText) &&
    groupNotes.length > 0
  ) {
    return await deleteSavedNoteById(groupNotes[0].id);
  }

  // 4. Match by keywords in queryText
  const cleanQ = String(combinedSearch || '')
    .toLowerCase()
    .replace(
      /(tolong|hapus|hapuskan|delete|buang|catat[ae]?n|jadwal|dokumen|file|foto|gambar|pesan|chat|yang|di|save|simpan|tersebut|tsb|ini|itu|tadi|ya|dong|bot)/gi,
      ' '
    )
    .trim();

  const words = cleanQ.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length > 0) {
    let bestNote = null;
    let bestScore = 0;
    for (const n of groupNotes) {
      const hay = `${n.title} ${n.content} ${n.fileInfo?.originalName || ''}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestNote = n;
      }
    }
    if (bestNote && bestScore > 0) {
      return await deleteSavedNoteById(bestNote.id);
    }
  }

  if (groupNotes.length === 1) {
    return await deleteSavedNoteById(groupNotes[0].id);
  }

  return null;
}

/**
 * Finds the best matching saved note with an attached file/photo when a user asks about it
 * or asks the bot to send/show it
 */
export function findSavedFileNoteToSend(groupId, queryText = '', quotedText = '', aiReplyText = '') {
  const notesWithFiles = getSavedNotesForGroup(groupId).filter(
    (n) => n.fileInfo && (n.fileInfo.driveFileId || n.fileInfo.savedFileName)
  );
  if (notesWithFiles.length === 0) return null;

  const qLower = String(queryText || '').toLowerCase().trim();
  const quotedLower = String(quotedText || '').toLowerCase().trim();
  const replyLower = String(aiReplyText || '').toLowerCase().trim();

  const isDirectSendFollowUp =
    /\b(kirim|kirimin|kirimkan|kesini|ke\s+sini|send|unduh|download|minta|ambil|ambilkan|mana|lihat|tampilkan|bagi)\b/i.test(
      qLower
    );

  // 1. Check explicit #ID in queryText, or in quotedText/aiReplyText when user asks for it
  const idMatch =
    qLower.match(/(?:#|id\s*#?|nomor\s*)(\d+)/i) ||
    (isDirectSendFollowUp && quotedLower.match(/(?:#|id\s*#?)(\d+)/i)) ||
    replyLower.match(/(?:#|id\s*#?)(\d+)/i);
  if (idMatch) {
    const numId = Number(idMatch[1]);
    const byId = notesWithFiles.find((n) => Number(n.id) === numId);
    if (byId) return byId;
  }

  // 2. Check if full note title or original filename appears in queryText, aiReplyText, or (if follow-up) quotedText
  for (const n of notesWithFiles) {
    const titleLower = (n.title || '').toLowerCase().trim();
    const origLower = (n.fileInfo?.originalName || '').toLowerCase().trim();
    if (titleLower && titleLower.length >= 3) {
      if (
        qLower.includes(titleLower) ||
        replyLower.includes(titleLower) ||
        (isDirectSendFollowUp && quotedLower.includes(titleLower))
      ) {
        return n;
      }
    }
    if (origLower && origLower.length >= 4) {
      if (
        qLower.includes(origLower) ||
        replyLower.includes(origLower) ||
        (isDirectSendFollowUp && quotedLower.includes(origLower))
      ) {
        return n;
      }
    }
  }

  // 3. Match by keywords in queryText (or quotedText if user says "kirim kesini" / "mana" / etc.)
  const stopWords =
    /\b(halo|hai|ai|bot|nanbot|tolong|bantu|coba|kirim|kirimin|kirimkan|kesini|ke|sini|send|unduh|download|minta|ambil|ambilkan|mana|lihat|cari|carikan|cek|tampilkan|apa|ya|bisa|saya|aku|kamu|yang|udah|sudah|pernah|di|save|simpan|catat|tadi|kemarin|dong|deh|nih|itu|ini|tersebut)\b/gi;

  const sourceForKeywords = isDirectSendFollowUp ? `${qLower} ${quotedLower}` : qLower;
  const queryKeywords = sourceForKeywords
    .replace(stopWords, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (queryKeywords.length > 0) {
    let best = null;
    let bestScore = 0;
    for (const n of notesWithFiles) {
      const hay = `${n.title} ${n.content} ${n.fileInfo?.originalName || ''} ${n.category || ''}`.toLowerCase();
      let score = 0;
      for (const w of queryKeywords) {
        if (hay.includes(w)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best && bestScore > 0) return best;
  }

  // 4. Check by file type keywords (word/docx, excel/xlsx, pdf, foto/gambar) if user is asking for a file
  if (isDirectSendFollowUp || /\b(file|dokumen|berkas|foto|gambar|catatan|jadwal)\b/i.test(qLower)) {
    if (/\b(excel|xlsx|xls|spreadsheet)\b/i.test(qLower)) {
      const found = notesWithFiles.find(
        (n) =>
          /\.(xlsx|xls|csv)$/i.test(n.fileInfo?.originalName || '') ||
          (n.fileInfo?.mimeType || '').includes('spreadsheet') ||
          (n.fileInfo?.mimeType || '').includes('excel')
      );
      if (found) return found;
    }
    if (/\b(word|docx|doc)\b/i.test(qLower)) {
      const found = notesWithFiles.find(
        (n) =>
          /\.(docx|doc)$/i.test(n.fileInfo?.originalName || '') ||
          (n.fileInfo?.mimeType || '').includes('word')
      );
      if (found) return found;
    }
    if (/\b(pdf)\b/i.test(qLower)) {
      const found = notesWithFiles.find(
        (n) =>
          /\.pdf$/i.test(n.fileInfo?.originalName || '') ||
          (n.fileInfo?.mimeType || '').includes('pdf')
      );
      if (found) return found;
    }
    if (/\b(foto|gambar|image|photo)\b/i.test(qLower)) {
      const found = notesWithFiles.find(
        (n) => n.fileInfo?.mediaType === 'image' || (n.fileInfo?.mimeType || '').startsWith('image/')
      );
      if (found) return found;
    }
  }

  // 5. If user explicitly asks "kirim kesini", "kirimin", "mana filenya", "lihat dong" and there is a saved file, return the most recent one
  if (
    /\b(kirim\s+ke\s*sini|kirimin|kirimkan|kirim\s+itu|kirim\s+lagi|mana\s+file|mana\s+foto|minta\s+file|minta\s+foto|bagi\s+file)\b/i.test(
      qLower
    )
  ) {
    return notesWithFiles[0];
  }

  return null;
}

export function formatNotesListText(groupId) {
  const notes = getSavedNotesForGroup(groupId);
  if (notes.length === 0) {
    return '📭 *Belum ada catatan atau file yang disimpan di grup ini.*\n\nContoh cara menyimpan:\n• Kirim/reply file atau foto lalu ketik: `ai tolong save file ini judulnya jadwal nandar`\n• Atau ketik: `ai tolong save jadwal rapat senin jam 9`';
  }

  let out = `📋 *DAFTAR CATATAN & FILE TERSIMPAN (${notes.length} Item)*\n\n`;
  for (const n of notes) {
    let fileLabel = '';
    if (n.fileInfo?.originalName) {
      const jenis = n.fileInfo.mediaType === 'image' ? '🖼️ Foto' : '📎 Dokumen';
      fileLabel = ` _(${jenis})_`;
    }
    out += `*#${n.id}* — *${n.title}*${fileLabel}\n`;
    if (n.content && n.content.toLowerCase() !== n.title.toLowerCase()) {
      out += `   📝 ${n.content}\n`;
    }
    out += `   👤 _Oleh ${n.savedBy} (${n.formattedTime})_\n\n`;
  }
  out += `💡 _Ketik nama catatan (misal: "ai minta jadwal nandar") untuk meminta bot mengirim filenya, atau "ai hapus catatan #ID" untuk menghapus._`;
  return out;
}

/**
 * Detects whether a user's message in WhatsApp is instructing the bot to:
 * 1) LIST saved notes ("list catatan", "daftar catatan", "list file")
 * 2) DELETE an existing saved note ("hapus catatan tersebut", "hapus file #1")
 * 3) SAVE a note/schedule/chat/document/photo permanently
 */
export function parseNoteCommand(questionText = '', quotedText = '', hasMedia = false) {
  const text = (questionText || '').trim();
  const lower = text.toLowerCase();

  const noteWord = '(?:catat[ae]?n|catet[ae]?n|note|notes|file|dokumen|berkas|foto|gambar)';

  // 1. Check LIST NOTES command
  const listRegex = new RegExp(
    `^\\s*(?:tolong\\s+|coba\\s+)?(?:list|daftar|lihat\\s+semua|cek\\s+semua|tampilkan\\s+semua|show)\\s+${noteWord}\\b|\\b(?:list|daftar)\\s+${noteWord}\\b`,
    'i'
  );
  if (listRegex.test(lower)) {
    return {
      action: 'list'
    };
  }

  // 2. Check DELETE command
  const deleteRegex = new RegExp(
    `\\b(hapus|hapuskan|delete|buang|hilangkan)\\b.*\\b(${noteWord}|jadwal|save|simpanan|#\\d+|ini|itu|tersebut|tadi)\\b|\\b(hapus|delete)\\s+#?\\d+\\b`,
    'i'
  );
  if (deleteRegex.test(lower)) {
    return {
      action: 'delete',
      targetQuery: text
    };
  }

  // 3. Check SAVE command
  const isQuestionAboutSaved =
    new RegExp(
      `\\b(apa\\s+aja|apa\\s+saja|mana\\s+aja|lihat|tampilkan|cek|cari|carikan|tanya|kapan|berapa|siapa|kirim|kirimin|kirimkan|kesini|minta|ambil|ambilkan)\\b`,
      'i'
    ).test(lower) &&
    !/\b(tolong\s+(?:bantu\s+)?save|save\s*kan|simpan\s*kan|tolong\s+(?:bantu\s+)?simpan|tolong\s+(?:bantu\s+)?catat|save\s+file|simpan\s+file|save\s+foto|simpan\s+foto)\b/i.test(
      lower
    );

  if (isQuestionAboutSaved) {
    return { action: 'none' };
  }

  const saveRegex = new RegExp(
    `\\b(tolong\\s+(?:bantu\\s+)?save(?:kan)?|bantu\\s+save(?:kan)?|save\\s*kan|save\\s+ini|save\\s+chat|save\\s+jadwal|save\\s+${noteWord}|save\\s+pesan|simpan(?:kan)?\\s+(?:ini|chat|jadwal|pesan|${noteWord})|tolong\\s+(?:bantu\\s+)?simpan(?:kan)?|tolong\\s+(?:bantu\\s+)?catat(?:kan)?|catat(?:kan)?\\s+(?:ini|jadwal|pesan|chat)|masuk(?:in|kan)\\s+ke\\s+${noteWord})\\b`,
    'i'
  );

  const startsWithSave = /^(save|simpan|catat)\b[\s:,-]*/i.test(lower);

  if (saveRegex.test(lower) || startsWithSave) {
    const cleanTitle = cleanRealisticNoteTitle(text);

    // Clean quotedText from bot's greeting if user replied to a message
    let cleanQuoted = String(quotedText || '')
      .replace(/^Halo[^!\n]*!\s*Saya\s+[a-zA-Z0-9_-]+\s+siap\s+membantu\.?\s*/i, '')
      .trim();

    let finalTitle = cleanTitle;
    let finalContent = cleanTitle;

    if (cleanQuoted && !hasMedia) {
      // If user replied to a text message and gave a custom title (e.g. "save ini judulnya jadwal nandar")
      if (cleanTitle && cleanTitle !== 'Catatan Penting' && cleanTitle.length >= 2) {
        finalTitle = cleanTitle;
        finalContent = cleanQuoted;
      } else {
        finalTitle = cleanRealisticNoteTitle(cleanQuoted);
        finalContent = cleanQuoted;
      }
    } else if (hasMedia) {
      finalTitle = cleanTitle;
      finalContent = cleanTitle;
    }

    if (finalContent || hasMedia) {
      return {
        action: 'save',
        titleToSave: finalTitle || 'Catatan Penting',
        contentToSave: finalContent || finalTitle || 'Lampiran File'
      };
    }
  }

  return { action: 'none' };
}

loadNotesStore();
