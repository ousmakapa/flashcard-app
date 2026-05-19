(function () {
  const DB_NAME = 'offline_flashcards_v5';
  const DB_VERSION = 4;
  const DEFAULT_DECK_NAME = 'Default';
  const CARD_STATES = ['new', 'learning', 'review', 'relearning'];
  const RATINGS = ['again', 'hard', 'good', 'easy'];
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction;
        const oldVersion = event.oldVersion || 0;

        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('reviewLogs')) db.createObjectStore('reviewLogs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (oldVersion < 3 && !db.objectStoreNames.contains('media')) {
          db.createObjectStore('media', { keyPath: 'id' });
        }

        const decks = transaction.objectStore('decks');
        ensureIndex(decks, 'name', 'name');
        ensureIndex(decks, 'updatedAt', 'updatedAt');

        const cards = transaction.objectStore('cards');
        ensureIndex(cards, 'deckId', 'deckId');
        ensureIndex(cards, 'state', 'state');
        ensureIndex(cards, 'dueAt', 'dueAt');
        ensureIndex(cards, 'updatedAt', 'updatedAt');
        ensureIndex(cards, 'suspended', 'suspended');
        ensureIndex(cards, 'state_dueAt', ['state', 'dueAt']);
        ensureIndex(cards, 'deckId_dueAt', ['deckId', 'dueAt']);
        ensureIndex(cards, 'deckId_state_dueAt', ['deckId', 'state', 'dueAt']);
        ensureIndex(cards, 'deckId_updatedAt', ['deckId', 'updatedAt']);

        const logs = transaction.objectStore('reviewLogs');
        ensureIndex(logs, 'cardId', 'cardId');
        ensureIndex(logs, 'deckId', 'deckId');
        ensureIndex(logs, 'timestamp', 'timestamp');
        ensureIndex(logs, 'deckId_timestamp', ['deckId', 'timestamp']);

        const media = transaction.objectStore('media');
        ensureIndex(media, 'createdAt', 'createdAt');
        ensureIndex(media, 'refCount', 'refCount');
      };
      request.onblocked = () => reject(new Error('Database upgrade is blocked by another open tab or window. Close other copies of this app and reopen it.'));
      request.onerror = () => reject(request.error || new Error('Failed to open database.'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
    });
    return dbPromise;
  }

  function ensureIndex(store, name, keyPath, options) {
    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options || { unique: false });
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  async function tx(storeNames, mode, executor) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      const stores = {};
      storeNames.forEach((name) => { stores[name] = transaction.objectStore(name); });
      let result;
      let settled = false;

      transaction.oncomplete = () => { settled = true; resolve(result); };
      transaction.onerror = () => { settled = true; reject(transaction.error || new Error('Transaction failed.')); };
      transaction.onabort = () => { settled = true; reject(transaction.error || new Error('Transaction aborted.')); };

      Promise.resolve()
        .then(() => executor(stores, transaction))
        .then((value) => { result = value; })
        .catch((error) => {
          if (!settled) {
            try { transaction.abort(); } catch (abortError) {}
          }
          reject(error);
        });
    });
  }

  function iterateCursor(request, onItem) {
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error('Cursor failed.'));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        onItem(cursor.value, cursor);
      };
    });
  }

  function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function nowISO() { return new Date().toISOString(); }

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function isValidISO(value) {
    return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
  }

  function clampNumber(value, fallback, min, max, roundInteger) {
    let next = Number(value);
    if (!Number.isFinite(next)) next = fallback;
    if (typeof min === 'number') next = Math.max(min, next);
    if (typeof max === 'number') next = Math.min(max, next);
    if (roundInteger) next = Math.round(next);
    return next;
  }

  function normalizeDeckName(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  }

  function validateDeckName(value) {
    const name = normalizeDeckName(value);
    if (!name) throw new Error('Deck name is required.');
    if (name.length > 120) throw new Error('Deck name must be 120 characters or fewer.');
    return name;
  }

  function normalizeTags(value) {
    const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    const seen = new Set();
    return raw
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function normalizeIdList(value) {
    const raw = Array.isArray(value) ? value : [];
    const seen = new Set();
    return raw
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  }

  function buildSearchText(record) {
    return [record.question, record.answer, ...(record.tags || [])].join(' ').toLowerCase();
  }

  function normalizeDeckForRead(deck) {
    if (!deck) return null;
    const idValue = String(deck.id || '').trim();
    const nameValue = normalizeDeckName(deck.name || deck.id || '');
    if (!idValue || !nameValue) return null;
    const createdAt = isValidISO(deck.createdAt) ? deck.createdAt : isValidISO(deck.updatedAt) ? deck.updatedAt : nowISO();
    const updatedAt = isValidISO(deck.updatedAt) ? deck.updatedAt : createdAt;
    return { id: idValue, name: nameValue, createdAt, updatedAt };
  }

  function prepareDeckForWrite(deck, options) {
    const preserveTimestamps = !!(options && options.preserveTimestamps);
    const normalized = normalizeDeckForRead(deck) || {};
    const now = nowISO();
    return {
      id: normalized.id || id('deck'),
      name: validateDeckName(normalized.name || deck?.name || ''),
      createdAt: preserveTimestamps && isValidISO(deck?.createdAt) ? deck.createdAt : (normalized.createdAt || now),
      updatedAt: preserveTimestamps && isValidISO(deck?.updatedAt) ? deck.updatedAt : now,
    };
  }

  function normalizeCardForRead(record) {
    if (!record) return null;
    const createdAt = isValidISO(record.createdAt) ? record.createdAt : isValidISO(record.updatedAt) ? record.updatedAt : nowISO();
    const updatedAt = isValidISO(record.updatedAt) ? record.updatedAt : createdAt;
    const dueAt = isValidISO(record.dueAt) ? record.dueAt : createdAt;
    const state = CARD_STATES.includes(record.state) ? record.state : 'new';
    const question = String(record.question || '').trim();
    const answer = String(record.answer || '').trim();
    if (!question || !answer) return null;
    const card = {
      id: String(record.id || id('card')),
      deckId: String(record.deckId || ''),
      question,
      answer,
      tags: normalizeTags(record.tags),
      frontImageIds: normalizeIdList(record.frontImageIds),
      backImageIds: normalizeIdList(record.backImageIds),
      createdAt,
      updatedAt,
      state,
      dueAt,
      intervalDays: clampNumber(record.intervalDays, 0, 0, null, true),
      easeFactor: Number(clampNumber(record.easeFactor, 2.5, 1.3, 5, false).toFixed(2)),
      reps: clampNumber(record.reps, 0, 0, null, true),
      lapses: clampNumber(record.lapses, 0, 0, null, true),
      lastReviewedAt: isValidISO(record.lastReviewedAt) ? record.lastReviewedAt : null,
      lastRating: RATINGS.includes(record.lastRating) ? record.lastRating : null,
      lastReviewIntervalDays: clampNumber(record.lastReviewIntervalDays, 0, 0, null, true),
      suspended: !!record.suspended,
      cardType: record.cardType === 'cloze' ? 'cloze' : 'basic',
    };
    card.searchText = buildSearchText(card);
    return card;
  }

  function prepareCardForWrite(record, options) {
    const preserveTimestamps = !!(options && options.preserveTimestamps);
    const normalized = normalizeCardForRead(record) || {};
    const now = nowISO();
    const card = {
      ...normalized,
      id: normalized.id || String(record?.id || id('card')),
      deckId: String(normalized.deckId || record?.deckId || '').trim(),
      question: String(normalized.question || '').trim(),
      answer: String(normalized.answer || '').trim(),
      tags: normalizeTags(normalized.tags),
      frontImageIds: normalizeIdList(normalized.frontImageIds),
      backImageIds: normalizeIdList(normalized.backImageIds),
      createdAt: preserveTimestamps && isValidISO(record?.createdAt) ? record.createdAt : (normalized.createdAt || now),
      updatedAt: preserveTimestamps && isValidISO(record?.updatedAt) ? record.updatedAt : now,
      state: CARD_STATES.includes(normalized.state) ? normalized.state : 'new',
      dueAt: isValidISO(normalized.dueAt) ? normalized.dueAt : now,
      intervalDays: clampNumber(normalized.intervalDays, 0, 0, null, true),
      easeFactor: Number(clampNumber(normalized.easeFactor, 2.5, 1.3, 5, false).toFixed(2)),
      reps: clampNumber(normalized.reps, 0, 0, null, true),
      lapses: clampNumber(normalized.lapses, 0, 0, null, true),
      lastReviewedAt: isValidISO(normalized.lastReviewedAt) ? normalized.lastReviewedAt : null,
      lastRating: RATINGS.includes(normalized.lastRating) ? normalized.lastRating : null,
      lastReviewIntervalDays: clampNumber(normalized.lastReviewIntervalDays, 0, 0, null, true),
      suspended: !!normalized.suspended,
      cardType: normalized.cardType === 'cloze' ? 'cloze' : 'basic',
    };
    if (!card.deckId) throw new Error('Card deck is required.');
    if (!card.question) throw new Error('Front is required.');
    if (!card.answer) throw new Error('Back is required.');
    card.searchText = buildSearchText(card);
    return card;
  }

  function normalizeReviewLog(log) {
    if (!log || !log.id || !log.cardId || !log.deckId || !RATINGS.includes(log.rating) || !isValidISO(log.timestamp)) return null;
    return {
      id: String(log.id),
      cardId: String(log.cardId),
      deckId: String(log.deckId),
      timestamp: log.timestamp,
      rating: log.rating,
      previousState: CARD_STATES.includes(log.previousState) ? log.previousState : 'new',
      newState: CARD_STATES.includes(log.newState) ? log.newState : 'new',
      previousIntervalDays: clampNumber(log.previousIntervalDays, 0, 0, null, true),
      newIntervalDays: clampNumber(log.newIntervalDays, 0, 0, null, true),
      previousEaseFactor: Number(clampNumber(log.previousEaseFactor, 2.5, 1.3, 5, false).toFixed(2)),
      newEaseFactor: Number(clampNumber(log.newEaseFactor, 2.5, 1.3, 5, false).toFixed(2)),
      studySeconds: clampNumber(log.studySeconds, 0, 0, null, true),
    };
  }

  function normalizeMediaForRead(record) {
    if (!record || !record.id || !record.blob) return null;
    const type = String(record.type || record.mime || record.blob.type || '').trim();
    if (!type.startsWith('image/')) return null;
    return {
      id: String(record.id),
      name: String(record.name || 'image').trim() || 'image',
      type,
      size: clampNumber(record.size || record.blob.size, record.blob.size || 0, 0, null, true),
      blob: record.blob,
      createdAt: isValidISO(record.createdAt) ? record.createdAt : nowISO(),
      refCount: clampNumber(record.refCount, 0, 0, null, true),
    };
  }

  function prepareMediaForWrite(record, options) {
    const preserveTimestamps = !!(options && options.preserveTimestamps);
    const normalized = normalizeMediaForRead(record) || {};
    const blob = record?.blob || normalized.blob;
    if (!(blob instanceof Blob)) throw new Error('Invalid image payload.');
    const type = String(record?.type || normalized.type || blob.type || '').trim();
    if (!type.startsWith('image/')) throw new Error('Only image files are supported.');
    const size = clampNumber(record?.size || blob.size, blob.size || 0, 0, null, true);
    if (size > MAX_IMAGE_BYTES) throw new Error(`Image is too large. Limit is ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB per image.`);
    const now = nowISO();
    return {
      id: String(record?.id || normalized.id || id('media')),
      name: String(record?.name || normalized.name || 'image').trim() || 'image',
      type,
      size,
      blob,
      createdAt: preserveTimestamps && isValidISO(record?.createdAt) ? record.createdAt : (normalized.createdAt || now),
      refCount: clampNumber(record?.refCount ?? normalized.refCount, 0, 0, null, true),
    };
  }

  function normalizeMetaRecord(record) {
    if (!record || typeof record.key !== 'string') return null;
    return { key: record.key, value: clone(record.value) };
  }

  function uniqueIdList(ids) {
    return normalizeIdList(ids);
  }

  function buildRefCountsFromCards(cards) {
    const counts = new Map();
    (cards || []).forEach((card) => {
      uniqueIdList([...(card.frontImageIds || []), ...(card.backImageIds || [])]).forEach((mediaId) => {
        counts.set(mediaId, (counts.get(mediaId) || 0) + 1);
      });
    });
    return counts;
  }

  async function ensureDefaultDeck() {
    return tx(['decks'], 'readwrite', async ({ decks }) => {
      const all = (await reqToPromise(decks.getAll())).map(normalizeDeckForRead).filter(Boolean);
      const existing = all.find((deck) => deck.name.toLowerCase() === DEFAULT_DECK_NAME.toLowerCase());
      if (existing) return existing;
      const defaultDeck = prepareDeckForWrite({ id: 'default', name: DEFAULT_DECK_NAME });
      decks.put(defaultDeck);
      return defaultDeck;
    });
  }

  async function listDecks() {
    const raw = await tx(['decks'], 'readonly', async ({ decks }) => reqToPromise(decks.getAll()));
    const normalized = (raw || []).map(normalizeDeckForRead).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    if (normalized.find((deck) => deck.name === DEFAULT_DECK_NAME)) return normalized;
    // Default deck is missing — create it and re-read.
    await ensureDefaultDeck();
    const updated = await tx(['decks'], 'readonly', async ({ decks }) => reqToPromise(decks.getAll()));
    return (updated || []).map(normalizeDeckForRead).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getDeck(deckId) {
    if (!deckId) return null;
    const deck = await tx(['decks'], 'readonly', async ({ decks }) => reqToPromise(decks.get(deckId)));
    return normalizeDeckForRead(deck);
  }

  async function findDeckByNameCI(name, stores) {
    const target = normalizeDeckName(name).toLowerCase();
    const all = stores ? await reqToPromise(stores.decks.getAll()) : await tx(['decks'], 'readonly', async ({ decks }) => reqToPromise(decks.getAll()));
    return (all || []).map(normalizeDeckForRead).filter(Boolean).find((deck) => deck.name.toLowerCase() === target) || null;
  }

  async function createDeck(name) {
    const cleanName = validateDeckName(name);
    return tx(['decks'], 'readwrite', async ({ decks }) => {
      const duplicate = await findDeckByNameCI(cleanName, { decks });
      if (duplicate) throw new Error('A deck with this name already exists.');
      const deck = prepareDeckForWrite({ name: cleanName });
      decks.put(deck);
      return deck;
    });
  }

  async function renameDeck(deckId, newName) {
    const cleanName = validateDeckName(newName);
    return tx(['decks', 'cards', 'reviewLogs'], 'readwrite', async ({ decks, cards, reviewLogs }) => {
      const existing = normalizeDeckForRead(await reqToPromise(decks.get(deckId)));
      if (!existing) throw new Error('Deck not found.');
      const duplicate = await findDeckByNameCI(cleanName, { decks });
      if (duplicate && duplicate.id !== existing.id) throw new Error('Another deck already uses this name.');
      const updated = prepareDeckForWrite({ ...existing, name: cleanName, createdAt: existing.createdAt });
      decks.put(updated);

      await iterateCursor(cards.index('deckId').openCursor(IDBKeyRange.only(deckId)), (value, cursor) => {
        const card = normalizeCardForRead(value);
        if (!card) {
          cursor.delete();
          cursor.continue();
          return;
        }
        card.deckId = updated.id;
        card.updatedAt = nowISO();
        card.searchText = buildSearchText(card);
        cursor.update(card);
        cursor.continue();
      });
      await iterateCursor(reviewLogs.index('deckId').openCursor(IDBKeyRange.only(deckId)), (value, cursor) => {
        const log = normalizeReviewLog(value);
        if (!log) {
          cursor.delete();
          cursor.continue();
          return;
        }
        log.deckId = updated.id;
        cursor.update(log);
        cursor.continue();
      });
      return updated;
    });
  }

  async function deleteDeck(deckId, mode) {
    if (!deckId) throw new Error('Deck id is required.');
    const deleteMode = mode === 'delete-cards' ? 'delete-cards' : 'move-to-default';
    return tx(['decks', 'cards', 'reviewLogs', 'media'], 'readwrite', async ({ decks, cards, reviewLogs, media }) => {
      const target = normalizeDeckForRead(await reqToPromise(decks.get(deckId)));
      if (!target) throw new Error('Deck not found.');
      if (deleteMode === 'move-to-default' && target.name === DEFAULT_DECK_NAME) {
        throw new Error('The Default deck cannot be deleted by moving cards into itself.');
      }

      let defaultDeck = null;
      if (deleteMode === 'move-to-default') {
        defaultDeck = await findDeckByNameCI(DEFAULT_DECK_NAME, { decks });
        if (!defaultDeck) {
          defaultDeck = prepareDeckForWrite({ id: 'default', name: DEFAULT_DECK_NAME });
          decks.put(defaultDeck);
        }
      }

      const cardsToDelete = [];
      const cardIdsToDelete = new Set();
      await iterateCursor(cards.index('deckId').openCursor(IDBKeyRange.only(deckId)), (value, cursor) => {
        const card = normalizeCardForRead(value);
        if (!card) {
          cursor.delete();
          cursor.continue();
          return;
        }
        if (deleteMode === 'delete-cards') {
          cardsToDelete.push(card);
          cardIdsToDelete.add(card.id);
          cursor.delete();
        } else {
          const moved = prepareCardForWrite({ ...card, deckId: defaultDeck.id, createdAt: card.createdAt });
          cursor.update(moved);
        }
        cursor.continue();
      });

      if (deleteMode === 'delete-cards') {
        const diff = new Map();
        cardsToDelete.forEach((card) => {
          uniqueIdList([...(card.frontImageIds || []), ...(card.backImageIds || [])]).forEach((mediaId) => {
            diff.set(mediaId, (diff.get(mediaId) || 0) - 1);
          });
        });
        await applyMediaRefDiff(media, diff);
      }

      await iterateCursor(reviewLogs.index('deckId').openCursor(IDBKeyRange.only(deckId)), (value, cursor) => {
        const log = normalizeReviewLog(value);
        if (!log) {
          cursor.delete();
          cursor.continue();
          return;
        }
        if (deleteMode === 'delete-cards' || cardIdsToDelete.has(log.cardId)) {
          cursor.delete();
        } else {
          log.deckId = defaultDeck.id;
          cursor.update(log);
        }
        cursor.continue();
      });

      decks.delete(deckId);
      return { deletedDeckId: deckId, mode: deleteMode, affectedCount: deleteMode === 'delete-cards' ? cardsToDelete.length : 'moved' };
    });
  }

  async function listCards() {
    const cards = await tx(['cards'], 'readonly', async ({ cards }) => reqToPromise(cards.getAll()));
    return (cards || []).map(normalizeCardForRead).filter(Boolean);
  }

  async function listCardKeys() {
    return tx(['cards'], 'readonly', async ({ cards }) => {
      return new Promise((resolve, reject) => {
        const keys = [];
        const req = cards.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) { resolve(keys); return; }
          const r = cursor.value;
          keys.push({ deckId: r.deckId || '', question: r.question || '', answer: r.answer || '' });
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  async function getCard(cardId) {
    if (!cardId) return null;
    const card = await tx(['cards'], 'readonly', async ({ cards }) => reqToPromise(cards.get(cardId)));
    return normalizeCardForRead(card);
  }

  async function getCardsByIds(ids) {
    const list = uniqueIdList(ids);
    if (!list.length) return [];
    return tx(['cards'], 'readonly', async ({ cards }) => {
      const out = [];
      for (const cardId of list) {
        const card = normalizeCardForRead(await reqToPromise(cards.get(cardId)));
        if (card) out.push(card);
      }
      return out;
    });
  }

  async function getCardsByDeck(deckId) {
    if (!deckId) return [];
    return tx(['cards'], 'readonly', async ({ cards }) => {
      const out = [];
      await iterateCursor(cards.index('deckId').openCursor(IDBKeyRange.only(deckId)), (value, cursor) => {
        const card = normalizeCardForRead(value);
        if (card) out.push(card);
        cursor.continue();
      });
      return out;
    });
  }

  async function validateImageRefsExist(mediaStore, ids) {
    const unique = uniqueIdList(ids);
    for (const mediaId of unique) {
      const media = normalizeMediaForRead(await reqToPromise(mediaStore.get(mediaId)));
      if (!media) throw new Error('A selected image could not be found. Please try again.');
    }
  }

  async function applyMediaRefDiff(mediaStore, diffMap) {
    let deleted = 0;
    for (const [mediaId, delta] of diffMap.entries()) {
      if (!delta) continue;
      const current = normalizeMediaForRead(await reqToPromise(mediaStore.get(mediaId)));
      if (!current) {
        if (delta > 0) throw new Error('A referenced image could not be found.');
        continue;
      }
      const nextCount = Math.max(0, (current.refCount || 0) + delta);
      if (nextCount === 0) {
        mediaStore.delete(mediaId);
        deleted += 1;
      } else {
        mediaStore.put({ ...current, refCount: nextCount });
      }
    }
    return deleted;
  }

  function diffImageRefs(oldIds, newIds) {
    const diff = new Map();
    const oldMap = new Map();
    const newMap = new Map();
    uniqueIdList(oldIds).forEach((id) => oldMap.set(id, (oldMap.get(id) || 0) + 1));
    uniqueIdList(newIds).forEach((id) => newMap.set(id, (newMap.get(id) || 0) + 1));
    new Set([...oldMap.keys(), ...newMap.keys()]).forEach((id) => {
      const delta = (newMap.get(id) || 0) - (oldMap.get(id) || 0);
      if (delta) diff.set(id, delta);
    });
    return diff;
  }



  async function bulkCreateCards(cardInputs) {
    const cards = (cardInputs || []).map((item) => prepareCardForWrite(item));
    const CHUNK = 300;
    let total = 0;
    for (let i = 0; i < cards.length; i += CHUNK) {
      const chunk = cards.slice(i, i + CHUNK);
      await tx(['decks', 'cards', 'media'], 'readwrite', async ({ decks, cards: cardsStore, media }) => {
        const deckCache = new Map();
        for (const card of chunk) {
          if (!deckCache.has(card.deckId)) {
            deckCache.set(card.deckId, normalizeDeckForRead(await reqToPromise(decks.get(card.deckId))));
          }
          if (!deckCache.get(card.deckId)) throw new Error(`Selected deck does not exist: ${card.deckId}`);
          await validateImageRefsExist(media, [...card.frontImageIds, ...card.backImageIds]);
        }
        const diff = new Map();
        chunk.forEach((card) => {
          cardsStore.put(card);
          uniqueIdList([...(card.frontImageIds || []), ...(card.backImageIds || [])]).forEach((mediaId) => {
            diff.set(mediaId, (diff.get(mediaId) || 0) + 1);
          });
        });
        await applyMediaRefDiff(media, diff);
      });
      total += chunk.length;
      // yield to browser between chunks so UI stays responsive
      await new Promise((r) => setTimeout(r, 0));
    }
    return total;
  }

  async function createCard(cardInput) {
    const clean = prepareCardForWrite(cardInput || {});
    return tx(['decks', 'cards', 'media'], 'readwrite', async ({ decks, cards, media }) => {
      const deck = normalizeDeckForRead(await reqToPromise(decks.get(clean.deckId)));
      if (!deck) throw new Error('Selected deck does not exist.');
      await validateImageRefsExist(media, [...clean.frontImageIds, ...clean.backImageIds]);
      cards.put(clean);
      const diff = diffImageRefs([], [...clean.frontImageIds, ...clean.backImageIds]);
      await applyMediaRefDiff(media, diff);
      return clean;
    });
  }

  async function updateCard(cardInput) {
    if (!cardInput || !cardInput.id) throw new Error('Card id is required for update.');
    return tx(['decks', 'cards', 'reviewLogs', 'media'], 'readwrite', async ({ decks, cards, reviewLogs, media }) => {
      const existing = normalizeCardForRead(await reqToPromise(cards.get(cardInput.id)));
      if (!existing) throw new Error('Card not found.');
      const merged = prepareCardForWrite({ ...existing, ...cardInput, createdAt: existing.createdAt });
      const deck = normalizeDeckForRead(await reqToPromise(decks.get(merged.deckId)));
      if (!deck) throw new Error('Selected deck does not exist.');
      await validateImageRefsExist(media, [...merged.frontImageIds, ...merged.backImageIds]);
      cards.put(merged);
      const diff = diffImageRefs([...existing.frontImageIds, ...existing.backImageIds], [...merged.frontImageIds, ...merged.backImageIds]);
      await applyMediaRefDiff(media, diff);
      if (existing.deckId !== merged.deckId) {
        await iterateCursor(reviewLogs.index('cardId').openCursor(IDBKeyRange.only(existing.id)), (value, cursor) => {
          const log = normalizeReviewLog(value);
          if (!log) {
            cursor.delete();
            cursor.continue();
            return;
          }
          log.deckId = merged.deckId;
          cursor.update(log);
          cursor.continue();
        });
      }
      return merged;
    });
  }

  async function deleteCard(cardId) {
    if (!cardId) throw new Error('Card id is required.');
    return tx(['cards', 'reviewLogs', 'media'], 'readwrite', async ({ cards, reviewLogs, media }) => {
      const existing = normalizeCardForRead(await reqToPromise(cards.get(cardId)));
      if (!existing) return true;
      cards.delete(cardId);
      await iterateCursor(reviewLogs.index('cardId').openCursor(IDBKeyRange.only(cardId)), (value, cursor) => {
        cursor.delete();
        cursor.continue();
      });
      const diff = diffImageRefs([...existing.frontImageIds, ...existing.backImageIds], []);
      await applyMediaRefDiff(media, diff);
      return true;
    });
  }

  async function toggleSuspend(cardId, suspended) {
    return tx(['cards'], 'readwrite', async ({ cards }) => {
      const existing = normalizeCardForRead(await reqToPromise(cards.get(cardId)));
      if (!existing) throw new Error('Card not found.');
      const updated = prepareCardForWrite({ ...existing, suspended: !!suspended, createdAt: existing.createdAt });
      cards.put(updated);
      return updated;
    });
  }

  async function bulkMoveCards(cardIds, deckId) {
    const targetIds = uniqueIdList(cardIds);
    if (!targetIds.length) return 0;
    return tx(['decks', 'cards', 'reviewLogs'], 'readwrite', async ({ decks, cards, reviewLogs }) => {
      const deck = normalizeDeckForRead(await reqToPromise(decks.get(deckId)));
      if (!deck) throw new Error('Selected deck does not exist.');
      let count = 0;
      for (const cardId of targetIds) {
        const existing = normalizeCardForRead(await reqToPromise(cards.get(cardId)));
        if (!existing) continue;
        const updated = prepareCardForWrite({ ...existing, deckId: deck.id, createdAt: existing.createdAt });
        cards.put(updated);
        if (existing.deckId !== updated.deckId) {
          await iterateCursor(reviewLogs.index('cardId').openCursor(IDBKeyRange.only(cardId)), (value, cursor) => {
            const log = normalizeReviewLog(value);
            if (!log) {
              cursor.delete();
              cursor.continue();
              return;
            }
            log.deckId = updated.deckId;
            cursor.update(log);
            cursor.continue();
          });
        }
        count += 1;
      }
      return count;
    });
  }

  async function bulkSuspendCards(cardIds, suspended) {
    const targetIds = uniqueIdList(cardIds);
    if (!targetIds.length) return 0;
    return tx(['cards'], 'readwrite', async ({ cards }) => {
      let count = 0;
      for (const cardId of targetIds) {
        const existing = normalizeCardForRead(await reqToPromise(cards.get(cardId)));
        if (!existing) continue;
        cards.put(prepareCardForWrite({ ...existing, suspended: !!suspended, createdAt: existing.createdAt }));
        count += 1;
      }
      return count;
    });
  }

  async function bulkResetScheduling(cardIds) {
    const targetIds = uniqueIdList(cardIds);
    if (!targetIds.length) return 0;
    return tx(['cards'], 'readwrite', async ({ cards }) => {
      let count = 0;
      for (const cardId of targetIds) {
        const existing = normalizeCardForRead(await reqToPromise(cards.get(cardId)));
        if (!existing) continue;
        cards.put(prepareCardForWrite({
          ...existing,
          state: 'new',
          dueAt: nowISO(),
          intervalDays: 0,
          easeFactor: 2.5,
          reps: 0,
          lapses: 0,
          lastReviewedAt: null,
          lastRating: null,
          lastReviewIntervalDays: 0,
          suspended: false,
          createdAt: existing.createdAt,
        }));
        count += 1;
      }
      return count;
    });
  }

  async function bulkDeleteCards(cardIds) {
    const targetIds = uniqueIdList(cardIds);
    if (!targetIds.length) return 0;
    return tx(['cards', 'reviewLogs', 'media'], 'readwrite', async ({ cards, reviewLogs, media }) => {
      let count = 0;
      const diff = new Map();
      for (const cardId of targetIds) {
        const existing = normalizeCardForRead(await reqToPromise(cards.get(cardId)));
        if (!existing) continue;
        cards.delete(cardId);
        await iterateCursor(reviewLogs.index('cardId').openCursor(IDBKeyRange.only(cardId)), (value, cursor) => {
          cursor.delete();
          cursor.continue();
        });
        uniqueIdList([...(existing.frontImageIds || []), ...(existing.backImageIds || [])]).forEach((mediaId) => {
          diff.set(mediaId, (diff.get(mediaId) || 0) - 1);
        });
        count += 1;
      }
      await applyMediaRefDiff(media, diff);
      return count;
    });
  }

  async function countCards() {
    return tx(['cards'], 'readonly', async ({ cards }) => reqToPromise(cards.count()));
  }

  async function countReviewLogs() {
    return tx(['reviewLogs'], 'readonly', async ({ reviewLogs }) => reqToPromise(reviewLogs.count()));
  }

  async function countMedia() {
    return tx(['media'], 'readonly', async ({ media }) => reqToPromise(media.count()));
  }

  async function countMeta() {
    return tx(['meta'], 'readonly', async ({ meta }) => reqToPromise(meta.count()));
  }

  async function getStorageSummary() {
    const [deckCount, cardCount, reviewLogCount, metaCount, mediaCount] = await Promise.all([
      tx(['decks'], 'readonly', async ({ decks }) => reqToPromise(decks.count())),
      countCards(),
      countReviewLogs(),
      countMeta(),
      countMedia(),
    ]);
    return { deckCount, cardCount, reviewLogCount, metaCount, mediaCount };
  }

  async function countDueBefore(iso, deckId) {
    return tx(['cards'], 'readonly', async ({ cards }) => {
      const index = deckId ? cards.index('deckId_dueAt') : cards.index('dueAt');
      const range = deckId ? IDBKeyRange.bound([deckId, ''], [deckId, iso], false, false) : IDBKeyRange.upperBound(iso, false);
      let count = 0;
      await iterateCursor(index.openCursor(range), (value, cursor) => {
        const card = normalizeCardForRead(value);
        if (card && !card.suspended && card.dueAt <= iso) count += 1;
        cursor.continue();
      });
      return count;
    });
  }

  async function countByState(state, deckId) {
    return tx(['cards'], 'readonly', async ({ cards }) => {
      const index = deckId ? cards.index('deckId_state_dueAt') : cards.index('state');
      let count = 0;
      const range = deckId ? IDBKeyRange.bound([deckId, state, ''], [deckId, state, '\uffff']) : IDBKeyRange.only(state);
      await iterateCursor(index.openCursor(range), (value, cursor) => {
        const card = normalizeCardForRead(value);
        if (card) count += 1;
        cursor.continue();
      });
      return count;
    });
  }

  async function getReviewScopeSnapshot(deckId) {
    const endToday = new Date();
    endToday.setHours(23, 59, 59, 999);
    const [dueNow, dueToday, newCount] = await Promise.all([
      countDueBefore(nowISO(), deckId),
      countDueBefore(endToday.toISOString(), deckId),
      countByState('new', deckId),
    ]);
    return { dueNow, dueToday, newCount };
  }

  async function fetchDueByState(state, deckId) {
    return tx(['cards'], 'readonly', async ({ cards }) => {
      const now = nowISO();
      const index = deckId ? cards.index('deckId_state_dueAt') : cards.index('state_dueAt');
      const range = deckId
        ? IDBKeyRange.bound([deckId, state, ''], [deckId, state, now], false, false)
        : IDBKeyRange.bound([state, ''], [state, now], false, false);
      const out = [];
      await iterateCursor(index.openCursor(range), (value, cursor) => {
        const card = normalizeCardForRead(value);
        if (card && !card.suspended && card.state === state && card.dueAt <= now) out.push(card);
        cursor.continue();
      });
      return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    });
  }

  async function getTodayNewStudiedCount(deckId) {
    return tx(['reviewLogs'], 'readonly', async ({ reviewLogs }) => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const range = deckId ? IDBKeyRange.bound([deckId, start.toISOString()], [deckId, end.toISOString()]) : IDBKeyRange.bound(start.toISOString(), end.toISOString());
      const index = deckId ? reviewLogs.index('deckId_timestamp') : reviewLogs.index('timestamp');
      const seen = new Set();
      await iterateCursor(index.openCursor(range), (value, cursor) => {
        const log = normalizeReviewLog(value);
        if (log && log.previousState === 'new') seen.add(log.cardId);
        cursor.continue();
      });
      return seen.size;
    });
  }

  async function getReviewQueueSnapshot(deckId, newCardsPerDay) {
    const [learning, relearning, review, news, newStudiedToday, nextDueCard] = await Promise.all([
      fetchDueByState('learning', deckId),
      fetchDueByState('relearning', deckId),
      fetchDueByState('review', deckId),
      fetchDueByState('new', deckId),
      getTodayNewStudiedCount(deckId),
      findNextDue(deckId),
    ]);
    const remainingNew = Math.max(0, Number(newCardsPerDay || 0) - newStudiedToday);
    const allowedNew = news.slice(0, remainingNew);
    const hiddenNewCount = Math.max(0, news.length - allowedNew.length);
    return {
      cards: [...learning, ...relearning, ...allowedNew, ...review],
      counts: { learning: learning.length, relearning: relearning.length, new: allowedNew.length, review: review.length },
      hiddenNewCount,
      newStudiedToday,
      nextDueAt: nextDueCard ? nextDueCard.dueAt : null,
    };
  }

  async function findNextDue(deckId) {
    return tx(['cards'], 'readonly', async ({ cards }) => {
      const now = nowISO();
      const index = deckId ? cards.index('deckId_dueAt') : cards.index('dueAt');
      const range = deckId ? IDBKeyRange.lowerBound([deckId, now], true) : IDBKeyRange.lowerBound(now, true);
      return new Promise((resolve, reject) => {
        const request = index.openCursor(range);
        request.onerror = () => reject(request.error || new Error('Failed looking up next due card.'));
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve(null);
            return;
          }
          const card = normalizeCardForRead(cursor.value);
          if (card && !card.suspended) {
            resolve(card);
            return;
          }
          cursor.continue();
        };
      });
    });
  }

  async function getDashboardSnapshot() {
    const [decks, cards, logs] = await Promise.all([listDecks(), listCards(), listReviewLogs()]);
    return window.Stats.computeDashboard(cards, decks, logs);
  }

  async function searchCards(options) {
    const query = String(options?.query || '').trim().toLowerCase();
    const deckId = options?.deckId || '';
    const suspendFilter = options?.suspendFilter || 'all';
    const page = Math.max(1, Number(options?.page || 1));
    const pageSize = Math.max(1, Math.min(200, Number(options?.pageSize || 20)));

    return tx(['cards'], 'readonly', async ({ cards }) => {
      let source;
      let range = null;
      let direction = 'prev';

      if (deckId && !query) {
        source = cards.index('deckId_updatedAt');
        range = IDBKeyRange.bound([deckId, ''], [deckId, '\uffff']);
      } else {
        source = cards.index('updatedAt');
      }

      const matched = [];
      await new Promise((resolve, reject) => {
        const request = source.openCursor(range, direction);
        request.onerror = () => reject(request.error || new Error('Search failed.'));
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve();
            return;
          }
          const card = normalizeCardForRead(cursor.value);
          let include = !!card;
          if (include && deckId && card.deckId !== deckId) include = false;
          if (include && suspendFilter === 'active' && card.suspended) include = false;
          if (include && suspendFilter === 'suspended' && !card.suspended) include = false;
          if (include && query && !card.searchText.includes(query)) include = false;
          if (include) matched.push(card);
          cursor.continue();
        };
      });

      const total = matched.length;
      const start = (page - 1) * pageSize;
      return { total, items: matched.slice(start, start + pageSize) };
    });
  }

  async function createMediaFromFile(file) {
    if (!(file instanceof Blob)) throw new Error('No file selected.');
    const name = file.name || 'image';
    return tx(['media'], 'readwrite', async ({ media }) => {
      const record = prepareMediaForWrite({ name, type: file.type, size: file.size, blob: file, refCount: 0 });
      media.put(record);
      return record;
    });
  }

  async function bulkCreateMedia(mediaInputs) {
    const records = (mediaInputs || []).map((item) => prepareMediaForWrite({
      id: item?.id,
      name: item?.name,
      type: item?.type,
      size: item?.size,
      blob: item?.blob,
      refCount: 0,
    }));
    if (!records.length) return [];
    return tx(['media'], 'readwrite', async ({ media }) => {
      records.forEach((record) => media.put(record));
      return records;
    });
  }

  async function getMedia(mediaId) {
    if (!mediaId) return null;
    const record = await tx(['media'], 'readonly', async ({ media }) => reqToPromise(media.get(mediaId)));
    return normalizeMediaForRead(record);
  }

  async function listMedia() {
    const records = await tx(['media'], 'readonly', async ({ media }) => reqToPromise(media.getAll()));
    return (records || []).map(normalizeMediaForRead).filter(Boolean);
  }

  async function deleteMedia(mediaId) {
    if (!mediaId) return false;
    return tx(['media'], 'readwrite', async ({ media }) => {
      media.delete(mediaId);
      return true;
    });
  }

  async function deleteMediaIfUnused(mediaIds) {
    const ids = uniqueIdList(mediaIds);
    if (!ids.length) return 0;
    return tx(['media'], 'readwrite', async ({ media }) => {
      let deleted = 0;
      for (const mediaId of ids) {
        const record = normalizeMediaForRead(await reqToPromise(media.get(mediaId)));
        if (record && clampNumber(record.refCount, 0, 0, null, true) === 0) {
          media.delete(mediaId);
          deleted += 1;
        }
      }
      return deleted;
    });
  }

  async function findOrphanMediaIds() {
    return tx(['media'], 'readonly', async ({ media }) => {
      const out = [];
      await iterateCursor(media.index('refCount').openCursor(IDBKeyRange.only(0)), (value, cursor) => {
        const record = normalizeMediaForRead(value);
        if (record) out.push(record.id);
        cursor.continue();
      });
      return out;
    });
  }

  async function cleanupOrphanMedia() {
    return tx(['media'], 'readwrite', async ({ media }) => {
      let deleted = 0;
      await iterateCursor(media.index('refCount').openCursor(IDBKeyRange.only(0)), (value, cursor) => {
        cursor.delete();
        deleted += 1;
        cursor.continue();
      });
      return deleted;
    });
  }

  async function listReviewLogs() {
    const logs = await tx(['reviewLogs'], 'readonly', async ({ reviewLogs }) => reqToPromise(reviewLogs.getAll()));
    return (logs || []).map(normalizeReviewLog).filter(Boolean).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async function applyReview(payload) {
    if (!payload || !payload.cardBefore || !payload.cardAfter || !payload.reviewLog) throw new Error('Invalid review payload.');
    const reviewLog = normalizeReviewLog(payload.reviewLog);
    if (!reviewLog) throw new Error('Invalid review log.');
    return tx(['cards', 'reviewLogs'], 'readwrite', async ({ cards, reviewLogs }) => {
      const existing = normalizeCardForRead(await reqToPromise(cards.get(payload.cardBefore.id)));
      if (!existing) throw new Error('Card not found.');
      const updated = prepareCardForWrite({ ...payload.cardAfter, id: existing.id, createdAt: existing.createdAt });
      cards.put(updated);
      reviewLogs.put(reviewLog);
      return { card: updated, reviewLog };
    });
  }

  async function undoReview(payload) {
    if (!payload || !payload.cardSnapshot || !payload.reviewLogId) throw new Error('Nothing to undo.');
    return tx(['cards', 'reviewLogs'], 'readwrite', async ({ cards, reviewLogs }) => {
      const snapshot = prepareCardForWrite({ ...payload.cardSnapshot }, { preserveTimestamps: true });
      cards.put(snapshot);
      reviewLogs.delete(payload.reviewLogId);
      return snapshot;
    });
  }

  async function clearReviewLogs() {
    return tx(['reviewLogs'], 'readwrite', async ({ reviewLogs }) => {
      reviewLogs.clear();
      return true;
    });
  }

  async function getSetting(key, fallback) {
    const record = await tx(['meta'], 'readonly', async ({ meta }) => reqToPromise(meta.get(key)));
    if (!record) return fallback;
    return clone(record.value);
  }

  async function setSetting(key, value) {
    return tx(['meta'], 'readwrite', async ({ meta }) => {
      meta.put({ key, value: clone(value) });
      return true;
    });
  }

  async function listMeta() {
    const records = await tx(['meta'], 'readonly', async ({ meta }) => reqToPromise(meta.getAll()));
    return (records || []).map(normalizeMetaRecord).filter(Boolean);
  }

  async function exportAll() {
    const [decks, cards, reviewLogs, media, meta] = await Promise.all([listDecks(), listCards(), listReviewLogs(), listMedia(), listMeta()]);
    return { decks, cards, reviewLogs, media, meta };
  }

  async function replaceAll(payload) {
    const decks = (payload?.decks || []).map((item) => prepareDeckForWrite(item, { preserveTimestamps: true }));
    const cards = (payload?.cards || []).map((item) => prepareCardForWrite(item, { preserveTimestamps: true }));
    const reviewLogs = (payload?.reviewLogs || []).map(normalizeReviewLog).filter(Boolean);
    const media = (payload?.media || []).map((item) => prepareMediaForWrite(item, { preserveTimestamps: true }));
    const meta = (payload?.meta || []).map(normalizeMetaRecord).filter(Boolean);

    const deckIds = new Set(decks.map((deck) => deck.id));
    cards.forEach((card) => {
      if (!deckIds.has(card.deckId)) throw new Error(`Card references missing deck: ${card.deckId}`);
    });
    const mediaIds = new Set(media.map((item) => item.id));
    cards.forEach((card) => {
      [...card.frontImageIds, ...card.backImageIds].forEach((mediaId) => {
        if (!mediaIds.has(mediaId)) throw new Error(`Card references missing image: ${mediaId}`);
      });
    });
    const cardIds = new Set(cards.map((card) => card.id));
    reviewLogs.forEach((log) => {
      if (!cardIds.has(log.cardId)) throw new Error(`Review log references missing card: ${log.cardId}`);
      if (!deckIds.has(log.deckId)) throw new Error(`Review log references missing deck: ${log.deckId}`);
    });

    const refCounts = buildRefCountsFromCards(cards);
    const mediaFinal = media.map((item) => ({ ...item, refCount: refCounts.get(item.id) || 0 }));

    return tx(['decks', 'cards', 'reviewLogs', 'media', 'meta'], 'readwrite', async ({ decks: deckStore, cards: cardStore, reviewLogs: logStore, media: mediaStore, meta: metaStore }) => {
      deckStore.clear();
      cardStore.clear();
      logStore.clear();
      mediaStore.clear();
      metaStore.clear();
      decks.forEach((deck) => deckStore.put(deck));
      cards.forEach((card) => cardStore.put(card));
      reviewLogs.forEach((log) => logStore.put(log));
      mediaFinal.forEach((item) => mediaStore.put(item));
      meta.forEach((item) => metaStore.put(item));
      return true;
    });
  }

  async function wipeAll() {
    return tx(['decks', 'cards', 'reviewLogs', 'media', 'meta'], 'readwrite', async ({ decks, cards, reviewLogs, media, meta }) => {
      decks.clear();
      cards.clear();
      reviewLogs.clear();
      media.clear();
      meta.clear();
      return true;
    });
  }

  window.DB = {
    DB_NAME,
    DB_VERSION,
    DEFAULT_DECK_NAME,
    CARD_STATES,
    RATINGS,
    MAX_IMAGE_BYTES,
    openDB,
    nowISO,
    clone,
    id,
    normalizeDeckForRead,
    prepareDeckForWrite,
    normalizeCardForRead,
    prepareCardForWrite,
    normalizeReviewLog,
    normalizeMediaForRead,
    prepareMediaForWrite,
    ensureDefaultDeck,
    listDecks,
    getDeck,
    createDeck,
    renameDeck,
    deleteDeck,
    listCards,
    listCardKeys,
    getCard,
    getCardsByIds,
    getCardsByDeck,
    bulkCreateCards,
    createCard,
    updateCard,
    deleteCard,
    toggleSuspend,
    bulkMoveCards,
    bulkSuspendCards,
    bulkResetScheduling,
    bulkDeleteCards,
    countCards,
    countReviewLogs,
    countMedia,
    countMeta,
    getStorageSummary,
    getReviewScopeSnapshot,
    getReviewQueueSnapshot,
    getTodayNewStudiedCount,
    findNextDue,
    getDashboardSnapshot,
    searchCards,
    createMediaFromFile,
    bulkCreateMedia,
    getMedia,
    listMedia,
    deleteMedia,
    deleteMediaIfUnused,
    findOrphanMediaIds,
    cleanupOrphanMedia,
    listReviewLogs,
    applyReview,
    undoReview,
    clearReviewLogs,
    getSetting,
    setSetting,
    listMeta,
    exportAll,
    replaceAll,
    wipeAll,
  };
})();
