(function () {
  'use strict';

  const APP_ID = 'binance-wotd-helper-root';
  const STORAGE_KEY = 'binance_wotd_helper_extension_v1';
  const DEFAULT_WORD_LENGTH = 8;
  const DEFAULT_ROWS = 4;
  const PAGE_CHECK_INTERVAL_MS = 1200;
  const MAX_SUGGESTIONS = 18;
  const KEYBOARD_ZONE_TOP_RATIO = 0.62;

  const state = loadState();
  const runtime = {
    mounted: false,
    lastUrl: location.href,
    lastBoardFingerprint: '',
    analysisToken: 0,
    analysisTimer: null,
    drag: null,
    loadPromises: {
      common: null,
      full: null,
    },
    wordlists: {
      common: null,
      full: null,
    },
    elements: {},
    lastNotice: '',
  };

  normalizeState();
  boot();

  function boot() {
    ensureMounted();
    setInterval(function () {
      if (runtime.lastUrl !== location.href) {
        runtime.lastUrl = location.href;
        runtime.lastBoardFingerprint = '';
        window.setTimeout(ensureMounted, 250);
        return;
      }
      ensureMounted();
      maybeRefreshFromPageBoard();
    }, PAGE_CHECK_INTERVAL_MS);
  }

  function ensureMounted() {
    if (!isLikelyWotdPage()) {
      removeApp();
      return;
    }

    if (runtime.mounted && !document.getElementById(APP_ID)) {
      runtime.mounted = false;
      runtime.elements = {};
    }

    if (runtime.mounted) {
      return;
    }

    createApp();
    runtime.mounted = true;
    scheduleAnalysis();
  }

  function removeApp() {
    const existing = document.getElementById(APP_ID);
    if (existing) {
      existing.remove();
    }
    runtime.mounted = false;
    runtime.elements = {};
  }

  function isLikelyWotdPage() {
    if (!document.body) {
      return false;
    }

    const href = String(location.href || '').toLowerCase();
    if (href.includes('wotd') || href.includes('word-of-the-day') || href.includes('word-of-day')) {
      return true;
    }

    const title = String(document.title || '').toLowerCase();
    if (title.includes('wotd') || title.includes('word of the day')) {
      return true;
    }

    const bodyText = String(document.body.innerText || '').slice(0, 4000).toLowerCase();
    return bodyText.includes('word of the day') || bodyText.includes('wotd');
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      console.warn('[WOTD Helper] Failed to load state', error);
      return {};
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('[WOTD Helper] Failed to save state', error);
    }
  }

  function normalizeState() {
    state.wordLength = sanitizeWordLength(state.wordLength);
    state.dictionaryMode = 'full';
    state.syncFromPage = true;
    state.cluesCollapsed = state.cluesCollapsed !== false;
    state.candidatesCollapsed = state.candidatesCollapsed !== false;
    state.panelPosition = normalizePanelPosition(state.panelPosition);
    state.minimized = Boolean(state.minimized);
    state.rows = normalizeRows(state.rows, state.wordLength);
  }

  function sanitizeWordLength(value) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
      return DEFAULT_WORD_LENGTH;
    }
    return Math.max(4, Math.min(10, Math.floor(normalized)));
  }

  function normalizeDictionaryMode(value) {
    if (value === 'common' || value === 'full' || value === 'auto') {
      return value;
    }
    return 'auto';
  }

  function normalizePanelPosition(value) {
    if (!value || typeof value !== 'object') {
      return { left: null, top: 88 };
    }

    const left = Number(value.left);
    const top = Number(value.top);
    return {
      left: Number.isFinite(left) ? left : null,
      top: Number.isFinite(top) ? top : 88,
    };
  }

  function createEmptyPattern(wordLength) {
    return '.'.repeat(wordLength);
  }

  function createEmptyRow(wordLength) {
    return {
      word: '',
      pattern: createEmptyPattern(wordLength),
    };
  }

  function normalizeRows(rows, wordLength) {
    const normalized = Array.isArray(rows) ? rows.slice(0, 8).map(function (row) {
      const word = String((row && row.word) || '')
        .toLowerCase()
        .replace(/[^a-z]/g, '')
        .slice(0, wordLength);
      const patternRaw = String((row && row.pattern) || '');
      const pattern = normalizeStoredPattern(patternRaw, wordLength);
      return { word, pattern };
    }) : [];

    while (normalized.length < DEFAULT_ROWS) {
      normalized.push(createEmptyRow(wordLength));
    }

    return normalized;
  }

  function normalizeStoredPattern(pattern, wordLength) {
    const values = [];
    for (const char of pattern) {
      if (char === '.' || char === '0' || char === '1' || char === '2') {
        values.push(char);
      }
    }
    while (values.length < wordLength) {
      values.push('.');
    }
    return values.slice(0, wordLength).join('');
  }

  function createApp() {
    const existing = document.getElementById(APP_ID);
    if (existing) {
      existing.remove();
    }

    const root = document.createElement('div');
    root.id = APP_ID;
    root.innerHTML = [
      '<div class="wotd-panel">',
      '  <div class="wotd-header">',
      '    <div>',
      '      <div class="wotd-title">WOTD Helper</div>',
      '      <div class="wotd-subtitle">自动同步 · 完整词库</div>',
      '    </div>',
      '    <div class="wotd-header-actions">',
      '      <button type="button" class="wotd-icon-btn" data-action="toggle" title="收起/展开">−</button>',
      '    </div>',
      '  </div>',
      '  <div class="wotd-body"></div>',
      '</div>',
    ].join('');

    document.body.appendChild(root);

    runtime.elements.root = root;
    runtime.elements.body = root.querySelector('.wotd-body');
    runtime.elements.toggleButton = root.querySelector('[data-action="toggle"]');
    runtime.elements.header = root.querySelector('.wotd-header');

    applyPanelPosition();
    bindStaticEvents();
    setupDrag();
    renderBody();
  }

  function bindStaticEvents() {
    const root = runtime.elements.root;
    if (!root) {
      return;
    }

    root.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const action = target.getAttribute('data-action');
      if (action === 'toggle') {
        state.minimized = !state.minimized;
        saveState();
        renderBody();
        if (!state.minimized) {
          scheduleAnalysis();
        }
        return;
      }
      if (action === 'toggle-clues') {
        state.cluesCollapsed = !state.cluesCollapsed;
        saveState();
        renderRows();
        return;
      }
      if (action === 'toggle-candidates') {
        state.candidatesCollapsed = !state.candidatesCollapsed;
        saveState();
        scheduleAnalysis();
        return;
      }

      if (action === 'fill-word') {
        const word = String(target.getAttribute('data-word') || '');
        fillWordIntoPage(word);
        return;
      }
      if (action === 'copy-word') {
        const word = String(target.getAttribute('data-word') || '');
        copyWord(word);
      }
    });

    root.addEventListener('input', function () {});
    root.addEventListener('change', function () {});
  }

  function applyPanelPosition() {
    const root = runtime.elements.root;
    if (!root) {
      return;
    }

    const width = root.offsetWidth || 388;
    const margin = 20;
    const left = Number.isFinite(state.panelPosition.left)
      ? state.panelPosition.left
      : Math.max(margin, window.innerWidth - width - margin);
    const top = Number.isFinite(state.panelPosition.top) ? state.panelPosition.top : 88;

    const clamped = clampPanelPosition(left, top, width, root.offsetHeight || 100);
    state.panelPosition.left = clamped.left;
    state.panelPosition.top = clamped.top;
    root.style.left = clamped.left + 'px';
    root.style.top = clamped.top + 'px';
    root.style.right = 'auto';
  }

  function setupDrag() {
    const header = runtime.elements.header;
    const root = runtime.elements.root;
    if (!header || !root) {
      return;
    }

    header.addEventListener('pointerdown', function (event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.closest('button')) {
        return;
      }

      const rect = root.getBoundingClientRect();
      runtime.drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      header.setPointerCapture(event.pointerId);
      root.classList.add('is-dragging');
    });

    header.addEventListener('pointermove', function (event) {
      if (!runtime.drag || runtime.drag.pointerId !== event.pointerId) {
        return;
      }

      const width = root.offsetWidth || 388;
      const height = root.offsetHeight || 100;
      const nextLeft = event.clientX - runtime.drag.offsetX;
      const nextTop = event.clientY - runtime.drag.offsetY;
      const clamped = clampPanelPosition(nextLeft, nextTop, width, height);

      state.panelPosition.left = clamped.left;
      state.panelPosition.top = clamped.top;
      root.style.left = clamped.left + 'px';
      root.style.top = clamped.top + 'px';
    });

    function finishDrag(event) {
      if (!runtime.drag || runtime.drag.pointerId !== event.pointerId) {
        return;
      }
      runtime.drag = null;
      root.classList.remove('is-dragging');
      saveState();
      if (header.hasPointerCapture(event.pointerId)) {
        header.releasePointerCapture(event.pointerId);
      }
    }

    header.addEventListener('pointerup', finishDrag);
    header.addEventListener('pointercancel', finishDrag);
    window.addEventListener('resize', function () {
      applyPanelPosition();
      saveState();
    });
  }

  function clampPanelPosition(left, top, width, height) {
    const margin = 12;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop),
    };
  }

  function handleFieldChange(target) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('[data-role="word-length-input"]')) {
      const previousLength = state.wordLength;
      state.wordLength = sanitizeWordLength(target.value);
      if (previousLength !== state.wordLength) {
        state.rows = normalizeRows(state.rows, state.wordLength);
        saveState();
        renderRows();
        scheduleAnalysis();
      }
      return;
    }

    if (target.matches('[data-role="dictionary-mode"]')) {
      state.dictionaryMode = normalizeDictionaryMode(target.value);
      saveState();
      scheduleAnalysis();
      return;
    }

    if (target.matches('[data-role="sync-from-page"]')) {
      state.syncFromPage = Boolean(target.checked);
      saveState();
      if (state.syncFromPage) {
        const syncResult = syncRowsFromPage();
        runtime.lastNotice = syncResult ? syncResult.message : '未检测到页面棋盘';
      } else {
        runtime.lastBoardFingerprint = '';
      }
      renderBody();
      scheduleAnalysis();
      return;
    }

    if (target.matches('[data-role="guess-word"]')) {
      const rowIndex = Number(target.getAttribute('data-row-index'));
      if (!Number.isInteger(rowIndex) || !state.rows[rowIndex]) {
        return;
      }
      state.rows[rowIndex].word = target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, state.wordLength);
      target.value = state.rows[rowIndex].word;
      saveState();
      scheduleAnalysis();
    }
  }

  function renderBody() {
    const body = runtime.elements.body;
    if (!body) {
      return;
    }

    body.classList.toggle('is-minimized', state.minimized);
    runtime.elements.toggleButton.textContent = state.minimized ? '+' : '−';

    if (state.minimized) {
      body.innerHTML = '<div class="wotd-minimized-text">面板已收起，点右上角展开。</div>';
      return;
    }

    body.innerHTML = [
      '<div class="wotd-summary-bar">',
      '  <span class="wotd-summary-chip">' + state.wordLength + ' 字母</span>',
      '  <span class="wotd-summary-chip">完整词库</span>',
      '  <span class="wotd-summary-chip">自动同步</span>',
      '</div>',
      '<div class="wotd-help">自动从页面读取棋盘并计算下一词。</div>',
      '<div class="wotd-top-recommendation"></div>',
      '<div class="wotd-sections">',
      '  <div class="wotd-section">',
      '    <button type="button" class="wotd-section-toggle" data-action="toggle-clues">',
      '      <span>已同步线索</span>',
      '      <span class="wotd-section-meta" data-role="clue-summary"></span>',
      '      <span class="wotd-section-arrow">' + (state.cluesCollapsed ? '+' : '−') + '</span>',
      '    </button>',
      '  </div>',
      '<div class="wotd-rows"></div>',
      '</div>',
      '<div class="wotd-note">候选词列表默认折叠，面板支持直接拖动。</div>',
      '<div class="wotd-analysis"></div>',
    ].join('');

    renderRows();
    renderAnalysis({ status: 'idle', message: '正在自动同步页面数据...' });
  }

  function renderRows() {
    const container = runtime.elements.body && runtime.elements.body.querySelector('.wotd-rows');
    const summary = runtime.elements.body && runtime.elements.body.querySelector('[data-role="clue-summary"]');
    if (!container) {
      return;
    }

    const filledRows = state.rows.filter(function (row) {
      return row.word || row.pattern.replace(/\./g, '');
    }).length;

    if (summary) {
      summary.textContent = filledRows + ' 行';
    }

    if (state.cluesCollapsed) {
      container.innerHTML = '';
      container.classList.add('is-collapsed');
      return;
    }

    const visibleRows = state.rows
      .map(function (row, index) {
        return { row: row, index: index };
      })
      .filter(function (item) {
        return item.row.word || item.row.pattern.replace(/\./g, '');
      });

    container.classList.remove('is-collapsed');
    const rowsToRender = visibleRows.length ? visibleRows : [{ row: state.rows[0], index: 0 }];
    container.innerHTML = rowsToRender.map(function (item) {
      const row = item.row;
      const rowIndex = item.index;
      return [
        '<div class="wotd-row">',
        '  <div class="wotd-row-top">',
        '    <span class="wotd-row-index">#' + (rowIndex + 1) + '</span>',
        '    <div class="wotd-row-word">' + escapeHtml(row.word || '·'.repeat(state.wordLength)) + '</div>',
        '  </div>',
        '  <div class="wotd-pattern-grid is-readonly">',
        renderPatternCells(row.pattern, rowIndex),
        '  </div>',
        '</div>',
      ].join('');
    }).join('');
  }

  function renderPatternCells(pattern, rowIndex) {
    return Array.from(pattern).map(function (value, cellIndex) {
      const meta = getPatternMeta(value);
      const actionAttr = state.cluesCollapsed ? '' : ' data-row-index="' + rowIndex + '" data-cell-index="' + cellIndex + '"';
      return [
        '<div',
        ' class="wotd-pattern-cell is-' + meta.className + '"',
        actionAttr,
        ' title="' + meta.title + '">',
        meta.label,
        '</div>',
      ].join('');
    }).join('');
  }

  function handleFieldChange() {
  }

  function renderDictionaryOptions() {
    return '';
  }

  function getPatternMeta(value) {
    if (value === '0') {
      return { label: '灰', className: 'absent', title: '不存在，再点切换到黄色' };
    }
    if (value === '1') {
      return { label: '黄', className: 'present', title: '存在但位置不对，再点切换到绿色' };
    }
    if (value === '2') {
      return { label: '绿', className: 'correct', title: '位置正确，再点清空' };
    }
    return { label: '?', className: 'unknown', title: '未设置，点击切换到灰色' };
  }

  function cyclePatternCell(rowIndex, cellIndex) {
    if (!state.rows[rowIndex]) {
      return;
    }

    const values = Array.from(state.rows[rowIndex].pattern);
    const current = values[cellIndex];
    const next = current === '.' ? '0' : current === '0' ? '1' : current === '1' ? '2' : '.';
    values[cellIndex] = next;
    state.rows[rowIndex].pattern = values.join('');
    saveState();
    renderRows();
    scheduleAnalysis();
  }

  function scheduleAnalysis() {
    const token = ++runtime.analysisToken;
    if (runtime.analysisTimer) {
      window.clearTimeout(runtime.analysisTimer);
    }
    renderAnalysis({ status: 'loading', message: '正在计算候选词...' });
    runtime.analysisTimer = window.setTimeout(function () {
      runtime.analysisTimer = null;
      analyzeState(token);
    }, 120);
  }

  async function analyzeState(token) {
    try {
      let syncMessage = '';
      const syncResult = syncRowsFromPage();
      if (syncResult && syncResult.changed) {
        renderBody();
      }
      if (syncResult && syncResult.fingerprint) {
        runtime.lastBoardFingerprint = syncResult.fingerprint;
      }
      syncMessage = syncResult && syncResult.message ? syncResult.message : '';

      const completeRows = getCompleteRows();
      const fullWords = await loadWordList('full');
      if (token !== runtime.analysisToken) {
        return;
      }

      const result = runAnalysis(fullWords, completeRows);
      const sourceLabel = '完整词库';
      const recommendedWord = result.candidates[0] || '';
      const recommendedSource = result.candidates[0] ? '完整词库' : '';

      renderAnalysis({
        status: 'ready',
        sourceLabel: sourceLabel,
        completeRows: completeRows.length,
        result: result,
        recommendedWord: recommendedWord,
        recommendedSource: recommendedSource,
        message: joinNotice(syncMessage, runtime.lastNotice),
      });
      runtime.lastNotice = '';
    } catch (error) {
      renderAnalysis({
        status: 'error',
        message: error && error.message ? error.message : '分析失败',
      });
    }
  }

  function maybeRefreshFromPageBoard() {
    if (!runtime.mounted || !state.syncFromPage) {
      return;
    }

    const boardState = readBoardStateFromPage();
    const fingerprint = boardState ? getBoardFingerprint(boardState) : '';
    if (!fingerprint || fingerprint === runtime.lastBoardFingerprint) {
      return;
    }

    runtime.lastBoardFingerprint = fingerprint;
    scheduleAnalysis();
  }

  function syncRowsFromPage() {
    const boardState = readBoardStateFromPage();
    if (!boardState) {
      return null;
    }

    const nextRows = boardState.rows.length ? boardState.rows.slice(0, 8) : [];
    while (nextRows.length < Math.min(boardState.rowCount, 8)) {
      nextRows.push(createEmptyRow(boardState.wordLength));
    }

    const normalizedRows = normalizeRows(nextRows, boardState.wordLength);
    const nextFingerprint = getBoardFingerprint({
      wordLength: boardState.wordLength,
      rows: normalizedRows,
    });
    const previousFingerprint = getBoardFingerprint({
      wordLength: state.wordLength,
      rows: state.rows,
    });
    const changed = nextFingerprint !== previousFingerprint;

    state.wordLength = boardState.wordLength;
    state.rows = normalizedRows;
    saveState();

    return {
      changed: changed,
      fingerprint: nextFingerprint,
      message: boardState.filledRowCount > 0 || changed ? '已从页面同步 ' + boardState.filledRowCount + ' 行线索' : '',
    };
  }

  function getCompleteRows() {
    return state.rows
      .map(function (row) {
        return {
          word: row.word,
          pattern: row.pattern,
        };
      })
      .filter(function (row) {
        return row.word.length === state.wordLength && row.pattern.length === state.wordLength && !row.pattern.includes('.');
      });
  }

  function readBoardStateFromPage() {
    const board = findBestBoard();
    if (!board) {
      return null;
    }

    const rows = board.rows.map(function (rowElement) {
      return readBoardRow(rowElement, board.wordLength);
    });

    return {
      wordLength: board.wordLength,
      rowCount: board.rows.length,
      filledRowCount: rows.filter(function (row) {
        return row.word || row.pattern.replace(/\./g, '');
      }).length,
      rows: rows,
    };
  }

  function findBestBoard() {
    const selectors = [
      'div[dir="ltr"].bn-flex.relative.flex-col',
      'div[dir="ltr"]',
      'div.bn-flex.relative.flex-col',
    ];
    const seen = new Set();
    const candidates = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement) || seen.has(element)) {
          continue;
        }
        seen.add(element);
        if (!isVisible(element)) {
          continue;
        }
        const rows = getBoardRowsFromContainer(element);
        if (!rows.length) {
          continue;
        }
        candidates.push({
          root: element,
          rows: rows,
          wordLength: getBoardCells(rows[0]).length,
          score: rows.length * 100 + getBoardCells(rows[0]).length,
        });
      }
    }

    if (!candidates.length) {
      return null;
    }

    candidates.sort(function (left, right) {
      return right.score - left.score;
    });
    return candidates[0];
  }

  function getBoardRowsFromContainer(container) {
    const rows = [];
    const counts = Object.create(null);

    for (const child of container.children) {
      if (!(child instanceof HTMLElement)) {
        continue;
      }
      const cells = getBoardCells(child);
      if (cells.length < 4 || cells.length > 10) {
        continue;
      }
      rows.push(child);
      counts[cells.length] = (counts[cells.length] || 0) + 1;
    }

    const preferredLength = Object.keys(counts)
      .map(function (value) {
        return Number(value);
      })
      .sort(function (left, right) {
        const diff = counts[right] - counts[left];
        return diff || right - left;
      })[0];

    if (!preferredLength || (counts[preferredLength] || 0) < 4) {
      return [];
    }

    return rows.filter(function (rowElement) {
      return getBoardCells(rowElement).length === preferredLength;
    });
  }

  function getBoardCells(rowElement) {
    return Array.from(rowElement.children).filter(function (child) {
      return isBoardTileElement(child);
    });
  }

  function isBoardTileElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const className = String(element.className || '');
    return className.includes('aspect-square')
      && className.includes('rounded-[6px]')
      && className.includes('border')
      && className.includes('touch-manipulation');
  }

  function readBoardRow(rowElement, wordLength) {
    const cells = getBoardCells(rowElement).slice(0, wordLength);
    let word = '';
    let pattern = '';

    for (const cell of cells) {
      const letter = readTileLetter(cell);
      const result = inferTileResult(cell, letter);
      word += letter;
      pattern += result;
    }

    return {
      word: word,
      pattern: pattern || createEmptyPattern(wordLength),
    };
  }

  function readTileLetter(cell) {
    return String(cell.innerText || '')
      .replace(/\s+/g, '')
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .slice(0, 1);
  }

  function inferTileResult(cell, letter) {
    if (!letter) {
      return '.';
    }

    const style = window.getComputedStyle(cell);
    const classText = (String(cell.className || '') + ' ' + String(cell.getAttribute('style') || '')).toLowerCase();
    const background = parseCssColor(style.backgroundColor);
    const border = parseCssColor(style.borderColor);
    const boxShadow = String(style.boxShadow || '').toLowerCase();
    const hasFilledBackground = background.a > 0.05;

    if (looksGreen(background, border, classText, boxShadow) && hasFilledBackground) {
      return '2';
    }
    if (looksYellow(background, border, classText, boxShadow) && hasFilledBackground) {
      return '1';
    }
    if (looksGray(background, border, classText, boxShadow) && hasFilledBackground) {
      return '0';
    }

    return '.';
  }

  function parseCssColor(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw === 'transparent') {
      return { r: 0, g: 0, b: 0, a: 0 };
    }

    const match = raw.match(/rgba?\(([^)]+)\)/);
    if (!match) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }

    const parts = match[1].split(',').map(function (item) {
      return Number(item.trim());
    });
    return {
      r: parts[0] || 0,
      g: parts[1] || 0,
      b: parts[2] || 0,
      a: typeof parts[3] === 'number' && Number.isFinite(parts[3]) ? parts[3] : 1,
    };
  }

  function looksGreen(background, border, classText, boxShadow) {
    if (classText.includes('green') || classText.includes('success') || classText.includes('correct')) {
      return true;
    }
    if (boxShadow.includes('green')) {
      return true;
    }
    return isGreenColor(background) || isGreenColor(border);
  }

  function looksYellow(background, border, classText, boxShadow) {
    if (classText.includes('yellow') || classText.includes('gold') || classText.includes('present')) {
      return true;
    }
    if (boxShadow.includes('yellow') || boxShadow.includes('255, 250, 93') || boxShadow.includes('240, 185, 11')) {
      return true;
    }
    return isYellowColor(background) || isYellowColor(border);
  }

  function looksGray(background, border, classText, boxShadow) {
    if (classText.includes('gray') || classText.includes('grey') || classText.includes('absent') || classText.includes('wrong')) {
      return true;
    }
    if (boxShadow.includes('rgba(0,0,0') || boxShadow.includes('rgba(0, 0, 0')) {
      return true;
    }
    return isGrayColor(background) || isGrayColor(border);
  }

  function isGreenColor(color) {
    return color.a > 0.05 && color.g >= 90 && color.g >= color.r + 18 && color.g >= color.b + 8;
  }

  function isYellowColor(color) {
    return color.a > 0.05 && color.r >= 140 && color.g >= 120 && color.b <= 140 && Math.abs(color.r - color.g) <= 90;
  }

  function isGrayColor(color) {
    return color.a > 0.05
      && Math.abs(color.r - color.g) <= 18
      && Math.abs(color.g - color.b) <= 18
      && (color.r + color.g + color.b) / 3 <= 170;
  }

  function getBoardFingerprint(boardState) {
    return JSON.stringify({
      wordLength: boardState.wordLength,
      rows: boardState.rows,
    });
  }

  function joinNotice() {
    return Array.from(arguments)
      .map(function (value) {
        return String(value || '').trim();
      })
      .filter(Boolean)
      .join(' | ');
  }

  function runAnalysis(words, completeRows) {
    return window.BinanceWotdSolver.analyze(completeRows, words, state.wordLength);
  }

  async function loadWordList(kind) {
    if (runtime.wordlists[kind]) {
      return runtime.wordlists[kind];
    }
    if (runtime.loadPromises[kind]) {
      return runtime.loadPromises[kind];
    }

    const fileName = kind === 'full' ? 'wordlists/full_words.txt' : 'wordlists/common_words.txt';
    const url = chrome.runtime.getURL(fileName);
    runtime.loadPromises[kind] = fetch(url)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Failed to load ' + kind + ' word list');
        }
        return response.text();
      })
      .then(function (text) {
        const words = text.split(/\r?\n/).map(function (word) {
          return word.trim().toLowerCase();
        }).filter(Boolean);
        runtime.wordlists[kind] = words;
        return words;
      })
      .finally(function () {
        runtime.loadPromises[kind] = null;
      });

    return runtime.loadPromises[kind];
  }

  function renderAnalysis(payload) {
    const container = runtime.elements.body && runtime.elements.body.querySelector('.wotd-analysis');
    const topRecommendation = runtime.elements.body && runtime.elements.body.querySelector('.wotd-top-recommendation');
    if (!container) {
      return;
    }

    if (payload.status === 'loading') {
      if (topRecommendation) {
        topRecommendation.innerHTML = '';
      }
      container.innerHTML = '<div class="wotd-status is-loading">' + escapeHtml(payload.message || '处理中...') + '</div>';
      return;
    }

    if (payload.status === 'error') {
      if (topRecommendation) {
        topRecommendation.innerHTML = '';
      }
      container.innerHTML = '<div class="wotd-status is-error">' + escapeHtml(payload.message || '分析失败') + '</div>';
      return;
    }

    if (payload.status !== 'ready') {
      if (topRecommendation) {
        topRecommendation.innerHTML = '';
      }
      container.innerHTML = '<div class="wotd-status">' + escapeHtml(payload.message || '') + '</div>';
      return;
    }

    const analysis = payload.result;
    const summary = analysis.summary;
    const suggestions = analysis.candidates.slice(0, MAX_SUGGESTIONS);
    const notice = payload.message ? '<div class="wotd-status is-success">' + escapeHtml(payload.message) + '</div>' : '';
    const recommendation = payload.recommendedWord ? renderRecommendation(payload.recommendedWord, payload.recommendedSource) : '';

    if (topRecommendation) {
      topRecommendation.innerHTML = recommendation;
    }

    container.innerHTML = [
      notice,
      '<div class="wotd-summary-bar">',
      summaryChip(payload.completeRows + ' 行线索'),
      summaryChip(analysis.total + ' 个候选'),
      summaryChip(payload.sourceLabel),
      '</div>',
      '<div class="wotd-constraint-list">',
      constraintLine('固定位置', summary.fixed),
      constraintLine('至少包含', summary.minCounts.length ? summary.minCounts.join(', ') : '暂无'),
      constraintLine('最多包含', summary.maxCounts.length ? summary.maxCounts.join(', ') : '暂无'),
      constraintLine('位置禁用', summary.banned.length ? summary.banned.join(' | ') : '暂无'),
      '</div>',
      '<div class="wotd-section">',
      '  <button type="button" class="wotd-section-toggle" data-action="toggle-candidates">',
      '    <span>候选词</span>',
      '    <span class="wotd-section-meta">' + escapeHtml(String(analysis.total)) + '</span>',
      '    <span class="wotd-section-arrow">' + (state.candidatesCollapsed ? '+' : '−') + '</span>',
      '  </button>',
      state.candidatesCollapsed
        ? ''
        : '<div class="wotd-suggestions">' + (suggestions.length ? suggestions.map(renderSuggestion).join('') : '<div class="wotd-empty">没有匹配结果。</div>') + '</div>',
      '</div>',
    ].join('');
  }

  function summaryChip(value) {
    return '<span class="wotd-summary-chip">' + escapeHtml(value) + '</span>';
  }

  function constraintLine(label, value) {
    return [
      '<div class="wotd-constraint-line">',
      '  <span class="wotd-constraint-label">' + label + '</span>',
      '  <span class="wotd-constraint-value">' + escapeHtml(value) + '</span>',
      '</div>',
    ].join('');
  }

  function renderSuggestion(word) {
    return [
      '<div class="wotd-suggestion">',
      '  <div class="wotd-suggestion-word">' + escapeHtml(word) + '</div>',
      '  <div class="wotd-suggestion-actions">',
      '    <button type="button" class="wotd-secondary-btn" data-action="fill-word" data-word="' + escapeHtml(word) + '">填入</button>',
      '    <button type="button" class="wotd-ghost-btn" data-action="copy-word" data-word="' + escapeHtml(word) + '">复制</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderRecommendation(word, source) {
    return [
      '<div class="wotd-recommendation">',
      '  <div class="wotd-recommendation-head">',
      '    <div>',
      '      <div class="wotd-recommendation-label">推荐下一词</div>',
      '      <div class="wotd-recommendation-source">' + escapeHtml(source || '当前词库') + '</div>',
      '    </div>',
      '    <div class="wotd-recommendation-word">' + escapeHtml(word) + '</div>',
      '  </div>',
      '  <div class="wotd-recommendation-actions">',
      '    <button type="button" class="wotd-primary-btn" data-action="fill-word" data-word="' + escapeHtml(word) + '">填入推荐词</button>',
      '    <button type="button" class="wotd-ghost-btn" data-action="copy-word" data-word="' + escapeHtml(word) + '">复制</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function findEditableTarget() {
    const activeElement = document.activeElement;
    if (isEditableTarget(activeElement)) {
      return activeElement;
    }

    const selector = [
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="color"]):not([type="range"]):not([disabled])',
      'textarea',
      '[contenteditable="true"]',
    ].join(', ');

    const candidates = Array.from(document.querySelectorAll(selector))
      .filter(function (element) {
        return isEditableTarget(element) && (!runtime.elements.root || !runtime.elements.root.contains(element));
      });

    const preferred = candidates.find(function (element) {
      const maxLength = Number(element.getAttribute && element.getAttribute('maxlength'));
      return Number.isFinite(maxLength) && maxLength === state.wordLength;
    });

    return preferred || candidates[0] || null;
  }

  function isEditableTarget(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (!element.isConnected) {
      return false;
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled || element.readOnly) {
        return false;
      }
      return isVisible(element);
    }
    if (element.isContentEditable) {
      return isVisible(element);
    }
    return false;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function fillWordIntoPage(word) {
    if (typeWordViaBoard(word)) {
      runtime.lastNotice = '已输入到棋盘：' + word;
      scheduleAnalysis();
      return;
    }

    const target = findEditableTarget();
    if (!target) {
      runtime.lastNotice = '没有找到可填入的输入框';
      scheduleAnalysis();
      return;
    }

    try {
      if (target instanceof HTMLInputElement) {
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        descriptor.set.call(target, word);
      } else if (target instanceof HTMLTextAreaElement) {
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        descriptor.set.call(target, word);
      } else if (target.isContentEditable) {
        target.textContent = word;
      }

      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
      runtime.lastNotice = '已填入：' + word;
      scheduleAnalysis();
    } catch (error) {
      runtime.lastNotice = '填入失败：' + (error && error.message ? error.message : '未知错误');
      scheduleAnalysis();
    }
  }

  function typeWordViaBoard(word) {
    if (!readBoardStateFromPage()) {
      return false;
    }

    clickLikelyBoardCell();

    for (let index = 0; index < state.wordLength + 1; index += 1) {
      pressBoardKey('Backspace');
    }
    for (const letter of word.toUpperCase()) {
      if (!pressBoardKey(letter)) {
        return false;
      }
    }
    return true;
  }

  function clickLikelyBoardCell() {
    const board = findBestBoard();
    if (!board) {
      return false;
    }

    for (const row of board.rows) {
      const cells = getBoardCells(row);
      for (const cell of cells) {
        if (!readTileLetter(cell)) {
          cell.click();
          return true;
        }
      }
    }

    const fallbackCell = getBoardCells(board.rows[board.rows.length - 1])[0];
    if (fallbackCell) {
      fallbackCell.click();
      return true;
    }
    return false;
  }

  function pressBoardKey(key) {
    return clickVirtualKeyboardKey(key) || dispatchSyntheticBoardKey(key);
  }

  function clickVirtualKeyboardKey(key) {
    const labels = getBoardKeyLabels(key);
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div'))
      .filter(function (element) {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        if (runtime.elements.root && runtime.elements.root.contains(element)) {
          return false;
        }
        if (!isVisible(element)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.top < window.innerHeight * KEYBOARD_ZONE_TOP_RATIO) {
          return false;
        }

        const label = normalizeBoardKeyLabel(element.innerText);
        if (!label || labels.indexOf(label) === -1) {
          return false;
        }

        return rect.width >= 28 && rect.height >= 28;
      })
      .sort(function (left, right) {
        const leftArea = left.getBoundingClientRect().width * left.getBoundingClientRect().height;
        const rightArea = right.getBoundingClientRect().width * right.getBoundingClientRect().height;
        return rightArea - leftArea;
      });

    if (!candidates.length) {
      return false;
    }

    candidates[0].click();
    return true;
  }

  function dispatchSyntheticBoardKey(key) {
    const activeTarget = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    if (activeTarget && activeTarget.focus) {
      activeTarget.focus();
    }

    const normalized = normalizeSyntheticKey(key);
    const keyCode = getKeyCode(normalized);
    const eventInit = {
      key: normalized,
      code: getKeyCodeName(normalized),
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    };

    const targets = [document, window];
    if (activeTarget) {
      targets.unshift(activeTarget);
    }

    for (const eventName of ['keydown', 'keypress', 'keyup']) {
      for (const target of targets) {
        target.dispatchEvent(new KeyboardEvent(eventName, eventInit));
      }
    }

    return true;
  }

  function getBoardKeyLabels(key) {
    if (key === 'Backspace') {
      return ['BACKSPACE', 'DELETE', '⌫', '←', 'X'];
    }
    if (key === 'Enter') {
      return ['ENTER'];
    }
    return [String(key || '').toUpperCase()];
  }

  function normalizeBoardKeyLabel(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function normalizeSyntheticKey(key) {
    if (key === 'Backspace' || key === 'Enter') {
      return key;
    }
    return String(key || '').toLowerCase();
  }

  function getKeyCodeName(key) {
    if (key === 'Backspace') {
      return 'Backspace';
    }
    if (key === 'Enter') {
      return 'Enter';
    }
    return 'Key' + String(key).toUpperCase();
  }

  function getKeyCode(key) {
    if (key === 'Backspace') {
      return 8;
    }
    if (key === 'Enter') {
      return 13;
    }
    const charCode = String(key || '').toUpperCase().charCodeAt(0);
    return Number.isFinite(charCode) ? charCode : 0;
  }

  async function copyWord(word) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(word);
      } else {
        fallbackCopy(word);
      }
      runtime.lastNotice = '已复制：' + word;
      scheduleAnalysis();
    } catch (error) {
      try {
        fallbackCopy(word);
        runtime.lastNotice = '已复制：' + word;
      } catch (fallbackError) {
        runtime.lastNotice = '复制失败';
      }
      scheduleAnalysis();
    }
  }

  function fallbackCopy(word) {
    const textarea = document.createElement('textarea');
    textarea.value = word;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
})();
