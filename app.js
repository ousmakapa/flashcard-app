(function () {
  function getDefaultReviewSession() {
    return {
      mode: 'setup',
      deckId: 'all',
      deckName: 'All due cards',
      scopeLabel: 'Reviewing',
      answerShown: false,
      card: null,
      queue: [],
      remainingCount: 0,
      reviewedCount: 0,
      totalCount: 0,
      hiddenNewCount: 0,
      nextDueAt: null,
      frontMedia: [],
      backMedia: [],
      shownAt: null,
      busy: false,
      lastReviewAction: null,
      previews: null,
    };
  }

  function makeDraftItem({ mediaId, name, blob, existing }) {
    return {
      localId: `${mediaId}_${Math.random().toString(36).slice(2, 8)}`,
      mediaId,
      name,
      blob,
      objectUrl: window.UI.trackUrl(blob),
      existing: !!existing,
    };
  }

  const App = {
    state: {
      currentView: 'study',
      decks: [],
      dashboard: null,
      storage: { deckCount: 0, cardCount: 0, reviewLogCount: 0, metaCount: 0, mediaCount: 0 },
      settings: { theme: 'light', newCardsPerDay: 20 },
      reviewSession: getDefaultReviewSession(),
      reviewRefreshTimer: null,
      manageSearchTimer: null,
      manageState: {
        page: 1,
        pageSize: 20,
        search: '',
        deckFilter: '',
        suspendFilter: 'all',
        selectedIds: new Set(),
        editingCardId: null,
        currentItems: [],
      },
      cardEditorMedia: { front: [], back: [] },
      pdfCards: [],
      pdfFilter: 'all',
      onboardingStep: 1,
    },

    async init() {
      try {
        await window.DB.ensureDefaultDeck();
        this.bindEvents();
        await this.loadSettings();
        await this.refreshBaseData();
        await this.switchView('study');
        window.UI.showMessage('Ankur is ready. Everything stays local to this browser.', 'success');
        if (!localStorage.getItem('ankur_onboarded')) this.showOnboarding();
      } catch (error) {
        console.error(error);
        window.UI.showMessage(error.message || 'Failed to initialize the app.', 'error');
      }
    },

    bindEvents() {
      document.querySelectorAll('.nav-link').forEach((button) => {
        button.addEventListener('click', () => this.switchView(button.dataset.view));
      });
      document.getElementById('quick-refresh').addEventListener('click', () => this.refreshCurrentView(true));
      document.getElementById('quick-review-all').addEventListener('click', () => this.launchReviewForScope('all'));
      document.getElementById('dashboard-start-review').addEventListener('click', () => this.launchReviewForScope('all'));

      // Cloze editor controls
      document.getElementById('card-type').addEventListener('change', (event) => {
        const isCloze = event.target.value === 'cloze';
        document.getElementById('cloze-wrap-btn').classList.toggle('hidden', !isCloze);
      });
      document.getElementById('cloze-wrap-btn').addEventListener('click', () => this.wrapAsCloze());

      document.getElementById('create-deck-form').addEventListener('submit', (event) => this.handleCreateDeck(event));
      document.getElementById('deck-list').addEventListener('click', (event) => this.handleDeckListClick(event));
      document.getElementById('dashboard-deck-grid').addEventListener('click', (event) => {
        const button = event.target.closest('[data-review-deck]');
        if (button) this.launchReviewForScope(button.dataset.reviewDeck);
      });

      document.getElementById('review-scope-select').addEventListener('change', () => this.prepareReviewSetup());
      document.getElementById('start-review-btn').addEventListener('click', () => this.startReview());
      document.getElementById('show-answer-btn').addEventListener('click', () => this.showAnswer());
      document.getElementById('end-review-btn').addEventListener('click', () => this.endReview(true));
      document.getElementById('undo-last-rating-btn').addEventListener('click', () => this.undoLastRating());
      document.getElementById('suspend-current-card-btn').addEventListener('click', () => this.suspendCurrentReviewCard());
      document.getElementById('edit-current-card-btn').addEventListener('click', () => this.editCurrentReviewCard());
      document.getElementById('review-empty-refresh-btn').addEventListener('click', () => this.refreshReviewEmptyState(false));
      document.getElementById('review-empty-change-scope-btn').addEventListener('click', () => this.endReview(false));
      document.querySelectorAll('.rating-btn').forEach((button) => button.addEventListener('click', () => this.rateCurrentCard(button.dataset.rating)));

      document.getElementById('card-form').addEventListener('submit', (event) => this.handleCardSave(event));
      document.getElementById('card-form-reset').addEventListener('click', () => this.resetCardEditor());
      document.getElementById('card-front-preview').addEventListener('click', (event) => this.handleDraftImageRemove(event, 'front'));
      document.getElementById('card-back-preview').addEventListener('click', (event) => this.handleDraftImageRemove(event, 'back'));
      document.getElementById('card-front-images').addEventListener('change', (event) => this.addDraftImages('front', event.target.files));
      document.getElementById('card-back-images').addEventListener('change', (event) => this.addDraftImages('back', event.target.files));
      ['card-front-dropzone', 'card-back-dropzone'].forEach((id) => this.bindDropzone(id));

      document.getElementById('manage-search').addEventListener('input', () => {
        clearTimeout(this.state.manageSearchTimer);
        this.state.manageSearchTimer = window.setTimeout(() => {
          this.state.manageState.page = 1;
          this.renderManageView();
        }, 380);
      });
      document.getElementById('manage-deck-filter').addEventListener('change', () => {
        this.state.manageState.page = 1;
        this.renderManageView();
      });
      document.getElementById('manage-suspend-filter').addEventListener('change', () => {
        this.state.manageState.page = 1;
        this.renderManageView();
      });
      document.getElementById('manage-pagination').addEventListener('click', (event) => this.handleManagePagination(event));
      document.getElementById('manage-cards-table').addEventListener('click', (event) => this.handleManageTableClick(event));
      document.getElementById('manage-cards-table').addEventListener('change', (event) => this.handleManageTableChange(event));
      document.getElementById('manage-select-page').addEventListener('change', (event) => this.handleSelectPage(event));
      document.getElementById('bulk-move-btn').addEventListener('click', () => this.bulkMoveCards());
      document.getElementById('bulk-suspend-btn').addEventListener('click', () => this.bulkSuspendCards(true));
      document.getElementById('bulk-unsuspend-btn').addEventListener('click', () => this.bulkSuspendCards(false));
      document.getElementById('bulk-reset-btn').addEventListener('click', () => this.bulkResetScheduling());
      document.getElementById('bulk-delete-btn').addEventListener('click', () => this.bulkDeleteCards());

      document.getElementById('import-form').addEventListener('submit', (event) => this.handleImport(event));
      document.getElementById('export-backup-btn').addEventListener('click', () => this.handleExportBackup());
      document.getElementById('import-backup-btn').addEventListener('click', () => this.handleRestoreBackup());

      document.getElementById('help-btn').addEventListener('click', () => this.showOnboarding());
      document.getElementById('onboarding-close').addEventListener('click', () => this.closeOnboarding());
      document.getElementById('onboarding-next').addEventListener('click', () => this.onboardingNext());
      document.getElementById('onboarding-prev').addEventListener('click', () => this.onboardingPrev());
      document.getElementById('onboarding-dialog').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) this.closeOnboarding();
      });

      document.getElementById('pdf-generate-btn').addEventListener('click', () => this.handlePdfImport());
      document.getElementById('pdf-file').addEventListener('change', (e) => {
        const label = document.getElementById('pdf-file-label-text');
        const wrap = e.target.closest('.file-pick-wrap').querySelector('.file-pick-label');
        if (e.target.files[0]) {
          label.textContent = e.target.files[0].name;
          wrap.classList.add('has-file');
        } else {
          label.textContent = 'Choose PDF file';
          wrap.classList.remove('has-file');
        }
      });
      document.getElementById('import-file').addEventListener('change', (e) => {
        const label = document.getElementById('import-file-label-text');
        const wrap = e.target.closest('.file-pick-wrap').querySelector('.file-pick-label');
        if (e.target.files[0]) {
          label.textContent = e.target.files[0].name;
          wrap.classList.add('has-file');
        } else {
          label.textContent = 'Choose source file';
          wrap.classList.remove('has-file');
        }
      });
      document.getElementById('import-backup-file').addEventListener('change', (e) => {
        const label = document.getElementById('import-backup-file-label-text');
        const wrap = e.target.closest('.file-pick-wrap').querySelector('.file-pick-label');
        if (e.target.files[0]) {
          label.textContent = e.target.files[0].name;
          wrap.classList.add('has-file');
        } else {
          label.textContent = 'Choose backup file (.json)';
          wrap.classList.remove('has-file');
        }
      });
      document.getElementById('pdf-import-btn').addEventListener('click', () => this.handlePdfConfirmImport());
      document.getElementById('pdf-discard-btn').addEventListener('click', () => this.handlePdfDiscard());
      document.getElementById('pdf-check-all').addEventListener('change', (e) => this.pdfToggleAll(e.target.checked));
      document.querySelectorAll('.pdf-filter-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.pdfFilterByDifficulty(btn.dataset.filter));
      });

      document.getElementById('save-settings-btn').addEventListener('click', () => this.saveSettings());
      document.getElementById('seed-sample-data-btn').addEventListener('click', () => this.seedSampleData());
      document.getElementById('cleanup-orphan-media-btn').addEventListener('click', () => this.cleanupOrphanMedia());
      document.getElementById('clear-review-logs-btn').addEventListener('click', () => this.clearReviewLogs());
      document.getElementById('wipe-data-btn').addEventListener('click', () => this.wipeData());
      document.getElementById('reset-site-data-btn').addEventListener('click', () => this.resetSiteData());

      document.addEventListener('keydown', (event) => this.handleGlobalKeys(event));
    },

    async loadSettings() {
      const [theme, newCardsPerDay] = await Promise.all([
        window.DB.getSetting('theme', 'light'),
        window.DB.getSetting('newCardsPerDay', 20),
      ]);
      this.state.settings.theme = theme === 'dark' ? 'dark' : 'light';
      this.state.settings.newCardsPerDay = Math.max(0, Number(newCardsPerDay || 20));
      window.UI.setTheme(this.state.settings.theme);
      document.getElementById('theme-select').value = this.state.settings.theme;
      document.getElementById('new-cards-per-day').value = this.state.settings.newCardsPerDay;
      const savedKey = localStorage.getItem('openai_api_key') || '';
      if (savedKey) document.getElementById('openai-api-key').value = savedKey;
    },

    async refreshBaseData() {
      const [decks, dashboard, storage] = await Promise.all([
        window.DB.listDecks(),
        window.DB.getDashboardSnapshot(),
        window.DB.getStorageSummary(),
      ]);
      this.state.decks = decks;
      this.state.dashboard = dashboard;
      this.state.storage = storage;
      window.UI.renderDashboard(dashboard);
      window.UI.renderDeckList(decks, dashboard.perDeck);
      window.UI.renderStorageSummary(storage);
      window.UI.fillDeckSelect('review-scope-select', decks, { includeAll: true, allLabel: 'All due cards' });
      window.UI.fillDeckSelect('manage-deck-filter', decks, { includeAll: true, allLabel: 'All decks' });
      window.UI.fillDeckSelect('bulk-move-deck', decks, { includeNone: true, noneLabel: 'Move selected to...' });
      window.UI.fillDeckSelect('import-deck-select', decks, { includeNone: true, noneLabel: 'Choose target deck' });
      window.UI.fillDeckSelect('pdf-deck-select', decks, { includeNone: true, noneLabel: 'Choose target deck' });
      await this.refreshReviewOverview();
      await this.populateEditorFromCurrentState();
    },

    async switchView(view) {
      if (this.state.currentView === 'cards' && view !== 'cards') {
        await this.releaseUnusedDraftMedia();
        this.state.cardEditorMedia = { front: [], back: [] };
        this.state.manageState.editingCardId = null;
      }
      this.state.currentView = view;
      window.UI.setActiveView(view);
      await this.refreshCurrentView(true);
    },

    async refreshCurrentView(force) {
      if (force) await this.refreshBaseData();
      if (this.state.currentView === 'study') {
        await this.refreshReviewOverview();
      }
      if (this.state.currentView === 'cards') {
        await this.renderManageView();
      }
      if (this.state.currentView === 'stats') {
        await this.renderStatsView();
      }
      if (this.state.currentView === 'settings') {
        await this.refreshSettingsView();
      }
    },

    async refreshSettingsView() {
      const orphans = await window.DB.findOrphanMediaIds();
      document.getElementById('orphan-media-note').textContent = `${orphans.length} orphan image${orphans.length === 1 ? '' : 's'} currently unused.`;
    },

    async handleCreateDeck(event) {
      event.preventDefault();
      const input = document.getElementById('new-deck-name');
      try {
        const deck = await window.DB.createDeck(input.value);
        input.value = '';
        await this.refreshBaseData();
        window.UI.toast(`Deck created: ${deck.name}`, 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Failed to create deck.', 'error');
      }
    },

    async handleDeckListClick(event) {
      const review = event.target.closest('[data-review-deck]');
      if (review) {
        this.launchReviewForScope(review.dataset.reviewDeck);
        return;
      }
      const rename = event.target.closest('[data-rename-deck]');
      if (rename) {
        const deck = this.state.decks.find((item) => item.id === rename.dataset.renameDeck);
        if (!deck) return;
        const result = await window.UI.showConfirm({
          eyebrow: 'Rename deck',
          title: deck.name,
          copy: 'Choose a new unique deck name. Cards and review logs will follow the rename.',
          confirmLabel: 'Save rename',
          confirmVariant: 'primary',
          extraHTML: `<label>New name<input name="newName" type="text" maxlength="120" value="${window.UI.esc(deck.name)}" required /></label>`,
        });
        if (!result.confirmed) return;
        const newName = String(result.formData.get('newName') || '').trim();
        try {
          await window.DB.renameDeck(deck.id, newName);
          await this.refreshBaseData();
          await this.renderManageView();
          window.UI.toast('Deck renamed.', 'success');
        } catch (error) {
          window.UI.toast(error.message || 'Failed to rename deck.', 'error');
        }
        return;
      }
      const del = event.target.closest('[data-delete-deck]');
      if (del) {
        const deck = this.state.decks.find((item) => item.id === del.dataset.deleteDeck);
        if (!deck) return;
        const result = await window.UI.showConfirm({
          eyebrow: 'Delete deck',
          title: deck.name,
          copy: 'Choose whether to move existing cards to Default or delete the cards too.',
          confirmLabel: 'Delete deck',
          extraHTML: `
            <label><input type="radio" name="deckDeleteMode" value="move-to-default" checked /> Move cards to Default</label>
            <label><input type="radio" name="deckDeleteMode" value="delete-cards" /> Delete cards in this deck too</label>
          `,
        });
        if (!result.confirmed) return;
        const mode = String(result.formData.get('deckDeleteMode') || 'move-to-default');
        try {
          await window.DB.deleteDeck(deck.id, mode);
          await this.refreshBaseData();
          await this.renderManageView();
          window.UI.toast('Deck deleted.', 'success');
        } catch (error) {
          window.UI.toast(error.message || 'Failed to delete deck.', 'error');
        }
      }
    },

    bindDropzone(id) {
      const node = document.getElementById(id);
      if (!node) return;
      const side = node.dataset.side;
      ['dragenter', 'dragover'].forEach((type) => node.addEventListener(type, (event) => {
        event.preventDefault();
        node.classList.add('is-dragover');
      }));
      ['dragleave', 'dragend', 'drop'].forEach((type) => node.addEventListener(type, (event) => {
        event.preventDefault();
        node.classList.remove('is-dragover');
      }));
      node.addEventListener('drop', (event) => this.addDraftImages(side, event.dataTransfer.files));
      node.addEventListener('paste', (event) => {
        const files = [];
        Array.from(event.clipboardData?.items || []).forEach((item) => {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        });
        if (files.length) this.addDraftImages(side, files);
      });
    },

    async addDraftImages(side, files) {
      const list = Array.from(files || []);
      if (!list.length) return;
      for (const file of list) {
        try {
          const media = await window.DB.createMediaFromFile(file);
          this.state.cardEditorMedia[side].push(makeDraftItem({ mediaId: media.id, name: media.name, blob: media.blob, existing: false }));
        } catch (error) {
          window.UI.toast(error.message || 'Failed to add image.', 'error');
        }
      }
      await window.UI.renderMediaDrafts(side === 'front' ? 'card-front-preview' : 'card-back-preview', this.state.cardEditorMedia[side]);
      const input = document.getElementById(side === 'front' ? 'card-front-images' : 'card-back-images');
      if (input) input.value = '';
    },

    async handleDraftImageRemove(event, side) {
      const button = event.target.closest('[data-remove-media]');
      if (!button) return;
      const localId = button.dataset.removeMedia;
      const drafts = this.state.cardEditorMedia[side];
      const index = drafts.findIndex((item) => item.localId === localId);
      if (index === -1) return;
      const [removed] = drafts.splice(index, 1);
      if (removed && !removed.existing) {
        await window.DB.deleteMediaIfUnused([removed.mediaId]);
      }
      await window.UI.renderMediaDrafts(side === 'front' ? 'card-front-preview' : 'card-back-preview', drafts);
    },

    async populateEditorFromCurrentState() {
      let card = null;
      if (this.state.manageState.editingCardId) {
        card = await window.DB.getCard(this.state.manageState.editingCardId);
        if (!card) this.state.manageState.editingCardId = null;
      }
      if (!card) {
        await this.releaseUnusedDraftMedia();
        this.state.cardEditorMedia = { front: [], back: [] };
      } else if (!this.state.cardEditorMedia.front.length && !this.state.cardEditorMedia.back.length) {
        this.state.cardEditorMedia.front = await this.buildDraftsFromMediaIds(card.frontImageIds, true);
        this.state.cardEditorMedia.back = await this.buildDraftsFromMediaIds(card.backImageIds, true);
      }
      await window.UI.populateCardEditor(card, this.state.decks, this.state.cardEditorMedia);
    },

    async buildDraftsFromMediaIds(ids, existing) {
      const drafts = [];
      for (const mediaId of ids || []) {
        const media = await window.DB.getMedia(mediaId);
        if (!media) continue;
        drafts.push(makeDraftItem({ mediaId, name: media.name, blob: media.blob, existing }));
      }
      return drafts;
    },

    async releaseUnusedDraftMedia() {
      const removable = [];
      ['front', 'back'].forEach((side) => {
        this.state.cardEditorMedia[side].forEach((item) => {
          if (!item.existing) removable.push(item.mediaId);
        });
      });
      if (removable.length) await window.DB.deleteMediaIfUnused(removable);
    },

    async resetCardEditor() {
      this.state.manageState.editingCardId = null;
      await this.populateEditorFromCurrentState();
    },

    collectCardFormData() {
      const cardId = document.getElementById('card-id').value.trim();
      const dueLocal = document.getElementById('card-due-at').value;
      let dueAt = new Date().toISOString();
      if (dueLocal) {
        const date = new Date(dueLocal);
        if (!Number.isNaN(date.getTime())) dueAt = date.toISOString();
      }
      return {
        id: cardId || undefined,
        deckId: document.getElementById('card-deck').value,
        question: document.getElementById('card-question').value.trim(),
        answer: document.getElementById('card-answer').value.trim(),
        tags: document.getElementById('card-tags').value,
        state: document.getElementById('card-state').value,
        dueAt,
        intervalDays: Number(document.getElementById('card-interval-days').value || 0),
        easeFactor: Number(document.getElementById('card-ease-factor').value || 2.5),
        reps: Number(document.getElementById('card-reps').value || 0),
        lapses: Number(document.getElementById('card-lapses').value || 0),
        lastReviewIntervalDays: Number(document.getElementById('card-last-review-interval').value || 0),
        suspended: document.getElementById('card-suspended').checked,
        cardType: document.getElementById('card-type').value === 'cloze' ? 'cloze' : 'basic',
        frontImageIds: this.state.cardEditorMedia.front.map((item) => item.mediaId),
        backImageIds: this.state.cardEditorMedia.back.map((item) => item.mediaId),
      };
    },

    async handleCardSave(event) {
      event.preventDefault();
      try {
        const raw = this.collectCardFormData();
        raw.tags = window.Importer.normalizeTags(raw.tags);
        if (raw.id) {
          await window.DB.updateCard(raw);
          window.UI.toast('Card updated.', 'success');
        } else {
          await window.DB.createCard({
            ...window.Scheduler.newCardDefaults(),
            ...raw,
            createdAt: window.DB.nowISO(),
            updatedAt: window.DB.nowISO(),
          });
          window.UI.toast('Card added.', 'success');
        }
        this.state.manageState.editingCardId = null;
        this.state.manageState.selectedIds.clear();
        await this.refreshBaseData();
        await this.renderManageView();
      } catch (error) {
        window.UI.toast(error.message || 'Failed to save card.', 'error');
      }
    },

    async renderManageView() {
      window.UI.fillDeckSelect('card-deck', this.state.decks);
      const manageState = this.state.manageState;
      manageState.search = document.getElementById('manage-search').value.trim();
      manageState.deckFilter = document.getElementById('manage-deck-filter').value;
      manageState.suspendFilter = document.getElementById('manage-suspend-filter').value;
      let result = await window.DB.searchCards({
        query: manageState.search,
        deckId: manageState.deckFilter && manageState.deckFilter !== 'all' ? manageState.deckFilter : '',
        suspendFilter: manageState.suspendFilter,
        page: manageState.page,
        pageSize: manageState.pageSize,
      });
      // If page is out of bounds (e.g. after deleting the last card on page 2+), reset to page 1
      if (!result.items.length && manageState.page > 1) {
        manageState.page = 1;
        result = await window.DB.searchCards({
          query: manageState.search,
          deckId: manageState.deckFilter && manageState.deckFilter !== 'all' ? manageState.deckFilter : '',
          suspendFilter: manageState.suspendFilter,
          page: 1,
          pageSize: manageState.pageSize,
        });
      }
      const deckMap = new Map(this.state.decks.map((deck) => [deck.id, deck.name]));
      result.items = result.items.map((item) => ({ ...item, deckName: deckMap.get(item.deckId) || item.deckId }));
      this.state.manageState.currentItems = result.items;
      window.UI.fillDeckSelect('bulk-move-deck', this.state.decks, { includeNone: true, noneLabel: 'Move selected to...' });
      window.UI.renderManageTable(result, this.state.manageState);
      await this.populateEditorFromCurrentState();
    },

    handleManagePagination(event) {
      const button = event.target.closest('[data-page]');
      if (!button || button.disabled) return;
      this.state.manageState.page = Math.max(1, Number(button.dataset.page || 1));
      this.renderManageView();
    },

    async handleManageTableClick(event) {
      const edit = event.target.closest('[data-edit-card]');
      if (edit) {
        await this.releaseUnusedDraftMedia();
        this.state.cardEditorMedia = { front: [], back: [] };
        this.state.manageState.editingCardId = edit.dataset.editCard;
        await this.populateEditorFromCurrentState();
        return;
      }
      const suspend = event.target.closest('[data-toggle-suspend]');
      if (suspend) {
        try {
          await window.DB.toggleSuspend(suspend.dataset.toggleSuspend, suspend.dataset.nextState === 'true');
          await this.refreshBaseData();
          await this.renderManageView();
        } catch (error) {
          window.UI.toast(error.message || 'Failed to update card.', 'error');
        }
        return;
      }
      const del = event.target.closest('[data-delete-card]');
      if (del) {
        const confirmed = await window.UI.showConfirm({
          eyebrow: 'Delete card',
          title: 'Remove this card?',
          copy: 'The card, its images if no longer used elsewhere, and its review logs will be removed.',
          confirmLabel: 'Delete card',
        });
        if (!confirmed.confirmed) return;
        try {
          await window.DB.deleteCard(del.dataset.deleteCard);
          this.state.manageState.selectedIds.delete(del.dataset.deleteCard);
          if (this.state.manageState.editingCardId === del.dataset.deleteCard) this.state.manageState.editingCardId = null;
          await this.refreshBaseData();
          await this.renderManageView();
          window.UI.toast('Card deleted.', 'success');
        } catch (error) {
          window.UI.toast(error.message || 'Failed to delete card.', 'error');
        }
      }
    },

    handleManageTableChange(event) {
      const checkbox = event.target.closest('[data-select-card]');
      if (!checkbox) return;
      const id = checkbox.dataset.selectCard;
      if (checkbox.checked) this.state.manageState.selectedIds.add(id);
      else this.state.manageState.selectedIds.delete(id);
      this.renderManageView();
    },

    handleSelectPage(event) {
      const ids = JSON.parse(event.target.dataset.pageIds || '[]');
      ids.forEach((id) => {
        if (event.target.checked) this.state.manageState.selectedIds.add(id);
        else this.state.manageState.selectedIds.delete(id);
      });
      this.renderManageView();
    },

    async bulkMoveCards() {
      const deckId = document.getElementById('bulk-move-deck').value;
      if (!deckId) return window.UI.toast('Choose a destination deck first.', 'error');
      const ids = [...this.state.manageState.selectedIds];
      if (!ids.length) return window.UI.toast('Select at least one card.', 'error');
      try {
        await window.DB.bulkMoveCards(ids, deckId);
        this.state.manageState.selectedIds.clear();
        await this.refreshBaseData();
        await this.renderManageView();
        window.UI.toast('Cards moved.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Bulk move failed.', 'error');
      }
    },

    async bulkSuspendCards(suspended) {
      const ids = [...this.state.manageState.selectedIds];
      if (!ids.length) return window.UI.toast('Select at least one card.', 'error');
      try {
        await window.DB.bulkSuspendCards(ids, suspended);
        await this.refreshBaseData();
        await this.renderManageView();
        window.UI.toast(suspended ? 'Cards suspended.' : 'Cards unsuspended.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Bulk update failed.', 'error');
      }
    },

    async bulkResetScheduling() {
      const ids = [...this.state.manageState.selectedIds];
      if (!ids.length) return window.UI.toast('Select at least one card.', 'error');
      const result = await window.UI.showConfirm({
        eyebrow: 'Reset scheduling',
        title: 'Reset selected cards?',
        copy: 'Selected cards will return to new and become due immediately. Content and images are kept.',
        confirmLabel: 'Reset cards',
      });
      if (!result.confirmed) return;
      try {
        await window.DB.bulkResetScheduling(ids);
        await this.refreshBaseData();
        await this.renderManageView();
        window.UI.toast('Scheduling reset.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Reset failed.', 'error');
      }
    },

    async bulkDeleteCards() {
      const ids = [...this.state.manageState.selectedIds];
      if (!ids.length) return window.UI.toast('Select at least one card.', 'error');
      const result = await window.UI.showConfirm({
        eyebrow: 'Delete cards',
        title: `Delete ${ids.length} selected card${ids.length === 1 ? '' : 's'}?`,
        copy: 'Cards, related review logs, and images that become unused will be removed.',
        confirmLabel: 'Delete selected',
      });
      if (!result.confirmed) return;
      try {
        await window.DB.bulkDeleteCards(ids);
        this.state.manageState.selectedIds.clear();
        this.state.manageState.editingCardId = null;
        await this.refreshBaseData();
        await this.renderManageView();
        window.UI.toast('Selected cards deleted.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Delete failed.', 'error');
      }
    },

    prepareReviewSetup() {
      this.clearUndo();
      this.clearReviewAutoRefresh();
      this.state.reviewSession = getDefaultReviewSession();
      this.state.reviewSession.deckId = document.getElementById('review-scope-select').value || 'all';
      this.refreshReviewOverview();
    },

    async refreshReviewOverview() {
      const scope = document.getElementById('review-scope-select').value || 'all';
      const deck = this.state.decks.find((item) => item.id === scope);
      const deckId = scope === 'all' ? null : scope;
      const [scopeSnapshot, queueSnapshot] = await Promise.all([
        window.DB.getReviewScopeSnapshot(deckId),
        window.DB.getReviewQueueSnapshot(deckId, this.state.settings.newCardsPerDay),
      ]);
      const remainingNew = Math.max(0, this.state.settings.newCardsPerDay - queueSnapshot.newStudiedToday);
      window.UI.renderReviewScope(deck ? deck.name : 'All due cards', scopeSnapshot, remainingNew, queueSnapshot.hiddenNewCount);
      if (this.state.reviewSession.mode === 'setup') window.UI.renderReviewSetup(deck ? deck.name : 'All due cards');
    },

    clearUndo() {
      this.state.reviewSession.lastReviewAction = null;
      document.getElementById('undo-last-rating-btn').disabled = true;
    },

    clearReviewAutoRefresh() {
      if (this.state.reviewRefreshTimer) {
        clearTimeout(this.state.reviewRefreshTimer);
        this.state.reviewRefreshTimer = null;
      }
    },

    async launchReviewForScope(scope) {
      window.UI.setActiveView('study');
      this.state.currentView = 'study';
      this.clearUndo();
      this.clearReviewAutoRefresh();
      document.getElementById('review-scope-select').value = scope || 'all';
      await this.startReview();
    },

    async startReview() {
      const scope = document.getElementById('review-scope-select').value || 'all';
      const deck = this.state.decks.find((item) => item.id === scope);
      const queueSnapshot = await window.DB.getReviewQueueSnapshot(scope === 'all' ? null : scope, this.state.settings.newCardsPerDay);
      this.state.reviewSession = {
        ...getDefaultReviewSession(),
        mode: queueSnapshot.cards.length ? 'review' : 'empty',
        deckId: scope,
        deckName: deck ? deck.name : 'All due cards',
        scopeLabel: deck ? deck.name : 'All due cards',
        queue: queueSnapshot.cards,
        totalCount: queueSnapshot.cards.length,
        remainingCount: queueSnapshot.cards.length,
        hiddenNewCount: queueSnapshot.hiddenNewCount,
        nextDueAt: queueSnapshot.nextDueAt,
      };
      if (!queueSnapshot.cards.length) {
        await this.refreshReviewEmptyState(true);
        return;
      }
      await this.advanceReviewCard(false);
    },

    async resolveReviewMedia(ids) {
      const out = [];
      for (const mediaId of ids || []) {
        const media = await window.DB.getMedia(mediaId);
        if (!media) continue;
        out.push({ id: media.id, name: media.name, url: window.UI.trackUrl(media.blob) });
      }
      return out;
    },

    async advanceReviewCard(consume) {
      if (consume) this.state.reviewSession.queue.shift();
      const card = this.state.reviewSession.queue[0] || null;
      if (!card) {
        this.state.reviewSession.mode = 'empty';
        this.state.reviewSession.card = null;
        await this.refreshReviewEmptyState(true);
        return;
      }
      window.UI.revokeObjectUrls();
      this.state.reviewSession.card = card;
      this.state.reviewSession.answerShown = false;
      this.state.reviewSession.remainingCount = this.state.reviewSession.queue.length;
      this.state.reviewSession.frontMedia = await this.resolveReviewMedia(card.frontImageIds);
      this.state.reviewSession.backMedia = [];
      this.state.reviewSession.previews = {
        again: window.Scheduler.getRatingPreviewLabel(card, 'again'),
        hard: window.Scheduler.getRatingPreviewLabel(card, 'hard'),
        good: window.Scheduler.getRatingPreviewLabel(card, 'good'),
        easy: window.Scheduler.getRatingPreviewLabel(card, 'easy'),
      };
      await window.UI.renderReviewCard(this.state.reviewSession);
    },

    async showAnswer() {
      if (this.state.reviewSession.mode !== 'review' || !this.state.reviewSession.card || this.state.reviewSession.busy) return;
      this.state.reviewSession.answerShown = true;
      this.state.reviewSession.shownAt = Date.now();
      this.state.reviewSession.backMedia = await this.resolveReviewMedia(this.state.reviewSession.card.backImageIds);
      await window.UI.renderReviewCard(this.state.reviewSession);
    },

    async rateCurrentCard(rating) {
      const session = this.state.reviewSession;
      if (session.busy || session.mode !== 'review' || !session.card || !session.answerShown) return;
      session.busy = true;
      try {
        const before = window.DB.clone(session.card);
        const applied = window.Scheduler.applyRating(before, rating);
        const studySeconds = session.shownAt ? Math.max(0, Math.round((Date.now() - session.shownAt) / 1000)) : 0;
        applied.reviewLog.studySeconds = studySeconds;
        const saved = await window.DB.applyReview({ cardBefore: before, cardAfter: applied.card, reviewLog: applied.reviewLog });
        session.lastReviewAction = {
          cardSnapshot: before,
          reviewLogId: saved.reviewLog.id,
          scopeDeckId: session.deckId,
        };
        session.reviewedCount += 1;
        session.busy = false;
        if (applied.isLeech) {
          window.UI.toast(`Card suspended - too many lapses (${window.Scheduler.LEECH_THRESHOLD}). Edit it to unsuspend.`, 'error');
        }
        await this.rebuildReviewQueueAfterAction();
      } catch (error) {
        session.busy = false;
        window.UI.toast(error.message || 'Failed to save review.', 'error');
        await window.UI.renderReviewCard(session);
      }
    },

    async rebuildReviewQueueAfterAction() {
      const scope = this.state.reviewSession.deckId === 'all' ? null : this.state.reviewSession.deckId;
      const snapshot = await window.DB.getReviewQueueSnapshot(scope, this.state.settings.newCardsPerDay);
      this.state.reviewSession.queue = snapshot.cards;
      this.state.reviewSession.hiddenNewCount = snapshot.hiddenNewCount;
      this.state.reviewSession.nextDueAt = snapshot.nextDueAt;
      this.state.reviewSession.totalCount = Math.max(this.state.reviewSession.reviewedCount + snapshot.cards.length, this.state.reviewSession.totalCount);
      await this.advanceReviewCard(false);
    },

    async undoLastRating() {
      const session = this.state.reviewSession;
      if (session.busy || !session.lastReviewAction) return;
      if (session.lastReviewAction.scopeDeckId !== session.deckId) return window.UI.toast('Undo is only available in the same review scope.', 'error');
      session.busy = true;
      try {
        await window.DB.undoReview(session.lastReviewAction);
        session.lastReviewAction = null;
        session.reviewedCount = Math.max(0, session.reviewedCount - 1);
        session.busy = false;
        await this.rebuildReviewQueueAfterAction();
        window.UI.toast('Last rating undone.', 'success');
      } catch (error) {
        session.busy = false;
        window.UI.toast(error.message || 'Undo failed.', 'error');
      }
    },

    async suspendCurrentReviewCard() {
      const session = this.state.reviewSession;
      if (!session.card || session.busy) return;
      try {
        await window.DB.toggleSuspend(session.card.id, true);
        session.lastReviewAction = null;
        await this.rebuildReviewQueueAfterAction();
        window.UI.toast('Card suspended.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Could not suspend card.', 'error');
      }
    },

    async editCurrentReviewCard() {
      const card = this.state.reviewSession.card;
      if (!card) return;
      this.endReview(false);
      this.state.manageState.editingCardId = card.id;
      this.state.cardEditorMedia = { front: [], back: [] };
      await this.switchView('cards');
      await this.populateEditorFromCurrentState();
    },

    endReview(returnToSetup) {
      this.clearReviewAutoRefresh();
      const scope = document.getElementById('review-scope-select').value || 'all';
      this.state.reviewSession = getDefaultReviewSession();
      this.state.reviewSession.deckId = scope;
      this.state.reviewSession.mode = 'setup';
      if (returnToSetup) {
        window.UI.renderReviewSetup(scope === 'all' ? 'All due cards' : (this.state.decks.find((deck) => deck.id === scope)?.name || 'Selected deck'));
      } else {
        window.UI.renderStudyHome();
      }
      this.refreshReviewOverview();
    },

    async refreshReviewEmptyState(fromStart) {
      const scope = this.state.reviewSession.deckId === 'all' ? null : this.state.reviewSession.deckId;
      const snapshot = await window.DB.getReviewQueueSnapshot(scope, this.state.settings.newCardsPerDay);
      if (snapshot.cards.length) {
        this.state.reviewSession.mode = 'review';
        this.state.reviewSession.queue = snapshot.cards;
        this.state.reviewSession.hiddenNewCount = snapshot.hiddenNewCount;
        this.state.reviewSession.nextDueAt = snapshot.nextDueAt;
        if (fromStart) this.state.reviewSession.totalCount = snapshot.cards.length;
        await this.advanceReviewCard(false);
        return;
      }
      this.state.reviewSession.mode = 'empty';
      this.state.reviewSession.hiddenNewCount = snapshot.hiddenNewCount;
      this.state.reviewSession.nextDueAt = snapshot.nextDueAt;
      const noCards = (this.state.storage?.cardCount || 0) === 0;
      const hiddenNew = snapshot.hiddenNewCount || 0;
      const eyebrow = noCards ? 'No cards in library' : 'Nothing due right now';
      const title = noCards ? 'No cards yet.' : "You're caught up!";
      let subtitle;
      if (noCards) {
        subtitle = 'Go to Import → PDF section to generate your first flashcards with AI.';
      } else if (hiddenNew > 0) {
        subtitle = `${hiddenNew} new card${hiddenNew === 1 ? '' : 's'} are waiting but hidden to keep today's session at your daily limit. Raise "New cards per day" in Settings to see more.`;
      } else {
        subtitle = snapshot.nextDueAt
          ? 'Great work! The next card will appear automatically when it becomes due.'
          : 'All done. Add more cards in Import to keep the queue going.';
      }
      window.UI.renderReviewEmpty({
        nextDueRelative: noCards ? '—' : window.Stats.formatRelativeFuture(snapshot.nextDueAt),
        nextDueExact: noCards ? '—' : window.Stats.formatDateTime(snapshot.nextDueAt),
        hiddenNewCount: snapshot.hiddenNewCount,
        eyebrow,
        title,
        subtitle,
      });
      this.clearReviewAutoRefresh();
      this.state.reviewRefreshTimer = window.setTimeout(() => {
        if (this.state.currentView === 'study' && this.state.reviewSession.mode === 'empty') this.refreshReviewEmptyState(false);
      }, 30000);
    },

    async handleImport(event) {
      event.preventDefault();
      const fileInput = document.getElementById('import-file');
      const file = fileInput.files[0];
      if (!file) return window.UI.toast('Choose a file to import.', 'error');
      try {
        let parsed;
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.apkg')) {
          window.UI.renderImportSummary({ title: 'Reading .apkg file...', copy: 'Extracting ZIP and parsing Anki database. Please wait.' });
          parsed = await window.ApkgReader.parseApkgFile(file, (msg) => {
            window.UI.renderImportSummary({ title: msg, copy: 'Parsing notes and preparing image extraction…' });
          });
        } else {
          const text = await file.text();
          parsed = window.Importer.parseImportFile(file.name, text);
        }
        const newDeckName = document.getElementById('import-new-deck-name').value.trim();
        let defaultDeckId = document.getElementById('import-deck-select').value || '';
        if (newDeckName) {
          const deck = await window.DB.createDeck(newDeckName);
          defaultDeckId = deck.id;
        }
        if (['txt', 'tsv'].includes(parsed.fileType) && !defaultDeckId) {
          throw new Error('Choose a target deck for this import type, or create a new deck above.');
        }

        const rows = parsed.imported.map((row) => ({
          ...row,
          deckId: parsed.fileType === 'csv' ? null : (defaultDeckId || null),
          deckName: (parsed.fileType === 'csv' || (!defaultDeckId && parsed.fileType === 'apkg')) ? (row.deckName || '') : '',
        }));

        const resolvedRows = [];
        for (const row of rows) {
          let deckId = row.deckId;
          if (parsed.fileType === 'csv' || (!deckId && parsed.fileType === 'apkg')) {
            const fallbackDeckId = defaultDeckId || 'default';
            const deckName = String(row.deckName || '').trim();
            let targetDeck = null;
            if (deckName) {
              targetDeck = this.state.decks.find((item) => item.name.toLowerCase() === deckName.toLowerCase()) || null;
              if (!targetDeck) {
                targetDeck = await window.DB.createDeck(deckName);
                this.state.decks.push(targetDeck);
              }
            } else {
              targetDeck = this.state.decks.find((item) => item.id === fallbackDeckId) || null;
              if (!targetDeck && fallbackDeckId === 'default') {
                targetDeck = this.state.decks.find((item) => item.name.toLowerCase() === window.DB.DEFAULT_DECK_NAME.toLowerCase()) || null;
              }
              if (!targetDeck) throw new Error('Could not resolve the target deck for CSV import.');
            }
            deckId = targetDeck.id;
          }
          resolvedRows.push({ ...row, deckId });
        }

        const deduped = await window.Importer.detectImportDuplicates(resolvedRows, defaultDeckId);
        let mediaIdByName = new Map();
        const extraSkipped = [];

        if (parsed.fileType === 'apkg' && typeof parsed.loadMediaFiles === 'function') {
          const requestedMediaNames = [...new Set(deduped.accepted.flatMap((row) => [
            ...(row.frontImageNames || []),
            ...(row.backImageNames || []),
          ]))];

          if (requestedMediaNames.length) {
            window.UI.renderImportSummary({
              title: 'Importing .apkg media...',
              copy: `Preparing ${requestedMediaNames.length} referenced image${requestedMediaNames.length === 1 ? '' : 's'}.`,
            });
            const { mediaFiles, missing } = await parsed.loadMediaFiles(requestedMediaNames, (msg) => {
              window.UI.renderImportSummary({ title: msg, copy: 'Only images still needed after duplicate filtering are being extracted.' });
            });
            const createdMedia = await window.DB.bulkCreateMedia(mediaFiles.map((item) => ({
              name: item.name,
              type: item.type,
              size: item.size,
              blob: new Blob([item.data], { type: item.type }),
            })));
            mediaIdByName = new Map(createdMedia.map((item) => [item.name, item.id]));

            if (missing.length) {
              missing.forEach((item) => extraSkipped.push(`Media "${item.name}": ${item.reason}`));
            }
          }
        }

        const resolveMediaId = (name) => {
          const raw = String(name || '').trim();
          if (!raw) return '';
          if (mediaIdByName.has(raw)) return mediaIdByName.get(raw);
          let decoded = raw;
          try { decoded = decodeURIComponent(raw); } catch (_) {}
          if (mediaIdByName.has(decoded)) return mediaIdByName.get(decoded);
          const trimmed = decoded.replace(/^\.?[\\/]+/, '');
          if (mediaIdByName.has(trimmed)) return mediaIdByName.get(trimmed);
          const basename = trimmed.split(/[\\/]/).pop() || trimmed;
          return mediaIdByName.get(basename) || '';
        };

        const cardsToCreate = deduped.accepted.map((row) => {
          const frontImageIds = (row.frontImageNames || [])
            .map((name) => resolveMediaId(name))
            .filter(Boolean);
          const backImageIds = (row.backImageNames || [])
            .map((name) => resolveMediaId(name))
            .filter(Boolean);
          const frontOk = row.question !== '[image]' || frontImageIds.length > 0;
          const backOk = row.answer !== '[image]' || backImageIds.length > 0;
          if (!frontOk || !backOk) {
            extraSkipped.push(`Row ${row.row}: missing required image media for an image-only card side.`);
            return null;
          }
          return {
            ...window.Scheduler.newCardDefaults(),
            id: window.DB.id('card'),
            deckId: row.deckId,
            question: row.question,
            answer: row.answer,
            tags: row.tags,
            cardType: row.cardType || 'basic',
            frontImageIds,
            backImageIds,
            createdAt: window.DB.nowISO(),
            updatedAt: window.DB.nowISO(),
          };
        }).filter(Boolean);
        if (cardsToCreate.length) await window.DB.bulkCreateCards(cardsToCreate);
        await this.refreshBaseData();
        await this.renderManageView();
        const formatLabel = parsed.fileType === 'apkg' ? '.apkg' : parsed.fileType === 'tsv' ? 'TSV' : parsed.fileType === 'csv' ? 'CSV' : 'TXT';
        window.UI.renderImportSummary({
          title: `Imported ${cardsToCreate.length} card${cardsToCreate.length === 1 ? '' : 's'} from ${formatLabel}.`,
          copy: `Skipped ${parsed.skipped.length + extraSkipped.length} invalid row(s) and ${deduped.duplicates.length} duplicate(s).${parsed.fileType === 'apkg' ? ` Imported ${mediaIdByName.size} image${mediaIdByName.size === 1 ? '' : 's'}.` : ''}`,
          details: [
            ...(parsed.skipped.length ? parsed.skipped.map((item) => `Row ${item.row}: ${item.reason}`) : []),
            ...extraSkipped,
            ...(deduped.duplicates.length ? deduped.duplicates.map((item) => `Duplicate: ${item.question.slice(0, 60)}`) : []),
          ].join('\n'),
        });
        fileInput.value = '';
        document.getElementById('import-file-label-text').textContent = 'Choose source file';
        fileInput.closest('.file-pick-wrap').querySelector('.file-pick-label').classList.remove('has-file');
        document.getElementById('import-new-deck-name').value = '';
        window.UI.toast('Import complete.', 'success');
      } catch (error) {
        window.UI.renderImportSummary({ title: 'Import failed.', copy: error.message || 'Could not import file.' });
        window.UI.toast(error.message || 'Import failed.', 'error');
      }
    },

    async handleExportBackup() {
      try {
        window.UI.renderBackupSummary('Building backup...');
        const json = await window.Importer.exportBackup();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        window.Importer.downloadFile(`offline-flashcards-v5-backup-${stamp}.json`, json, 'application/json');
        window.UI.renderBackupSummary('Backup downloaded.', 'success');
        window.UI.toast('Backup downloaded.', 'success');
      } catch (error) {
        window.UI.renderBackupSummary(error.message || 'Backup failed.', 'error');
        window.UI.toast(error.message || 'Backup failed.', 'error');
      }
    },

    async handleRestoreBackup() {
      const file = document.getElementById('import-backup-file').files[0];
      if (!file) return window.UI.toast('Choose a backup file first.', 'error');
      const confirmed = await window.UI.showConfirm({
        eyebrow: 'Restore backup',
        title: 'Replace all current local data?',
        copy: 'A safety backup will download first. Restore only proceeds if validation succeeds completely.',
        confirmLabel: 'Restore now',
      });
      if (!confirmed.confirmed) return;
      try {
        const safetyBackup = await window.Importer.exportBackup();
        const safetyStamp = new Date().toISOString().replace(/[:.]/g, '-');
        window.Importer.downloadFile(`offline-flashcards-v5-safety-backup-${safetyStamp}.json`, safetyBackup, 'application/json');
        const jsonText = await file.text();
        const result = await window.Importer.restoreBackup(jsonText);
        await this.loadSettings();
        await this.refreshBaseData();
        this.resetReviewAndEditorState();
        window.UI.renderBackupSummary(`Restore complete. ${result.cards} cards, ${result.reviewLogs} logs, ${result.media} images restored.`, 'success');
        window.UI.toast('Restore complete.', 'success');
        const bkInput = document.getElementById('import-backup-file');
        bkInput.value = '';
        document.getElementById('import-backup-file-label-text').textContent = 'Choose backup file (.json)';
        bkInput.closest('.file-pick-wrap').querySelector('.file-pick-label').classList.remove('has-file');
      } catch (error) {
        window.UI.renderBackupSummary(error.message || 'Restore failed.', 'error');
        window.UI.toast(error.message || 'Restore failed.', 'error');
      }
    },

    resetReviewAndEditorState() {
      this.clearReviewAutoRefresh();
      this.state.reviewSession = getDefaultReviewSession();
      this.state.manageState.selectedIds.clear();
      this.state.manageState.editingCardId = null;
      this.state.cardEditorMedia = { front: [], back: [] };
      window.UI.revokeObjectUrls();
    },

    showOnboarding() {
      this.state.onboardingStep = 1;
      this._renderOnboardingStep();
      document.getElementById('onboarding-dialog').showModal();
    },

    closeOnboarding() {
      localStorage.setItem('ankur_onboarded', '1');
      document.getElementById('onboarding-dialog').close();
    },

    onboardingNext() {
      const total = 5;
      if (this.state.onboardingStep < total) {
        this.state.onboardingStep += 1;
        this._renderOnboardingStep();
      } else {
        this.closeOnboarding();
      }
    },

    onboardingPrev() {
      if (this.state.onboardingStep > 1) {
        this.state.onboardingStep -= 1;
        this._renderOnboardingStep();
      }
    },

    _renderOnboardingStep() {
      const step = this.state.onboardingStep;
      const total = 5;
      document.querySelectorAll('.onboarding-step').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.step) === step);
      });
      const dotsEl = document.getElementById('onboarding-dots');
      dotsEl.innerHTML = Array.from({ length: total }, (_, i) =>
        `<div class="onboarding-dot${i + 1 === step ? ' active' : ''}"></div>`
      ).join('');
      const prevBtn = document.getElementById('onboarding-prev');
      const nextBtn = document.getElementById('onboarding-next');
      prevBtn.style.visibility = step === 1 ? 'hidden' : 'visible';
      nextBtn.textContent = step === total ? 'Get started' : 'Next';
    },

    async handlePdfImport() {
      const fileInput = document.getElementById('pdf-file');
      const file = fileInput.files[0];
      if (!file) return window.UI.toast('Choose a PDF file first.', 'error');
      if (!file.name.toLowerCase().endsWith('.pdf')) return window.UI.toast('Please choose a .pdf file.', 'error');
      if (file.size > 50 * 1024 * 1024) return window.UI.toast('PDF is too large (max 50 MB). Try a smaller file.', 'error');

      if (!window.PdfImporter) return window.UI.toast('PDF importer failed to load. Check your internet connection and refresh.', 'error');

      const apiKey = localStorage.getItem('openai_api_key') || '';
      if (!apiKey) return window.UI.toast('Add your OpenAI API key in Settings first.', 'error');

      const newDeckName = document.getElementById('pdf-new-deck-name').value.trim();
      let deckId = document.getElementById('pdf-deck-select').value || '';
      if (newDeckName) {
        try {
          const deck = await window.DB.createDeck(newDeckName);
          deckId = deck.id;
          await this.refreshBaseData();
          document.getElementById('pdf-new-deck-name').value = '';
        } catch (err) {
          return window.UI.toast(err.message || 'Could not create deck.', 'error');
        }
      }
      if (!deckId) return window.UI.toast('Choose or create a target deck.', 'error');

      const statusEl = document.getElementById('pdf-status');
      const previewWrap = document.getElementById('pdf-preview-wrap');
      const generateBtn = document.getElementById('pdf-generate-btn');

      statusEl.classList.remove('hidden');
      statusEl.textContent = 'Starting…';
      previewWrap.classList.add('hidden');
      generateBtn.disabled = true;

      try {
        const cards = await window.PdfImporter.generateFlashcardsFromPdf(file, apiKey, (msg) => {
          statusEl.textContent = msg;
        });
        if (!cards.length) {
          statusEl.textContent = 'No cards could be generated from this PDF. Try a different file.';
          return;
        }
        this.state.pdfCards = cards.map((c, i) => ({ ...c, _id: i, deckId }));
        this.state.pdfFilter = 'all';
        statusEl.textContent = `Done — ${cards.length} cards generated. Review below, then click Add.`;
        document.getElementById('pdf-new-deck-name').value = '';
        this.renderPdfPreview();
        previewWrap.classList.remove('hidden');
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        window.UI.toast(err.message, 'error');
      } finally {
        generateBtn.disabled = false;
      }
    },

    renderPdfPreview() {
      const cards = this.state.pdfCards || [];
      const filter = this.state.pdfFilter || 'all';
      const visible = filter === 'all' ? cards : cards.filter((c) => c.difficulty === filter);

      // Update filter button active state
      document.querySelectorAll('.pdf-filter-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });

      const tbody = document.getElementById('pdf-preview-body');
      tbody.innerHTML = '';
      visible.forEach((card) => {
        const tr = document.createElement('tr');
        tr.dataset.id = card._id;
        const td0 = document.createElement('td');
        td0.className = 'checkbox-col';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'pdf-card-check';
        cb.dataset.id = card._id;
        cb.checked = !card._excluded;
        cb.addEventListener('change', () => { card._excluded = !cb.checked; this.updatePdfCount(); });
        td0.appendChild(cb);
        const td1 = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `difficulty-pill difficulty-${card.difficulty}`;
        badge.textContent = card.difficulty;
        td1.appendChild(badge);
        const td2 = document.createElement('td');
        td2.className = 'pdf-cell-text';
        td2.textContent = card.question;
        const td3 = document.createElement('td');
        td3.className = 'pdf-cell-text';
        td3.textContent = card.answer;
        tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
        tbody.appendChild(tr);
      });

      const easy = cards.filter((c) => c.difficulty === 'easy').length;
      const medium = cards.filter((c) => c.difficulty === 'medium').length;
      const hard = cards.filter((c) => c.difficulty === 'hard').length;
      document.getElementById('pdf-preview-count').textContent =
        `${cards.length} cards — Easy: ${easy}  Medium: ${medium}  Hard: ${hard}`;
      document.getElementById('pdf-check-all').checked = visible.length > 0 && visible.every((c) => !c._excluded);
      this.updatePdfCount();
    },

    pdfToggleAll(checked) {
      const cards = this.state.pdfCards || [];
      const filter = this.state.pdfFilter || 'all';
      const visible = filter === 'all' ? cards : cards.filter((c) => c.difficulty === filter);
      visible.forEach((c) => { c._excluded = !checked; });
      document.querySelectorAll('.pdf-card-check').forEach((cb) => { cb.checked = checked; });
      this.updatePdfCount();
    },

    pdfFilterByDifficulty(filter) {
      this.state.pdfFilter = filter;
      this.renderPdfPreview();
    },

    updatePdfCount() {
      const selected = (this.state.pdfCards || []).filter((c) => !c._excluded).length;
      document.getElementById('pdf-import-count').textContent = selected;
    },

    async handlePdfConfirmImport() {
      const toImport = (this.state.pdfCards || []).filter((c) => !c._excluded);
      if (!toImport.length) return window.UI.toast('No cards selected.', 'error');
      const importBtn = document.getElementById('pdf-import-btn');
      importBtn.disabled = true;
      try {
        const rows = toImport.map((c) => ({
          deckId: c.deckId,
          question: c.question,
          answer: c.answer,
          tags: [c.difficulty],
          cardType: 'basic',
        }));
        const deduped = await window.Importer.detectImportDuplicates(rows, rows[0].deckId);
        if (deduped.accepted.length) await window.DB.bulkCreateCards(deduped.accepted);
        await this.refreshBaseData();
        document.getElementById('pdf-preview-wrap').classList.add('hidden');
        const statusEl = document.getElementById('pdf-status');
        const n = deduped.accepted.length;
        const d = deduped.duplicates.length;
        statusEl.textContent = n > 0
          ? `Imported ${n} card${n === 1 ? '' : 's'}${d > 0 ? `. Skipped ${d} duplicate${d === 1 ? '' : 's'}.` : '.'}`
          : `All ${d} card${d === 1 ? '' : 's'} already exist in this deck — nothing new to import.`;
        this.state.pdfCards = [];
        if (n > 0) window.UI.toast(`Imported ${n} cards.`, 'success');
        else window.UI.toast('All cards were already in the deck.', 'info');
      } catch (err) {
        window.UI.toast(err.message || 'Import failed.', 'error');
      } finally {
        importBtn.disabled = false;
      }
    },

    handlePdfDiscard() {
      this.state.pdfCards = [];
      this.state.pdfFilter = 'all';
      document.getElementById('pdf-preview-wrap').classList.add('hidden');
      document.getElementById('pdf-status').classList.add('hidden');
      document.getElementById('pdf-file').value = '';
      document.getElementById('pdf-file-label-text').textContent = 'Choose PDF file';
      document.querySelector('.file-pick-label').classList.remove('has-file');
      document.getElementById('pdf-new-deck-name').value = '';
    },

    async renderStatsView() {
      const [cards, decks, logs] = await Promise.all([window.DB.listCards(), window.DB.listDecks(), window.DB.listReviewLogs()]);
      const dailyStats = window.Stats.computeDailyStats(logs);
      window.UI.renderStats({
        topStrip: window.Stats.buildTopStrip(cards, logs, dailyStats),
        dailyStats,
        perDeck: window.Stats.computePerDeckStats(cards, decks, logs),
      });
    },

    async saveSettings() {
      try {
        const theme = document.getElementById('theme-select').value === 'dark' ? 'dark' : 'light';
        const newCardsPerDay = Math.max(0, Number(document.getElementById('new-cards-per-day').value || 0));
        const apiKey = document.getElementById('openai-api-key').value.trim();
        if (apiKey) localStorage.setItem('openai_api_key', apiKey);
        else localStorage.removeItem('openai_api_key');
        await Promise.all([
          window.DB.setSetting('theme', theme),
          window.DB.setSetting('newCardsPerDay', newCardsPerDay),
        ]);
        this.state.settings.theme = theme;
        this.state.settings.newCardsPerDay = newCardsPerDay;
        window.UI.setTheme(theme);
        await this.refreshReviewOverview();
        window.UI.toast('Settings saved.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Could not save settings.', 'error');
      }
    },

    async seedSampleData() {
      try {
        const deckA = await window.DB.createDeck('Sample Medicine');
        const deckB = await window.DB.createDeck('Sample Biology');
        const rows = [
          [deckA.id, 'Name the four chambers of the heart.', 'Right atrium, right ventricle, left atrium, left ventricle.'],
          [deckA.id, 'What carries oxygenated blood from the lungs to the heart?', 'The pulmonary veins.'],
          [deckA.id, 'Define systole.', 'The contraction phase of the cardiac cycle.'],
          [deckA.id, 'Which valve sits between the left atrium and left ventricle?', 'The mitral valve.'],
          [deckB.id, 'What is the powerhouse of the cell?', 'The mitochondrion.'],
          [deckB.id, 'Which molecule carries genetic instructions?', 'DNA.'],
          [deckB.id, 'What is osmosis?', 'The net movement of water across a semipermeable membrane.'],
          [deckB.id, 'What do ribosomes do?', 'They synthesize proteins.'],
        ];
        await window.DB.bulkCreateCards(rows.map(([deckId, question, answer]) => ({
          ...window.Scheduler.newCardDefaults(),
          id: window.DB.id('card'),
          deckId,
          question,
          answer,
          tags: [],
          frontImageIds: [],
          backImageIds: [],
          createdAt: window.DB.nowISO(),
          updatedAt: window.DB.nowISO(),
        }))); 
        await this.refreshBaseData();
        await this.renderManageView();
        window.UI.toast('Sample data added.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Sample data could not be added.', 'error');
      }
    },

    async cleanupOrphanMedia() {
      try {
        const deleted = await window.DB.cleanupOrphanMedia();
        await this.refreshBaseData();
        await this.refreshSettingsView();
        window.UI.toast(`Deleted ${deleted} orphan image${deleted === 1 ? '' : 's'}.`, 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Cleanup failed.', 'error');
      }
    },

    async clearReviewLogs() {
      const confirmed = await window.UI.showConfirm({
        eyebrow: 'Clear review logs',
        title: 'Delete all study history?',
        copy: 'Cards, scheduling, and images stay intact. Only the review log history is removed.',
        confirmLabel: 'Clear logs',
      });
      if (!confirmed.confirmed) return;
      try {
        await window.DB.clearReviewLogs();
        await this.refreshBaseData();
        if (this.state.currentView === 'stats') await this.renderStatsView();
        window.UI.toast('Review logs cleared.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Could not clear logs.', 'error');
      }
    },

    async wipeData() {
      const confirmed = await window.UI.showConfirm({
        eyebrow: 'Delete everything',
        title: 'Remove all local data?',
        copy: 'This deletes decks, cards, images, review logs, settings, and API key from this browser. The page will reload.',
        confirmLabel: 'Delete everything',
      });
      if (!confirmed.confirmed) return;
      try {
        await window.DB.wipeAll();
        ['openai_api_key', 'ankur_onboarded'].forEach((k) => localStorage.removeItem(k));
        window.location.reload();
      } catch (error) {
        window.UI.toast(error.message || 'Could not delete data.', 'error');
      }
    },

    async resetSiteData() {
      const confirmed = await window.UI.showConfirm({
        eyebrow: 'Reset site data',
        title: 'Clear all data for this app?',
        copy: 'This removes your cards, decks, settings, API key, and cached files — only for this app. No other Chrome data is affected. The page will reload.',
        confirmLabel: 'Clear site data',
      });
      if (!confirmed.confirmed) return;
      try {
        // 1. Wipe IndexedDB
        await window.DB.wipeAll();
        // 2. Clear all localStorage keys belonging to this app
        ['openai_api_key', 'ankur_onboarded'].forEach((k) => localStorage.removeItem(k));
        // 3. Unregister service workers
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        // 4. Clear all cache storage
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        // 5. Reload fresh
        window.location.reload();
      } catch (error) {
        window.UI.toast(error.message || 'Could not reset site data.', 'error');
      }
    },

    wrapAsCloze() {
      const textarea = document.getElementById('card-question');
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const selected = text.slice(start, end).trim() || 'answer';
      const wrapped = `{{c1::${selected}}}`;
      textarea.value = text.slice(0, start) + wrapped + text.slice(end);
      textarea.selectionStart = start + wrapped.length;
      textarea.selectionEnd = start + wrapped.length;
      textarea.focus();
    },

    handleGlobalKeys(event) {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (['input', 'textarea', 'select'].includes(activeTag)) return;
      if (this.state.currentView !== 'study') return;
      const session = this.state.reviewSession;
      if (event.code === 'KeyZ' && session.lastReviewAction && !session.busy) {
        event.preventDefault();
        this.undoLastRating();
        return;
      }
      if (session.mode !== 'review' || !session.card || session.busy) return;
      if (!session.answerShown && event.code === 'Space') {
        event.preventDefault();
        this.showAnswer();
        return;
      }
      const map = { Digit1: 'again', Digit2: 'hard', Digit3: 'good', Digit4: 'easy' };
      if (session.answerShown && map[event.code]) {
        event.preventDefault();
        this.rateCurrentCard(map[event.code]);
      }
    },
  };

  window.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})();
