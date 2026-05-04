const { Wing } = require('behringer-wing');
const {
  meters,
  connection: wingConnection,
  refreshInterval: refreshIntervalConfig,
  lowResource: lowResourceConfig,
} = require('./config');

const KIND_OSC_PREFIX = {
  channel: 'ch', aux: 'aux', bus: 'bus',
  main: 'main', matrix: 'mtx', dca: 'dca'
};

let io = null;
let allColors = {};
let allNames = {};
/** @type {string|null} */
let lastConnectedIp = null;

// Serialized snapshots of the last payloads we broadcast. Used to skip
// redundant `config` / `channel-info` emits on every info-fetch cycle, so
// clients don't rebuild their DOM when nothing actually changed on the
// console.
let lastEmittedConfigJson = null;
let lastEmittedChannelInfoJson = null;

// --- Adaptive info-fetch scope ---
// Normal mode: full fetch (names/colors for every console strip).
// Scoped mode: only fetch names/colors for strips currently in the meter
//   config. The whole-console cache from the last full fetch is preserved and
//   just overlaid with the scoped updates, so settings pages that open later
//   still see the last-known names/colors of strips we're not actively
//   refreshing. When a settings client connects we flip back to full mode and
//   the sleep is interrupted so the refresh is near-instant.
let settingsClientCount = 0;
// Force the next info-fetch cycle to be full, regardless of client counts.
// Set to true on (re)connect (so we always have a complete cache), and when
// a settings client connects during scoped mode.
let pendingFullFetch = true;
// Resolver for the current info-fetch-loop sleep, so we can wake it early.
let infoSleepAbort = null;

function noteSettingsClientConnected() {
  settingsClientCount++;
  if (settingsClientCount === 1) {
    pendingFullFetch = true;
    if (infoSleepAbort) infoSleepAbort();
  }
}

function noteSettingsClientDisconnected() {
  if (settingsClientCount > 0) settingsClientCount--;
}

function infoSleep(ms) {
  // Short-circuit only when a full refresh is pending AND there's a client
  // waiting for it. Without the clientsCount guard, `pendingFullFetch` (set
  // true on every connect) combined with the universal-A "skip body when 0
  // clients" branch would hot-loop at CPU speed until the first connection.
  if (pendingFullFetch && io && io.engine.clientsCount > 0) return Promise.resolve();
  return new Promise(resolve => {
    const t = setTimeout(() => { infoSleepAbort = null; resolve(); }, ms);
    infoSleepAbort = () => { clearTimeout(t); infoSleepAbort = null; resolve(); };
  });
}

// Compute the sleep duration between info-fetch cycles, respecting the user's
// refresh interval but enforcing the LRM floor when LRM is on.
function getEffectiveRefreshIntervalMs() {
  const user = refreshIntervalConfig.getRefreshIntervalMs();
  if (lowResourceConfig.getLowResourceMode()) {
    return Math.max(user, lowResourceConfig.LRM_REFRESH_INTERVAL_FLOOR_MS);
  }
  return user;
}

// Woken by sockets/index.js when any client (meter view or settings) connects.
// In the idle-server case the info-fetch loop skips work while no clients are
// attached; this wakes it so a fresh client gets up-to-date names/colors
// within a cycle instead of waiting out the full refresh interval.
function noteAnyClientConnected() {
  if (infoSleepAbort) infoSleepAbort();
}

// --- Universal C: per-frame meter-value fingerprint diff ---
// Compare a quantized view of the new meter values against the last emit.
// When identical (e.g. silent channels, unchanged levels) we skip the emit
// entirely, which saves socket bandwidth and per-frame client work. Clients
// that connect while in this idle state still see the last frame because we
// replay `lastMeterValues` to each new socket in sockets/index.js.
/** Keep in sync with `updateMeters` in `public/js/script.js`. */
const METER_FP_MIN_DB = -60;
const METER_FP_MAX_DB = 0;
const METER_FP_SEGS = 37;
let lastMeterValues = null;
let lastMeterFingerprint = null;

