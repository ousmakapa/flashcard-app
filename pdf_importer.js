(function () {
  'use strict';

  const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
  const MODEL = 'gpt-4o-mini';
  const CHUNK_CHARS = 4000;

  let pdfJsReady = false;

  async function loadPdfJs() {
    if (pdfJsReady && window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_CDN;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load PDF.js. Check your internet connection.'));
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    pdfJsReady = true;
    return window.pdfjsLib;
  }

  async function extractPdfText(file, onProgress) {
    const pdfjs = await loadPdfJs();
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buffer }).promise;
    const total = pdf.numPages;
    const parts = [];
    for (let i = 1; i <= total; i++) {
      if (onProgress) onProgress(`Extracting text… page ${i} / ${total}`);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((it) => it.str).join(' '));
      await new Promise((r) => setTimeout(r, 0));
    }
    return parts.join('\n').trim();
  }

  function chunkText(text) {
    const chunks = [];
    const paras = text.split(/\n{2,}/);
    let cur = '';
    for (const p of paras) {
      if (cur.length + p.length > CHUNK_CHARS && cur.length > 0) {
        chunks.push(cur.trim());
        cur = p;
      } else {
        cur += (cur ? '\n\n' : '') + p;
      }
    }
    if (cur.trim().length > 100) chunks.push(cur.trim());
    return chunks;
  }

  async function callOpenAI(chunk, apiKey) {
    const system = `You are a dental and medical education expert creating spaced-repetition flashcards.

Generate three difficulty levels:
- easy: basic recall (definitions, anatomy facts, normal values, terminology)
- medium: mechanism/concept questions (how/why, pathophysiology, pharmacology mechanisms)
- hard: clinical application (differential diagnosis, treatment planning, complications, case reasoning)

Aim for an equal mix of all three levels. Only generate cards for content clearly present in the text. Keep answers concise but complete.

Return ONLY a valid JSON array with no markdown, no explanation, nothing else:
[{"question":"...","answer":"...","difficulty":"easy"}]`;

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: chunk },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI API error: ${res.status}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const cards = JSON.parse(match[0]);
      return (cards || []).filter(
        (c) => c && typeof c.question === 'string' && typeof c.answer === 'string' &&
               ['easy', 'medium', 'hard'].includes(c.difficulty)
      );
    } catch (_) { return []; }
  }

  async function generateFlashcardsFromPdf(file, apiKey, onProgress) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('OpenAI API key is required. Add it in Settings.');
    }
    onProgress('Loading PDF…');
    const text = await extractPdfText(file, onProgress);
    if (!text || text.length < 100) {
      throw new Error('Could not extract text. This may be a scanned/image-only PDF.');
    }
    const chunks = chunkText(text);
    if (!chunks.length) throw new Error('No readable text found in PDF.');

    onProgress(`Extracted ${Math.round(text.length / 1000)}k characters (${chunks.length} chunk${chunks.length === 1 ? '' : 's'}). Calling OpenAI…`);

    const all = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress(`Generating cards… chunk ${i + 1} / ${chunks.length}  (${all.length} cards so far)`);
      const cards = await callOpenAI(chunks[i], apiKey.trim());
      all.push(...cards);
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400));
    }
    return all;
  }

  window.PdfImporter = { generateFlashcardsFromPdf };
})();
