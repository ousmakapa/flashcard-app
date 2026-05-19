(function () {
  // ─── Constants ─────────────────────────────────────────────────────────────

  const LEECH_THRESHOLD = 8;   // auto-suspend after this many lapses
  const FUZZ_FACTOR     = 0.08; // ±8% randomisation applied only in applyRating()

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function addDays(date, count) {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + count);
    return next;
  }

  function addMinutes(date, count) {
    const next = new Date(date.getTime());
    next.setMinutes(next.getMinutes() + count);
    return next;
  }

  function round(value) {
    return Math.round(Number(value || 0));
  }

  // Apply a small random fuzz to an interval (days) so cards reviewed on the
  // same day don't all pile up on the same future date.
  // Only called inside applyRating(), never in computeUpdates() so that
  // getRatingPreview() always shows a deterministic value to the user.
  function applyFuzz(days) {
    if (days <= 1) return days;
    const delta = Math.max(1, Math.round(days * FUZZ_FACTOR));
    return days + Math.round((Math.random() * 2 - 1) * delta);
  }

  function clampEase(ease) {
    return Math.max(1.3, Number(ease.toFixed(2)));
  }

  function formatDelay(fromDate, toDate) {
    const diffMs = Math.max(0, toDate.getTime() - fromDate.getTime());
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.round(hours / 24);
    return `${days}d`;
  }

  function newCardDefaults() {
    return {
      state: 'new',
      dueAt: new Date().toISOString(),
      intervalDays: 0,
      easeFactor: 2.5,
      reps: 0,
      lapses: 0,
      lastReviewedAt: null,
      lastRating: null,
      lastReviewIntervalDays: 0,
      suspended: false,
    };
  }

  // ─── Core scheduling logic ─────────────────────────────────────────────────
  // computeUpdates() is pure / deterministic — no fuzz, no side effects.
  // It is used both by applyRating() (with fuzz added after) and by
  // getRatingPreview() (without fuzz, so the UI label stays stable).

  function computeUpdates(card, rating, now) {
    if (!window.DB.RATINGS.includes(rating)) throw new Error('Invalid rating.');
    if (!window.DB.CARD_STATES.includes(card.state)) throw new Error('Invalid card state.');

    const ease = card.easeFactor || 2.5;
    const interval = card.intervalDays || 0;

    const updates = {
      lastReviewedAt: now.toISOString(),
      lastRating: rating,
      lastReviewIntervalDays: card.lastReviewIntervalDays || 0,
      reps: card.reps || 0,
      lapses: card.lapses || 0,
      easeFactor: ease,
      intervalDays: interval,
      state: card.state,
      dueAt: card.dueAt,
      suspended: card.suspended || false,
    };

    // ── New ──────────────────────────────────────────────────────────────────
    if (card.state === 'new') {
      if (rating === 'again') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 1).toISOString();
      } else if (rating === 'hard') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 10).toISOString();
      } else if (rating === 'good') {
        updates.state = 'review';
        updates.intervalDays = 1;
        updates.dueAt = addDays(now, 1).toISOString();
        updates.reps = (card.reps || 0) + 1;
      } else if (rating === 'easy') {
        updates.state = 'review';
        updates.intervalDays = 4;
        updates.easeFactor = clampEase(ease + 0.15);
        updates.dueAt = addDays(now, 4).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }

    // ── Learning ─────────────────────────────────────────────────────────────
    } else if (card.state === 'learning') {
      if (rating === 'again') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 1).toISOString();
      } else if (rating === 'hard') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 10).toISOString();
      } else if (rating === 'good') {
        updates.state = 'review';
        updates.intervalDays = 1;
        updates.dueAt = addDays(now, 1).toISOString();
        updates.reps = (card.reps || 0) + 1;
      } else if (rating === 'easy') {
        updates.state = 'review';
        updates.intervalDays = 4;
        updates.easeFactor = clampEase(ease + 0.15);
        updates.dueAt = addDays(now, 4).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }

    // ── Review ───────────────────────────────────────────────────────────────
    } else if (card.state === 'review') {
      if (rating === 'again') {
        updates.state = 'relearning';
        updates.lastReviewIntervalDays = interval;
        updates.lapses = (card.lapses || 0) + 1;
        updates.easeFactor = clampEase(ease - 0.2);
        updates.intervalDays = 1;
        updates.dueAt = addMinutes(now, 10).toISOString();
      } else if (rating === 'hard') {
        // Hard: 1.2× interval, ease −0.15
        updates.state = 'review';
        updates.easeFactor = clampEase(ease - 0.15);
        updates.intervalDays = Math.max(1, round(interval * 1.2));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      } else if (rating === 'good') {
        // Good: interval × ease
        updates.state = 'review';
        updates.intervalDays = Math.max(1, round(interval * ease));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      } else if (rating === 'easy') {
        // Easy: interval × ease × 1.3, ease +0.15
        updates.state = 'review';
        updates.easeFactor = clampEase(ease + 0.15);
        updates.intervalDays = Math.max(1, round(interval * updates.easeFactor * 1.3));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }

    // ── Relearning ────────────────────────────────────────────────────────────
    } else if (card.state === 'relearning') {
      const lastInterval = card.lastReviewIntervalDays || 1;
      if (rating === 'again') {
        updates.state = 'relearning';
        updates.dueAt = addMinutes(now, 10).toISOString();
      } else if (rating === 'hard') {
        // Hard: 25% of last interval (minimum 1 day)
        updates.state = 'review';
        updates.intervalDays = Math.max(1, round(lastInterval * 0.25));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      } else if (rating === 'good') {
        // Good: 50% of last interval
        updates.state = 'review';
        updates.intervalDays = Math.max(1, round(lastInterval * 0.5));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      } else if (rating === 'easy') {
        // Easy: 75% of last interval (minimum 3 days)
        updates.state = 'review';
        updates.intervalDays = Math.max(3, round(lastInterval * 0.75));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
    }

    return updates;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  function applyRating(card, rating) {
    const now = new Date();
    const updates = computeUpdates(card, rating, now);

    // Add fuzz to scheduled intervals so cards don't pile up on the same date.
    if (updates.state === 'review' && updates.intervalDays > 1) {
      updates.intervalDays = applyFuzz(updates.intervalDays);
      updates.dueAt = addDays(now, updates.intervalDays).toISOString();
    }

    // Leech detection: auto-suspend after LEECH_THRESHOLD lapses.
    const isLeech = updates.lapses >= LEECH_THRESHOLD && !card.suspended;
    if (isLeech) updates.suspended = true;

    const nextCard = { ...card, ...updates, updatedAt: now.toISOString() };

    const reviewLog = {
      id: window.DB.id('log'),
      cardId: card.id,
      deckId: card.deckId,
      timestamp: now.toISOString(),
      rating,
      previousState: card.state,
      newState: nextCard.state,
      previousIntervalDays: card.intervalDays || 0,
      newIntervalDays: nextCard.intervalDays || 0,
      previousEaseFactor: Number((card.easeFactor || 2.5).toFixed(2)),
      newEaseFactor: Number((nextCard.easeFactor || 2.5).toFixed(2)),
      studySeconds: 0,
    };

    return { timestamp: now.toISOString(), card: nextCard, reviewLog, isLeech };
  }

  function getRatingPreview(card, rating) {
    const now = new Date();
    const updates = computeUpdates(card, rating, now);
    return {
      state: updates.state,
      dueAt: updates.dueAt,
      delay: formatDelay(now, new Date(updates.dueAt)),
    };
  }

  function getRatingPreviewLabel(card, rating) {
    const preview = getRatingPreview(card, rating);
    const exact = new Date(preview.dueAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${preview.delay} · ${exact}`;
  }

  window.Scheduler = {
    newCardDefaults,
    applyRating,
    getRatingPreview,
    getRatingPreviewLabel,
    formatDelay,
    LEECH_THRESHOLD,
  };
})();