function computeMeterFingerprint(values) {
  const fp = new Int8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const raw = values[i] || 0;
    const db = raw / 256;
    const n = (db - METER_FP_MIN_DB) / (METER_FP_MAX_DB - METER_FP_MIN_DB);
    const pct = n < 0 ? 0 : n > 1 ? 1 : n;
    fp[i] = Math.round(pct * METER_FP_SEGS);
  }
  return fp;
}

function fingerprintsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function getLastMeterValues() { return lastMeterValues; }

function broadcastLowResourceMode() {
  if (!io) return;
  io.emit('low-resource', {
    lowResourceMode: lowResourceConfig.getLowResourceMode(),
    refreshIntervalMs: refreshIntervalConfig.getRefreshIntervalMs(),
  });
}

/** Same shape as GET /api/wing-connection (for Socket.IO + HTTP). */
function getConnectionStatusPayload() {
  const summary = wingConnection.getConnectionSummary();
  const connected = lastConnectedIp != null;
  return {
    fixedWingIp: wingConnection.getFixedWingIp(),
    envWingIp: (process.env.WING_IP || '').trim() || null,
    effectiveMode: wingConnection.getEffectiveMode(),
    connectionSource: summary.source,
    connectionSourceTitle: summary.sourceTitle,
    connectionSourceDetail: summary.sourceDetail,
    configuredAddress: summary.configuredAddress,
    lastConnectedIp,
    displayAddress: summary.configuredAddress || lastConnectedIp || null,
    connected,
  };
}

function emitConnectionStatus() {
  if (io) io.emit('wing-connection-status', getConnectionStatusPayload());
}

function emitChannelInfo() {
  if (!io) return;
  const payload = { colors: allColors, names: allNames };
  const json = JSON.stringify(payload);
  if (json === lastEmittedChannelInfoJson) return;
  lastEmittedChannelInfoJson = json;
  io.emit('channel-info', payload);
}

function emitConfigIfChanged(config) {
  if (!io) return;
  const json = JSON.stringify(config);
  if (json === lastEmittedConfigJson) return;
  lastEmittedConfigJson = json;
  io.emit('config', config);
}

function init(socketIo) {
  io = socketIo;
  meters.setOnConfigChanged(() => scheduleReconnect(new Error('Config updated')));
}

function scheduleReconnect(reason) {
  console.error('Wing connection lost, scheduling reconnect in 5s.', reason || '');
  setTimeout(connectToWing, 5000);
}

