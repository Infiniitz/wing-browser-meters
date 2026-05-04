const { Router } = require('express');
const { Wing } = require('behringer-wing');
const {
  meters,
  connection: wingConnection,
  refreshInterval,
  displayLayout,
  meterLabelColors,
  meterTextColors,
  lowResource,
} = require('../services/config');
const wing = require('../services/wing');

function isValidIpv4(s) {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(String(s).trim());
}

const router = Router();

router.get('/meters-config', (req, res) => {
  try {
    const config = meters.getMeterConfig();
    res.json(Array.isArray(config) ? config : []);
  } catch (err) {
    console.error('GET /api/meters-config:', err);
    res.status(500).json([]);
  }
});

router.post('/meters-config', (req, res) => {
  const config = req.body && req.body.config;
  if (!Array.isArray(config)) {
    return res.status(400).json({ error: 'Missing or invalid config array' });
  }
  for (const entry of config) {
    if (!meters.validateEntry(entry)) {
      return res.status(400).json({ error: `Invalid entry: kind=${entry.kind}, index=${entry.index}` });
    }
  }
  try {
    meters.applyMeterConfig(config);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/meters-config:', err);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

router.get('/channel-colors', (req, res) => {
  res.json(wing.getAllColors());
});

router.get('/channel-names', (req, res) => {
  res.json(wing.getAllNames());
});

router.get('/wing-connection', (req, res) => {
  res.json(wing.getConnectionStatusPayload());
});

router.post('/wing-connection', (req, res) => {
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'fixedWingIp')) {
    return res.status(400).json({
      error: 'Missing fixedWingIp: use null for discovery, "" for manual offline, or an IPv4 string',
    });
  }
  const raw = req.body.fixedWingIp;
  if (raw === null) {
    wingConnection.setFixedWingIp(null);
  } else if (typeof raw === 'string' && raw.trim() === '') {
    wingConnection.setFixedWingIp('');
  } else if (typeof raw === 'string') {
    const ip = raw.trim();
    if (!isValidIpv4(ip)) return res.status(400).json({ error: 'Invalid IPv4 address' });
    wingConnection.setFixedWingIp(ip);
  } else {
    return res.status(400).json({ error: 'fixedWingIp must be null, a string (IPv4 or empty), or omitted' });
  }
  meters.bumpConnectionGeneration();
  wing.emitConnectionStatus();
  res.json({
    ok: true,
    fixedWingIp: wingConnection.getFixedWingIp(),
    effectiveMode: wingConnection.getEffectiveMode(),
  });
});

router.get('/refresh-interval', (req, res) => {
  try {
    res.json({ refreshIntervalMs: refreshInterval.getRefreshIntervalMs() });
  } catch (err) {
    console.error('GET /api/refresh-interval:', err);
    res.status(500).json({ error: 'Failed to read refresh interval' });
  }
});

router.post('/refresh-interval', (req, res) => {
  const raw = req.body && req.body.refreshIntervalMs;
  if (raw === undefined) {
    return res.status(400).json({ error: 'Missing refreshIntervalMs' });
  }
  if (!refreshInterval.isAllowedMs(raw)) {
    return res.status(400).json({
      error: `refreshIntervalMs must be ${refreshInterval.MIN_MS}–${refreshInterval.MAX_MS} in steps of ${refreshInterval.STEP_MS}`,
    });
  }
  // While Low Resource Mode is on the stored interval must be at or above the
  // LRM floor — enforce it server-side so a stale client or direct API call
  // can't slip below.
  const lrmFloor = lowResource.LRM_REFRESH_INTERVAL_FLOOR_MS;
  if (lowResource.getLowResourceMode() && Number(raw) < lrmFloor) {
    return res.status(409).json({
      error: `Low Resource Mode is on; refreshIntervalMs must be at least ${lrmFloor}`,
      refreshIntervalMs: refreshInterval.getRefreshIntervalMs(),
    });
  }
  try {
    const refreshIntervalMs = refreshInterval.setRefreshIntervalMs(raw);
    res.json({ ok: true, refreshIntervalMs });
  } catch (err) {
    console.error('POST /api/refresh-interval:', err);
    res.status(500).json({ error: 'Failed to save refresh interval' });
  }
});

router.get('/display-layout', (req, res) => {
  try {
    res.json(displayLayout.getDisplayLayout());
  } catch (err) {
    console.error('GET /api/display-layout:', err);
    res.status(500).json({ error: 'Failed to read display layout' });
  }
});

router.get('/meter-label-colors', (req, res) => {
  try {
    res.json(meterLabelColors.getMeterLabelColors());
  } catch (err) {
    console.error('GET /api/meter-label-colors:', err);
    res.status(500).json({ error: 'Failed to read meter label colors' });
  }
});

router.get('/meter-text-colors', (req, res) => {
  try {
    res.json(meterTextColors.getMeterTextColors());
  } catch (err) {
    console.error('GET /api/meter-text-colors:', err);
    res.status(500).json({ error: 'Failed to read meter text colors' });
  }
});

router.post('/meter-text-colors', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Expected JSON body' });
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'textColorModeCustom')) {
    patch.textColorModeCustom = body.textColorModeCustom;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'textColors') && body.textColors !== null) {
    if (typeof body.textColors !== 'object' || Array.isArray(body.textColors)) {
      return res.status(400).json({ error: 'textColors must be an object' });
    }
    patch.textColors = body.textColors;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error: 'No valid fields: textColorModeCustom, textColors',
    });
  }
  try {
    const next = meterTextColors.setMeterTextColors(patch);
    res.json({ ok: true, ...next });
  } catch (err) {
    console.error('POST /api/meter-text-colors:', err);
    res.status(500).json({ error: 'Failed to save meter text colors' });
  }
});

