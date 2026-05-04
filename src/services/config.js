/**
 * Consolidated configuration module.
 *
 * All persisted settings for the app live in a single JSON file
 * (`app-config.json`) managed by the internal store at the top of this file.
 * Feature namespaces (connection, refreshInterval, lowResource, displayLayout,
 * meterLabelColors, meterTextColors, meters) are plain objects exported from
 * the bottom. Consumers do:
 *
 *   const { refreshInterval, displayLayout } = require('../services/config');
 *
 * Public API per namespace is stable and identical to the pre-consolidation
 * modules; only the `require` path and the import destructuring changed.
 */

const path = require('path');
const fs = require('fs');

// ============================================================================
// SCHEMA & CONSTANTS
// ============================================================================

const VERSION = 1;

/**
 * Directory that holds `app-config.json`. Defaults to `<cwd>/data`, which
 * works out-of-the-box both locally (`data/` at the project root) and inside
 * Docker (WORKDIR `/app` → `/app/data`, mounted as a volume in compose).
 * Override with the `CONFIG_DIR` env var if you need a different location.
 */
const configDir = process.env.CONFIG_DIR
  ? path.resolve(process.env.CONFIG_DIR)
  : path.join(process.cwd(), 'data');
const filePath = path.join(configDir, 'app-config.json');
const tmpPath = filePath + '.tmp';

const COLOR_KINDS = ['channel', 'aux', 'bus', 'main', 'matrix', 'dca'];

const KIND_MAX_INDEX = { channel: 39, aux: 7, bus: 15, main: 3, matrix: 7, dca: 15 };

const ONE_BASED_KINDS = new Set(['channel', 'main', 'bus', 'matrix', 'aux', 'dca']);

/**
 * Kinds that carry pre-fader (input) and post-fader (output) taps in the same
 * meter-request block. The Wing V1 meter stream already contains both taps per
 * channel/aux/bus/main/matrix/dca strip, so switching PRE/POST is just a matter
 * of reading different offsets in `extractMeterValues` — we do NOT need to
 * subscribe to a separate meter kind.
 */
const TAP_AWARE_KINDS = new Set(['channel', 'aux', 'bus', 'main', 'matrix', 'dca']);

const REFRESH = { MIN_MS: 1000, MAX_MS: 300000, STEP_MS: 100, DEFAULT_MS: 10000 };

/**
 * Low Resource Mode (LRM). When enabled:
 *   - Meter emit rate is capped at ~10 Hz instead of Wing's native rate.
 *   - Refresh-interval floor is raised to 30 s (longer user values still win).
 *   - Meter-segment CSS transitions are disabled on client meter pages.
 */
const LRM = {
  DEFAULT: false,
  METER_THROTTLE_MS: 100,          // ~10 Hz
  REFRESH_INTERVAL_FLOOR_MS: 30000, // 30 s
};

const LAYOUT_LIMITS = {
  MIN_ROWS: 1,
  /** Matches maximum meters selectable in the app (all channel/bus/etc. slots). */
  MAX_ROWS: 92,
  MIN_METERS_PER_ROW: 1,
  MAX_METERS_PER_ROW: 92,
};

const DEFAULTS = {
  version: VERSION,
  connection: { fixedWingIp: null },
  refreshIntervalMs: REFRESH.DEFAULT_MS,
  lowResourceMode: LRM.DEFAULT,
  displayLayout: {
    showNumberLabel: true,
    showNameLabel: true,
    verticalRowMode: false,
    verticalRowCount: 2,
    verticalMetersPerRow: 12,
  },
  meterLabelColors: { labelColorModeCustom: false, labelColors: {} },
  meterTextColors: { textColorModeCustom: false, textColors: {} },
  meters: [],
};

// ============================================================================
// SHARED NORMALIZERS
// ============================================================================

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === true  || value === 'true'  || value === 1) return true;
  if (value === false || value === 'false' || value === 0) return false;
  return fallback;
}

