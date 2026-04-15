(function () {
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

  function computeUpdates(card, rating, now) {
    if (!window.DB.RATINGS.includes(rating)) throw new Error('Invalid rating.');
    if (!window.DB.CARD_STATES.includes(card.state)) throw new Error('Invalid card state.');

    const updates = {
      lastReviewedAt: now.toISOString(),
      lastRating: rating,
      lastReviewIntervalDays: card.lastReviewIntervalDays || 0,
      reps: card.reps || 0,
      lapses: card.lapses || 0,
      easeFactor: card.easeFactor || 2.5,
      intervalDays: card.intervalDays || 0,
      state: card.state,
      dueAt: card.dueAt,
    };

    if (card.state === 'new') {
      if (rating === 'again') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 1).toISOString();
      }
      if (rating === 'hard') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 10).toISOString();
      }
      if (rating === 'good') {
        updates.state = 'review';
        updates.intervalDays = 1;
        updates.dueAt = addDays(now, 1).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
      if (rating === 'easy') {
        updates.state = 'review';
        updates.intervalDays = 4;
        updates.easeFactor = Number(((card.easeFactor || 2.5) + 0.05).toFixed(2));
        updates.dueAt = addDays(now, 4).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
    } else if (card.state === 'learning') {
      if (rating === 'again') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 1).toISOString();
      }
      if (rating === 'hard') {
        updates.state = 'learning';
        updates.dueAt = addMinutes(now, 10).toISOString();
      }
      if (rating === 'good') {
        updates.state = 'review';
        updates.intervalDays = 1;
        updates.dueAt = addDays(now, 1).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
      if (rating === 'easy') {
        updates.state = 'review';
        updates.intervalDays = 4;
        updates.easeFactor = Number(((card.easeFactor || 2.5) + 0.05).toFixed(2));
        updates.dueAt = addDays(now, 4).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
    } else if (card.state === 'review') {
      if (rating === 'again') {
        updates.state = 'relearning';
        updates.lastReviewIntervalDays = card.intervalDays;
        updates.lapses = (card.lapses || 0) + 1;
        updates.easeFactor = Math.max(1.3, Number(((card.easeFactor || 2.5) - 0.2).toFixed(2)));
        updates.intervalDays = 1;
        updates.dueAt = addMinutes(now, 10).toISOString();
      }
      if (rating === 'hard') {
        updates.state = 'review';
        updates.easeFactor = Math.max(1.3, Number(((card.easeFactor || 2.5) - 0.05).toFixed(2)));
        updates.intervalDays = Math.max(1, round((card.intervalDays || 1) * 1.2));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
      if (rating === 'good') {
        updates.state = 'review';
        updates.intervalDays = Math.max(1, round((card.intervalDays || 1) * (card.easeFactor || 2.5)));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
      if (rating === 'easy') {
        updates.state = 'review';
        updates.easeFactor = Number(((card.easeFactor || 2.5) + 0.05).toFixed(2));
        updates.intervalDays = Math.max(1, round((card.intervalDays || 1) * updates.easeFactor * 1.3));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
    } else if (card.state === 'relearning') {
      if (rating === 'again') {
        updates.state = 'relearning';
        updates.dueAt = addMinutes(now, 10).toISOString();
      }
      if (rating === 'hard') {
        updates.state = 'review';
        updates.intervalDays = 1;
        updates.dueAt = addDays(now, 1).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
      if (rating === 'good') {
        updates.state = 'review';
        updates.intervalDays = Math.max(1, round((card.lastReviewIntervalDays || 1) * 0.5));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
      if (rating === 'easy') {
        updates.state = 'review';
        updates.intervalDays = Math.max(3, round((card.lastReviewIntervalDays || 1) * 0.75));
        updates.dueAt = addDays(now, updates.intervalDays).toISOString();
        updates.reps = (card.reps || 0) + 1;
      }
    }

    return updates;
  }

  function applyRating(card, rating) {
    const now = new Date();
    const updates = computeUpdates(card, rating, now);
    const nextCard = {
      ...card,
      ...updates,
      updatedAt: now.toISOString(),
    };
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
    return { timestamp: now.toISOString(), card: nextCard, reviewLog };
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
  };
})();
