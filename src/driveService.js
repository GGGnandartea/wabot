import fs from 'fs';
import { getConfig } from './config.js';

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB max for lightweight files (.docx, .xlsx, .pdf, photos)

/**
 * Uploads a buffer to Google Drive via the configured Google Apps Script Web App URL.
 * Returns { fileId, viewUrl, downloadUrl }
 */
export async function uploadBufferToGoogleDrive({ buffer, fileName, mimeType }) {
  const config = getConfig();
  const scriptUrl = (config.googleDriveScriptUrl || '').trim();
  if (!scriptUrl) {
    return null;
  }

  const base64Data = buffer.toString('base64');
  const res = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'upload',
      folderName: config.googleDriveFolderName || 'WabotAI_Files',
      fileName: fileName || `file-${Date.now()}`,
      mimeType: mimeType || 'application/octet-stream',
      base64Data
    }),
    redirect: 'follow',
    signal: AbortSignal.timeout(45000)
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data?.fileId) {
    throw new Error(data?.error || `Gagal upload ke Google Drive (HTTP ${res.status})`);
  }

  return {
    driveFileId: data.fileId,
    driveViewUrl: data.viewUrl || `https://drive.google.com/file/d/${data.fileId}/view`,
    driveDownloadUrl: data.downloadUrl || `https://drive.google.com/uc?export=download&id=${data.fileId}`
  };
}

/**
 * Downloads a file buffer from Google Drive by its driveFileId
 */
export async function downloadBufferFromGoogleDrive(driveFileId) {
  if (!driveFileId) return null;
  const config = getConfig();
  const scriptUrl = (config.googleDriveScriptUrl || '').trim();

  // Method 1: Via Google Apps Script Web App (returns base64 JSON)
  if (scriptUrl) {
    try {
      const res = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'download',
          fileId: driveFileId
        }),
        redirect: 'follow',
        signal: AbortSignal.timeout(45000)
      });
      const data = await res.json().catch(() => null);
      if (data?.ok && data?.base64Data) {
        return Buffer.from(data.base64Data, 'base64');
      }
    } catch (err) {
      console.error('[DriveService] Gagal download via Apps Script, mencoba direct link:', err.message);
    }
  }

  // Method 2: Direct Google Drive download link fallback
  const directUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`;
  const res = await fetch(directUrl, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`Gagal mengunduh file dari Google Drive (HTTP ${res.status})`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Deletes a file from Google Drive when the saved note is deleted
 */
export async function deleteFileFromGoogleDrive(driveFileId) {
  if (!driveFileId) return false;
  const config = getConfig();
  const scriptUrl = (config.googleDriveScriptUrl || '').trim();
  if (!scriptUrl) return false;

  try {
    const res = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        fileId: driveFileId
      }),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => null);
    return Boolean(data?.ok);
  } catch (err) {
    console.error('[DriveService] Gagal menghapus file di Google Drive:', err.message);
    return false;
  }
}

export async function testGoogleDriveConnection(customScriptUrl) {
  const config = getConfig();
  const scriptUrl = (customScriptUrl ?? config.googleDriveScriptUrl ?? '').trim();
  if (!scriptUrl) {
    throw new Error('URL Web App Google Apps Script masih kosong.');
  }

  const res = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'ping',
      folderName: config.googleDriveFolderName || 'WabotAI_Files'
    }),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `Respons Google Drive tidak valid (HTTP ${res.status})`);
  }

  return {
    ok: true,
    folderName: data.folderName || 'WabotAI_Files',
    folderUrl: data.folderUrl || '',
    message: data.message || 'Terhubung ke Google Drive!'
  };
}

export const GOOGLE_APPS_SCRIPT_TEMPLATE = `// Copy-Paste kode ini ke https://script.google.com -> Deploy -> New deployment -> Web app (Who has access: Anyone)
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var folderName = body.folderName || 'WabotAI_Files';
    var folders = DriveApp.getFoldersByName(folderName);
    var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

    if (action === 'ping') {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        folderName: folder.getName(),
        folderUrl: folder.getUrl(),
        message: 'Google Drive berhasil terhubung ke folder ' + folder.getName()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'upload') {
      var bytes = Utilities.base64Decode(body.base64Data);
      var blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', body.fileName || 'file');
      var file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        fileId: file.getId(),
        viewUrl: file.getUrl(),
        downloadUrl: 'https://drive.google.com/uc?export=download&id=' + file.getId()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'download') {
      var dFile = DriveApp.getFileById(body.fileId);
      var b64 = Utilities.base64Encode(dFile.getBlob().getBytes());
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        fileName: dFile.getName(),
        mimeType: dFile.getMimeType(),
        base64Data: b64
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'delete') {
      var delFile = DriveApp.getFileById(body.fileId);
      delFile.setTrashed(true);
      return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Action tidak dikenal' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}`;

