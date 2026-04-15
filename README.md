# Offline Flashcards V5

A lightweight offline flashcard web app that runs entirely in the browser by opening `index.html` locally.

## What is new in V5

- dedicated image media store with local offline image support on front and back
- media reference counting for safer cleanup and fewer full-card scans
- compound IndexedDB indexes for faster review queue and deck-level due lookups
- backup / restore now includes decks, cards, review logs, images, and settings
- fail-closed backup validation for missing decks, cards, logs, or media references
- safety backup download before restore
- bulk actions in Manage Cards
- drag/drop and paste image upload in the card editor
- review logs remain the source of truth for stats and daily new-card counting

## File tree

- index.html
- styles.css
- app.js
- db.js
- scheduler.js
- importer.js
- stats.js
- ui.js
- sample_import.txt
- sample_import.csv

## How to use

1. Download the bundle and unzip it.
2. Open `index.html` in a modern browser.
3. Create a deck or import a TXT / CSV file.
4. Start review from the Dashboard or Review tab.
5. Export a backup regularly from Import / Export.

## Import formats

### TXT
One card per line:

`front;back`

Quoted fields are supported so semicolons can appear inside a card.

### CSV
Header row required:

`front,back,deck,tags`

- `front` and `back` are required
- `deck` is optional
- `tags` is optional and comma-separated inside the cell

## Backup behavior

Export creates one JSON file containing:
- decks
- cards
- review logs
- media/images
- settings/meta

Restore behavior:
- validates structure before replacing anything
- validates deck references, card references, log references, and image references
- reconstructs image blobs from the backup
- downloads a safety backup before restore
- replaces data atomically

## Known limitations

- search still uses cursor filtering for contains-match text search; it is fine for a few thousand cards but is not a full text-search engine
- no sync or accounts
- no audio/video/media other than images
- no .apkg import
- image-heavy backups can become large

## Manual regression checklist

### Review flow
- start review for all decks and for a single deck
- verify order: learning/relearning first, then new, then review
- verify rating previews match the actual next due time
- verify Show Answer, rating buttons, keyboard shortcuts, and progress bar all work

### Undo
- rate a card once, undo it, and confirm the card returns exactly to its prior state
- change review scope and confirm undo no longer crosses scopes

### Daily new-card limit
- set a small daily limit in Settings
- confirm due learning/relearning and review cards still appear
- confirm extra new cards are hidden and reported in the UI

### Manage Cards
- add a card manually
- edit a card
- suspend and unsuspend a card
- run bulk move, bulk suspend, bulk reset scheduling, and bulk delete

### Image upload / display / removal
- upload front and back images
- drag and drop an image into the editor
- paste an image from the clipboard into the editor
- save the card and confirm images display in Review
- remove an image before save and confirm it disappears

### Orphan media cleanup
- upload images, cancel/reset without saving, then run cleanup
- delete a card with images and confirm unused media is removed

### Import
- import TXT into an existing deck
- import CSV with deck and tags columns
- confirm invalid rows are skipped and duplicates are reported cleanly

### Backup / restore
- export a backup, wipe data, restore backup, and confirm cards, logs, images, and settings return
- try a malformed backup and confirm restore fails without touching existing data

### Persistence
- close the browser tab and reopen `index.html`
- confirm decks, cards, review state, settings, and images remain available
