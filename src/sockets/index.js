const { meters, lowResource, refreshInterval } = require('../services/config');
const wing = require('../services/wing');

function setupSockets(io) {
  io.on('connection', (socket) => {
    // Clients advertise their page via the socket.io handshake query (see
    // public/js/settings.js). Meter-view pages omit it. We only need to
    // distinguish settings vs non-settings so the wing service can decide
    // whether to run a full or scoped info-fetch cycle.
    const page = (socket.handshake && socket.handshake.query && socket.handshake.query.page) || '';
    const isSettingsClient = page === 'settings';
    console.log(`Client connected: ${socket.id}${isSettingsClient ? ' (settings)' : ''}`);

    if (isSettingsClient) wing.noteSettingsClientConnected();
    // Wake the info-fetch loop whenever anyone connects so an idle server
    // doesn't leave the first client staring at stale data.
    wing.noteAnyClientConnected();

    socket.emit('config', meters.getMeterConfig());
    socket.emit('wing-connection-status', wing.getConnectionStatusPayload());
    socket.emit('channel-info', { colors: wing.getAllColors(), names: wing.getAllNames() });
    socket.emit('low-resource', {
      lowResourceMode: lowResource.getLowResourceMode(),
      refreshIntervalMs: refreshInterval.getRefreshIntervalMs(),
    });
    // Replay the last-sent meter frame so freshly-connected clients see
    // current bar levels immediately — the meter loop now skips emits when
    // the quantized bar state hasn't changed, so we can't rely on the next
    // frame to paint the bars for a new client.
    const lastMeters = wing.getLastMeterValues();
    if (lastMeters) socket.emit('meters', lastMeters);

    socket.on('disconnect', () => {
      if (isSettingsClient) wing.noteSettingsClientDisconnected();
      console.log('Client disconnected:', socket.id);
    });
  });
}

module.exports = { setupSockets };