router.post('/meter-label-colors', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Expected JSON body' });
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'labelColorModeCustom')) {
    patch.labelColorModeCustom = body.labelColorModeCustom;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'labelColors') && body.labelColors !== null) {
    if (typeof body.labelColors !== 'object' || Array.isArray(body.labelColors)) {
      return res.status(400).json({ error: 'labelColors must be an object' });
    }
    patch.labelColors = body.labelColors;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error: 'No valid fields: labelColorModeCustom, labelColors',
    });
  }
  try {
    const next = meterLabelColors.setMeterLabelColors(patch);
    res.json({ ok: true, ...next });
  } catch (err) {
    console.error('POST /api/meter-label-colors:', err);
    res.status(500).json({ error: 'Failed to save meter label colors' });
  }
});

router.post('/display-layout', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Expected JSON body' });
  }
  const allowed = [
    'showNumberLabel',
    'showNameLabel',
    'verticalRowMode',
    'verticalRowCount',
    'verticalMetersPerRow',
  ];
  const patch = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error:
        'No valid fields: showNumberLabel, showNameLabel, verticalRowMode, verticalRowCount, verticalMetersPerRow',
    });
  }
  try {
    const next = displayLayout.setDisplayLayout(patch);
    res.json({ ok: true, ...next });
  } catch (err) {
    console.error('POST /api/display-layout:', err);
    res.status(500).json({ error: 'Failed to save display layout' });
  }
});

router.get('/low-resource', (req, res) => {
  try {
    res.json({ lowResourceMode: lowResource.getLowResourceMode() });
  } catch (err) {
    console.error('GET /api/low-resource:', err);
    res.status(500).json({ error: 'Failed to read low resource mode' });
  }
});

router.post('/low-resource', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.lowResourceMode !== 'boolean') {
    return res.status(400).json({ error: 'Expected { lowResourceMode: boolean }' });
  }
  try {
    const prev = lowResource.getLowResourceMode();
    const next = lowResource.setLowResourceMode(body.lowResourceMode);
    // Bump the refresh interval up to the LRM floor when turning LRM on.
    // Leave any higher user value alone.
    let refreshIntervalMs = refreshInterval.getRefreshIntervalMs();
    if (next && !prev && refreshIntervalMs < lowResource.LRM_REFRESH_INTERVAL_FLOOR_MS) {
      refreshIntervalMs = refreshInterval.setRefreshIntervalMs(
        lowResource.LRM_REFRESH_INTERVAL_FLOOR_MS
      );
    }
    if (prev !== next) wing.broadcastLowResourceMode();
    res.json({ ok: true, lowResourceMode: next, refreshIntervalMs });
  } catch (err) {
    console.error('POST /api/low-resource:', err);
    res.status(500).json({ error: 'Failed to save low resource mode' });
  }
});

router.get('/wing-scan', async (req, res) => {
  try {
    const devices = await Wing.scan(false);
    res.json({ devices });
  } catch (err) {
    console.error('GET /api/wing-scan:', err);
    res.status(500).json({ error: err.message || 'Scan failed' });
  }
});

module.exports = router;
