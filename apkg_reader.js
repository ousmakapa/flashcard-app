// Offline Flashcards V5 — Anki .apkg importer
// Imports notes AND all images referenced in them.
// Uses File.slice() so only the bytes actually needed are read from disk.
// No external dependencies. Requires DecompressionStream (Chrome 80+, Firefox 113+, Safari 16.4+).
(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image

  const IMAGE_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    avif: 'image/avif', bmp: 'image/bmp',
  };

  const utf8 = new TextDecoder('utf-8', { fatal: false });

  function guessImageType(filename) {
    const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
    return IMAGE_TYPES[ext] || null;
  }

  // ─── File helpers ───────────────────────────────────────────────────────────

  async function readSlice(file, start, length) {
    if (length <= 0) return new Uint8Array(0);
    const clamped = Math.max(0, start);
    return new Uint8Array(await file.slice(clamped, clamped + length).arrayBuffer());
  }

  // ─── Byte helpers ──────────────────────────────────────────────────────────

  function u16BE(d, o) { return (d[o] << 8) | d[o + 1]; }
  function u32BE(d, o) { return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0; }
  function u16LE(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32LE(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }

  function intBE(d, o, n) {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = v * 256 + d[o + i];
    if (n < 8) { const hi = Math.pow(2, n * 8 - 1); if (v >= hi) v -= hi * 2; }
    return v;
  }

  function varint(d, o) {
    let v = 0;
    for (let i = 0; i < 9; i += 1) {
      const b = d[o + i];
      if (i < 8) { v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return [v, i + 1]; }
      else return [v * 256 + b, 9];
    }
    return [v, 9];
  }

  // ─── ZIP reader ─────────────────────────────────────────────────────────────

  async function findEOCD(file) {
    const tailSize = Math.min(file.size, 65558);
    const tail = await readSlice(file, file.size - tailSize, tailSize);
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        return { cdSize: u32LE(tail, i + 12), cdOffset: u32LE(tail, i + 16) };
      }
    }
    throw new Error('Not a valid .apkg file — ZIP signature not found.');
  }

  function parseCentralDir(cd) {
    const entries = {};
    let pos = 0;
    while (pos < cd.length) {
      if (cd[pos] !== 0x50 || cd[pos + 1] !== 0x4b || cd[pos + 2] !== 0x01 || cd[pos + 3] !== 0x02) break;
      const method   = u16LE(cd, pos + 10);
      const compSz   = u32LE(cd, pos + 20);
      const fullSz   = u32LE(cd, pos + 24);
      const nameLen  = u16LE(cd, pos + 28);
      const extraLen = u16LE(cd, pos + 30);
      const commLen  = u16LE(cd, pos + 32);
      const lhOffset = u32LE(cd, pos + 42);
      const name     = utf8.decode(cd.subarray(pos + 46, pos + 46 + nameLen));
      entries[name]  = { name, method, compSz, fullSz, lhOffset };
      pos += 46 + nameLen + extraLen + commLen;
    }
    return entries;
  }

  async function extractEntry(file, entry) {
    const lhFixed = await readSlice(file, entry.lhOffset, 30);
    if (lhFixed[0] !== 0x50 || lhFixed[1] !== 0x4b || lhFixed[2] !== 0x03 || lhFixed[3] !== 0x04) {
      throw new Error(`Bad local file header for "${entry.name}".`);
    }
    const nameLen  = u16LE(lhFixed, 26);
    const extraLen = u16LE(lhFixed, 28);
    const dataStart = entry.lhOffset + 30 + nameLen + extraLen;
    const compressed = await readSlice(file, dataStart, entry.compSz);

    if (entry.method === 0) return compressed;
    if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method} in "${entry.name}".`);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('.apkg import requires DecompressionStream support (Chrome 80+, Firefox 113+, Safari 16.4+).');
    }
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    // Write and read concurrently — awaiting writer.close() alone deadlocks
    // when decompressed output fills the readable queue (backpressure stalls the write).
    const chunks = []; let total = 0;
    await Promise.all([
      (async () => { await writer.write(compressed); await writer.close(); })(),
      (async () => {
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
      })(),
    ]);
    const out = new Uint8Array(total); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // ─── SQLite reader ──────────────────────────────────────────────────────────

  function getPage(data, pageNum, pageSize) {
    const off = (pageNum - 1) * pageSize;
    return data.subarray(off, off + pageSize);
  }

  function localPayloadSize(total, pageSize) {
    const X = pageSize - 35;
    const M = Math.floor(((pageSize - 12) * 32) / 255) - 23;
    if (total <= X) return total;
    let K = M + ((total - M) % (pageSize - 4));
    if (K > X) K = M;
    return K;
  }

  function readPayload(data, page, cellPos, total, pageSize) {
    const local = localPayloadSize(total, pageSize);
    if (local === total) return page.subarray(cellPos, cellPos + total);
    const result = new Uint8Array(total);
    result.set(page.subarray(cellPos, cellPos + local));
    let nextPage = u32BE(page, cellPos + local);
    let written  = local;
    while (nextPage > 0 && written < total) {
      const ovPage = getPage(data, nextPage, pageSize);
      nextPage = u32BE(ovPage, 0);
      const chunk = Math.min(total - written, pageSize - 4);
      result.set(ovPage.subarray(4, 4 + chunk), written);
      written += chunk;
    }
    return result;
  }

  function parseRecord(payload) {
    const [hLen, hLenBytes] = varint(payload, 0);
    let hp = hLenBytes, dp = hLen;
    const values = [];
    while (hp < hLen) {
      const [st, stBytes] = varint(payload, hp); hp += stBytes;
      if      (st === 0)  { values.push(null); }
      else if (st === 1)  { values.push(intBE(payload, dp, 1)); dp += 1; }
      else if (st === 2)  { values.push(intBE(payload, dp, 2)); dp += 2; }
      else if (st === 3)  { values.push(intBE(payload, dp, 3)); dp += 3; }
      else if (st === 4)  { values.push(intBE(payload, dp, 4)); dp += 4; }
      else if (st === 5)  { values.push(intBE(payload, dp, 6)); dp += 6; }
      else if (st === 6)  { values.push(intBE(payload, dp, 8)); dp += 8; }
      else if (st === 7)  {
        const view = new DataView(payload.buffer, payload.byteOffset + dp, 8);
        values.push(view.getFloat64(0, false)); dp += 8;
      }
      else if (st === 8)  { values.push(0); }
      else if (st === 9)  { values.push(1); }
      else if (st >= 12)  {
        const len = st % 2 === 0 ? (st - 12) / 2 : (st - 13) / 2;
        const bytes = payload.subarray(dp, dp + len);
        values.push(st % 2 === 0 ? bytes.slice() : utf8.decode(bytes));
        dp += len;
      } else { values.push(null); }
    }
    return values;
  }

  function collectRecords(data, rootPage, pageSize) {
    const records = []; const visited = new Set();
    function visit(pageNum) {
      if (!pageNum || visited.has(pageNum)) return;
      visited.add(pageNum);
      const page   = getPage(data, pageNum, pageSize);
      const hOff   = pageNum === 1 ? 100 : 0;
      const pType  = page[hOff];
      const nCells = u16BE(page, hOff + 3);
      const hSize  = (pType === 0x0d || pType === 0x0a) ? 8 : 12;
      if (pType === 0x05) {
        const rightmost = u32BE(page, hOff + 8);
        for (let i = 0; i < nCells; i += 1) visit(u32BE(page, u16BE(page, hOff + hSize + i * 2)));
        visit(rightmost);
      } else if (pType === 0x0d) {
        for (let i = 0; i < nCells; i += 1) {
          const cOff = u16BE(page, hOff + hSize + i * 2);
          let pos = cOff;
          const [totalPayload, pb] = varint(page, pos); pos += pb;
          const [, rb]             = varint(page, pos); pos += rb;
          const payload = readPayload(data, page, pos, totalPayload, pageSize);
          try { records.push(parseRecord(payload)); } catch (_) {}
        }
      }
    }
    visit(rootPage);
    return records;
  }

  function readSchema(data, pageSize) {
    const rows = collectRecords(data, 1, pageSize);
    const map  = {};
    for (const row of rows) {
      if (row[0] === 'table' && typeof row[1] === 'string' && typeof row[3] === 'number') {
        map[row[1].toLowerCase()] = row[3];
      }
    }
    return map;
  }

  // ─── HTML helpers ───────────────────────────────────────────────────────────

  // Returns deduplicated local image filenames referenced by <img src="..."> in the HTML.
  function extractImageNames(html) {
    if (!html) return [];
    const names = []; const seen = new Set();
    const re = /<img[^>]+src=["']?([^"'\s>]+)["']?/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const src = m[1];
      if (!src || src.startsWith('data:') || src.startsWith('http') || src.startsWith('//')) continue;
      let name = src;
      try { name = decodeURIComponent(src); } catch (_) {}
      if (!seen.has(name)) { seen.add(name); names.push(name); }
    }
    return names;
  }

  // Strips HTML tags, Anki sound tags, and template syntax to produce plain text.
  function stripHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/\[sound:[^\]]+\]/g, '')
      // Note: cloze syntax {{c1::word}} is intentionally preserved so the app can render it.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<img[^>]*>/gi, '')       // images go to frontImageIds/backImageIds
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Resolve a media filename against the zip index, trying common variations.
  function resolveZipName(name, filenameToZipIndex) {
    if (!name) return '';
    const direct = String(name);
    if (Object.prototype.hasOwnProperty.call(filenameToZipIndex, direct)) return direct;
    let decoded = direct;
    try { decoded = decodeURIComponent(direct); } catch (_) {}
    if (Object.prototype.hasOwnProperty.call(filenameToZipIndex, decoded)) return decoded;
    const trimmed = decoded.replace(/^\.?[\\/]+/, '');
    if (Object.prototype.hasOwnProperty.call(filenameToZipIndex, trimmed)) return trimmed;
    const basename = trimmed.split(/[\\/]/).pop() || trimmed;
    if (Object.prototype.hasOwnProperty.call(filenameToZipIndex, basename)) return basename;
    return '';
  }

  // ─── Main entry point ────────────────────────────────────────────────────────

  async function parseApkgFile(file, onProgress) {
    function progress(msg) { if (typeof onProgress === 'function') onProgress(msg); }

    progress('Locating ZIP directory…');
    const eocd    = await findEOCD(file);

    progress('Reading file index…');
    const cdBuf   = await readSlice(file, eocd.cdOffset, eocd.cdSize);
    const entries = parseCentralDir(cdBuf);

    // ── SQLite database ─────────────────────────────────────────────────────
    const dbEntry = entries['collection.anki21'] || entries['collection.anki2'];
    if (!dbEntry) {
      throw new Error(
        'Could not find the Anki collection database inside this .apkg file. ' +
        'Make sure the file is a valid Anki deck export (File → Export → Anki Deck Package).'
      );
    }

    progress(`Extracting database (${(dbEntry.compSz / 1024 / 1024).toFixed(1)} MB compressed)…`);
    const db = await extractEntry(file, dbEntry);
    if (db.length < 100 || utf8.decode(db.subarray(0, 15)) !== 'SQLite format 3') {
      throw new Error('The Anki collection database inside the .apkg file is not a valid SQLite file.');
    }

    let pageSize = u16BE(db, 16);
    if (pageSize === 1) pageSize = 65536;

    const schema = readSchema(db, pageSize);
    if (!schema.notes) {
      throw new Error('The Anki database does not contain a notes table. The deck may be empty or use an unsupported format.');
    }

    progress('Parsing notes…');
    const noteRows = collectRecords(db, schema.notes, pageSize);

    // ── Media index (filename → zip entry index) ────────────────────────────
    // Format: {"0": "image.jpg", "1": "audio.mp3", ...}  →  invert to {"image.jpg": "0"}
    const filenameToZipIndex = {};
    const mediaEntry = entries['media'] || entries['media.json'];
    if (mediaEntry) {
      try {
        const mediaBytes = await extractEntry(file, mediaEntry);
        const rawMap = JSON.parse(utf8.decode(mediaBytes));
        Object.entries(rawMap).forEach(([idx, name]) => {
          if (typeof name === 'string') filenameToZipIndex[name] = String(idx);
        });
      } catch (_) {
        // Media map missing or corrupt — images will be unavailable but notes still import.
      }
    }

    // ── Parse notes → cards ─────────────────────────────────────────────────
    // Strategy: field[0] = front, field[1] = back.
    // This is correct for Basic, Basic (Reversed), and Cloze note types,
    // which covers the vast majority of real-world study decks.
    const imported = [];
    const skipped  = [];

    noteRows.forEach((row, idx) => {
      // Auto-detect the flds column: it's the only column containing the \x1f
      // field separator. Depending on whether Anki stored 'id INTEGER PRIMARY KEY'
      // in the record payload, flds may be at index 5 (id omitted) or 6 (id present).
      let fldsCol = -1;
      for (const ci of [5, 6, 4]) {
        if (typeof row[ci] === 'string' && row[ci].includes('\x1f')) { fldsCol = ci; break; }
      }
      // Single-field notes have no \x1f — fall back to first string at candidate positions.
      if (fldsCol === -1) {
        for (const ci of [5, 6, 4]) {
          if (typeof row[ci] === 'string') { fldsCol = ci; break; }
        }
      }
      if (fldsCol === -1) {
        skipped.push({ row: idx + 1, reason: 'Missing fields data' });
        return;
      }

      const fields    = row[fldsCol].split('\x1f');
      const frontHtml = fields[0] || '';
      const rawBackHtml = fields[1] || '';

      // Cloze notes store everything in field[0] and leave field[1] (Extra) empty.
      // Detect by the presence of {{cN::...}} syntax in the front field.
      const isCloze = /\{\{c\d+::/i.test(frontHtml);
      // For cloze with an empty back: mirror the front so the answer screen can
      // reveal the filled-in text (renderClozeAnswer handles the display).
      const backHtml = (isCloze && !rawBackHtml.trim()) ? frontHtml : rawBackHtml;

      const frontText   = stripHtml(frontHtml);
      const backText    = stripHtml(backHtml);
      const frontImages = extractImageNames(frontHtml);
      // For cloze the back is the same field, so avoid duplicate image refs.
      const backImages  = isCloze ? [] : extractImageNames(backHtml);

      // A side is valid if it has text OR at least one image.
      if (!(frontText || frontImages.length) || !(backText || backImages.length)) {
        skipped.push({ row: idx + 1, reason: 'Front or back has no text and no images' });
        return;
      }

      // tags is always the column immediately before flds in the Anki schema.
      const tagsRaw = row[fldsCol - 1];
      const tags = typeof tagsRaw === 'string' ? tagsRaw.trim().split(/\s+/).filter(Boolean) : [];

      imported.push({
        row: idx + 1,
        question: frontText || '[image]',
        answer:   backText  || '[image]',
        frontImageNames: frontImages,
        backImageNames:  backImages,
        tags,
        cardType: isCloze ? 'cloze' : 'basic',
        deckName: '',
      });
    });

    // ── Deferred image loader ───────────────────────────────────────────────
    // Called by app.js after duplicate detection, so only images for accepted
    // cards are extracted. Each image is read with File.slice() — no full-file load.
    async function loadMediaFiles(requestedNames, mediaProgress) {
      const report = typeof mediaProgress === 'function' ? mediaProgress : progress;

      // Resolve all names once, deduplicate, filter to images only.
      const uniqueNames = [...new Set(
        (requestedNames || [])
          .map((name) => resolveZipName(name, filenameToZipIndex))
          .filter((name) => name && guessImageType(name))
      )];

      const mediaFiles = [];
      const missing    = [];

      for (let i = 0; i < uniqueNames.length; i += 1) {
        const imageName = uniqueNames[i];
        const type      = guessImageType(imageName);
        const zipIndex  = filenameToZipIndex[imageName];
        const zipEntry  = zipIndex != null ? entries[zipIndex] : null;

        if (!type || !zipEntry) {
          missing.push({ name: imageName, reason: 'not found in package' });
          continue;
        }

        if (i === 0 || (i + 1) % 25 === 0 || i + 1 === uniqueNames.length) {
          report(`Extracting images… ${i + 1} / ${uniqueNames.length}`);
        }

        // Skip before extracting if we already know it's oversized.
        if (zipEntry.fullSz > MAX_IMAGE_BYTES) {
          missing.push({ name: imageName, reason: 'image exceeds 8 MB limit' });
          continue;
        }

        try {
          const data = await extractEntry(file, zipEntry);
          if (data.byteLength > MAX_IMAGE_BYTES) {
            missing.push({ name: imageName, reason: 'image exceeds 8 MB limit after decompression' });
            continue;
          }
          mediaFiles.push({ name: imageName, data, type, size: data.byteLength });
        } catch (_) {
          missing.push({ name: imageName, reason: 'extraction failed' });
        }
      }

      return { mediaFiles, missing };
    }

    progress(`Done — ${imported.length} notes parsed.`);
    return { fileType: 'apkg', imported, skipped, loadMediaFiles };
  }

  window.ApkgReader = { parseApkgFile };
})();
