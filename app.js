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
      currentView: 'dashboard',
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
    },

    async init() {
      try {
        await window.DB.ensureDefaultDeck();
        this.bindEvents();
        await this.loadSettings();
        await this.refreshBaseData();
        await this.switchView('dashboard');
        window.UI.showMessage('Offline Flashcards V5 is ready. Everything stays local to this browser until you export a backup.', 'success');
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
        }, 180);
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

      document.getElementById('save-settings-btn').addEventListener('click', () => this.saveSettings());
      document.getElementById('seed-sample-data-btn').addEventListener('click', () => this.seedSampleData());
      document.getElementById('cleanup-orphan-media-btn').addEventListener('click', () => this.cleanupOrphanMedia());
      document.getElementById('clear-review-logs-btn').addEventListener('click', () => this.clearReviewLogs());
      document.getElementById('wipe-data-btn').addEventListener('click', () => this.wipeData());

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
      document.getElementById('new-cards-per-day').value = this.state.settings.newCardsPerDay;
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
      window.UI.fillDeckSelect('bulk-move-deck', decks, { includeNone: true, noneLabel: 'Move selected to…' });
      window.UI.fillDeckSelect('import-deck-select', decks, { includeNone: true, noneLabel: 'Choose target deck' });
      await this.refreshReviewOverview();
      await this.populateEditorFromCurrentState();
    },

    async switchView(view) {
      if (this.state.currentView === 'manage' && view !== 'manage') {
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
      if (this.state.currentView === 'review') {
        await this.refreshReviewOverview();
      }
      if (this.state.currentView === 'manage') {
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
      const result = await window.DB.searchCards({
        query: manageState.search,
        deckId: manageState.deckFilter && manageState.deckFilter !== 'all' ? manageState.deckFilter : '',
        suspendFilter: manageState.suspendFilter,
        page: manageState.page,
        pageSize: manageState.pageSize,
      });
      const deckMap = new Map(this.state.decks.map((deck) => [deck.id, deck.name]));
      result.items = result.items.map((item) => ({ ...item, deckName: deckMap.get(item.deckId) || item.deckId }));
      this.state.manageState.currentItems = result.items;
      window.UI.fillDeckSelect('bulk-move-deck', this.state.decks, { includeNone: true, noneLabel: 'Move selected to…' });
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
      window.UI.setActiveView('review');
      this.state.currentView = 'review';
      document.getElementById('review-scope-select').value = scope || 'all';
      this.prepareReviewSetup();
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
        await this.rebuildReviewQueueAfterAction();
        window.UI.toast('Saved', 'success');
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
      await this.switchView('manage');
      await this.populateEditorFromCurrentState();
    },

    endReview(returnToSetup) {
      this.clearReviewAutoRefresh();
      const scope = document.getElementById('review-scope-select').value || 'all';
      this.state.reviewSession = getDefaultReviewSession();
      this.state.reviewSession.deckId = scope;
      this.state.reviewSession.mode = 'setup';
      if (returnToSetup) window.UI.renderReviewSetup(scope === 'all' ? 'All due cards' : (this.state.decks.find((deck) => deck.id === scope)?.name || 'Selected deck'));
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
      window.UI.renderReviewEmpty({
        nextDueRelative: window.Stats.formatRelativeFuture(snapshot.nextDueAt),
        nextDueExact: window.Stats.formatDateTime(snapshot.nextDueAt),
        hiddenNewCount: snapshot.hiddenNewCount,
        title: 'You’re caught up.',
        subtitle: 'The next card will appear here automatically when it becomes due.',
      });
      this.clearReviewAutoRefresh();
      this.state.reviewRefreshTimer = window.setTimeout(() => {
        if (this.state.currentView === 'review' && this.state.reviewSession.mode === 'empty') this.refreshReviewEmptyState(false);
      }, 30000);
    },

    async handleImport(event) {
      event.preventDefault();
      const fileInput = document.getElementById('import-file');
      const file = fileInput.files[0];
      if (!file) return window.UI.toast('Choose a file to import.', 'error');
      try {
        const text = await file.text();
        const parsed = window.Importer.parseImportFile(file.name, text);
        const newDeckName = document.getElementById('import-new-deck-name').value.trim();
        let defaultDeckId = document.getElementById('import-deck-select').value || '';
        if (newDeckName) {
          const deck = await window.DB.createDeck(newDeckName);
          defaultDeckId = deck.id;
        }
        if (parsed.fileType === 'txt' && !defaultDeckId) throw new Error('Choose a target deck for TXT imports or create a new deck.');

        const rows = parsed.imported.map((row) => ({
          ...row,
          deckId: parsed.fileType === 'csv' ? null : defaultDeckId,
        }));

        const resolvedRows = [];
        for (const row of rows) {
          let deckId = row.deckId;
          if (parsed.fileType === 'csv') {
            const deckName = row.deckName || defaultDeckId || window.DB.DEFAULT_DECK_NAME;
            let targetDeck = this.state.decks.find((item) => item.name.toLowerCase() === String(deckName).toLowerCase()) || null;
            if (!targetDeck) {
              targetDeck = await window.DB.createDeck(deckName);
              this.state.decks.push(targetDeck);
            }
            deckId = targetDeck.id;
          }
          resolvedRows.push({ ...row, deckId });
        }

        const deduped = await window.Importer.detectImportDuplicates(resolvedRows, defaultDeckId);
        const cardsToCreate = deduped.accepted.map((row) => ({
          ...window.Scheduler.newCardDefaults(),
          id: window.DB.id('card'),
          deckId: row.deckId,
          question: row.question,
          answer: row.answer,
          tags: row.tags,
          frontImageIds: [],
          backImageIds: [],
          createdAt: window.DB.nowISO(),
          updatedAt: window.DB.nowISO(),
        }));
        if (cardsToCreate.length) await window.DB.bulkCreateCards(cardsToCreate);
        await this.refreshBaseData();
        await this.renderManageView();
        window.UI.renderImportSummary({
          title: `Imported ${cardsToCreate.length} card${cardsToCreate.length === 1 ? '' : 's'}.`,
          copy: `Skipped ${parsed.skipped.length} invalid row(s) and ${deduped.duplicates.length} duplicate(s).`,
          details: [
            ...(parsed.skipped.length ? parsed.skipped.map((item) => `Row ${item.row}: ${item.reason}`) : []),
            ...(deduped.duplicates.length ? deduped.duplicates.map((item) => `Duplicate: ${item.question.slice(0, 60)}`) : []),
          ].join('\n'),
        });
        fileInput.value = '';
        document.getElementById('import-new-deck-name').value = '';
        window.UI.toast('Import complete.', 'success');
      } catch (error) {
        window.UI.renderImportSummary({ title: 'Import failed.', copy: error.message || 'Could not import file.' });
        window.UI.toast(error.message || 'Import failed.', 'error');
      }
    },

    async handleExportBackup() {
      try {
        window.UI.renderBackupSummary('Building backup…');
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
        copy: 'This deletes decks, cards, images, review logs, and settings from this browser.',
        confirmLabel: 'Delete everything',
      });
      if (!confirmed.confirmed) return;
      try {
        await window.DB.wipeAll();
        await window.DB.ensureDefaultDeck();
        await window.DB.setSetting('theme', 'light');
        await window.DB.setSetting('newCardsPerDay', 20);
        this.resetReviewAndEditorState();
        await this.loadSettings();
        await this.refreshBaseData();
        await this.switchView('dashboard');
        window.UI.toast('All data removed.', 'success');
      } catch (error) {
        window.UI.toast(error.message || 'Could not delete data.', 'error');
      }
    },

    handleGlobalKeys(event) {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (['input', 'textarea', 'select'].includes(activeTag)) return;
      if (this.state.currentView !== 'review') return;
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
