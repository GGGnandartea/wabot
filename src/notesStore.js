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

export function loadNotesStore() {
  try {
    if (fs.existsSync(NOTES_FILE)) {
      const raw = fs.readFileSync(NOTES_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.notes)) {
        notesData = {
          nextId:
            Number(parsed.nextId) ||
            parsed.notes.reduce((max, n) => Math.max(max, Number(n.id) || 0), 0) + 1,
          notes: parsed.notes
        };
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

function inferCategoryAndTitle(text, fileInfo) {
  const lower = (text || '').toLowerCase();
  let category = 'catatan';
  if (fileInfo) {
    category = fileInfo.mediaType === 'image' ? 'foto' : 'dokumen';
  } else if (
    /(jadwal|agenda|meeting|rapat|jam\s+\d|senin|selasa|rabu|kamis|jumat|sabtu|minggu|tanggal)/i.test(
      lower
    )
  ) {
    category = 'jadwal';
  }

  let cleanLine = (text || '').split('\n')[0].trim();
  if (cleanLine.length > 60) {
    cleanLine = cleanLine.slice(0, 57) + '...';
  }
  if ((!cleanLine || cleanLine.startsWith('[Dokumen:') || cleanLine.startsWith('(Lampiran')) && fileInfo?.originalName) {
    cleanLine = fileInfo.originalName;
  }
  const prefixLabel =
    category === 'jadwal'
      ? '📅 Jadwal'
      : category === 'foto'
      ? '🖼️ Foto'
      : category === 'dokumen'
      ? '📄 File'
      : '📌 Catatan';
  const title = cleanLine ? `${prefixLabel}: ${cleanLine}` : `${prefixLabel} Penting`;

  return { category, title };
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
  const inferred = inferCategoryAndTitle(content, fileInfo);

  const note = {
    id: notesData.nextId++,
    groupId: groupId || 'global',
    groupName: groupName || groupId || 'Grup',
    title: (title || inferred.title).trim(),
    content: (content || '').trim(),
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

  // 2. Check if user quoted the exact note content or bot confirmation message
  if (quotedText && quotedText.trim()) {
    const qLower = quotedText.trim().toLowerCase();
    for (const n of groupNotes) {
      const contentLower = (n.content || '').toLowerCase();
      if (contentLower && (qLower.includes(contentLower) || contentLower.includes(qLower))) {
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

  // 5. If there is only 1 note in the group and user said "hapus catatan/file", delete that single note
  if (groupNotes.length === 1) {
    return await deleteSavedNoteById(groupNotes[0].id);
  }

  return null;
}

/**
 * Finds the best matching saved note with an attached file/photo when a user asks the bot to send it back
 */
export function findSavedFileNoteToSend(groupId, queryText = '') {
  const notesWithFiles = getSavedNotesForGroup(groupId).filter(
    (n) => n.fileInfo && (n.fileInfo.driveFileId || n.fileInfo.savedFileName)
  );
  if (notesWithFiles.length === 0) return null;

  const q = String(queryText || '').toLowerCase();

  // 1. Check by explicit ID (#1, #2, etc.)
  const idMatch = q.match(/#?(\d+)/);
  if (idMatch) {
    const numId = Number(idMatch[1]);
    const byId = notesWithFiles.find((n) => Number(n.id) === numId);
    if (byId) return byId;
  }

  // 2. Check by file type keywords (word/docx, excel/xlsx, pdf, foto/gambar)
  if (/\b(excel|xlsx|xls|spreadsheet)\b/i.test(q)) {
    const found = notesWithFiles.find((n) =>
      /\.(xlsx|xls|csv)$/i.test(n.fileInfo?.originalName || '') ||
      (n.fileInfo?.mimeType || '').includes('spreadsheet') ||
      (n.fileInfo?.mimeType || '').includes('excel')
    );
    if (found) return found;
  }
  if (/\b(word|docx|doc)\b/i.test(q)) {
    const found = notesWithFiles.find((n) =>
      /\.(docx|doc)$/i.test(n.fileInfo?.originalName || '') ||
      (n.fileInfo?.mimeType || '').includes('word')
    );
    if (found) return found;
  }
  if (/\b(pdf)\b/i.test(q)) {
    const found = notesWithFiles.find((n) =>
      /\.pdf$/i.test(n.fileInfo?.originalName || '') ||
      (n.fileInfo?.mimeType || '').includes('pdf')
    );
    if (found) return found;
  }
  if (/\b(foto|gambar|image|photo)\b/i.test(q)) {
    const found = notesWithFiles.find(
      (n) => n.fileInfo?.mediaType === 'image' || (n.fileInfo?.mimeType || '').startsWith('image/')
    );
    if (found) return found;
  }

  // 3. Match by keywords in title, content, or filename
  const words = q
    .replace(
      /\b(tolong|kirim|kirimin|kirimkan|minta|ambil|ambilkan|unduh|download|mana|lihat|file|dokumen|foto|gambar|lampiran|yang|di|save|simpan|tadi|kemarin|dong|ya|bot)\b/gi,
      ' '
    )
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (words.length > 0) {
    let best = null;
    let bestScore = 0;
    for (const n of notesWithFiles) {
      const hay = `${n.title} ${n.content} ${n.fileInfo?.originalName || ''}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best && bestScore > 0) return best;
  }

  // 4. Default to most recent saved file in this group
  return notesWithFiles[0];
}

export function formatNotesListText(groupId) {
  const notes = getSavedNotesForGroup(groupId);
  if (notes.length === 0) {
    return '📭 *Belum ada catatan atau file penting yang di-save di grup ini.*\n\nUntuk menyimpan catatan/jadwal/file (.docx, .xlsx, .pdf, foto), ketik:\n`@bot tolong save kan jadwal ini ya: ...`\natau reply sebuah pesan/file lalu ketik `@bot tolong savekan ini ya`.';
  }

  let out = `📋 *DAFTAR CATATAN & FILE TERSIMPAN (${notes.length} Item)*\n\n`;
  for (const n of notes) {
    let fileLabel = '';
    if (n.fileInfo?.originalName) {
      const storageTag = n.fileInfo.driveFileId ? '☁️ Google Drive' : '💾 Server';
      fileLabel = `\n   📎 _File (${storageTag}): ${n.fileInfo.originalName}_`;
    }
    out += `*#${n.id}* — *${n.title}*\n`;
    out += `   📝 ${n.content}${fileLabel}\n`;
    out += `   👤 _Disimpan oleh ${n.savedBy} (${n.formattedTime})_\n\n`;
  }
  out += `💡 _Tips:_\n- Ketik \`@bot kirim file #ID\` untuk meminta bot mengirim ulang file/foto.\n- Ketik \`@bot hapus catatan #ID\` atau \`@bot hapus catatan tersebut\` untuk menghapus.`;
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
    `^\\s*(?:tolong\\s+|coba\\s+)?(?:list|daftar|lihat|cek|tampilkan|show)\\s+${noteWord}\\b|\\b(?:list|daftar)\\s+${noteWord}\\b`,
    'i'
  );
  if (listRegex.test(lower)) {
    return {
      action: 'list'
    };
  }

  // 2. Check DELETE command
  const deleteRegex = new RegExp(
    `\\b(hapus|hapuskan|delete|buang|hilangkan)\\b.*\\b(${noteWord}|jadwal|save|simpanan|#\\d+)\\b|\\b(hapus|delete)\\s+#?\\d+\\b`,
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
      `\\b(apa\\s+aja|apa\\s+saja|mana\\s+aja|lihat|tampilkan|cek|cari|carikan|tanya|kapan|berapa|siapa|kirim|kirimin|kirimkan|minta|ambil|ambilkan)\\b.*\\b(yang\\s+di\\s*save|yang\\s+disimpan|udah\\s+di\\s*save|sudah\\s+disimpan|${noteWord}|jadwal)\\b`,
      'i'
    ).test(lower) &&
    !/\b(tolong\s+save|save\s*kan|simpan\s*kan|tolong\s+simpan|tolong\s+catat)\b/i.test(lower);

  if (isQuestionAboutSaved) {
    return { action: 'none' };
  }

  const saveRegex = new RegExp(
    `\\b(tolong\\s+save(?:kan)?|save\\s*kan|save\\s+ini|save\\s+chat|save\\s+jadwal|save\\s+${noteWord}|save\\s+pesan|simpan(?:kan)?\\s+(?:ini|chat|jadwal|pesan|${noteWord})|tolong\\s+simpan(?:kan)?|tolong\\s+catat(?:kan)?|catat(?:kan)?\\s+(?:ini|jadwal|pesan|chat)|masuk(?:in|kan)\\s+ke\\s+${noteWord})\\b`,
    'i'
  );

  const startsWithSave = /^(save|simpan|catat)\b[\s:,-]*/i.test(lower);

  if (saveRegex.test(lower) || startsWithSave) {
    let extractedNote = text
      .replace(
        new RegExp(
          `^(tolong\\s+)?(save\\s*kan|save|simpan\\s*kan|simpan|catat\\s*kan|catat)\\s*(jadwal\\s+ini|chat\\s+ini|pesan\\s+ini|${noteWord}\\s+ini|ini)?\\s*(ya|dong|deh|nih|bot)?[\\s:,-]*`,
          'i'
        ),
        ''
      )
      .replace(
        /\s*(nanti\s+(kalo|kalau)?\s*(saya|aku|kita)\s+(butuh|tanya|perlu|minta|panggil).*)$/i,
        ''
      )
      .trim();

    let finalContent = '';
    if (quotedText && quotedText.trim()) {
      if (
        extractedNote &&
        extractedNote.length > 3 &&
        !/^(ya|dong|nanti.*|tolong.*)$/i.test(extractedNote)
      ) {
        finalContent = `${quotedText.trim()}\n(Catatan tambahan: ${extractedNote})`;
      } else {
        finalContent = quotedText.trim();
      }
    } else {
      finalContent = extractedNote || text;
    }

    if (finalContent || hasMedia) {
      return {
        action: 'save',
        contentToSave: finalContent || '(Lampiran File / Foto Penting)'
      };
    }
  }

  return { action: 'none' };
}

loadNotesStore();