async function fetchNamesFromMixer(wing) {
  const meterConfig = meters.getMeterConfig();
  const updatedConfig = [];
  for (const req of meterConfig) {
    const displayNum = meters.ONE_BASED_KINDS.has(req.kind) ? req.index + 1 : req.index;
    const defaultLabel = `${req.kind.toUpperCase()} ${displayNum}`;
    let name = req.label || defaultLabel;
    let color;
    let stereo = false;
    try {
      const nameIndex = meters.ONE_BASED_KINDS.has(req.kind) ? req.index + 1 : req.index;
      let oscPath = '';
      if (req.kind === 'channel') oscPath = `/ch/${nameIndex}/name`;
      else if (req.kind === 'main') oscPath = `/main/${nameIndex}/name`;
      else if (req.kind === 'bus') oscPath = `/bus/${nameIndex}/name`;
      else if (req.kind === 'matrix') oscPath = `/mtx/${nameIndex}/name`;
      else if (req.kind === 'aux') oscPath = `/aux/${nameIndex}/name`;
      else if (req.kind === 'dca') oscPath = `/dca/${nameIndex}/name`;

      if (oscPath) {
        const nodeId = Wing.nameToId(oscPath);
        if (nodeId !== undefined) {
          await wing.requestNodeData(nodeId);
          while (true) {
            const response = await wing.read();
            if (response.type === 'node-data' && response.id === nodeId) {
              const fetchedName = response.data.getString();
              const trimmed = fetchedName ? fetchedName.trim() : '';
              if (trimmed) {
                if (req.kind === 'main' && /^main\s+0$/i.test(trimmed)) {
                  name = defaultLabel;
                } else {
                  name = trimmed;
                }
              } else {
                name = defaultLabel;
              }
              break;
            }
          }
        }
      }

      let colPrefix = '';
      if (req.kind === 'channel') colPrefix = `/ch/${nameIndex}`;
      else if (req.kind === 'aux') colPrefix = `/aux/${nameIndex}`;
      else if (req.kind === 'bus') colPrefix = `/bus/${nameIndex}`;
      else if (req.kind === 'main') colPrefix = `/main/${nameIndex}`;
      else if (req.kind === 'matrix') colPrefix = `/mtx/${nameIndex}`;
      else if (req.kind === 'dca') colPrefix = `/dca/${nameIndex}`;

      if (colPrefix) {
        try {
          const colNodeId = Wing.nameToId(`${colPrefix}/col`);
          if (colNodeId !== undefined) {
            await wing.requestNodeData(colNodeId);
            while (true) {
              const response = await wing.read();
              if (response.type === 'node-data' && response.id === colNodeId) {
                color = response.data.getInt();
                break;
              }
            }
          }
        } catch (err) {
          console.error(`Failed to fetch color for ${req.kind} ${req.index}`, err);
        }
      }

      if (req.kind === 'channel' || req.kind === 'aux') {
        const modePath = req.kind === 'channel'
          ? `/ch/${nameIndex}/in/set/$mode`
          : `/aux/${nameIndex}/in/set/$mode`;
        try {
          const modeNodeId = Wing.nameToId(modePath);
          if (modeNodeId !== undefined) {
            await wing.requestNodeData(modeNodeId);
            while (true) {
              const response = await wing.read();
              if (response.type === 'node-data' && response.id === modeNodeId) {
                const mode = response.data.getString();
                stereo = (mode === 'ST' || mode === 'M/S');
                break;
              }
            }
          }
        } catch (err) {
          console.error(`Failed to fetch mode for ${req.kind} ${req.index}`, err);
        }
      } else if (req.kind === 'dca') {
        stereo = true;
      } else if (req.kind === 'bus' || req.kind === 'main' || req.kind === 'matrix') {
        stereo = true;
        const prefix = KIND_OSC_PREFIX[req.kind];
        const monoPath = `/${prefix}/${nameIndex}/busmono`;
        try {
          const monoNodeId = Wing.nameToId(monoPath);
          if (monoNodeId !== undefined) {
            await wing.requestNodeData(monoNodeId);
            while (true) {
              const response = await wing.read();
              if (response.type === 'node-data' && response.id === monoNodeId) {
                stereo = (response.data.getInt() !== 1);
                break;
              }
            }
          }
        } catch (err) {
          console.error(`Failed to fetch busmono for ${req.kind} ${req.index}`, err);
        }
      }
    } catch (err) {
      if (err && err.code === 'ERR_STREAM_DESTROYED') {
        throw err;
      }
      console.error(`Failed to fetch name for ${req.kind} ${req.index}`, err);
    }
    updatedConfig.push({ ...req, label: name, color, stereo });
  }
  return updatedConfig;
}

// Build the full list of {kind, index} pairs for every strip on the console.
function buildAllConsoleEntries() {
  const entries = [];
  for (const kind of Object.keys(KIND_OSC_PREFIX)) {
    const max = meters.KIND_MAX_INDEX[kind];
    if (max === undefined) continue;
    for (let i = 0; i <= max; i++) entries.push({ kind, index: i });
  }
  return entries;
}

