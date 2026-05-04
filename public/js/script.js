const socket = io();

const container = document.getElementById('metersContainer');
// Per-meter list of bar fill elements: meterFills[i] = [fill, fill?]. Each
// fill is the inner <div class="meter-fill"> whose clip-path inset is
// animated to reveal the colored bar zones (see public/css/style.css).
const meterFills = [];
// Parallel to meterFills: lastClipPct[i][b] is the last quantized 0..200
// step (0.5% buckets) we wrote for that bar. Used so updateMeters only
// touches inline styles when the bar would actually move; matches the
// server-side fingerprint quantization granularity closely enough that
// we rarely write the same frame twice.
const meterLastClipPct = [];
// Parallel to meterFills: references we need for in-place label/color
// updates when the server re-emits config with only name/color changes.
const meterInfos = [];
let lastConfig = [];
let lastStructuralKey = null;

const DEFAULT_DISPLAY_LAYOUT = {
  showNumberLabel: true,
  showNameLabel: true,
  verticalRowMode: false,
  verticalRowCount: 2,
  verticalMetersPerRow: 12,
};

const METER_COLOR_KINDS = ['channel', 'aux', 'bus', 'main', 'matrix', 'dca'];

// The data tags below are rendered by the server once per page load and do not
// change during the lifetime of this page (changes in settings require a
// reload). Parse them once and reuse to avoid repeated getElementById +
// JSON.parse calls during every config / label update.
let cachedMeterLabelColors = null;
let cachedMeterTextColors = null;
let cachedDisplayLayout = null;
let cachedIsVertical = null;

function readMeterLabelColorsRaw() {
  const el = document.getElementById('meter-label-colors-data');
  if (!el || !el.textContent.trim()) {
    return { labelColorModeCustom: false, labelColors: {} };
  }
  try {
    const o = JSON.parse(el.textContent);
    const labelColorModeCustom =
      typeof o.labelColorModeCustom === 'boolean' ? o.labelColorModeCustom : false;
    const labelColors = {};
    if (o.labelColors && typeof o.labelColors === 'object') {
      for (let i = 0; i < METER_COLOR_KINDS.length; i++) {
        const k = METER_COLOR_KINDS[i];
        if (!Object.prototype.hasOwnProperty.call(o.labelColors, k)) continue;
        const v = o.labelColors[k];
        if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())) {
          labelColors[k] = v.trim().toLowerCase();
        }
      }
    }
    return { labelColorModeCustom, labelColors };
  } catch {
    return { labelColorModeCustom: false, labelColors: {} };
  }
}

function readMeterTextColorsRaw() {
  const el = document.getElementById('meter-text-colors-data');
  if (!el || !el.textContent.trim()) {
    return { textColorModeCustom: false, textColors: {} };
  }
  try {
    const o = JSON.parse(el.textContent);
    const textColorModeCustom =
      typeof o.textColorModeCustom === 'boolean' ? o.textColorModeCustom : false;
    const textColors = {};
    if (o.textColors && typeof o.textColors === 'object') {
      for (let i = 0; i < METER_COLOR_KINDS.length; i++) {
        const k = METER_COLOR_KINDS[i];
        if (!Object.prototype.hasOwnProperty.call(o.textColors, k)) continue;
        const v = o.textColors[k];
        if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())) {
          textColors[k] = v.trim().toLowerCase();
        }
      }
    }
    return { textColorModeCustom, textColors };
  } catch {
    return { textColorModeCustom: false, textColors: {} };
  }
}