function toHex6(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.slice(1).toLowerCase()}`;
}

function toClampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function deepClone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

// ============================================================================
// PERSISTENT STORE (atomic tmp+rename writes, in-memory cache)
// ============================================================================

let state = null;

function readBundleFile() {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function writeBundleFile(obj) {
  const json = JSON.stringify(obj, null, 2);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function load() {
  const existing = readBundleFile();
  if (existing) {
    // Fill any missing top-level keys from defaults so downstream code can
    // always rely on the shape — without clobbering user values.
    state = Object.assign(deepClone(DEFAULTS), existing);
    state.version = VERSION;
    return;
  }
  state = deepClone(DEFAULTS);
  writeBundleFile(state);
  console.log('config: consolidated config initialised at app-config.json.');
}

function ensureLoaded() {
  if (state === null) load();
}

function storeGet(key) {
  ensureLoaded();
  return deepClone(state[key]);
}

function storeSet(key, value) {
  ensureLoaded();
  state[key] = deepClone(value);
  writeBundleFile(state);
}

load();

// ============================================================================
// CONNECTION
// ============================================================================

/**
 * @returns {{ fixedWingIp: string|null }}
 *   null  → use automatic discovery (and WING_IP when set)
 *   ''    → manual mode, no address: stay disconnected (WING_IP and discovery ignored)
 *   'x.x.x.x' → connect to this IP
 */
function readConnection() {
  const data = storeGet('connection');
  if (!data || typeof data !== 'object') return { fixedWingIp: null };
  if (!Object.prototype.hasOwnProperty.call(data, 'fixedWingIp') || data.fixedWingIp === null) {
    return { fixedWingIp: null };
  }
  if (typeof data.fixedWingIp === 'string') {
    const t = data.fixedWingIp.trim();
    return { fixedWingIp: t || '' };
  }
  return { fixedWingIp: null };
}

const connection = {
  getFixedWingIp() {
    return readConnection().fixedWingIp;
  },

  /**
   * @param {string|null} ip null = automatic discovery; '' = manual offline; else IPv4 string
   */
  setFixedWingIp(ip) {
    if (ip === null) {
      storeSet('connection', { fixedWingIp: null });
      return;
    }
    if (ip === '' || (typeof ip === 'string' && ip.trim() === '')) {
      storeSet('connection', { fixedWingIp: '' });
      return;
    }
    storeSet('connection', { fixedWingIp: String(ip).trim() });
  },

  /**
   * @returns {string|undefined|false} string = host; undefined = discovery; false = do not connect
   */
  getConnectTarget() {
    const { fixedWingIp } = readConnection();
    if (fixedWingIp === '') return false;
    if (fixedWingIp) return fixedWingIp;
    const env = (process.env.WING_IP || '').trim();
    return env || undefined;
  },

  getEffectiveMode() {
    const { fixedWingIp } = readConnection();
    if (fixedWingIp === '') return 'manual-offline';
    if (fixedWingIp) return 'saved';
    if ((process.env.WING_IP || '').trim()) return 'environment';
    return 'discovery';
  },

  /** Human-readable summary of how the server chooses the Wing address. */
  getConnectionSummary() {
    const { fixedWingIp } = readConnection();
    const env = (process.env.WING_IP || '').trim() || null;
    if (fixedWingIp) {
      return {
        source: 'saved',
        sourceTitle: 'Saved in Settings',
        sourceDetail: 'This IP is stored in app-config.json on the server. It overrides WING_IP.',
        configuredAddress: fixedWingIp,
      };
    }
    if (fixedWingIp === '') {
      return {
        source: 'manual-offline',
        sourceTitle: 'Manual (no address)',
        sourceDetail:
          'Automatic discovery is off and no IP is saved. The server stays disconnected until you apply an address or turn discovery back on.',
        configuredAddress: null,
      };
    }
    if (env) {
      return {
        source: 'environment',
        sourceTitle: 'Environment (WING_IP)',
        sourceDetail: 'Taken from the WING_IP variable (.env, Docker, systemd, etc.).',
        configuredAddress: env,
      };
    }
    return {
      source: 'discovery',
      sourceTitle: 'Automatic discovery',
      sourceDetail: 'The server scans the LAN for a Wing; the first console that responds is used.',
      configuredAddress: null,
    };
  },
};

// ============================================================================
// REFRESH INTERVAL
// ============================================================================

function roundToRefreshStep(n) {
  return Math.round(n / REFRESH.STEP_MS) * REFRESH.STEP_MS;
}

function normalizeRefreshMs(ms) {
  const n = Math.round(Number(ms));
  if (!Number.isFinite(n)) return roundToRefreshStep(REFRESH.DEFAULT_MS);
  const clamped = Math.min(REFRESH.MAX_MS, Math.max(REFRESH.MIN_MS, n));
  return roundToRefreshStep(clamped);
}

const refreshInterval = {
  MIN_MS: REFRESH.MIN_MS,
  MAX_MS: REFRESH.MAX_MS,
  STEP_MS: REFRESH.STEP_MS,

  /** True if value is an allowed integer ms (1000–300000, step 100). */
  isAllowedMs(ms) {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n) || n < REFRESH.MIN_MS || n > REFRESH.MAX_MS) return false;
    return n % REFRESH.STEP_MS === 0;
  },

  getRefreshIntervalMs() {
    const raw = storeGet('refreshIntervalMs');
    return normalizeRefreshMs(typeof raw === 'number' ? raw : REFRESH.DEFAULT_MS);
  },

  setRefreshIntervalMs(ms) {
    const v = normalizeRefreshMs(ms);
    storeSet('refreshIntervalMs', v);
    return v;
  },
};

// ============================================================================
// LOW RESOURCE MODE
// ============================================================================

const lowResource = {
  LRM_METER_THROTTLE_MS: LRM.METER_THROTTLE_MS,
  LRM_REFRESH_INTERVAL_FLOOR_MS: LRM.REFRESH_INTERVAL_FLOOR_MS,

  getLowResourceMode() {
    const raw = storeGet('lowResourceMode');
    if (typeof raw === 'undefined') return LRM.DEFAULT;
    return toBool(raw, LRM.DEFAULT);
  },

  setLowResourceMode(value) {
    const v = toBool(value, LRM.DEFAULT);
    storeSet('lowResourceMode', v);
    return v;
  },
};

// ============================================================================
// DISPLAY LAYOUT
// ============================================================================

function readLayout() {
  const data = storeGet('displayLayout');
  if (!data || typeof data !== 'object') return { ...DEFAULTS.displayLayout };
  return {
    showNumberLabel: toBool(data.showNumberLabel, DEFAULTS.displayLayout.showNumberLabel),
    showNameLabel: toBool(data.showNameLabel, DEFAULTS.displayLayout.showNameLabel),
    verticalRowMode: toBool(data.verticalRowMode, DEFAULTS.displayLayout.verticalRowMode),
    verticalRowCount: toClampInt(
      data.verticalRowCount,
      LAYOUT_LIMITS.MIN_ROWS,
      LAYOUT_LIMITS.MAX_ROWS,
      DEFAULTS.displayLayout.verticalRowCount,
    ),
    verticalMetersPerRow: toClampInt(
      data.verticalMetersPerRow,
      LAYOUT_LIMITS.MIN_METERS_PER_ROW,
      LAYOUT_LIMITS.MAX_METERS_PER_ROW,
      DEFAULTS.displayLayout.verticalMetersPerRow,
    ),
  };
}

const displayLayout = {
  getDisplayLayout() {
    return readLayout();
  },

  /**
   * @param {Partial<{
   *   showNumberLabel: boolean,
   *   showNameLabel: boolean,
   *   verticalRowMode: boolean,
   *   verticalRowCount: number,
   *   verticalMetersPerRow: number,
   * }>} patch
   */
  setDisplayLayout(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new Error('Invalid display layout payload');
    }
    const cur = readLayout();
    const next = {
      showNumberLabel: Object.prototype.hasOwnProperty.call(patch, 'showNumberLabel')
        ? toBool(patch.showNumberLabel, cur.showNumberLabel)
        : cur.showNumberLabel,
      showNameLabel: Object.prototype.hasOwnProperty.call(patch, 'showNameLabel')
        ? toBool(patch.showNameLabel, cur.showNameLabel)
        : cur.showNameLabel,
      verticalRowMode: Object.prototype.hasOwnProperty.call(patch, 'verticalRowMode')
        ? toBool(patch.verticalRowMode, cur.verticalRowMode)
        : cur.verticalRowMode,
      verticalRowCount: Object.prototype.hasOwnProperty.call(patch, 'verticalRowCount')
        ? toClampInt(patch.verticalRowCount, LAYOUT_LIMITS.MIN_ROWS, LAYOUT_LIMITS.MAX_ROWS, cur.verticalRowCount)
        : cur.verticalRowCount,
      verticalMetersPerRow: Object.prototype.hasOwnProperty.call(patch, 'verticalMetersPerRow')
        ? toClampInt(patch.verticalMetersPerRow, LAYOUT_LIMITS.MIN_METERS_PER_ROW, LAYOUT_LIMITS.MAX_METERS_PER_ROW, cur.verticalMetersPerRow)
        : cur.verticalMetersPerRow,
    };

    storeSet('displayLayout', next);
    return next;
  },
};

// ============================================================================
// METER-KIND COLORS (label + text share the same shape)
// ============================================================================

/**
 * Factory that generates identical read/write handlers for label-colors and
 * text-colors — they differ only in field names and store key.
 */
function makeKindColors({ storeKey, modeField, mapField }) {
  function read() {
    const data = storeGet(storeKey);
    if (!data || typeof data !== 'object') {
      return { [modeField]: false, [mapField]: {} };
    }
    const modeCustom = toBool(data[modeField], false);
    const colors = {};
    if (data[mapField] && typeof data[mapField] === 'object') {
      for (const k of COLOR_KINDS) {
        if (!Object.prototype.hasOwnProperty.call(data[mapField], k)) continue;
        const raw = data[mapField][k];
        if (raw === null || raw === undefined) continue;
        const h = toHex6(String(raw));
        if (h) colors[k] = h;
      }
    }
    return { [modeField]: modeCustom, [mapField]: colors };
  }

  function write(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new Error(`Invalid ${storeKey} payload`);
    }
    const cur = read();
    const colors = { ...cur[mapField] };
    if (
      Object.prototype.hasOwnProperty.call(patch, mapField) &&
      patch[mapField] && typeof patch[mapField] === 'object'
    ) {
      for (const k of COLOR_KINDS) {
        if (!Object.prototype.hasOwnProperty.call(patch[mapField], k)) continue;
        const v = patch[mapField][k];
        if (v === null || v === undefined || v === '') {
          delete colors[k];
        } else {
          const h = toHex6(String(v));
          if (h) colors[k] = h;
        }
      }
    }
    const next = {
      [modeField]: Object.prototype.hasOwnProperty.call(patch, modeField)
        ? toBool(patch[modeField], cur[modeField])
        : cur[modeField],
      [mapField]: colors,
    };
    storeSet(storeKey, next);
    return next;
  }

  return { read, write };
}

const _label = makeKindColors({
  storeKey: 'meterLabelColors',
  modeField: 'labelColorModeCustom',
  mapField: 'labelColors',
});

const _text = makeKindColors({
  storeKey: 'meterTextColors',
  modeField: 'textColorModeCustom',
  mapField: 'textColors',
});

const meterLabelColors = {
  getMeterLabelColors: _label.read,
  setMeterLabelColors: _label.write,
};

const meterTextColors = {
  getMeterTextColors: _text.read,
  setMeterTextColors: _text.write,
};

// ============================================================================
// METERS (stateful: in-memory config + requests + generation + change hook)
// ============================================================================

let meterConfig = [];
let meterRequests = [];
let connectionGeneration = 0;
let onConfigChanged = null;

function validateMeterEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const max = KIND_MAX_INDEX[entry.kind];
  if (max === undefined) return false;
  if (typeof entry.index !== 'number' || entry.index < 0 || entry.index > max) return false;
  if (entry.postFader !== undefined && typeof entry.postFader !== 'boolean') return false;
  return true;
}

function sanitizeMeterEntry(entry) {
  const clean = { kind: entry.kind, index: entry.index };
  if (entry.postFader === true && TAP_AWARE_KINDS.has(entry.kind)) {
    clean.postFader = true;
  }
  return clean;
}

function entryToRequest(entry) {
  return { kind: entry.kind, index: entry.index };
}

function loadMetersFromStore() {
  const raw = storeGet('meters');
  if (Array.isArray(raw)) {
    meterConfig = raw.filter(validateMeterEntry).map(sanitizeMeterEntry);
  } else {
    console.error('config: stored meters is not an array, using fallback.');
    meterConfig = [{ kind: 'main', index: 0 }];
  }
  meterRequests = meterConfig.map(entryToRequest);
}

loadMetersFromStore();

const meters = {
  KIND_MAX_INDEX,
  ONE_BASED_KINDS,

  validateEntry: validateMeterEntry,

  applyMeterConfig(newConfig) {
    const validated = newConfig.filter(validateMeterEntry).map(sanitizeMeterEntry);
    storeSet('meters', validated);
    meterConfig = validated;
    meterRequests = meterConfig.map(entryToRequest);
    connectionGeneration++;
    if (onConfigChanged) onConfigChanged();
  },

  setOnConfigChanged(fn) { onConfigChanged = fn; },

  getMeterConfig() { return meterConfig; },
  setMeterConfig(cfg) { meterConfig = cfg; },
  getRequests() { return meterRequests; },
  getConnectionGeneration() { return connectionGeneration; },

  /** Reconnect Wing without changing saved meter config (e.g. after WING IP change). */
  bumpConnectionGeneration() {
    connectionGeneration++;
    if (onConfigChanged) onConfigChanged();
  },
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  connection,
  refreshInterval,
  lowResource,
  displayLayout,
  meterLabelColors,
  meterTextColors,
  meters,
};
