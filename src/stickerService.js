import sharp from 'sharp';

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Splits text into multiple lines so it fits nicely inside a 512x512 sticker
 */
function wrapTextLines(text, maxCharsPerLine = 16, maxLines = 6) {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length >= maxLines - 1) {
        break;
      }
    }
  }
  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * Injects WhatsApp Sticker EXIF metadata (Pack Name & Publisher) into a WebP buffer
 */
function addStickerExif(webpBuffer, packName = 'NANBOT Sticker', author = 'Bos Nandar') {
  try {
    const json = JSON.stringify({
      'sticker-pack-id': 'com.wabotai.nanbot.pack',
      'sticker-pack-name': packName,
      'sticker-pack-publisher': author,
      emojis: ['🤖', '✨']
    });

    const exifHeader = Buffer.from([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    const jsonBuf = Buffer.from(json, 'utf-8');
    exifHeader.writeUInt32LE(jsonBuf.length, 14);
    const exifData = Buffer.concat([exifHeader, jsonBuf]);

    // If not standard RIFF WEBP, return original buffer
    if (
      webpBuffer.length < 12 ||
      webpBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
      webpBuffer.toString('ascii', 8, 12) !== 'WEBP'
    ) {
      return webpBuffer;
    }

    const padByte = exifData.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write('EXIF', 0, 4, 'ascii');
    chunkHeader.writeUInt32LE(exifData.length, 4);

    const exifChunk = Buffer.concat([chunkHeader, exifData, padByte]);
    const result = Buffer.concat([webpBuffer, exifChunk]);
    result.writeUInt32LE(result.length - 8, 4);
    return result;
  } catch {
    return webpBuffer;
  }
}

/**
 * Builds an SVG overlay for meme text on top of an image sticker
 */
function buildImageTextOverlaySvg(text) {
  const clean = String(text || '').trim();
  const maxChars = clean.length > 40 ? 22 : 16;
  const lines = wrapTextLines(clean.toUpperCase(), maxChars, 4);
  const fontSize = lines.length >= 3 ? 38 : lines.length === 2 ? 44 : 52;
  const lineHeight = Math.round(fontSize * 1.18);

  const totalHeight = lines.length * lineHeight;
  const startY = 490 - totalHeight + fontSize;

  const tspans = lines
    .map((line, i) => {
      const y = startY + i * lineHeight;
      return `<text x="256" y="${y}" font-family="Impact, Arial Black, sans-serif" font-size="${fontSize}" font-weight="900" text-anchor="middle" fill="#FFFFFF" stroke="#000000" stroke-width="10" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(line)}</text>`;
    })
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    ${tspans}
  </svg>`;

  return Buffer.from(svg);
}

/**
 * Builds a standalone 512x512 SVG for a pure text sticker (when no photo is provided)
 */
function buildPureTextStickerSvg(text) {
  const clean = String(text || '').trim();
  const len = clean.length;

  let maxChars = 12;
  let fontSize = 68;
  if (len > 60) {
    maxChars = 20;
    fontSize = 40;
  } else if (len > 30) {
    maxChars = 16;
    fontSize = 48;
  } else if (len > 14) {
    maxChars = 13;
    fontSize = 58;
  }

  const lines = wrapTextLines(clean, maxChars, 6);
  const lineHeight = Math.round(fontSize * 1.22);
  const totalHeight = lines.length * lineHeight;
  const startY = Math.round((512 - totalHeight) / 2 + fontSize * 0.82);

  const textElements = lines
    .map((line, i) => {
      const y = startY + i * lineHeight;
      return `<text x="256" y="${y}" font-family="Arial Rounded MT Bold, Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="800" text-anchor="middle" fill="#111b21">${escapeXml(line)}</text>`;
    })
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect x="16" y="16" width="480" height="480" rx="72" ry="72" fill="#FFFFFF" stroke="#00a884" stroke-width="10"/>
    ${textElements}
  </svg>`;

  return Buffer.from(svg);
}

/**
 * Generates a 512x512 WhatsApp WebP Sticker from:
 * 1) Photo only
 * 2) Photo + Text overlay
 * 3) Text only
 */
export async function createWhatsAppSticker({
  imageBuffer = null,
  text = '',
  packName = 'NANBOT Sticker',
  author = 'Bos Nandar'
}) {
  const cleanText = String(text || '').trim();
  let webpBuffer;

  if (imageBuffer) {
    let pipeline = sharp(imageBuffer).resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

    if (cleanText) {
      const overlaySvg = buildImageTextOverlaySvg(cleanText);
      pipeline = pipeline.composite([{ input: overlaySvg, top: 0, left: 0 }]);
    }

    webpBuffer = await pipeline.webp({ quality: 88 }).toBuffer();
  } else if (cleanText) {
    const textSvg = buildPureTextStickerSvg(cleanText);
    webpBuffer = await sharp(textSvg).resize(512, 512).webp({ quality: 92 }).toBuffer();
  } else {
    throw new Error('Harap sertakan foto atau teks kata-kata untuk membuat stiker.');
  }

  return addStickerExif(webpBuffer, packName, author);
}

/**
 * Detects whether a message is asking to create a sticker
 * Examples:
 * - "stiker" (with photo or replying to photo)
 * - "stiker kata kata lucu" (with photo, replying to photo, or text-only)
 * - "buat stiker lagi sibuk bos"
 * - "bikin stiker jangan berisik"
 */
export function parseStickerCommand(rawText = '', hasImage = false) {
  const text = String(rawText || '').trim();
  const lower = text.toLowerCase();

  // Match "stiker", "sticker", "buat stiker", "bikin stiker", "jadikan stiker", "jadiin stiker"
  const match = text.match(
    /^(?:tolong\s+)?(?:buat(?:kan|in)?\s+|bikin(?:in)?\s+|jadi(?:kan|in)\s+)?(?:stik?ker|sticker)(?:\s+kata(?:\s*-?\s*kata)?)?(?:[\s:,-]+([\s\S]*))?$/i
  );

  if (match) {
    const stickerText = (match[1] || '').trim();
    if (hasImage || stickerText.length > 0) {
      return {
        isSticker: true,
        stickerText
      };
    }
  }

  return { isSticker: false, stickerText: '' };
}