function clampInt(n, min, max, fallback) {
  const x = parseInt(n, 10);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

function readDisplayLayoutRaw() {
  const el = document.getElementById('display-layout-data');
  if (!el || !el.textContent.trim()) {
    return { ...DEFAULT_DISPLAY_LAYOUT };
  }
  try {
    const o = JSON.parse(el.textContent);
    return {
      showNumberLabel:
        typeof o.showNumberLabel === 'boolean' ? o.showNumberLabel : DEFAULT_DISPLAY_LAYOUT.showNumberLabel,
      showNameLabel:
        typeof o.showNameLabel === 'boolean' ? o.showNameLabel : DEFAULT_DISPLAY_LAYOUT.showNameLabel,
      verticalRowMode:
        typeof o.verticalRowMode === 'boolean' ? o.verticalRowMode : DEFAULT_DISPLAY_LAYOUT.verticalRowMode,
      verticalRowCount: clampInt(o.verticalRowCount, 1, 92, DEFAULT_DISPLAY_LAYOUT.verticalRowCount),
      verticalMetersPerRow: clampInt(
        o.verticalMetersPerRow,
        1,
        92,
        DEFAULT_DISPLAY_LAYOUT.verticalMetersPerRow
      ),
    };
  } catch {
    return { ...DEFAULT_DISPLAY_LAYOUT };
  }
}

function readMeterLabelColors() {
  if (cachedMeterLabelColors === null) cachedMeterLabelColors = readMeterLabelColorsRaw();
  return cachedMeterLabelColors;
}

function readMeterTextColors() {
  if (cachedMeterTextColors === null) cachedMeterTextColors = readMeterTextColorsRaw();
  return cachedMeterTextColors;
}

function readDisplayLayout() {
  if (cachedDisplayLayout === null) cachedDisplayLayout = readDisplayLayoutRaw();
  return cachedDisplayLayout;
}

function isVerticalPage() {
  if (cachedIsVertical === null) {
    cachedIsVertical = !!(document.body && document.body.classList.contains('page-vertical'));
  }
  return cachedIsVertical;
}

function structuralKey(config) {
  const parts = [];
  parts.push(isVerticalPage() ? 'v' : 'h');
  const dl = readDisplayLayout();
  parts.push(dl.verticalRowMode ? `r${dl.verticalRowCount}x${dl.verticalMetersPerRow}` : 'r-');
  parts.push(`n${config.length}`);
  for (let i = 0; i < config.length; i++) {
    const e = config[i];
    parts.push(`${e.kind}:${e.index}:${e.stereo === true ? 1 : 0}`);
  }
  return parts.join('|');
}

// Build DOM from scratch for the given config. Should only run on first load
// or when the structural key changes (meter list, stereo flags, row layout).
function rebuildMeters(config) {
  container.innerHTML = '';
  meterFills.length = 0;
  meterLastClipPct.length = 0;
  meterInfos.length = 0;

  const isVertical = isVerticalPage();
  const dl = readDisplayLayout();

  if (isVertical) {
    document.body.classList.toggle('page-vertical--double-row', !!(dl.verticalRowMode && config.length > 0));
  } else {
    document.body.classList.remove('page-vertical--double-row');
  }

  if (isVertical && dl.verticalRowMode && config.length > 0) {
    const R = dl.verticalRowCount;
    const M = dl.verticalMetersPerRow;
    const maxSlots = R * M;
    const visibleConfig = maxSlots > 0 ? config.slice(0, maxSlots) : [];
    container.classList.add('meters-container--vertical-double');
    let idx = 0;
    for (let r = 0; r < R; r++) {
      if (idx >= visibleConfig.length) break;
      const row = document.createElement('div');
      row.className = 'meters-row meters-row--vertical-double';
      const remaining = visibleConfig.length - idx;
      const take = r === R - 1 ? remaining : Math.min(M, remaining);
      for (let j = 0; j < take; j++) {
        appendMeterForEntry(visibleConfig[idx++], isVertical, row);
      }
      container.appendChild(row);
    }
    return;
  }

  container.classList.remove('meters-container--vertical-double');

  for (let i = 0; i < config.length; i++) {
    appendMeterForEntry(config[i], isVertical, container);
  }
}

// Public entry point: decide whether to rebuild or just update in place.
// Structural key covers anything that forces new DOM (meter list, stereo,
// row layout). Everything else (label text, color id) is updated in place
// so the browser never throws away the existing meter bars.
function createMeters(config) {
  const nextConfig = config || lastConfig || [];
  const key = structuralKey(nextConfig);
  if (key !== lastStructuralKey) {
    lastStructuralKey = key;
    lastConfig = nextConfig;
    rebuildMeters(nextConfig);
    return;
  }
  updateMetersInPlace(nextConfig);
  lastConfig = nextConfig;
}

// Structure matches the existing DOM: just reconcile labels and colors.
function updateMetersInPlace(config) {
  for (let i = 0; i < config.length && i < meterInfos.length; i++) {
    const entry = config[i];
    const info = meterInfos[i];
    if (!info) continue;
    const prev = info.entry || {};
    const nextLabel = entry.label || `${entry.kind.toUpperCase()} ${entry.index + 1}`;
    const truncatedLabel = nextLabel.length > 11 ? nextLabel.slice(0, 11) : nextLabel;
    const prevLabel = prev.label || `${(prev.kind || entry.kind).toUpperCase()} ${(prev.index ?? entry.index) + 1}`;
    const prevTruncated = prevLabel.length > 11 ? prevLabel.slice(0, 11) : prevLabel;
    if (truncatedLabel !== prevTruncated) {
      info.labelDiv.textContent = truncatedLabel;
    }
    if (info.channelNumDiv.title !== nextLabel) {
      info.channelNumDiv.title = nextLabel;
    }
    if (prev.color !== entry.color) {
      applyLabelStyle(info.labelDiv, entry.color, entry.kind);
      applyLabelStyle(info.channelNumDiv, entry.color, entry.kind);
    }
    info.entry = entry;
  }
}

function appendMeterForEntry(entry, isVertical, parentEl) {
  const label = entry.label || `${entry.kind.toUpperCase()} ${entry.index + 1}`;
  const stereo = entry.stereo === true;
  const num = entry.index + 1;
  const KIND_PREFIX = { main: 'M', bus: 'B', aux: 'A', matrix: 'MX', dca: 'D' };
  const channelNum = KIND_PREFIX[entry.kind] ? `${KIND_PREFIX[entry.kind]}${num}` : String(num);
  createMeterElement(channelNum, label, entry.color, entry.kind, stereo, isVertical, parentEl, entry);
}

// Scribble strip colors: 18 slots (1–18). Adjust hex values as needed.
const SCRIBBLE_COLORS = [
  '#3E63CC', // 13
  '#0180FF', // 10
  '#5A33FF', // 16
  '#00CED1', // 12
  '#01B23E', // 6 
  '#96CC00', // 3
  '#F2DD00', // 4
  '#C06A1F', // 17
  '#E02040', // 8
  '#FF7A7A', // 14
  '#FF33F6', // 5
  '#A533FF', // 2
  '#FFB81A', // 1
  '#25C3FF', // 7
  '#FF5A30', // 11
  '#33E6A5', // 9
  '#707070', // 15
  '#E0E0E0'  // 18
];

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

function createMeterBar() {
  const bg = document.createElement('div');
  bg.className = 'meter-bg';
  const fill = document.createElement('div');
  fill.className = 'meter-fill';
  bg.appendChild(fill);
  return { bg, fill };
}

function applyLabelForegroundColor(el, contrastBgHex, kind) {
  const mtc = readMeterTextColors();
  const hasTextOverride =
    mtc.textColorModeCustom &&
    kind &&
    mtc.textColors &&
    Object.prototype.hasOwnProperty.call(mtc.textColors, kind) &&
    typeof mtc.textColors[kind] === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(mtc.textColors[kind]);
  if (hasTextOverride) {
    el.style.color = mtc.textColors[kind];
    return;
  }
  if (contrastBgHex) {
    el.style.color = autoTextOnBackground(contrastBgHex);
  } else {
    el.style.color = '';
  }
}

function applyLabelStyle(el, colorId, kind) {
  const mlc = readMeterLabelColors();
  const hasLabelOverride =
    mlc.labelColorModeCustom &&
    kind &&
    mlc.labelColors &&
    Object.prototype.hasOwnProperty.call(mlc.labelColors, kind) &&
    typeof mlc.labelColors[kind] === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(mlc.labelColors[kind]);
  if (hasLabelOverride) {
    const bg = mlc.labelColors[kind];
    el.style.backgroundColor = bg;
    el.classList.remove('meter-label--default');
    applyLabelForegroundColor(el, bg, kind);
    return;
  }
  el.style.backgroundColor = '';
  el.classList.remove('meter-label--default');
  if (colorId >= 1 && colorId <= 18) {
    const bg = SCRIBBLE_COLORS[colorId - 1];
    el.style.backgroundColor = bg;
    applyLabelForegroundColor(el, bg, kind);
  } else {
    el.classList.add('meter-label--default');
    applyLabelForegroundColor(el, '#455a64', kind);
  }
}

function createMeterElement(channelNum, label, colorId, kind, stereo, isVertical, parentEl, entry) {
  const mount = parentEl || container;
  const wrapper = document.createElement('div');
  wrapper.className = 'meter-wrapper';

  const fills = [];
  const bar1 = createMeterBar();
  fills.push(bar1.fill);

  if (stereo) {
    const bar2 = createMeterBar();
    bar2.bg.classList.add('meter-bg--stereo-r');
    fills.push(bar2.fill);
    const barsContainer = document.createElement('div');
    barsContainer.className = 'meter-bars';
    barsContainer.appendChild(bar1.bg);
    barsContainer.appendChild(bar2.bg);
    wrapper.appendChild(barsContainer);
  } else {
    wrapper.appendChild(bar1.bg);
  }

  const labelDiv = document.createElement('div');
  labelDiv.className = 'meter-label';
  labelDiv.textContent = label.length > 11 ? label.slice(0, 11) : label;
  applyLabelStyle(labelDiv, colorId, kind);

  const channelNumDiv = document.createElement('div');
  channelNumDiv.className = 'meter-channel-num';
  channelNumDiv.textContent = String(channelNum);
  channelNumDiv.title = label;
  applyLabelStyle(channelNumDiv, colorId, kind);

  if (isVertical) {
    // For vertical layout: keep bars on top, show channel number below.
    if (wrapper.firstChild) {
      wrapper.insertBefore(channelNumDiv, wrapper.firstChild.nextSibling);
    } else {
      wrapper.appendChild(channelNumDiv);
    }
    // Name label is hidden via CSS in vertical view but we keep DOM structure consistent.
    wrapper.appendChild(labelDiv);
  } else {
    wrapper.insertBefore(channelNumDiv, wrapper.firstChild);
    wrapper.insertBefore(labelDiv, channelNumDiv.nextSibling);
    const layout = readDisplayLayout();
    if (!layout.showNumberLabel) channelNumDiv.classList.add('meter-label--hidden');
    if (!layout.showNameLabel) labelDiv.classList.add('meter-label--hidden');
  }

  mount.appendChild(wrapper);
  meterFills.push(fills);
  const last = new Array(fills.length);
  for (let b = 0; b < fills.length; b++) last[b] = -1;
  meterLastClipPct.push(last);
  meterInfos.push({ entry: entry || null, wrapper, labelDiv, channelNumDiv });
}

function updateMeters(values) {
  if (!Array.isArray(values)) return;

  // WING Remote Protocols: meter levels are signed int16 in 1/256 dB. The bar
  // is a *level* meter: bottom = noise floor (-60 dB), top = 0 dBFS (not +10 dB
  // fader gain). Positive values still map to full scale (clip/over).
  const MIN_DB = -60;
  const MAX_DB = 0;
  // Page orientation only changes via reload, so cache once per frame.
  const isVert = isVerticalPage();
  let vi = 0;

  for (let i = 0; i < meterFills.length; i++) {
    const fills = meterFills[i];
    if (!fills) continue;
    const lastTrack = meterLastClipPct[i];

    for (let b = 0; b < fills.length; b++) {
      const fill = fills[b];
      if (!fill) continue;

      const rawVal = values[vi++] || 0;
      const dbVal = rawVal / 256.0;
      const normalized = (dbVal - MIN_DB) / (MAX_DB - MIN_DB);
      const percent = Math.max(0, Math.min(1, normalized));

      // Quantize to 0.5% (200 buckets across 0..100). On a 110px bar that's
      // ~0.55px, well below the 3px segment pitch, so the snap is invisible
      // — but it lets us skip identical-frame style writes when several
      // meters sit at the same level (e.g. silent channels).
      const q = Math.round(percent * 200);
      if (lastTrack && lastTrack[b] === q) continue;
      if (lastTrack) lastTrack[b] = q;

      const remainPct = (200 - q) * 0.5;
      // Horizontal: reveal from the left → animate the right inset.
      // Vertical: reveal from the bottom → animate the top inset.
      fill.style.clipPath = isVert
        ? `inset(${remainPct}% 0 0 0)`
        : `inset(0 ${remainPct}% 0 0)`;
    }
  }
}

socket.on('config', (config) => {
  createMeters(config);
});

let latestValues = null;
let rafPending = false;

socket.on('meters', (values) => {
  latestValues = values;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (latestValues) updateMeters(latestValues);
    });
  }
});

socket.on('low-resource', (payload) => {
  const on = !!(payload && payload.lowResourceMode);
  document.body.classList.toggle('low-resource', on);
});

// Hidden: click background (body or empty container area) to go back to settings
document.body.addEventListener('click', (e) => {
  if (!document.body.classList.contains('page-horizontal') && !document.body.classList.contains('page-vertical')) return;
  if (e.target === document.body || e.target === container) {
    window.location.href = '/';
  }
});