// Dedup the currently configured meter entries down to unique {kind, index}
// pairs. Used for the scoped info-fetch path so we only query strips that are
// actually in use.
function buildConfiguredEntries() {
  const meterConfig = meters.getMeterConfig();
  const seen = new Set();
  const entries = [];
  for (const e of meterConfig) {
    if (!e || !KIND_OSC_PREFIX[e.kind]) continue;
    const key = `${e.kind}:${e.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: e.kind, index: e.index });
  }
  return entries;
}

async function fetchColorsForEntries(wing, entries) {
  const colors = {};
  for (const { kind, index } of entries) {
    const prefix = KIND_OSC_PREFIX[kind];
    if (!prefix) continue;
    const nameIndex = meters.ONE_BASED_KINDS.has(kind) ? index + 1 : index;
    try {
      const colNodeId = Wing.nameToId(`/${prefix}/${nameIndex}/col`);
      if (colNodeId !== undefined) {
        await wing.requestNodeData(colNodeId);
        while (true) {
          const response = await wing.read();
          if (response.type === 'node-data' && response.id === colNodeId) {
            colors[`${kind}:${index}`] = response.data.getInt();
            break;
          }
        }
      }
    } catch (err) {
      if (err && err.code === 'ERR_STREAM_DESTROYED') throw err;
    }
  }
  return colors;
}

async function fetchNamesForEntries(wing, entries) {
  const names = {};
  for (const { kind, index } of entries) {
    const prefix = KIND_OSC_PREFIX[kind];
    if (!prefix) continue;
    const nameIndex = meters.ONE_BASED_KINDS.has(kind) ? index + 1 : index;
    try {
      const nodeId = Wing.nameToId(`/${prefix}/${nameIndex}/name`);
      if (nodeId !== undefined) {
        await wing.requestNodeData(nodeId);
        while (true) {
          const response = await wing.read();
          if (response.type === 'node-data' && response.id === nodeId) {
            const fetched = response.data.getString();
            const trimmed = fetched ? fetched.trim() : '';
            if (trimmed) names[`${kind}:${index}`] = trimmed;
            break;
          }
        }
      }
    } catch (err) {
      if (err && err.code === 'ERR_STREAM_DESTROYED') throw err;
    }
  }
  return names;
}

async function fetchAllColors(wing) {
  return fetchColorsForEntries(wing, buildAllConsoleEntries());
}

async function fetchAllNames(wing) {
  return fetchNamesForEntries(wing, buildAllConsoleEntries());
}

function getAllColors() { return allColors; }
function getAllNames() { return allNames; }

async function connectToWing() {
  const startGeneration = meters.getConnectionGeneration();
  lastEmittedConfigJson = null;
  lastEmittedChannelInfoJson = null;
  lastMeterValues = null;
  lastMeterFingerprint = null;
  pendingFullFetch = true;
  try {
    const target = wingConnection.getConnectTarget();
    let wing;
    if (target === false) {
      lastConnectedIp = null;
      emitConnectionStatus();
      console.log('Wing connection disabled (manual mode, no address).');
      return;
    }
    if (typeof target === 'string') {
      console.log(`Connecting to Wing console at ${target}...`);
      wing = await Wing.connect(target);
      lastConnectedIp = target;
    } else {
      console.log('Scanning for Behringer Wing consoles...');
      wing = await Wing.connect();
      const ra = wing.socket && wing.socket.remoteAddress;
      lastConnectedIp = ra ? String(ra).replace(/^::ffff:/, '') : null;
    }
    console.log('Connected to Wing console!');
    emitConnectionStatus();

    const requests = meters.getRequests();
    const meterId = await wing.requestMeter(requests);
    console.log(`Subscribed to meters with meterId: ${meterId}`);

    /**
     * Wing V1 meter block layout per kind (offsets within the block, in 16-bit
     * signed values). Wing sends both pre- and post-fader taps in the same
     * block, so PRE uses offsets 0/1 and POST uses offsets 2/3.
     *   channel/aux/bus/main/matrix (stride 8):
     *     [inL, inR, outL, outR, gateKey, gateGain, dynKey, dynGain]
     *   dca (stride 4):
     *     [preL, preR, postL, postR]
     */
    const STRIDE_PER_KIND = {
      channel: 8, aux: 8, bus: 8, main: 8, matrix: 8,
      dca: 4,
    };

    function extractMeterValues(rawValues) {
      const meterConfig = meters.getMeterConfig();
      const extracted = [];
      let offset = 0;
      for (const entry of meterConfig) {
        const stride = STRIDE_PER_KIND[entry.kind] || 8;
        const tapOffset = entry.postFader === true ? 2 : 0;
        extracted.push(rawValues[offset + tapOffset] || 0);
        if (entry.stereo) {
          extracted.push(rawValues[offset + tapOffset + 1] || 0);
        }
        offset += stride;
      }
      return extracted;
    }

    let lastMeterEmitMs = 0;
    async function meterLoop() {
      try {
        while (true) {
          if (meters.getConnectionGeneration() !== startGeneration) throw new Error('Config updated');
          const data = await wing.readMeters();
          if (meters.getConnectionGeneration() !== startGeneration) throw new Error('Config updated');
          if (data.meterId !== meterId) continue;

          // LRM throttle: cap emit rate to ~10 Hz. We still read frames from
          // Wing as fast as it sends them (required to keep the stream alive)
          // but drop the in-between ones instead of forwarding.
          if (lowResourceConfig.getLowResourceMode()) {
            const now = Date.now();
            if (now - lastMeterEmitMs < lowResourceConfig.LRM_METER_THROTTLE_MS) continue;
            lastMeterEmitMs = now;
          }

          // Universal B: nothing to send if no one is listening.
          if (!io || io.engine.clientsCount === 0) continue;

          const values = extractMeterValues(data.values);

          // Universal C: skip emit if the quantized bar state is identical to
          // the last frame we sent. Clients that connect later get the cached
          // `lastMeterValues` via sockets/index.js so their bars still render.
          const fp = computeMeterFingerprint(values);
          if (fingerprintsEqual(fp, lastMeterFingerprint)) continue;
          lastMeterFingerprint = fp;
          lastMeterValues = values;
          io.emit('meters', values);
        }
      } catch (err) {
        console.error('Meter loop error, will reconnect:', err);
        throw err;
      }
    }

    let firstFetch = true;
    async function infoFetchLoop() {
      try {
        while (true) {
          if (meters.getConnectionGeneration() !== startGeneration) throw new Error('Config updated');

          // Universal A: no clients connected → skip fetch work entirely. The
          // sleep is woken by noteAnyClientConnected() the moment someone
          // arrives, so the first client sees a fresh cycle within 1-2 s.
          if (!io || io.engine.clientsCount === 0) {
            await infoSleep(getEffectiveRefreshIntervalMs());
            continue;
          }

          try {
            const updated = await fetchNamesFromMixer(wing);
            meters.setMeterConfig(updated);
            emitConfigIfChanged(updated);
            if (firstFetch) {
              console.log('Fetched names from mixer:', updated.map(m => m.label).join(', '));
            }

            // Decide whether this cycle is full (whole console) or scoped
            // (just the meters we're actually using). We do a full cycle when:
            //   - it's the first cycle after a (re)connect, so the cache is
            //     complete for any settings page that opens later; OR
            //   - a settings client is currently connected; OR
            //   - one just connected and asked for a fresh full refresh.
            const doFullCycle = pendingFullFetch || settingsClientCount > 0;
            if (doFullCycle) {
              allColors = await fetchAllColors(wing);
              allNames = await fetchAllNames(wing);
              pendingFullFetch = false;
            } else {
              const scope = buildConfiguredEntries();
              const scopedColors = await fetchColorsForEntries(wing, scope);
              const scopedNames = await fetchNamesForEntries(wing, scope);
              // Overlay onto the last full snapshot so unselected strips keep
              // their last-known name/color.
              Object.assign(allColors, scopedColors);
              Object.assign(allNames, scopedNames);
            }
            emitChannelInfo();
            if (firstFetch) {
              console.log(`Fetched info for ${Object.keys(allColors).length} channels`);
              firstFetch = false;
            }
          } catch (err) {
            if (err && err.code === 'ERR_STREAM_DESTROYED') throw err;
            console.error('Info fetch failed (will keep trying until meter loop fails):', err);
          }
          if (meters.getConnectionGeneration() !== startGeneration) throw new Error('Config updated');
          await infoSleep(getEffectiveRefreshIntervalMs());
        }
      } catch (err) {
        console.error('Info fetch loop error, will reconnect:', err);
        throw err;
      }
    }

    await Promise.all([meterLoop(), infoFetchLoop()]);
  } catch (error) {
    lastConnectedIp = null;
    emitConnectionStatus();
    if (wingConnection.getConnectTarget() === false) {
      console.error('Wing connection aborted (manual offline):', error);
      return;
    }
    console.error('Error in Wing connection, will reconnect:', error);
    scheduleReconnect(error);
  }
}

module.exports = {
  init,
  connectToWing,
  getAllColors,
  getAllNames,
  getConnectionStatusPayload,
  emitConnectionStatus,
  noteSettingsClientConnected,
  noteSettingsClientDisconnected,
  noteAnyClientConnected,
  getLastMeterValues,
  broadcastLowResourceMode,
};
