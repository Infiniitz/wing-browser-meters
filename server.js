require('dotenv').config();
const { createServer } = require('http');
const { Server } = require('socket.io');
const app = require('./src/app');
const { setupSockets } = require('./src/sockets');
const wing = require('./src/services/wing');

const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

setupSockets(io);
wing.init(io);

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  wing.connectToWing();
});
