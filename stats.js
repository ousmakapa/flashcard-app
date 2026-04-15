(function () {
  function toLocalDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function startOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function endOfToday() {
    const date = new Date();
    date.setHours(23, 59, 59, 999);
    return date;
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDuration(seconds) {
    const safe = Math.max(0, Number(seconds || 0));
    const mins = Math.floor(safe / 60);
    const secs = Math.round(safe % 60);
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }

  function formatRelativeFuture(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const diffMs = date.getTime() - Date.now();
    if (diffMs <= 0) return 'Now';
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 60) return `In ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `In ${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 24);
    return `In ${days} day${days === 1 ? '' : 's'}`;
  }

  function dueNow(card) {
    return new Date(card.dueAt).getTime() <= Date.now();
  }

  function dueToday(card) {
    return new Date(card.dueAt).getTime() <= endOfToday().getTime();
  }

  function buildDailyStatRecord(dateKey) {
    return {
      dateKey,
      cardsReviewed: 0,
      againCount: 0,
      hardCount: 0,
      goodCount: 0,
      easyCount: 0,
      totalStudyTimeSeconds: 0,
      decksStudied: new Set(),
      learnedCards: new Set(),
      seenNewCards: new Set(),
    };
  }

  function computeDailyStats(logs) {
    const grouped = new Map();
    logs.forEach((log) => {
      if (!log || !log.timestamp) return;
      const key = toLocalDateKey(log.timestamp);
      if (!key) return;
      if (!grouped.has(key)) grouped.set(key, buildDailyStatRecord(key));
      const bucket = grouped.get(key);
      bucket.cardsReviewed += 1;
      bucket.totalStudyTimeSeconds += Number(log.studySeconds || 0);
      bucket.decksStudied.add(log.deckId);
      if (log.rating === 'again') bucket.againCount += 1;
      if (log.rating === 'hard') bucket.hardCount += 1;
      if (log.rating === 'good') bucket.goodCount += 1;
      if (log.rating === 'easy') bucket.easyCount += 1;
      if (log.previousState === 'new') bucket.seenNewCards.add(log.cardId);
      if (log.newState === 'review' && ['new', 'learning', 'relearning'].includes(log.previousState)) {
        bucket.learnedCards.add(log.cardId);
      }
    });
    return Array.from(grouped.values())
      .map((item) => ({
        dateKey: item.dateKey,
        cardsReviewed: item.cardsReviewed,
        againCount: item.againCount,
        hardCount: item.hardCount,
        goodCount: item.goodCount,
        easyCount: item.easyCount,
        newCardsStudied: item.seenNewCards.size,
        cardsLearned: item.learnedCards.size,
        totalStudyTimeSeconds: item.totalStudyTimeSeconds,
        decksStudiedCount: item.decksStudied.size,
      }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }

  function getTodayNewStudiedCount(logs, deckId) {
    const todayKey = toLocalDateKey(new Date());
    const seen = new Set();
    logs.forEach((log) => {
      if (toLocalDateKey(log.timestamp) !== todayKey) return;
      if (deckId && log.deckId !== deckId) return;
      if (log.previousState === 'new') seen.add(log.cardId);
    });
    return seen.size;
  }

  function computePerDeckStats(cards, decks, logs) {
    const todayKey = toLocalDateKey(new Date());
    return decks.map((deck) => {
      const deckCards = cards.filter((card) => card.deckId === deck.id);
      const deckLogs = logs.filter((log) => log.deckId === deck.id);
      const completedToday = new Set(deckLogs.filter((log) => toLocalDateKey(log.timestamp) === todayKey).map((log) => log.cardId)).size;
      const mastered = deckCards.filter((card) => card.state === 'review' && card.intervalDays >= 21).length;
      return {
        deckId: deck.id,
        deckName: deck.name,
        totalCards: deckCards.length,
        dueNow: deckCards.filter((card) => !card.suspended && dueNow(card)).length,
        dueToday: deckCards.filter((card) => !card.suspended && dueToday(card)).length,
        completedToday,
        totalReviewsAllTime: deckLogs.length,
        lapsesAllTime: deckCards.reduce((sum, card) => sum + Number(card.lapses || 0), 0),
        masteryPercentage: deckCards.length ? (mastered / deckCards.length) * 100 : 0,
        lastStudied: deckLogs.length ? deckLogs[deckLogs.length - 1].timestamp : null,
      };
    }).sort((a, b) => a.deckName.localeCompare(b.deckName));
  }

  function computeDashboard(cards, decks, logs) {
    const perDeck = computePerDeckStats(cards, decks, logs);
    const mastered = cards.filter((card) => card.state === 'review' && card.intervalDays >= 21).length;
    return {
      totalCards: cards.length,
      totalDueNow: cards.filter((card) => !card.suspended && dueNow(card)).length,
      totalDueToday: cards.filter((card) => !card.suspended && dueToday(card)).length,
      totalNew: cards.filter((card) => card.state === 'new').length,
      totalLearning: cards.filter((card) => card.state === 'learning').length,
      totalRelearning: cards.filter((card) => card.state === 'relearning').length,
      totalReview: cards.filter((card) => card.state === 'review').length,
      totalMastery: cards.length ? (mastered / cards.length) * 100 : 0,
      deckCount: decks.length,
      perDeck,
    };
  }

  function buildTopStrip(cards, logs, dailyStats) {
    const todayKey = toLocalDateKey(new Date());
    const todayStats = dailyStats.find((item) => item.dateKey === todayKey) || {
      cardsReviewed: 0,
      newCardsStudied: 0,
      cardsLearned: 0,
      againCount: 0,
      totalStudyTimeSeconds: 0,
      decksStudiedCount: 0,
    };
    const retention = todayStats.cardsReviewed ? Math.max(0, ((todayStats.cardsReviewed - todayStats.againCount) / todayStats.cardsReviewed) * 100) : 0;
    const mastered = cards.filter((card) => card.state === 'review' && card.intervalDays >= 21).length;
    return [
      { label: 'Reviewed today', value: todayStats.cardsReviewed },
      { label: 'New studied today', value: todayStats.newCardsStudied },
      { label: 'Learned today', value: todayStats.cardsLearned },
      { label: 'Retention today', value: `${retention.toFixed(0)}%` },
      { label: 'Study time today', value: formatDuration(todayStats.totalStudyTimeSeconds) },
      { label: 'Mastered cards', value: mastered },
      { label: 'Total logs', value: logs.length },
      { label: 'Decks studied today', value: todayStats.decksStudiedCount },
    ];
  }

  window.Stats = {
    toLocalDateKey,
    startOfToday,
    endOfToday,
    formatDateTime,
    formatDate,
    formatDuration,
    formatRelativeFuture,
    dueNow,
    dueToday,
    computeDailyStats,
    computePerDeckStats,
    computeDashboard,
    getTodayNewStudiedCount,
    buildTopStrip,
  };
})();
