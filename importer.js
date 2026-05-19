(function () {
  function parseDelimitedLine(line, delimiter) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (char === delimiter && !inQuotes) {
        values.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (inQuotes) return { ok: false, reason: 'Unclosed quote' };
    values.push(current.trim());
    return { ok: true, values };
  }

  function normalizeTags(raw) {
    if (!raw) return [];
    const seen = new Set();
    return String(raw)
      .split(/[;,|]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function parseTextToCards(text) {
    const rows = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const imported = [];
    const skipped = [];
    rows.forEach((rawLine, index) => {
      const row = index + 1;
      if (!rawLine.trim()) return;
      const parsed = parseDelimitedLine(rawLine, ';');
      if (!parsed.ok) {
        skipped.push({ row, reason: parsed.reason });
        return;
      }
      if (parsed.values.length !== 2) {
        skipped.push({ row, reason: 'Expected exactly one semicolon separator' });
        return;
      }
      const question = String(parsed.values[0] || '').trim();
      const answer = String(parsed.values[1] || '').trim();
      if (!question || !answer) {
        skipped.push({ row, reason: 'Front or back is empty' });
        return;
      }
      imported.push({ row, question, answer, deckName: '', tags: [] });
    });
    return { fileType: 'txt', imported, skipped };
  }

  function parseCSVText(text) {
    const rows = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const imported = [];
    const skipped = [];
    let headerMap = null;
    rows.forEach((rawLine, index) => {
      const row = index + 1;
      if (!rawLine.trim()) return;
      const parsed = parseDelimitedLine(rawLine, ',');
      if (!parsed.ok) {
        skipped.push({ row, reason: parsed.reason });
        return;
      }
      if (!headerMap) {
        const headers = parsed.values.map((value) => String(value || '').trim().toLowerCase());
        const frontIndex = headers.indexOf('front');
        const backIndex = headers.indexOf('back');
        if (frontIndex === -1 || backIndex === -1) {
          skipped.push({ row, reason: 'CSV header must include front and back columns' });
          return;
        }
        headerMap = { front: frontIndex, back: backIndex, deck: headers.indexOf('deck'), tags: headers.indexOf('tags') };
        return;
      }
      const question = String(parsed.values[headerMap.front] || '').trim();
      const answer = String(parsed.values[headerMap.back] || '').trim();
      const deckName = headerMap.deck >= 0 ? String(parsed.values[headerMap.deck] || '').trim() : '';
      const tags = headerMap.tags >= 0 ? normalizeTags(parsed.values[headerMap.tags]) : [];
      if (!question || !answer) {
        skipped.push({ row, reason: 'Front or back is empty' });
        return;
      }
      imported.push({ row, question, answer, deckName, tags });
    });
    if (!headerMap) {
      return { fileType: 'csv', imported: [], skipped: [{ row: 1, reason: 'CSV file is missing a valid header row' }] };
    }
    return { fileType: 'csv', imported, skipped };
  }

  // TSV (tab-separated values) — matches Anki's "Export Notes as Plain Text" format.
  // Supports an optional header row with columns: front, back, tags (case-insensitive).
  // Without a header, the first two columns are treated as front and back.
  function parseTSVText(text) {
    const rows = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const imported = [];
    const skipped  = [];
    let headerMap  = null;

    rows.forEach((rawLine, index) => {
      const row = index + 1;
      if (!rawLine.trim()) return;

      const values = rawLine.split('\t').map((v) => v.trim());

      // Detect header row: first non-empty row that contains "front" and "back" columns.
      if (!headerMap) {
        const lower = values.map((v) => v.toLowerCase());
        const fi = lower.indexOf('front');
        const bi = lower.indexOf('back');
        if (fi !== -1 && bi !== -1) {
          headerMap = { front: fi, back: bi, tags: lower.indexOf('tags') };
          return; // header row consumed
        }
        // No header — default to col 0 = front, col 1 = back, col 2 = tags.
        headerMap = { front: 0, back: 1, tags: 2 };
      }

      const question = String(values[headerMap.front] || '').trim();
      const answer   = String(values[headerMap.back]  || '').trim();
      const rawTags  = headerMap.tags >= 0 ? String(values[headerMap.tags] || '') : '';
      const tags     = rawTags ? normalizeTags(rawTags.replace(/\s+/g, ',')) : [];

      if (!question || !answer) {
        skipped.push({ row, reason: 'Front or back is empty' });
        return;
      }
      imported.push({ row, question, answer, deckName: '', tags });
    });

    return { fileType: 'tsv', imported, skipped };
  }

  function parseImportFile(fileName, text) {
    const lower = String(fileName || '').toLowerCase();
    if (lower.endsWith('.csv')) return parseCSVText(text);
    if (lower.endsWith('.tsv')) return parseTSVText(text);
    return parseTextToCards(text);
  }

  function duplicateKey(deckId, question, answer) {
    return `${String(deckId || '').trim().toLowerCase()}::${String(question || '').trim().toLowerCase()}::${String(answer || '').trim().toLowerCase()}`;
  }

  async function detectImportDuplicates(rows, defaultDeckId) {
    const existingCards = await window.DB.listCards();
    const existingKeys = new Set(existingCards.map((card) => duplicateKey(card.deckId, card.question, card.answer)));
    const seenInFile = new Set();
    const accepted = [];
    const duplicates = [];
    rows.forEach((row) => {
      const deckId = row.deckId || defaultDeckId || '';
      const key = duplicateKey(deckId, row.question, row.answer);
      if (existingKeys.has(key) || seenInFile.has(key)) {
        duplicates.push({ ...row, deckId });
        return;
      }
      seenInFile.add(key);
      accepted.push({ ...row, deckId });
    });
    return { accepted, duplicates };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('Failed reading image.'));
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(base64, type) {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: type || 'application/octet-stream' });
    } catch (error) {
      throw new Error('Backup contains invalid image data.');
    }
  }

  async function exportBackup() {
    const all = await window.DB.exportAll();
    const media = [];
    for (const item of all.media) {
      media.push({
        id: item.id,
        name: item.name,
        type: item.type,
        size: item.size,
        createdAt: item.createdAt,
        refCount: item.refCount,
        data: await blobToBase64(item.blob),
      });
    }
    const payload = {
      app: 'offline-flashcards',
      version: 5,
      exportedAt: new Date().toISOString(),
      manifest: {
        deckCount: all.decks.length,
        cardCount: all.cards.length,
        reviewLogCount: all.reviewLogs.length,
        mediaCount: media.length,
        metaCount: all.meta.length,
      },
      decks: all.decks,
      cards: all.cards,
      reviewLogs: all.reviewLogs,
      media,
      meta: all.meta,
    };
    return JSON.stringify(payload, null, 2);
  }

  function downloadFile(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid backup format.');
    if (payload.app !== 'offline-flashcards') throw new Error('This file is not an Offline Flashcards backup.');
    if (!Array.isArray(payload.decks)) throw new Error('Backup is missing decks.');
    if (!Array.isArray(payload.cards)) throw new Error('Backup is missing cards.');
    if (!Array.isArray(payload.reviewLogs)) throw new Error('Backup is missing review logs.');
    if (!Array.isArray(payload.media)) throw new Error('Backup is missing media.');
    if (!Array.isArray(payload.meta)) throw new Error('Backup is missing settings/meta.');

    const decks = payload.decks.map((item, index) => {
      try {
        return window.DB.prepareDeckForWrite(item, { preserveTimestamps: true });
      } catch (error) {
        throw new Error(`Deck ${index + 1}: ${error.message}`);
      }
    });
    const deckIds = new Set(decks.map((deck) => deck.id));

    const media = payload.media.map((item, index) => {
      if (!item || typeof item.id !== 'string' || typeof item.data !== 'string') {
        throw new Error(`Media ${index + 1}: invalid media record.`);
      }
      const blob = base64ToBlob(item.data, item.type);
      return window.DB.prepareMediaForWrite({
        id: item.id,
        name: item.name,
        type: item.type,
        size: item.size || blob.size,
        blob,
        createdAt: item.createdAt,
        refCount: 0,
      }, { preserveTimestamps: true });
    });
    const mediaIds = new Set(media.map((item) => item.id));

    const cards = payload.cards.map((item, index) => {
      try {
        return window.DB.prepareCardForWrite(item, { preserveTimestamps: true });
      } catch (error) {
        throw new Error(`Card ${index + 1}: ${error.message}`);
      }
    });
    cards.forEach((card, index) => {
      if (!deckIds.has(card.deckId)) throw new Error(`Card ${index + 1}: references missing deck ${card.deckId}.`);
      [...(card.frontImageIds || []), ...(card.backImageIds || [])].forEach((mediaId) => {
        if (!mediaIds.has(mediaId)) throw new Error(`Card ${index + 1}: references missing image ${mediaId}.`);
      });
    });

    const cardIds = new Set(cards.map((card) => card.id));
    const reviewLogs = payload.reviewLogs.map((item, index) => {
      const normalized = window.DB.normalizeReviewLog(item);
      if (!normalized) throw new Error(`Review log ${index + 1}: invalid review log.`);
      return normalized;
    });
    reviewLogs.forEach((log, index) => {
      if (!cardIds.has(log.cardId)) throw new Error(`Review log ${index + 1}: references missing card ${log.cardId}.`);
      if (!deckIds.has(log.deckId)) throw new Error(`Review log ${index + 1}: references missing deck ${log.deckId}.`);
    });

    const meta = payload.meta.map((item, index) => {
      const normalized = { key: String(item?.key || ''), value: item?.value };
      if (!normalized.key) throw new Error(`Meta record ${index + 1}: invalid key.`);
      return normalized;
    });

    return { decks, cards, reviewLogs, media, meta, manifest: payload.manifest || null };
  }

  async function restoreBackup(jsonText) {
    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (error) {
      throw new Error('Invalid JSON backup.');
    }
    const validated = validateBackupPayload(payload);
    await window.DB.replaceAll(validated);
    return {
      decks: validated.decks.length,
      cards: validated.cards.length,
      reviewLogs: validated.reviewLogs.length,
      media: validated.media.length,
      meta: validated.meta.length,
    };
  }

  window.Importer = {
    parseDelimitedLine,
    normalizeTags,
    parseTextToCards,
    parseCSVText,
    parseTSVText,
    parseImportFile,
    detectImportDuplicates,
    blobToBase64,
    base64ToBlob,
    exportBackup,
    downloadFile,
    validateBackupPayload,
    restoreBackup,
  };
})();
