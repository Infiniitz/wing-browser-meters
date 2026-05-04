(function() {
  (function initSettingsTabs() {
    const tablist = document.querySelector('.settings-tabs');
    if (!tablist) return;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));

    function selectTab(index) {
      tabs.forEach((tab, i) => {
        const on = i === index;
        tab.classList.toggle('settings-tab--active', on);
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        const panel = panels[i];
        if (panel) {
          panel.classList.toggle('settings-tab-panel--active', on);
          if (on) panel.removeAttribute('hidden');
          else panel.setAttribute('hidden', '');
        }
      });
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => selectTab(i));
    });

    tablist.addEventListener('keydown', e => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const current = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
      let next = current;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      selectTab(next);
      tabs[next].focus();
    });
  })();

  const SCRIBBLE_COLORS = [
    '#3E63CC', '#0180FF', '#5A33FF', '#00CED1',
    '#01B23E', '#96CC00', '#F2DD00', '#C06A1F',
    '#E02040', '#FF7A7A', '#FF33F6', '#A533FF',
    '#FFB81A', '#25C3FF', '#FF5A30', '#33E6A5',
    '#707070', '#E0E0E0'
  ];

  const KIND_PREFIX = { main: 'M', bus: 'B', aux: 'A', matrix: 'MX', dca: 'D' };
  const KIND_LABELS = { channel: 'Channel', aux: 'Aux', bus: 'Bus', main: 'Main', matrix: 'Matrix', dca: 'DCA' };

  const NOTE_SELECTION =
    'Choose which channels and busses to show as meters. Changes take effect after saving; the app will reconnect to the mixer.';
  const NOTE_TAP =
    'Green = PRE fader, red = POST fader meter tap. Tap each box to switch. Save to apply the tap selection and reconnect to the mixer.';

  const container = document.getElementById('meterConfig');
  const revertBtn = document.getElementById('meterConfigRevert');
  const saveBtn = document.getElementById('meterConfigSave');
  const messageEl = document.getElementById('meterConfigMessage');
  const noteEl = document.getElementById('meterSelectionNote');
  const tapModeBtn = document.getElementById('meterTapModeToggle');
  const toolbarSelection = document.getElementById('toolbarSelection');
  const toolbarTap = document.getElementById('toolbarTap');

  let clientPollMs = parseInt(container.dataset.refreshInterval, 10) || 10000;
  /** @type {ReturnType<typeof setInterval>|null} */
  let channelPollTimerId = null;
  const colorMap = {};
  const nameMap = {};
  /** @type {'selection'|'tap'} */
  let uiMode = 'selection';
  /** @type {Record<string, 'pre'|'post'>} */
  const tapByKey = {};
  /** @type {import('socket.io-client').Socket|null} */
  let settingsIo = null;
  /** @type {string|null} null until /api/meters-config loads successfully */
  let savedMeterConfigSignature = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let meterConfigMessageClearTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let meterConfigSavedMessageDelayTimer = null;
  let meterConfigMessageOpId = 0;

  function boxKey(box) {
    return box.dataset.kind + ':' + box.dataset.index;
  }

  function srgbChannelToLinear(c) {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function relativeLuminanceFromRgb(r, g, b) {
    const R = srgbChannelToLinear(r);
    const G = srgbChannelToLinear(g);
    const B = srgbChannelToLinear(b);
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }

  function relativeLuminanceHex(hex) {
    if (typeof hex !== 'string') return NaN;
    const h = hex.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return NaN;
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    return relativeLuminanceFromRgb(r, g, b);
  }

  function contrastRatio(L1, L2) {
    const lighter = Math.max(L1, L2);
    const darker = Math.min(L1, L2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  const TEXT_CANDIDATES = [
    ['#000000', 0],
    ['#E0E0E0', relativeLuminanceFromRgb(224, 224, 224)],
    ['#FFFFFF', 1],
  ];

  function autoTextOnBackground(hex) {
    const Lbg = relativeLuminanceHex(hex);
    if (!Number.isFinite(Lbg)) return '#E0E0E0';
    let bestHex = '#000000';
    let bestRatio = 0;
    for (let i = 0; i < TEXT_CANDIDATES.length; i++) {
      const pair = TEXT_CANDIDATES[i];
      const cand = pair[0];
      const Lt = pair[1];
      const r = contrastRatio(Lbg, Lt);
      if (r > bestRatio) {
        bestRatio = r;
        bestHex = cand;
      }
    }
    return bestHex;
  }

  const METER_COLOR_KINDS = ['channel', 'aux', 'bus', 'main', 'matrix', 'dca'];
  const LABEL_COLOR_DEFAULT = '#455a64';
  const TEXT_COLOR_DEFAULT = '#000000';

  function wingScribbleHexForKind(kind) {
    const grid = container && container.querySelector('.meter-config-grid[data-kind="' + kind + '"]');
    const count = grid ? parseInt(grid.dataset.count, 10) : 0;
    for (let i = 0; i < count; i++) {
      const id = colorMap[kind + ':' + i];
      if (id >= 1 && id <= 18) return SCRIBBLE_COLORS[id - 1];
    }
    return LABEL_COLOR_DEFAULT;
  }

  function syncMeterColorInputClearIndicator(input) {
    if (!input) return;
    const wrap = input.closest('.settings-color-input-wrap');
    if (!wrap) return;
    wrap.classList.toggle('settings-color-input-wrap--cleared', input.dataset.override !== 'true');
  }

  function syncMeterColorPickerPreviewFromWing() {
    const textGrid = document.getElementById('textColorGrid');
    const labelGrid = document.getElementById('labelColorGrid');
    METER_COLOR_KINDS.forEach(kind => {
      const wingBg = wingScribbleHexForKind(kind);
      if (labelGrid) {
        const inp = labelGrid.querySelector('.settings-label-color-input[data-kind="' + kind + '"]');
        if (inp && inp.dataset.override !== 'true') {
          inp.value = wingBg;
        }
        syncMeterColorInputClearIndicator(inp);
      }
      if (textGrid) {
        const inp = textGrid.querySelector('.settings-text-color-input[data-kind="' + kind + '"]');
        if (inp && inp.dataset.override !== 'true') {
          inp.value = autoTextOnBackground(wingBg);
        }
        syncMeterColorInputClearIndicator(inp);
      }
    });
  }

  function applyNameToBox(box) {
    if (uiMode === 'tap') return;
    const key = boxKey(box);
    const name = nameMap[key];
    const num = parseInt(box.dataset.index, 10) + 1;
    const prefix = KIND_LABELS[box.dataset.kind] || box.dataset.kind;
    box.title = name ? `${prefix} ${num}: ${name}` : `${prefix} ${num}`;
  }

  function applyColorToBox(box) {
    if (uiMode === 'tap') return;
    const key = boxKey(box);
    const colorId = colorMap[key];
    if (colorId !== undefined && colorId >= 1 && colorId <= 18) {
      box.dataset.colorHex = SCRIBBLE_COLORS[colorId - 1];
    }
    updateBoxStyle(box);
  }

  function updateBoxStyle(box) {
    const hex = box.dataset.colorHex;
    if (!hex) return;
    if (box.classList.contains('toggle-box--active')) {
      box.style.backgroundColor = hex;
      box.style.borderColor = hex;
      box.style.color = autoTextOnBackground(hex);
      box.style.opacity = '';
    } else {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      box.style.backgroundColor = '';
      box.style.borderColor = `rgba(${r},${g},${b},0.75)`;
      box.style.color = '';
      box.style.opacity = '';
    }
  }

  function syncBoxDisplay(box) {
    if (uiMode === 'tap') {
      box.classList.remove('toggle-box--tap-pre', 'toggle-box--tap-post');
      const tap = tapByKey[boxKey(box)] || 'pre';
      box.classList.add(tap === 'pre' ? 'toggle-box--tap-pre' : 'toggle-box--tap-post');
      const idLabel = box.dataset.baseLabel || '';
      const tapWord = tap === 'pre' ? 'PRE' : 'POST';
      box.innerHTML =
        '<span class="toggle-box__tap-id"></span><span class="toggle-box__tap-word"></span>';
      box.querySelector('.toggle-box__tap-id').textContent = idLabel;
      box.querySelector('.toggle-box__tap-word').textContent = tapWord;
      box.style.backgroundColor = '';
      box.style.borderColor = '';
      box.style.color = '';
      box.style.opacity = '';
      const key = boxKey(box);
      const name = nameMap[key];
      const num = parseInt(box.dataset.index, 10) + 1;
      const prefix = KIND_LABELS[box.dataset.kind] || box.dataset.kind;
      const label = name ? `${prefix} ${num}: ${name}` : `${prefix} ${num}`;
      box.title = `${label} — ${tap === 'pre' ? 'Pre-fader meter' : 'Post-fader meter'} (tap to toggle)`;
    } else {
      box.classList.remove('toggle-box--tap-pre', 'toggle-box--tap-post');
      box.textContent = box.dataset.baseLabel || '';
      applyNameToBox(box);
      applyColorToBox(box);
    }
  }

  function syncAllBoxes() {
    container.querySelectorAll('.toggle-box').forEach(syncBoxDisplay);
  }

  function setUiMode(mode) {
    uiMode = mode;
    const isTap = mode === 'tap';
    tapModeBtn.textContent = isTap
      ? 'Choose which meters to show'
      : 'Set PRE/POST tap per meter';
    tapModeBtn.title = isTap
      ? 'Return to selecting which channels and busses appear on the meter page (on/off for each box).'
      : 'Switch to editing pre-fader vs post-fader meter tap for each box (green = PRE, red = POST).';
    toolbarSelection.hidden = isTap;
    toolbarTap.hidden = !isTap;
    noteEl.textContent = isTap ? NOTE_TAP : NOTE_SELECTION;
    container.classList.toggle('meter-config--tap-mode', isTap);

    syncAllBoxes();
  }

  function renderToggleBoxes() {
    container.querySelectorAll('.meter-config-grid').forEach(grid => {
      const kind = grid.dataset.kind;
      const count = parseInt(grid.dataset.count, 10);
      grid.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const box = document.createElement('div');
        box.className = 'toggle-box';
        box.dataset.kind = kind;
        box.dataset.index = String(i);
        const baseLabel = (KIND_PREFIX[kind] || '') + (i + 1);
        box.dataset.baseLabel = baseLabel;
        box.textContent = baseLabel;
        box.addEventListener('click', () => {
          if (uiMode === 'tap') {
            const key = boxKey(box);
            tapByKey[key] = (tapByKey[key] || 'pre') === 'pre' ? 'post' : 'pre';
            syncBoxDisplay(box);
          } else {
            box.classList.toggle('toggle-box--active');
            updateBoxStyle(box);
          }
          syncMeterSaveDirtyState();
        });
        grid.appendChild(box);
      }
    });
  }

  function setActiveFromConfig(config) {
    const set = new Set(config.map(e => e.kind + ':' + e.index));
    container.querySelectorAll('.toggle-box').forEach(box => {
      box.classList.toggle('toggle-box--active',
        set.has(boxKey(box)));
      applyColorToBox(box);
    });
    if (uiMode === 'tap') syncAllBoxes();
  }

  function revertMeterConfigToLastSaved() {
    if (savedMeterConfigSignature === null) return;
    let baseline;
    try {
      baseline = JSON.parse(savedMeterConfigSignature);
    } catch {
      return;
    }
    if (!Array.isArray(baseline)) return;
    Object.keys(tapByKey).forEach(k => {
      delete tapByKey[k];
    });
    baseline.forEach(entry => {
      const key = entry.kind + ':' + entry.index;
      tapByKey[key] = entry.postFader === true ? 'post' : 'pre';
    });
    setActiveFromConfig(baseline);
    syncMeterSaveDirtyState();
    showMessage('', false);
  }

  function applyAllColors(colors) {
    Object.assign(colorMap, colors);
    if (uiMode !== 'tap') {
      container.querySelectorAll('.toggle-box').forEach(applyColorToBox);
    }
    syncMeterColorPickerPreviewFromWing();
  }

  function applyAllNames(names) {
    Object.assign(nameMap, names);
    container.querySelectorAll('.toggle-box').forEach(box => {
      if (uiMode === 'tap') syncBoxDisplay(box);
      else applyNameToBox(box);
    });
  }

  function getConfigFromToggleBoxes() {
    const config = [];
    container.querySelectorAll('.toggle-box--active').forEach(box => {
      const key = boxKey(box);
      const entry = { kind: box.dataset.kind, index: parseInt(box.dataset.index, 10) };
      const tap = tapByKey[key] || 'pre';
      if (tap === 'post') entry.postFader = true;
      config.push(entry);
    });
    return config;
  }

  function normalizeMeterConfigEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
      .map(e => ({
        kind: e.kind,
        index: Number(e.index),
        ...(e.postFader === true ? { postFader: true } : {}),
      }))
      .sort((a, b) => `${a.kind}:${a.index}`.localeCompare(`${b.kind}:${b.index}`));
  }

  function meterConfigSignature(entries) {
    return JSON.stringify(normalizeMeterConfigEntries(entries));
  }

  function syncVerticalRowOverflowNote() {
    const noteEl = document.getElementById('verticalRowOverflowNote');
    const modeEl = document.getElementById('verticalRowMode');
    const rcEl = document.getElementById('verticalRowCount');
    const mrEl = document.getElementById('verticalMetersPerRow');
    if (!noteEl || !modeEl || !rcEl || !mrEl) return;
    const R = Math.min(92, Math.max(1, parseInt(rcEl.value, 10) || 1));
    const M = Math.min(92, Math.max(1, parseInt(mrEl.value, 10) || 1));
    const cap = R * M;
    const n = getConfigFromToggleBoxes().length;
    if (modeEl.checked && n > cap) {
      noteEl.hidden = false;
      noteEl.textContent = `You have ${n} meters selected, but custom row layout can only show ${cap} in Vertical view.\n(${R} rows × ${M} per row). Extra meters are not shown.`;
    } else {
      noteEl.hidden = true;
      noteEl.textContent = '';
    }
  }

  function syncMeterSaveDirtyState() {
    syncVerticalRowOverflowNote();
    if (!saveBtn) return;
    if (savedMeterConfigSignature === null) {
      saveBtn.classList.remove('settings-btn-primary--dirty');
      saveBtn.removeAttribute('aria-label');
      if (revertBtn) {
        revertBtn.classList.remove('meter-config-clear-btn--visible');
        revertBtn.disabled = true;
      }
      return;
    }
    const dirty = meterConfigSignature(getConfigFromToggleBoxes()) !== savedMeterConfigSignature;
    saveBtn.classList.toggle('settings-btn-primary--dirty', dirty);
    if (dirty) {
      saveBtn.setAttribute('aria-label', 'Save meter selection — unsaved changes');
    } else {
      saveBtn.removeAttribute('aria-label');
    }
    if (
      dirty &&
      !saveBtn.disabled &&
      messageEl &&
      !messageEl.classList.contains('meter-config-message--error')
    ) {
      clearMeterConfigMessageTimer();
      clearMeterConfigSavedMessageDelayTimer();
      bumpMeterConfigMessageOp();
      fadeMeterConfigMessageOut();
    }
    if (revertBtn) {
      revertBtn.classList.toggle('meter-config-clear-btn--visible', dirty);
      revertBtn.disabled = !dirty || saveBtn.disabled;
    }
  }

  function setGroupBoxes(group, active) {
    group.querySelectorAll('.toggle-box').forEach(box => {
      box.classList.toggle('toggle-box--active', active);
      updateBoxStyle(box);
    });
    syncMeterSaveDirtyState();
  }

  function setGroupTap(group, tap) {
    group.querySelectorAll('.toggle-box').forEach(box => {
      tapByKey[boxKey(box)] = tap;
      syncBoxDisplay(box);
    });
    syncMeterSaveDirtyState();
  }

  function clearMeterConfigMessageTimer() {
    if (meterConfigMessageClearTimer) {
      clearTimeout(meterConfigMessageClearTimer);
      meterConfigMessageClearTimer = null;
    }
  }

  function clearMeterConfigSavedMessageDelayTimer() {
    if (meterConfigSavedMessageDelayTimer) {
      clearTimeout(meterConfigSavedMessageDelayTimer);
      meterConfigSavedMessageDelayTimer = null;
    }
  }

  function bumpMeterConfigMessageOp() {
    return ++meterConfigMessageOpId;
  }

  function prefersReducedMotionMeterMessage() {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /**
   * @param {() => void} [done]
   */
  function fadeMeterConfigMessageOut(done) {
    if (!messageEl) {
      if (done) done();
      return;
    }
    const startId = meterConfigMessageOpId;
    if (!messageEl.textContent) {
      messageEl.className = 'meter-config-message';
      if (meterConfigMessageOpId === startId && done) done();
      return;
    }
    if (prefersReducedMotionMeterMessage()) {
      messageEl.textContent = '';
      messageEl.className = 'meter-config-message';
      if (meterConfigMessageOpId === startId && done) done();
      return;
    }
    if (!messageEl.classList.contains('meter-config-message--visible')) {
      messageEl.textContent = '';
      messageEl.className = 'meter-config-message';
      if (meterConfigMessageOpId === startId && done) done();
      return;
    }
    messageEl.classList.remove('meter-config-message--visible');
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(fallback);
      messageEl.removeEventListener('transitionend', onEnd);
      if (meterConfigMessageOpId !== startId) return;
      messageEl.textContent = '';
      messageEl.className = 'meter-config-message';
      if (done) done();
    };
    const onEnd = e => {
      if (meterConfigMessageOpId !== startId) return;
      if (e.propertyName !== 'opacity') return;
      cleanup();
    };
    messageEl.addEventListener('transitionend', onEnd);
    const fallback = setTimeout(cleanup, 400);
  }

  function scheduleMeterConfigMessageAutoHide(ms) {
    meterConfigMessageClearTimer = setTimeout(() => {
      meterConfigMessageClearTimer = null;
      const startId = meterConfigMessageOpId;
      if (!messageEl) return;
      if (prefersReducedMotionMeterMessage()) {
        messageEl.textContent = '';
        messageEl.className = 'meter-config-message';
        return;
      }
      if (!messageEl.classList.contains('meter-config-message--visible')) {
        messageEl.textContent = '';
        messageEl.className = 'meter-config-message';
        return;
      }
      messageEl.classList.remove('meter-config-message--visible');
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(fallback);
        messageEl.removeEventListener('transitionend', onEnd);
        if (meterConfigMessageOpId !== startId) return;
        messageEl.textContent = '';
        messageEl.className = 'meter-config-message';
      };
      const onEnd = e => {
        if (meterConfigMessageOpId !== startId) return;
        if (e.propertyName !== 'opacity') return;
        cleanup();
      };
      messageEl.addEventListener('transitionend', onEnd);
      const fallback = setTimeout(cleanup, 400);
    }, ms);
  }

  /**
   * @param {string} text
   * @param {boolean} [isError]
   * @param {{ clearAfterMs?: number }} [options] Same 5s pattern as wing IP transient hints
   */
  function showMessage(text, isError, options) {
    clearMeterConfigMessageTimer();
    clearMeterConfigSavedMessageDelayTimer();
    if (!messageEl) return;
    bumpMeterConfigMessageOp();
    const myOp = meterConfigMessageOpId;
    const instant = prefersReducedMotionMeterMessage();
    const ms = options && typeof options.clearAfterMs === 'number' ? options.clearAfterMs : 0;

    if (instant) {
      messageEl.textContent = text;
      messageEl.className =
        'meter-config-message' +
        (isError ? ' meter-config-message--error' : '') +
        (text ? ' meter-config-message--visible' : '');
      if (ms > 0 && text) {
        meterConfigMessageClearTimer = setTimeout(() => {
          meterConfigMessageClearTimer = null;
          messageEl.textContent = '';
          messageEl.className = 'meter-config-message';
        }, ms);
      }
      return;
    }

    if (!text) {
      fadeMeterConfigMessageOut();
      return;
    }

    function reveal() {
      if (myOp !== meterConfigMessageOpId) return;
      messageEl.textContent = text;
      messageEl.className =
        'meter-config-message' + (isError ? ' meter-config-message--error' : '');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (myOp !== meterConfigMessageOpId) return;
          messageEl.classList.add('meter-config-message--visible');
        });
      });
      if (ms > 0 && text) {
        scheduleMeterConfigMessageAutoHide(ms);
      }
    }

    if (messageEl.classList.contains('meter-config-message--visible') && messageEl.textContent) {
      const swapId = meterConfigMessageOpId;
      messageEl.classList.remove('meter-config-message--visible');
      const onSwapEnd = e => {
        if (e.propertyName !== 'opacity') return;
        clearTimeout(swapFallback);
        messageEl.removeEventListener('transitionend', onSwapEnd);
        if (meterConfigMessageOpId !== swapId) return;
        reveal();
      };
      const swapFallback = setTimeout(() => {
        messageEl.removeEventListener('transitionend', onSwapEnd);
        if (meterConfigMessageOpId !== swapId) return;
        reveal();
      }, 400);
      messageEl.addEventListener('transitionend', onSwapEnd);
    } else {
      reveal();
    }
  }

  renderToggleBoxes();

  tapModeBtn.addEventListener('click', () => {
    setUiMode(uiMode === 'selection' ? 'tap' : 'selection');
  });

  container.querySelectorAll('.meter-config-group-header .icon-btn--group-select').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.meter-config-group');
      setGroupBoxes(group, btn.dataset.action === 'all');
    });
  });

  container.querySelectorAll('.meter-config-group-header .icon-btn--group-tap').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.meter-config-group');
      const tap = btn.dataset.tap === 'post' ? 'post' : 'pre';
      setGroupTap(group, tap);
    });
  });

  document.getElementById('globalAll').addEventListener('click', () => {
    container.querySelectorAll('.toggle-box').forEach(box => {
      box.classList.add('toggle-box--active');
      updateBoxStyle(box);
    });
    syncMeterSaveDirtyState();
  });

  document.getElementById('globalNone').addEventListener('click', () => {
    container.querySelectorAll('.toggle-box').forEach(box => {
      box.classList.remove('toggle-box--active');
      updateBoxStyle(box);
    });
    syncMeterSaveDirtyState();
  });

  document.getElementById('globalAllPre').addEventListener('click', () => {
    container.querySelectorAll('.meter-config-group').forEach(g => setGroupTap(g, 'pre'));
  });

  document.getElementById('globalAllPost').addEventListener('click', () => {
    container.querySelectorAll('.meter-config-group').forEach(g => setGroupTap(g, 'post'));
  });

  fetch('/api/meters-config')
    .then(r => r.json())
    .then(config => {
      if (!Array.isArray(config)) return;
      setActiveFromConfig(config);
      config.forEach(entry => {
        const key = entry.kind + ':' + entry.index;
        if (entry.postFader === true) tapByKey[key] = 'post';
        else tapByKey[key] = 'pre';
      });
      if (uiMode === 'tap') syncAllBoxes();
      savedMeterConfigSignature = meterConfigSignature(config);
      syncMeterSaveDirtyState();
    })
    .catch(() => {
      showMessage('Could not load config', true);
      savedMeterConfigSignature = meterConfigSignature(getConfigFromToggleBoxes());
      syncMeterSaveDirtyState();
    });

  function refreshChannelInfo() {
    fetch('/api/channel-colors')
      .then(r => r.json())
      .then(colors => applyAllColors(colors))
      .catch(() => {});
    fetch('/api/channel-names')
      .then(r => r.json())
      .then(names => applyAllNames(names))
      .catch(() => {});
  }

  function startChannelPoll() {
    if (channelPollTimerId !== null) clearInterval(channelPollTimerId);
    channelPollTimerId = setInterval(refreshChannelInfo, clientPollMs);
  }

  if (typeof io === 'function') {
    settingsIo = io({ query: { page: 'settings' } });
    settingsIo.on('channel-info', payload => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.colors && typeof payload.colors === 'object') applyAllColors(payload.colors);
      if (payload.names && typeof payload.names === 'object') applyAllNames(payload.names);
    });
    settingsIo.on('low-resource', payload => {
      if (!payload || typeof payload !== 'object') return;
      const on = !!payload.lowResourceMode;
      document.body.classList.toggle('low-resource', on);
      const cb = document.getElementById('lowResourceMode');
      if (cb && cb.checked !== on) cb.checked = on;
      if (typeof applyLrmToRefresh === 'function') applyLrmToRefresh(payload.refreshIntervalMs);
    });
  }

  refreshChannelInfo();
  startChannelPoll();

  // Bridge so the Low Resource Mode toggle (defined further down in this
  // IIFE) can update the refresh-interval input's minimum and displayed value
  // in real time. Assigned inside the refresh-interval block below.
  let applyLrmToRefresh = null;

  const refreshIntervalInput = document.getElementById('refreshInterval');
  if (refreshIntervalInput) {
    const refreshIntervalField = refreshIntervalInput.closest('.settings-refresh-interval-field');
    const refreshIntervalUnitBtn = document.getElementById('refreshIntervalUnit');
    const lowResourceModeCheckbox = document.getElementById('lowResourceMode');
    const REFRESH_UNIT_STORAGE_KEY = 'wing.refreshIntervalUnit';
    const MS_MIN = 1000;
    const MS_MAX = 300000;
    const MS_STEP = 100;
    const LRM_MS_FLOOR = 30000;

    // Effective minimum in ms. While LRM is active the floor rises to 30 s so
    // the user can't set something below the LRM refresh floor.
    function getEffectiveMsMin() {
      return lowResourceModeCheckbox && lowResourceModeCheckbox.checked
        ? LRM_MS_FLOOR
        : MS_MIN;
    }

    let refreshCurrentMs = parseInt(refreshIntervalInput.value, 10);
    if (!Number.isFinite(refreshCurrentMs)) refreshCurrentMs = clientPollMs || 10000;
    let refreshUnit = 'ms';
    try {
      const stored = window.localStorage && window.localStorage.getItem(REFRESH_UNIT_STORAGE_KEY);
      if (stored === 's' || stored === 'ms') refreshUnit = stored;
    } catch (_) {}


    function formatSecondsDisplay(ms) {
      const v = ms / 1000;
      return String(Number(v.toFixed(1)));
    }
    function applyRefreshUnit() {
      const effMin = getEffectiveMsMin();
      if (refreshUnit === 's') {
        refreshIntervalInput.min = String(effMin / 1000);
        refreshIntervalInput.max = String(MS_MAX / 1000);
        refreshIntervalInput.step = '1';
        refreshIntervalInput.value = formatSecondsDisplay(refreshCurrentMs);
        refreshIntervalInput.setAttribute('aria-label', 'Refresh interval in seconds');
        refreshIntervalInput.title = 'How often to refresh names and colors from the mixer (s)';
        refreshIntervalInput.removeAttribute('inputmode');
        if (refreshIntervalField) refreshIntervalField.setAttribute('aria-label', 'Refresh interval (seconds)');
      } else {
        refreshIntervalInput.min = String(effMin);
        refreshIntervalInput.max = String(MS_MAX);
        refreshIntervalInput.step = String(MS_STEP);
        refreshIntervalInput.value = String(refreshCurrentMs);
        refreshIntervalInput.setAttribute('aria-label', 'Refresh interval in milliseconds');
        refreshIntervalInput.title = 'How often to refresh names and colors from the mixer (ms)';
        refreshIntervalInput.setAttribute('inputmode', 'numeric');
        if (refreshIntervalField) refreshIntervalField.setAttribute('aria-label', 'Refresh interval (milliseconds)');
      }
      if (refreshIntervalUnitBtn) {
        refreshIntervalUnitBtn.textContent = refreshUnit === 's' ? 'S' : 'MS';
        refreshIntervalUnitBtn.dataset.unit = refreshUnit;
        const label =
          refreshUnit === 's'
            ? 'Unit: seconds. Click to switch to milliseconds.'
            : 'Unit: milliseconds. Click to switch to seconds.';
        refreshIntervalUnitBtn.setAttribute('aria-label', label);
        refreshIntervalUnitBtn.setAttribute('title', label);
      }
      syncRefreshIntervalStepButtons();
    }
    function readDisplayedRefreshMs() {
      const s = refreshIntervalInput.value;
      if (s == null || s === '') return NaN;
      const n = Number(s);
      if (!Number.isFinite(n)) return NaN;
      return refreshUnit === 's' ? Math.round(n * 1000) : Math.round(n);
    }

    function parseRefreshBound(attr, fallback) {
      const s = refreshIntervalInput.getAttribute(attr);
      if (s == null || s === '') return fallback;
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    }
    function syncRefreshIntervalStepButtons() {
      if (!refreshIntervalField) return;
      const min = parseRefreshBound('min', -Infinity);
      const max = parseRefreshBound('max', Infinity);
      let v = Number(refreshIntervalInput.value);
      if (!Number.isFinite(v)) v = min === -Infinity ? 0 : min;
      const up = refreshIntervalField.querySelector('.settings-vertical-row-mode-field__step--up');
      const down = refreshIntervalField.querySelector('.settings-vertical-row-mode-field__step--down');
      if (up) up.disabled = v >= max;
      if (down) down.disabled = v <= min;
    }
    function adjustRefreshInterval(direction) {
      const min = parseRefreshBound('min', -Infinity);
      const max = parseRefreshBound('max', Infinity);
      const step = parseRefreshBound('step', 1);
      let v = Number(refreshIntervalInput.value);
      if (!Number.isFinite(v)) v = min === -Infinity ? 0 : min;
      const base = min === -Infinity ? 0 : min;
      let next;
      if (direction > 0) {
        next = Math.floor((v - base) / step + 1e-9) * step + base + step;
      } else {
        next = Math.ceil((v - base) / step - 1e-9) * step + base - step;
      }
      next = Math.min(max, Math.max(min, next));
      next = Math.round(next * 10) / 10;
      if (next !== v) {
        refreshIntervalInput.value = refreshUnit === 's' ? String(Number(next.toFixed(1))) : String(next);
        refreshIntervalInput.dispatchEvent(new Event('input', { bubbles: true }));
        refreshIntervalInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncRefreshIntervalStepButtons();
    }

    if (refreshIntervalField) {
      refreshIntervalField.addEventListener('click', e => {
        const step = e.target.closest('.settings-vertical-row-mode-field__step');
        if (!step || !refreshIntervalField.contains(step)) return;
        if (step.classList.contains('settings-vertical-row-mode-field__step--up')) {
          adjustRefreshInterval(1);
        } else if (step.classList.contains('settings-vertical-row-mode-field__step--down')) {
          adjustRefreshInterval(-1);
        }
      });
    }

    if (refreshIntervalUnitBtn) {
      refreshIntervalUnitBtn.addEventListener('click', () => {
        refreshUnit = refreshUnit === 'ms' ? 's' : 'ms';
        try {
          if (window.localStorage) window.localStorage.setItem(REFRESH_UNIT_STORAGE_KEY, refreshUnit);
        } catch (_) {}
        applyRefreshUnit();
      });
    }

    refreshIntervalInput.addEventListener('input', syncRefreshIntervalStepButtons);

    const REFRESH_SAVE_DEBOUNCE_MS = 400;
    let refreshSaveTimer = null;
    let refreshSaveAbort = null;

    function commitRefreshInterval() {
      refreshSaveTimer = null;
      let v = readDisplayedRefreshMs();
      if (!Number.isFinite(v)) {
        refreshIntervalInput.setCustomValidity('Invalid value');
        refreshIntervalInput.reportValidity();
        return;
      }
      const effMin = getEffectiveMsMin();
      if (v < effMin) {
        v = effMin;
        refreshCurrentMs = effMin;
        applyRefreshUnit();
      }
      if (v === refreshCurrentMs) return;
      if (refreshSaveAbort) refreshSaveAbort.abort();
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      refreshSaveAbort = controller;
      fetch('/api/refresh-interval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshIntervalMs: v }),
        signal: controller ? controller.signal : undefined,
      })
        .then(r => r.json().then(data => ({ status: r.status, data })))
        .then(({ status, data }) => {
          if (refreshSaveAbort !== controller) return;
          refreshSaveAbort = null;
          if (status >= 200 && status < 300 && data && typeof data.refreshIntervalMs === 'number') {
            const changed = data.refreshIntervalMs !== clientPollMs;
            clientPollMs = data.refreshIntervalMs;
            refreshCurrentMs = data.refreshIntervalMs;
            container.dataset.refreshInterval = String(clientPollMs);
            applyRefreshUnit();
            if (changed) startChannelPoll();
            return;
          }
          const err = (data && data.error) || 'Save failed';
          refreshIntervalInput.setCustomValidity(err);
          refreshIntervalInput.reportValidity();
        })
        .catch(err => {
          if (err && err.name === 'AbortError') return;
          if (refreshSaveAbort === controller) refreshSaveAbort = null;
          refreshIntervalInput.setCustomValidity('Network error');
          refreshIntervalInput.reportValidity();
        });
    }

    refreshIntervalInput.addEventListener('change', () => {
      refreshIntervalInput.setCustomValidity('');
      if (refreshSaveTimer) clearTimeout(refreshSaveTimer);
      refreshSaveTimer = setTimeout(commitRefreshInterval, REFRESH_SAVE_DEBOUNCE_MS);
    });

    refreshIntervalInput.addEventListener('blur', () => {
      if (refreshSaveTimer) {
        clearTimeout(refreshSaveTimer);
        commitRefreshInterval();
      }
    });

    applyRefreshUnit();

    // Called by the Low Resource Mode block below when LRM changes (locally
    // or from a socket broadcast). Updates the effective minimum and — if the
    // server bumped the stored interval to the LRM floor — the displayed
    // value too.
    applyLrmToRefresh = function (serverRefreshMs) {
      if (typeof serverRefreshMs === 'number' && Number.isFinite(serverRefreshMs)
          && serverRefreshMs !== refreshCurrentMs) {
        refreshCurrentMs = serverRefreshMs;
        clientPollMs = serverRefreshMs;
        if (container) container.dataset.refreshInterval = String(serverRefreshMs);
        startChannelPoll();
      }
      applyRefreshUnit();
    };

    fetch('/api/refresh-interval')
      .then(r => r.json())
      .then(data => {
        if (data && typeof data.refreshIntervalMs === 'number') {
          clientPollMs = data.refreshIntervalMs;
          refreshCurrentMs = data.refreshIntervalMs;
          container.dataset.refreshInterval = String(data.refreshIntervalMs);
          applyRefreshUnit();
          startChannelPoll();
        }
      })
      .catch(() => {});
  }

  const lowResourceModeInput = document.getElementById('lowResourceMode');
  if (lowResourceModeInput) {
    if (lowResourceModeInput.checked) document.body.classList.add('low-resource');
    let lrmAbort = null;
    lowResourceModeInput.addEventListener('change', () => {
      const desired = !!lowResourceModeInput.checked;
      document.body.classList.toggle('low-resource', desired);
      if (lrmAbort) lrmAbort.abort();
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      lrmAbort = controller;
      fetch('/api/low-resource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lowResourceMode: desired }),
        signal: controller ? controller.signal : undefined,
      })
        .then(r => r.json().then(data => ({ status: r.status, data })))
        .then(({ status, data }) => {
          if (lrmAbort !== controller) return;
          lrmAbort = null;
          if (status >= 200 && status < 300 && data && typeof data.lowResourceMode === 'boolean') {
            lowResourceModeInput.checked = data.lowResourceMode;
            document.body.classList.toggle('low-resource', data.lowResourceMode);
            if (typeof applyLrmToRefresh === 'function') applyLrmToRefresh(data.refreshIntervalMs);
            return;
          }
          lowResourceModeInput.checked = !desired;
          document.body.classList.toggle('low-resource', !desired);
          if (typeof applyLrmToRefresh === 'function') applyLrmToRefresh();
        })
        .catch(err => {
          if (err && err.name === 'AbortError') return;
          if (lrmAbort === controller) lrmAbort = null;
          lowResourceModeInput.checked = !desired;
          document.body.classList.toggle('low-resource', !desired);
          if (typeof applyLrmToRefresh === 'function') applyLrmToRefresh();
        });
    });
  }

  const textColorGrid = document.getElementById('textColorGrid');
  const labelColorGrid = document.getElementById('labelColorGrid');

  const textColorModeCustom = document.getElementById('textColorModeCustom');
  if (textColorGrid && textColorModeCustom) {
    function syncTextColorGridVisibility() {
      textColorGrid.style.display = textColorModeCustom.checked ? '' : 'none';
    }

    function buildTextColorsPayload() {
      const textColors = {};
      METER_COLOR_KINDS.forEach(kind => {
        const input = textColorGrid.querySelector('.settings-text-color-input[data-kind="' + kind + '"]');
        if (!input) return;
        textColors[kind] = input.dataset.override === 'true' ? input.value : null;
      });
      return textColors;
    }

    function postMeterTextColors() {
      fetch('/api/meter-text-colors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textColorModeCustom: textColorModeCustom.checked,
          textColors: buildTextColorsPayload(),
        }),
      }).catch(() => {});
    }

    textColorModeCustom.addEventListener('change', () => {
      syncTextColorGridVisibility();
      postMeterTextColors();
    });
    textColorGrid.querySelectorAll('.settings-text-color-input[data-kind]').forEach(input => {
      input.addEventListener('change', () => {
        input.dataset.override = 'true';
        syncMeterColorInputClearIndicator(input);
        postMeterTextColors();
      });
    });
    textColorGrid.querySelectorAll('.settings-meter-color-clear[data-scope="text"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-kind');
        if (!kind) return;
        const input = textColorGrid.querySelector('.settings-text-color-input[data-kind="' + kind + '"]');
        if (!input) return;
        input.dataset.override = 'false';
        input.value = autoTextOnBackground(wingScribbleHexForKind(kind));
        syncMeterColorInputClearIndicator(input);
        postMeterTextColors();
      });
    });
    textColorGrid.querySelectorAll('.settings-meter-color-default-kind[data-scope="text"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-kind');
        if (!kind) return;
        const input = textColorGrid.querySelector('.settings-text-color-input[data-kind="' + kind + '"]');
        if (!input) return;
        input.dataset.override = 'true';
        input.value = TEXT_COLOR_DEFAULT;
        syncMeterColorInputClearIndicator(input);
        postMeterTextColors();
      });
    });
    const meterTextColorClearAll = document.getElementById('meterTextColorClearAll');
    if (meterTextColorClearAll) {
      meterTextColorClearAll.addEventListener('click', () => {
        METER_COLOR_KINDS.forEach(kind => {
          const input = textColorGrid.querySelector('.settings-text-color-input[data-kind="' + kind + '"]');
          if (!input) return;
          input.dataset.override = 'false';
          input.value = autoTextOnBackground(wingScribbleHexForKind(kind));
          syncMeterColorInputClearIndicator(input);
        });
        postMeterTextColors();
      });
    }
    const meterTextColorDefaultAll = document.getElementById('meterTextColorDefaultAll');
    if (meterTextColorDefaultAll) {
      meterTextColorDefaultAll.addEventListener('click', () => {
        METER_COLOR_KINDS.forEach(kind => {
          const input = textColorGrid.querySelector('.settings-text-color-input[data-kind="' + kind + '"]');
          if (!input) return;
          input.dataset.override = 'true';
          input.value = TEXT_COLOR_DEFAULT;
          syncMeterColorInputClearIndicator(input);
        });
        postMeterTextColors();
      });
    }
    syncTextColorGridVisibility();
    syncMeterColorPickerPreviewFromWing();
  }

  const labelColorModeCustom = document.getElementById('labelColorModeCustom');
  if (labelColorGrid && labelColorModeCustom) {
    function syncLabelColorGridVisibility() {
      labelColorGrid.style.display = labelColorModeCustom.checked ? '' : 'none';
    }

    function buildLabelColorsPayload() {
      const labelColors = {};
      METER_COLOR_KINDS.forEach(kind => {
        const input = labelColorGrid.querySelector('.settings-label-color-input[data-kind="' + kind + '"]');
        if (!input) return;
        labelColors[kind] = input.dataset.override === 'true' ? input.value : null;
      });
      return labelColors;
    }

    function postMeterLabelColors() {
      fetch('/api/meter-label-colors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          labelColorModeCustom: labelColorModeCustom.checked,
          labelColors: buildLabelColorsPayload(),
        }),
      }).catch(() => {});
    }

    labelColorModeCustom.addEventListener('change', () => {
      syncLabelColorGridVisibility();
      postMeterLabelColors();
    });
    labelColorGrid.querySelectorAll('.settings-label-color-input[data-kind]').forEach(input => {
      input.addEventListener('change', () => {
        input.dataset.override = 'true';
        syncMeterColorInputClearIndicator(input);
        postMeterLabelColors();
      });
    });
    labelColorGrid.querySelectorAll('.settings-meter-color-clear[data-scope="label"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-kind');
        if (!kind) return;
        const input = labelColorGrid.querySelector('.settings-label-color-input[data-kind="' + kind + '"]');
        if (!input) return;
        input.dataset.override = 'false';
        input.value = wingScribbleHexForKind(kind);
        syncMeterColorInputClearIndicator(input);
        postMeterLabelColors();
      });
    });
    labelColorGrid.querySelectorAll('.settings-meter-color-default-kind[data-scope="label"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-kind');
        if (!kind) return;
        const input = labelColorGrid.querySelector('.settings-label-color-input[data-kind="' + kind + '"]');
        if (!input) return;
        input.dataset.override = 'true';
        input.value = LABEL_COLOR_DEFAULT;
        syncMeterColorInputClearIndicator(input);
        postMeterLabelColors();
      });
    });
    const meterLabelColorClearAll = document.getElementById('meterLabelColorClearAll');
    if (meterLabelColorClearAll) {
      meterLabelColorClearAll.addEventListener('click', () => {
        METER_COLOR_KINDS.forEach(kind => {
          const input = labelColorGrid.querySelector('.settings-label-color-input[data-kind="' + kind + '"]');
          if (!input) return;
          input.dataset.override = 'false';
          input.value = wingScribbleHexForKind(kind);
          syncMeterColorInputClearIndicator(input);
        });
        postMeterLabelColors();
      });
    }
    const meterLabelColorDefaultAll = document.getElementById('meterLabelColorDefaultAll');
    if (meterLabelColorDefaultAll) {
      meterLabelColorDefaultAll.addEventListener('click', () => {
        METER_COLOR_KINDS.forEach(kind => {
          const input = labelColorGrid.querySelector('.settings-label-color-input[data-kind="' + kind + '"]');
          if (!input) return;
          input.dataset.override = 'true';
          input.value = LABEL_COLOR_DEFAULT;
          syncMeterColorInputClearIndicator(input);
        });
        postMeterLabelColors();
      });
    }
    syncLabelColorGridVisibility();
    syncMeterColorPickerPreviewFromWing();
  }

  const showNumberLabelEl = document.getElementById('showNumberLabel');
  const showNameLabelEl = document.getElementById('showNameLabel');
  const verticalRowModeEl = document.getElementById('verticalRowMode');
  const verticalRowModeFields = document.getElementById('verticalRowModeFields');
  const verticalRowCountEl = document.getElementById('verticalRowCount');
  const verticalMetersPerRowEl = document.getElementById('verticalMetersPerRow');
  if (
    showNumberLabelEl &&
    showNameLabelEl &&
    verticalRowModeEl &&
    verticalRowModeFields &&
    verticalRowCountEl &&
    verticalMetersPerRowEl
  ) {
    function syncVerticalRowFieldsVisibility() {
      verticalRowModeFields.hidden = !verticalRowModeEl.checked;
    }
    function postDisplayLayout() {
      fetch('/api/display-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showNumberLabel: showNumberLabelEl.checked,
          showNameLabel: showNameLabelEl.checked,
          verticalRowMode: verticalRowModeEl.checked,
          verticalRowCount: parseInt(verticalRowCountEl.value, 10),
          verticalMetersPerRow: parseInt(verticalMetersPerRowEl.value, 10),
        }),
      }).catch(() => {});
      syncVerticalRowOverflowNote();
    }

    function parseVerticalRowInputBound(input, name, fallback) {
      const s = input.getAttribute(name);
      if (s == null || s === '') return fallback;
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    }

    function syncVerticalRowStepButtonsForInput(input) {
      const field = input.closest('.settings-vertical-row-mode-field');
      if (!field) return;
      const min = parseVerticalRowInputBound(input, 'min', -Infinity);
      const max = parseVerticalRowInputBound(input, 'max', Infinity);
      let v = parseInt(input.value, 10);
      if (Number.isNaN(v)) v = min === -Infinity ? 0 : min;
      const up = field.querySelector('.settings-vertical-row-mode-field__step--up');
      const down = field.querySelector('.settings-vertical-row-mode-field__step--down');
      if (up) up.disabled = v >= max;
      if (down) down.disabled = v <= min;
    }

    function adjustVerticalRowNumberInput(input, direction) {
      const min = parseVerticalRowInputBound(input, 'min', -Infinity);
      const max = parseVerticalRowInputBound(input, 'max', Infinity);
      const step = parseVerticalRowInputBound(input, 'step', 1);
      let v = parseInt(input.value, 10);
      if (Number.isNaN(v)) v = min === -Infinity ? 0 : min;
      const next = Math.min(max, Math.max(min, v + direction * step));
      if (next !== v) {
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncVerticalRowStepButtonsForInput(input);
    }

    verticalRowModeFields.addEventListener('click', e => {
      const step = e.target.closest('.settings-vertical-row-mode-field__step');
      if (!step || !verticalRowModeFields.contains(step)) return;
      const field = step.closest('.settings-vertical-row-mode-field');
      const input = field && field.querySelector('.settings-vertical-row-mode-field__input');
      if (!input) return;
      if (step.classList.contains('settings-vertical-row-mode-field__step--up')) {
        adjustVerticalRowNumberInput(input, 1);
      } else if (step.classList.contains('settings-vertical-row-mode-field__step--down')) {
        adjustVerticalRowNumberInput(input, -1);
      }
    });
    showNumberLabelEl.addEventListener('change', postDisplayLayout);
    showNameLabelEl.addEventListener('change', postDisplayLayout);
    verticalRowModeEl.addEventListener('change', () => {
      syncVerticalRowFieldsVisibility();
      postDisplayLayout();
    });
    verticalRowCountEl.addEventListener('change', postDisplayLayout);
    verticalMetersPerRowEl.addEventListener('change', postDisplayLayout);
    verticalRowCountEl.addEventListener('input', syncVerticalRowOverflowNote);
    verticalMetersPerRowEl.addEventListener('input', syncVerticalRowOverflowNote);
    verticalRowCountEl.addEventListener('input', () => syncVerticalRowStepButtonsForInput(verticalRowCountEl));
    verticalMetersPerRowEl.addEventListener('input', () => syncVerticalRowStepButtonsForInput(verticalMetersPerRowEl));
    verticalRowCountEl.addEventListener('change', () => syncVerticalRowStepButtonsForInput(verticalRowCountEl));
    verticalMetersPerRowEl.addEventListener('change', () => syncVerticalRowStepButtonsForInput(verticalMetersPerRowEl));
    syncVerticalRowFieldsVisibility();
    syncVerticalRowOverflowNote();
    syncVerticalRowStepButtonsForInput(verticalRowCountEl);
    syncVerticalRowStepButtonsForInput(verticalMetersPerRowEl);
  }

  const wingIpInput = document.getElementById('wingIpInput');
  const wingApplyIpBtn = document.getElementById('wingApplyIpBtn');
  const wingScanBtn = document.getElementById('wingScanBtn');
  const wingScanBtnWrap = document.getElementById('wingScanBtnWrap');
  const wingAutoDiscovery = document.getElementById('wingAutoDiscovery');
  const wingScanPanel = document.getElementById('wingScanPanel');
  const wingScanResultsDivider = document.getElementById('wingScanResultsDivider');
  const wingStatusBadge = document.getElementById('wingStatusBadge');
  const wingConnectionHint = document.getElementById('wingConnectionHint');
  const wingScanStatus = document.getElementById('wingScanStatus');
  const wingScanLoading = document.getElementById('wingScanLoading');
  const wingScanResults = document.getElementById('wingScanResults');
  const wingClearSavedIpBtn = document.getElementById('wingClearSavedIpBtn');

  if (
    wingIpInput &&
    wingApplyIpBtn &&
    wingScanBtn &&
    wingScanBtnWrap &&
    wingAutoDiscovery &&
    wingScanPanel &&
    wingScanResultsDivider &&
    wingScanStatus &&
    wingScanLoading &&
    wingScanResults &&
    wingStatusBadge &&
    wingConnectionHint &&
    wingClearSavedIpBtn
  ) {
    /** @type {object|null} */
    let lastWingConnectionPayload = null;
    let pendingWingHintFlash = '';
    let postWingIpHadRequestError = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let wingScanEmptyResultsCloseTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let wingHintIpv4TransientTimer = null;
    /** @type {{ text: string, isError: boolean } | null} */
    let wingHintIpv4TransientRestore = null;

    function clearWingHintIpv4TransientSchedule() {
      if (wingHintIpv4TransientTimer) {
        clearTimeout(wingHintIpv4TransientTimer);
        wingHintIpv4TransientTimer = null;
      }
      wingHintIpv4TransientRestore = null;
    }

    function finishWingHintIpv4TransientEarly() {
      if (wingHintIpv4TransientTimer) {
        clearTimeout(wingHintIpv4TransientTimer);
        wingHintIpv4TransientTimer = null;
      }
      if (wingHintIpv4TransientRestore) {
        wingConnectionHint.textContent = wingHintIpv4TransientRestore.text;
        wingConnectionHint.classList.toggle(
          'settings-wing-status-comment--error',
          wingHintIpv4TransientRestore.isError
        );
        wingHintIpv4TransientRestore = null;
      }
    }

    function isWingTransientIpv4HintMessage(msg) {
      return (
        typeof msg === 'string' &&
        (msg.includes('Invalid IPv4') || msg.includes('Enter an IPv4 address'))
      );
    }

    function showWingIpv4AddressHintTransient(message) {
      finishWingHintIpv4TransientEarly();
      wingHintIpv4TransientRestore = {
        text: wingConnectionHint.textContent,
        isError: wingConnectionHint.classList.contains('settings-wing-status-comment--error')
      };
      wingConnectionHint.textContent = message;
      wingConnectionHint.classList.add('settings-wing-status-comment--error');
      wingHintIpv4TransientTimer = setTimeout(() => {
        wingHintIpv4TransientTimer = null;
        if (wingHintIpv4TransientRestore) {
          wingConnectionHint.textContent = wingHintIpv4TransientRestore.text;
          wingConnectionHint.classList.toggle(
            'settings-wing-status-comment--error',
            wingHintIpv4TransientRestore.isError
          );
          wingHintIpv4TransientRestore = null;
        }
      }, 5000);
    }

    function ipFromWingInputField() {
      const raw = wingIpInput.value.trim();
      if (!raw) return '';
      return raw.split(' (')[0].trim();
    }

    function setWingConnectionHint(text, isError) {
      clearWingHintIpv4TransientSchedule();
      wingConnectionHint.textContent = text || '';
      wingConnectionHint.classList.toggle('settings-wing-status-comment--error', !!isError);
    }

    function wingConnectionHintNotesFromData(data) {
      const detail = (data.connectionSourceDetail || '').trim();
      const notes = [];
      if (detail) notes.push(detail);
      if (data.connectionSource === 'manual-offline' && data.envWingIp) {
        notes.push(
          `WING_IP (${data.envWingIp}) is set on the server but ignored in this mode. Turn on automatic discovery to use it.`
        );
      }
      if (data.connectionSource === 'saved' && data.envWingIp) {
        notes.push(
          `WING_IP (${data.envWingIp}) is also set on the server but is ignored until you clear the Settings IP or use automatic discovery.`
        );
      }
      if (data.connectionSource === 'environment') {
        notes.push(
          'To use a fixed IP from this page instead, remove WING_IP from the server environment. To use LAN scan, remove WING_IP and turn on automatic discovery.'
        );
      }
      if (data.connectionSource === 'discovery' && data.lastConnectedIp && !data.configuredAddress) {
        notes.push(
          'The address shown is the last console the server reached; with multiple Wings on the network, a different one may be chosen after reconnect.'
        );
      }
      return notes;
    }

    const wingScanTooltipEnabled = 'Scan for consoles';
    const wingScanTooltipDisabled =
      'Turn off automatic discovery (toggle to the left) to scan the network for Wing consoles.';

    function syncWingManualUi() {
      const autoOn = wingAutoDiscovery.checked;
      wingScanBtn.disabled = autoOn;
      if (autoOn) {
        wingScanBtn.removeAttribute('title');
        wingScanBtnWrap.setAttribute('title', wingScanTooltipDisabled);
        wingScanBtn.setAttribute('aria-label', wingScanTooltipDisabled);
      } else {
        wingScanBtnWrap.removeAttribute('title');
        wingScanBtn.setAttribute('title', wingScanTooltipEnabled);
        wingScanBtn.setAttribute('aria-label', 'Scan network for Wing consoles');
      }
    }

    function syncWingScanResultsDivider() {
      const show = !wingScanResults.hidden;
      wingScanResultsDivider.hidden = !show;
      wingConnectionHint.classList.toggle('settings-wing-status-comment--after-scan-results', show);
    }

    function closeWingScanPanel() {
      if (wingScanEmptyResultsCloseTimer) {
        clearTimeout(wingScanEmptyResultsCloseTimer);
        wingScanEmptyResultsCloseTimer = null;
      }
      wingScanPanel.hidden = true;
      wingScanLoading.hidden = true;
      wingScanStatus.textContent = '';
      wingScanResults.innerHTML = '';
      wingScanResults.hidden = true;
      syncWingScanResultsDivider();
    }

    function syncWingIpInlineActions() {
      const loadFailed = !lastWingConnectionPayload && wingIpInput.value === '—';
      if (loadFailed) {
        wingApplyIpBtn.hidden = true;
        wingClearSavedIpBtn.hidden = true;
        return;
      }
      if (wingAutoDiscovery.checked) {
        wingApplyIpBtn.hidden = true;
        wingClearSavedIpBtn.hidden = true;
        return;
      }
      const saved =
        lastWingConnectionPayload && lastWingConnectionPayload.fixedWingIp != null
          ? lastWingConnectionPayload.fixedWingIp
          : '';
      const typed = ipFromWingInputField();
      wingApplyIpBtn.hidden = !(typed !== '' && typed !== saved);
      wingClearSavedIpBtn.hidden = !saved;
    }

    function connectionModeBracket(data) {
      const src = data.connectionSource;
      if (src === 'saved') return 'Manual';
      if (src === 'environment') return 'Environment';
      if (src === 'manual-offline') return 'Offline';
      return 'Auto Discovery';
    }

    function renderConnectionStatus(data, options = {}) {
      const updateHint = options.updateHint !== false;
      lastWingConnectionPayload = data;
      const addr = data.displayAddress;
      const bracket = connectionModeBracket(data);
      const autoOn = wingAutoDiscovery.checked;

      if (autoOn) {
        wingIpInput.readOnly = true;
        wingIpInput.disabled = true;
        wingIpInput.value = addr ? `${addr} (${bracket})` : 'Searching for console…';
      } else {
        wingIpInput.readOnly = false;
        wingIpInput.disabled = false;
        if (document.activeElement !== wingIpInput) {
          wingIpInput.value = data.fixedWingIp != null ? data.fixedWingIp : '';
        }
      }

      if (updateHint) {
        clearWingHintIpv4TransientSchedule();
        const notes = wingConnectionHintNotesFromData(data);
        if (pendingWingHintFlash) {
          notes.unshift(pendingWingHintFlash);
          pendingWingHintFlash = '';
        }
        wingConnectionHint.textContent = notes.join(' ');
        wingConnectionHint.classList.remove('settings-wing-status-comment--error');
      }

      const connected = data.connected === true;
      wingStatusBadge.textContent = connected ? 'Connected' : 'Disconnected';
      wingStatusBadge.classList.toggle('settings-wing-status-badge--connected', connected);
      wingStatusBadge.classList.toggle('settings-wing-status-badge--disconnected', !connected);
      wingStatusBadge.setAttribute('aria-label', connected ? 'Wing connected' : 'Wing disconnected');

      syncWingIpInlineActions();
    }

    function loadWingConnection() {
      return fetch('/api/wing-connection')
        .then(r => r.json())
        .then(data => {
          wingAutoDiscovery.checked = data.fixedWingIp == null;
          renderConnectionStatus(data);
          if (data.fixedWingIp == null) {
            closeWingScanPanel();
          }
          syncWingScanResultsDivider();
          syncWingManualUi();
        })
        .catch(() => {
          pendingWingHintFlash = '';
          lastWingConnectionPayload = null;
          wingIpInput.readOnly = true;
          wingIpInput.disabled = true;
          wingIpInput.value = '—';
          setWingConnectionHint('Could not load connection settings from the server.', true);
          wingApplyIpBtn.hidden = true;
          wingClearSavedIpBtn.hidden = true;
          wingStatusBadge.textContent = 'Disconnected';
          wingStatusBadge.classList.remove('settings-wing-status-badge--connected');
          wingStatusBadge.classList.add('settings-wing-status-badge--disconnected');
          wingStatusBadge.setAttribute('aria-label', 'Wing disconnected');
          closeWingScanPanel();
        });
    }

    function postWingIp(fixedWingIp) {
      postWingIpHadRequestError = false;
      wingAutoDiscovery.disabled = true;
      wingScanBtn.disabled = true;
      wingIpInput.disabled = true;
      wingApplyIpBtn.disabled = true;
      wingClearSavedIpBtn.disabled = true;
      return fetch('/api/wing-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixedWingIp })
      })
        .then(r => r.json().then(data => ({ status: r.status, data })))
        .then(({ status, data }) => {
          if (status >= 200 && status < 300) {
            if (fixedWingIp === '') {
              pendingWingHintFlash =
                'Saved. The console stays disconnected until you apply an IP or turn on discovery.';
            } else if (fixedWingIp === null) {
              pendingWingHintFlash = 'Saved. The server is using automatic discovery…';
            } else {
              pendingWingHintFlash = 'Saved. The server is reconnecting to the Wing…';
            }
            return loadWingConnection().then(() => true);
          }
          postWingIpHadRequestError = true;
          const errMsg = data.error || 'Request failed';
          if (isWingTransientIpv4HintMessage(errMsg)) {
            showWingIpv4AddressHintTransient(errMsg);
          } else {
            setWingConnectionHint(errMsg, true);
          }
          return false;
        })
        .catch(() => {
          postWingIpHadRequestError = true;
          setWingConnectionHint('Network error', true);
          return false;
        })
        .finally(() => {
          wingAutoDiscovery.disabled = false;
          wingIpInput.disabled = false;
          wingApplyIpBtn.disabled = false;
          wingClearSavedIpBtn.disabled = false;
          if (lastWingConnectionPayload) {
            renderConnectionStatus(lastWingConnectionPayload, {
              updateHint: !postWingIpHadRequestError
            });
          }
          syncWingManualUi();
        });
    }

    wingAutoDiscovery.addEventListener('change', () => {
      if (wingAutoDiscovery.checked) {
        postWingIp(null);
      } else {
        postWingIp('');
      }
    });

    wingClearSavedIpBtn.addEventListener('click', () => {
      if (wingClearSavedIpBtn.hidden) return;
      postWingIp('');
    });

    wingApplyIpBtn.addEventListener('click', () => {
      if (wingApplyIpBtn.hidden) return;
      const v = ipFromWingInputField();
      if (!v) {
        showWingIpv4AddressHintTransient(
          'Enter an IPv4 address or turn on automatic discovery.'
        );
        return;
      }
      postWingIp(v);
    });

    wingIpInput.addEventListener('input', () => {
      syncWingIpInlineActions();
    });

    wingScanBtn.addEventListener('click', () => {
      if (wingAutoDiscovery.checked) return;
      if (wingScanEmptyResultsCloseTimer) {
        clearTimeout(wingScanEmptyResultsCloseTimer);
        wingScanEmptyResultsCloseTimer = null;
      }
      wingScanPanel.hidden = false;
      wingScanResults.innerHTML = '';
      wingScanResults.hidden = true;
      wingScanStatus.textContent = '';
      wingScanLoading.hidden = false;
      syncWingScanResultsDivider();
      wingScanBtn.disabled = true;
      fetch('/api/wing-scan')
        .then(r => r.json().then(data => ({ status: r.status, data })))
        .then(({ status, data }) => {
          wingScanLoading.hidden = true;
          wingScanStatus.textContent = '';
          if (status >= 200 && status < 300) {
            const devices = data.devices || [];
            if (!devices.length) {
              wingScanStatus.textContent = 'No consoles found.';
              wingScanEmptyResultsCloseTimer = setTimeout(() => {
                wingScanEmptyResultsCloseTimer = null;
                closeWingScanPanel();
              }, 5000);
              return;
            }
            devices.forEach(d => {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'settings-btn settings-wing-device-btn';
              const name = d.name || 'Wing';
              btn.textContent = `${name} · ${d.ip}${d.model ? ` · ${d.model}` : ''}`;
              btn.title = [d.serial, d.firmware].filter(Boolean).join(' · ');
              btn.addEventListener('click', () => {
                wingIpInput.value = d.ip;
                closeWingScanPanel();
                syncWingIpInlineActions();
              });
              wingScanResults.appendChild(btn);
            });
            wingScanResults.hidden = false;
          } else {
            wingScanStatus.textContent = (data && data.error) || 'Scan failed.';
          }
        })
        .catch(() => {
          wingScanLoading.hidden = true;
          wingScanStatus.textContent = 'Scan failed.';
        })
        .finally(() => {
          wingScanLoading.hidden = true;
          syncWingManualUi();
          syncWingScanResultsDivider();
        });
    });

    loadWingConnection();

    if (settingsIo) {
      settingsIo.on('wing-connection-status', data => {
        if (!data || typeof data !== 'object') return;
        renderConnectionStatus(data);
        syncWingManualUi();
      });
    }
  }

  if (revertBtn) {
    revertBtn.addEventListener('click', () => {
      revertMeterConfigToLastSaved();
    });
  }

  saveBtn.addEventListener('click', () => {
    const config = getConfigFromToggleBoxes();
    saveBtn.disabled = true;
    if (revertBtn) revertBtn.disabled = true;
    fetch('/api/meters-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    })
      .then(r => r.json().then(data => ({ status: r.status, data })))
      .then(({ status, data }) => {
        if (status >= 200 && status < 300) {
          savedMeterConfigSignature = meterConfigSignature(getConfigFromToggleBoxes());
          syncMeterSaveDirtyState();
          clearMeterConfigMessageTimer();
          clearMeterConfigSavedMessageDelayTimer();
          fadeMeterConfigMessageOut(() => {
            const dirtyRightAfterSave =
              savedMeterConfigSignature !== null &&
              meterConfigSignature(getConfigFromToggleBoxes()) !== savedMeterConfigSignature;
            if (!dirtyRightAfterSave) {
              meterConfigSavedMessageDelayTimer = setTimeout(() => {
                meterConfigSavedMessageDelayTimer = null;
                const stillDirty =
                  savedMeterConfigSignature !== null &&
                  meterConfigSignature(getConfigFromToggleBoxes()) !== savedMeterConfigSignature;
                if (!stillDirty) {
                  showMessage('Meter selection saved.', false, { clearAfterMs: 5000 });
                }
              }, 200);
            }
          });
        } else {
          showMessage(data.error || 'Save failed', true);
        }
      })
      .catch(() => showMessage('Save failed', true))
      .finally(() => {
        saveBtn.disabled = false;
        syncMeterSaveDirtyState();
      });
  });
})();
