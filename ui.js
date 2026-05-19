(function () {
  const activeObjectUrls = new Set();

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function revokeObjectUrls() {
    activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    activeObjectUrls.clear();
  }

  function trackUrl(blob) {
    const url = URL.createObjectURL(blob);
    activeObjectUrls.add(url);
    return url;
  }

  function setTheme(theme) {
    document.body.classList.toggle('dark-theme', theme === 'dark');
    const select = document.getElementById('theme-select');
    if (select) select.value = theme === 'dark' ? 'dark' : 'light';
  }

  function setActiveView(viewId) {
    document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${viewId}`));
    document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
    // When navigating to the study view from outside, reset to home state.
    if (viewId === 'study') {
      const home = document.getElementById('study-home');
      const shell = document.getElementById('study-session-shell');
      if (home) home.classList.remove('hidden');
      if (shell) shell.classList.add('hidden');
    }
  }

  // Cloze rendering helpers

  // Replaces {{c1::word}} and {{cN::word::hint}} syntax with styled spans.
  // All user-supplied text is escaped; only the span wrapper uses innerHTML.
  function renderClozeQuestion(rawText) {
    return String(rawText || '')
      .replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g, () => `<span class="cloze-blank">[...]</span>`);
  }

  function renderClozeAnswer(rawText) {
    return String(rawText || '')
      .replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g, (_, word) => `<span class="cloze-reveal">${esc(word)}</span>`);
  }

  function showMessage(text, kind) {
    const region = document.getElementById('message-region');
    if (!region) return;
    region.innerHTML = text ? `<div class="message-banner ${kind || 'info'}">${esc(text)}</div>` : '';
  }

  function toast(text, kind) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const node = document.createElement('div');
    node.className = `toast ${kind || 'info'}`;
    node.textContent = text;
    region.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(4px)';
      setTimeout(() => node.remove(), 220);
    }, 2600);
  }

  function renderStorageSummary(summary) {
    const root = document.getElementById('storage-summary');
    if (!root) return;
    const items = [
      ['Decks', summary.deckCount],
      ['Cards', summary.cardCount],
      ['Review logs', summary.reviewLogCount],
      ['Settings', summary.metaCount],
      ['Media', summary.mediaCount],
    ];
    root.innerHTML = items.map(([label, value]) => `<div class="storage-card"><span class="stat-label">${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  }

  function renderDashboard(snapshot) {
    document.getElementById('hero-due-now').textContent = snapshot.totalDueNow;
    document.getElementById('hero-due-today').textContent = snapshot.totalDueToday;
    const statRoot = document.getElementById('dashboard-stat-cards');
    statRoot.innerHTML = [
      ['Total cards', snapshot.totalCards],
      ['Unseen', snapshot.totalNew],
      ['Learning', snapshot.totalLearning],
      ['Re-learning', snapshot.totalRelearning],
      ['Graduated', snapshot.totalReview],
      ['Mastery', `${snapshot.totalMastery.toFixed(0)}%`],
      ['Decks', snapshot.deckCount],
    ].map(([label, value]) => `<div class="stat-card"><span class="stat-label">${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');

    const deckRoot = document.getElementById('dashboard-deck-grid');
    if (!snapshot.perDeck.length) {
      deckRoot.innerHTML = `
        <div class="get-started-panel">
          <div class="onboarding-icon">&#x1F393;</div>
          <h3 style="margin:0 0 6px">Welcome to Ankur!</h3>
          <p style="color:var(--text-soft);margin:0 0 18px">You have no cards yet. Follow these steps to get started in under 5 minutes:</p>
          <div class="get-started-steps">
            <div class="get-started-step">
              <div class="get-started-step-num">1</div>
              <h4>Save your API key</h4>
              <p>Go to <strong>Settings</strong> and paste your OpenAI API key. Get a free one at platform.openai.com → API keys.</p>
            </div>
            <div class="get-started-step">
              <div class="get-started-step-num">2</div>
              <h4>Import a PDF</h4>
              <p>Go to <strong>Import</strong> → scroll to <em>Import from PDF</em>. Upload a lecture PDF and AI generates Easy / Medium / Hard cards for you.</p>
            </div>
            <div class="get-started-step">
              <div class="get-started-step-num">3</div>
              <h4>Study daily</h4>
              <p>Tap <strong>Study now</strong> and rate each card honestly. The app schedules the next review automatically — no planning needed.</p>
            </div>
          </div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="document.querySelector('[data-view=import]').click()">Go to Import</button>
            <button class="btn btn-secondary" onclick="document.querySelector('[data-view=settings]').click()">Go to Settings</button>
          </div>
        </div>`;
      return;
    }
    deckRoot.innerHTML = snapshot.perDeck.map((deck) => `
      <article class="deck-card">
        <div>
          <div class="eyebrow">${esc(deck.deckName)}</div>
          <h4>${esc(deck.deckName)}</h4>
          <div class="deck-list-meta">
            <span class="pill">${deck.totalCards} cards</span>
            <span class="pill">${deck.completedToday} done today</span>
          </div>
        </div>
        <div class="deck-card-stats">
          <div class="deck-card-stat"><span class="stat-label">Due now</span><strong>${deck.dueNow}</strong></div>
          <div class="deck-card-stat"><span class="stat-label">Due today</span><strong>${deck.dueToday}</strong></div>
          <div class="deck-card-stat"><span class="stat-label">Reviews</span><strong>${deck.totalReviewsAllTime}</strong></div>
          <div class="deck-card-stat"><span class="stat-label">Mastery</span><strong>${deck.masteryPercentage.toFixed(0)}%</strong></div>
        </div>
        <div class="button-row left-aligned">
          <button class="btn btn-secondary" data-review-deck="${esc(deck.deckId)}">Review deck</button>
        </div>
      </article>
    `).join('');
  }

  function fillDeckSelect(selectId, decks, options) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const current = select.value;
    const items = [];
    if (options?.includeAll) items.push(`<option value="all">${esc(options.allLabel || 'All decks')}</option>`);
    if (options?.includeNone) items.push(`<option value="">${esc(options.noneLabel || 'Choose one')}</option>`);
    decks.forEach((deck) => items.push(`<option value="${esc(deck.id)}">${esc(deck.name)}</option>`));
    select.innerHTML = items.join('');
    if ([...select.options].find((option) => option.value === current)) select.value = current;
  }

  function renderDeckList(decks, perDeck) {
    const root = document.getElementById('deck-list');
    if (!root) return;
    if (!decks.length) {
      root.innerHTML = '<div class="empty-box">No decks yet.</div>';
      return;
    }
    const statsById = new Map((perDeck || []).map((item) => [item.deckId, item]));
    root.innerHTML = decks.map((deck) => {
      const stats = statsById.get(deck.id) || { totalCards: 0, dueNow: 0, dueToday: 0, completedToday: 0, masteryPercentage: 0, totalReviewsAllTime: 0 };
      return `
        <article class="deck-list-item">
          <div>
            <div class="eyebrow">Deck</div>
            <h4>${esc(deck.name)}</h4>
            <div class="deck-list-meta">
              <span class="pill">${stats.totalCards} cards</span>
              <span class="pill">${stats.dueNow} due now</span>
              <span class="pill">${stats.completedToday} done today</span>
              <span class="pill">${stats.masteryPercentage.toFixed(0)}% mastery</span>
            </div>
          </div>
          <div class="button-row left-aligned">
            <button class="btn btn-secondary" data-review-deck="${esc(deck.id)}">Review</button>
            <button class="btn btn-secondary" data-rename-deck="${esc(deck.id)}">Rename</button>
            <button class="btn btn-danger" data-delete-deck="${esc(deck.id)}">Delete</button>
          </div>
        </article>
      `;
    }).join('');
  }

  async function renderMediaDrafts(containerId, drafts) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    for (const draft of drafts) {
      let url = draft.objectUrl || null;
      if (!url && draft.blob) url = trackUrl(draft.blob);
      const card = document.createElement('div');
      card.className = 'media-thumb';
      card.innerHTML = `
        <img alt="" src="${esc(url || '')}" />
        <button type="button" data-remove-media="${esc(draft.localId)}">x</button>
        <div class="media-meta">${esc(draft.name || 'image')}</div>
      `;
      container.appendChild(card);
    }
  }

  function toLocalInputValue(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function populateCardEditor(card, decks, drafts) {
    fillDeckSelect('card-deck', decks);
    document.getElementById('card-form-title').textContent = card ? 'Edit card' : 'Add card';
    document.getElementById('card-id').value = card?.id || '';
    document.getElementById('card-deck').value = card?.deckId || (decks[0] ? decks[0].id : '');
    document.getElementById('card-question').value = card?.question || '';
    document.getElementById('card-answer').value = card?.answer || '';
    document.getElementById('card-tags').value = (card?.tags || []).join(', ');
    document.getElementById('card-state').value = card?.state || 'new';
    document.getElementById('card-due-at').value = toLocalInputValue(card?.dueAt || new Date().toISOString());
    document.getElementById('card-interval-days').value = card?.intervalDays ?? 0;
    document.getElementById('card-ease-factor').value = card?.easeFactor ?? 2.5;
    document.getElementById('card-reps').value = card?.reps ?? 0;
    document.getElementById('card-lapses').value = card?.lapses ?? 0;
    document.getElementById('card-last-review-interval').value = card?.lastReviewIntervalDays ?? 0;
    document.getElementById('card-suspended').checked = !!card?.suspended;
    document.getElementById('card-advanced').open = !!card;
    const cardType = card?.cardType || 'basic';
    const typeSelect = document.getElementById('card-type');
    const wrapBtn = document.getElementById('cloze-wrap-btn');
    if (typeSelect) typeSelect.value = cardType;
    if (wrapBtn) wrapBtn.classList.toggle('hidden', cardType !== 'cloze');
    await renderMediaDrafts('card-front-preview', drafts.front || []);
    await renderMediaDrafts('card-back-preview', drafts.back || []);
  }

  function renderManageTable(result, state) {
    const body = document.getElementById('manage-cards-table');
    const empty = document.getElementById('manage-empty-state');
    if (!body || !empty) return;
    if (!result.items.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.textContent = state.search || state.deckFilter || state.suspendFilter !== 'all'
        ? 'No cards match the current filters.'
        : 'No cards yet. Add one on the left or import a file.';
    } else {
      empty.classList.add('hidden');
      body.innerHTML = result.items.map((card) => `
        <tr>
          <td class="checkbox-col"><input type="checkbox" data-select-card="${esc(card.id)}" ${state.selectedIds.has(card.id) ? 'checked' : ''} /></td>
          <td>
            <div class="table-title">${esc(card.question.slice(0, 120))}</div>
            <div class="table-muted">${esc(card.answer.slice(0, 120))}</div>
          </td>
          <td>${esc(card.deckName || card.deckId)}</td>
          <td>
            <div class="badge-row">
              <span class="tag status-${esc(card.state)}">${esc(card.state)}</span>
              ${card.suspended ? '<span class="tag">suspended</span>' : ''}
            </div>
          </td>
          <td>${esc(window.Stats.formatDateTime(card.dueAt))}</td>
          <td><div class="badge-row">${(card.tags || []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div></td>
          <td>${(card.frontImageIds?.length || 0) + (card.backImageIds?.length || 0)}</td>
          <td>
            <div class="button-row left-aligned">
              <button class="btn btn-secondary" data-edit-card="${esc(card.id)}">Edit</button>
              <button class="btn btn-secondary" data-toggle-suspend="${esc(card.id)}" data-next-state="${card.suspended ? 'false' : 'true'}">${card.suspended ? 'Unsuspend' : 'Suspend'}</button>
              <button class="btn btn-danger" data-delete-card="${esc(card.id)}">Delete</button>
            </div>
          </td>
        </tr>
      `).join('');
    }

    const pagination = document.getElementById('manage-pagination');
    const totalPages = Math.max(1, Math.ceil(result.total / state.pageSize));
    pagination.innerHTML = `
      <div class="table-muted">Showing ${result.total ? ((state.page - 1) * state.pageSize) + 1 : 0}-${Math.min(result.total, state.page * state.pageSize)} of ${result.total}</div>
      <div class="button-row right-aligned">
        <button class="btn btn-secondary" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="pill">Page ${state.page} / ${totalPages}</span>
        <button class="btn btn-secondary" data-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    `;
    document.getElementById('manage-selected-count').textContent = `${state.selectedIds.size} selected`;
    const pageIds = new Set(result.items.map((item) => item.id));
    const selectPage = document.getElementById('manage-select-page');
    selectPage.checked = result.items.length > 0 && result.items.every((item) => state.selectedIds.has(item.id));
    selectPage.indeterminate = result.items.some((item) => state.selectedIds.has(item.id)) && !selectPage.checked;
    selectPage.dataset.pageIds = JSON.stringify([...pageIds]);
  }

  function renderImportSummary(summary) {
    const root = document.getElementById('import-summary');
    if (!root) return;
    root.innerHTML = `
      <div><strong>${esc(summary.title)}</strong></div>
      <div class="table-muted">${esc(summary.copy)}</div>
      ${summary.details ? `<pre>${esc(summary.details)}</pre>` : ''}
    `;
  }

  function renderBackupSummary(summary, kind) {
    const root = document.getElementById('backup-summary');
    if (!root) return;
    root.classList.toggle('danger-box', kind === 'error');
    root.innerHTML = `<div><strong>${esc(summary)}</strong></div>`;
  }

  function renderReviewScope(scopeLabel, snapshot, remainingNew, hiddenNew) {
    document.getElementById('review-scope-due-pill').textContent = `Due now: ${snapshot.dueNow}`;
    document.getElementById('review-scope-today-pill').textContent = `Due today: ${snapshot.dueToday}`;
    document.getElementById('review-scope-hidden-pill').textContent = `Hidden new: ${hiddenNew}`;
    document.getElementById('review-new-limit-display').value = `${remainingNew}`;
    document.getElementById('review-eyebrow').textContent = scopeLabel || 'Reviewing';
  }

  function showStudySession() {
    const home = document.getElementById('study-home');
    const shell = document.getElementById('study-session-shell');
    if (home) home.classList.add('hidden');
    if (shell) shell.classList.remove('hidden');
  }

  async function renderReviewCard(session) {
    showStudySession();
    const question = document.getElementById('review-question');
    const answer = document.getElementById('review-answer');
    const answerWrap = document.getElementById('review-answer-wrap');
    const showAnswerRow = document.getElementById('show-answer-row');
    const ratingRow = document.getElementById('rating-row');
    const panel = document.getElementById('review-panel');
    const setup = document.getElementById('review-setup-panel');
    const empty = document.getElementById('review-empty-panel');
    if (setup) setup.classList.add('hidden');
    if (empty) empty.classList.add('hidden');
    if (panel) panel.classList.remove('hidden');

    document.getElementById('review-deck-name').textContent = session.deckName;
    document.getElementById('review-session-meta').textContent = `${session.remainingCount} due card${session.remainingCount === 1 ? '' : 's'} left - ${session.reviewedCount} reviewed this session`;
    document.getElementById('review-state-pill').textContent = session.card.state;
    document.getElementById('review-due-pill').textContent = window.Stats.formatDateTime(session.card.dueAt);
    document.getElementById('review-progress-pill').textContent = `${session.reviewedCount}/${session.totalCount}`;
    document.getElementById('review-progress-bar').style.width = `${session.totalCount ? (session.reviewedCount / session.totalCount) * 100 : 0}%`;

    // Render question / answer. Cloze cards use innerHTML, basic cards use textContent.
    const isCloze = session.card.cardType === 'cloze';
    if (isCloze) {
      question.innerHTML = renderClozeQuestion(session.card.question);
      answer.innerHTML = renderClozeAnswer(session.card.question); // cloze answer reveals the same text
    } else {
      question.textContent = session.card.question;
      answer.textContent = session.card.answer;
    }

    answerWrap.classList.toggle('hidden', !session.answerShown);
    showAnswerRow.classList.toggle('hidden', session.answerShown);
    ratingRow.classList.toggle('hidden', !session.answerShown);

    document.getElementById('undo-last-rating-btn').disabled = !session.lastReviewAction || session.busy;
    document.getElementById('suspend-current-card-btn').disabled = !session.card || session.busy;
    document.getElementById('edit-current-card-btn').disabled = !session.card || session.busy;

    const frontRoot = document.getElementById('review-question-images');
    const backRoot = document.getElementById('review-answer-images');
    frontRoot.innerHTML = session.frontMedia.map((item) => `
      <div class="media-thumb"><img alt="" src="${esc(item.url)}" /><div class="media-meta">${esc(item.name)}</div></div>
    `).join('');
    backRoot.innerHTML = session.backMedia.map((item) => `
      <div class="media-thumb"><img alt="" src="${esc(item.url)}" /><div class="media-meta">${esc(item.name)}</div></div>
    `).join('');

    document.querySelectorAll('[data-preview-for]').forEach((node) => {
      const rating = node.dataset.previewFor;
      node.textContent = session.previews?.[rating] || '';
    });
  }

  function renderReviewSetup(scopeName) {
    showStudySession();
    const setup = document.getElementById('review-setup-panel');
    const panel = document.getElementById('review-panel');
    const empty = document.getElementById('review-empty-panel');
    if (setup) setup.classList.remove('hidden');
    if (panel) panel.classList.add('hidden');
    if (empty) empty.classList.add('hidden');
    const deckName = document.getElementById('review-deck-name');
    if (deckName) deckName.textContent = scopeName || 'All due cards';
  }

  function renderReviewEmpty(state) {
    showStudySession();
    const setup = document.getElementById('review-setup-panel');
    const panel = document.getElementById('review-panel');
    const empty = document.getElementById('review-empty-panel');
    if (setup) setup.classList.add('hidden');
    if (panel) panel.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    document.getElementById('review-next-due-relative').textContent = state.nextDueRelative || '--';
    document.getElementById('review-next-due-exact').textContent = state.nextDueExact || '--';
    document.getElementById('review-hidden-new-count').textContent = state.hiddenNewCount || 0;
    document.getElementById('review-empty-title').textContent = state.title || "You're caught up.";
    document.getElementById('review-empty-subtitle').textContent = state.subtitle || 'The next card will appear here automatically when it becomes due.';
  }

  function renderStudyHome() {
    const home = document.getElementById('study-home');
    const shell = document.getElementById('study-session-shell');
    if (home) home.classList.remove('hidden');
    if (shell) shell.classList.add('hidden');
  }

  function renderStats(data) {
    const topRoot = document.getElementById('stats-top-strip');
    topRoot.innerHTML = data.topStrip.map((item) => `<div class="stat-card"><span class="stat-label">${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join('');

    const dailyRoot = document.getElementById('stats-daily-chart');
    const maxReviewed = Math.max(1, ...data.dailyStats.map((item) => item.cardsReviewed));
    dailyRoot.innerHTML = data.dailyStats.slice(-14).map((day) => {
      const height = Math.max(8, Math.round((day.cardsReviewed / maxReviewed) * 160));
      return `
        <div class="day-bar" title="${esc(day.dateKey)} - ${day.cardsReviewed} reviewed">
          <div class="day-bar-value">${day.cardsReviewed}</div>
          <div class="day-bar-fill" style="height:${height}px"></div>
          <div class="day-bar-label">${esc(day.dateKey.slice(5))}</div>
        </div>
      `;
    }).join('') || '<div class="empty-box">No review logs yet.</div>';

    const deckBody = document.getElementById('stats-deck-table');
    deckBody.innerHTML = data.perDeck.length ? data.perDeck.map((item) => `
      <tr>
        <td>${esc(item.deckName)}</td>
        <td>${item.totalCards}</td>
        <td>${item.dueNow}</td>
        <td>${item.dueToday}</td>
        <td>${item.completedToday}</td>
        <td>${item.totalReviewsAllTime}</td>
        <td>${item.lapsesAllTime}</td>
        <td>${item.masteryPercentage.toFixed(0)}%</td>
        <td>${esc(window.Stats.formatDateTime(item.lastStudied))}</td>
      </tr>
    `).join('') : '<tr><td colspan="9">No deck stats yet.</td></tr>';
  }

  function showConfirm(options) {
    const dialog = document.getElementById('confirm-dialog');
    if (!dialog) return Promise.resolve({ confirmed: false, formData: new FormData() });
    document.getElementById('confirm-eyebrow').textContent = options?.eyebrow || 'Confirm';
    document.getElementById('confirm-title').textContent = options?.title || 'Are you sure?';
    document.getElementById('confirm-copy').textContent = options?.copy || 'This action cannot be undone.';
    document.getElementById('confirm-submit').textContent = options?.confirmLabel || 'Confirm';
    document.getElementById('confirm-submit').className = `btn ${options?.confirmVariant === 'secondary' ? 'btn-secondary' : options?.confirmVariant === 'primary' ? 'btn-primary' : 'btn-danger'}`;
    const extra = document.getElementById('confirm-extra');
    extra.innerHTML = options?.extraHTML || '';

    return new Promise((resolve) => {
      const handleClose = () => {
        dialog.removeEventListener('close', handleClose);
        resolve({ confirmed: dialog.returnValue === 'confirm', formData: new FormData(dialog.querySelector('form')) });
      };
      dialog.addEventListener('close', handleClose, { once: true });
      dialog.showModal();
    });
  }

  window.UI = {
    esc,
    revokeObjectUrls,
    trackUrl,
    setTheme,
    setActiveView,
    showMessage,
    toast,
    renderStorageSummary,
    renderDashboard,
    fillDeckSelect,
    renderDeckList,
    renderMediaDrafts,
    populateCardEditor,
    renderManageTable,
    renderImportSummary,
    renderBackupSummary,
    renderReviewScope,
    renderReviewSetup,
    renderReviewCard,
    renderReviewEmpty,
    renderStudyHome,
    renderClozeQuestion,
    renderClozeAnswer,
    renderStats,
    showConfirm,
  };
})();





