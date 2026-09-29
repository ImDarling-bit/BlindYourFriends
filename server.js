'use strict';

// Sert la page du jeu. La partie elle-même tourne en pair-à-pair chez l'hôte :
// ce serveur ne fait que distribuer les fichiers (au PC local et aux amis du même Wi-Fi).

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

// Adresse IPv4 du PC sur le réseau local, en préférant les plages des box (192.168.x, puis 10.x).
function lanAddress() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) found.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b))[0] || null;
}

function createApp(getPort) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/api/lan', (_req, res) => {
    const ip = lanAddress();
    res.json({ url: ip ? `http://${ip}:${getPort()}/` : null });
  });
  return app;
}

// Démarre le serveur ; si le port est pris, en prend un autre libre.
function startServer(port = 3000) {
  return new Promise((resolve, reject) => {
    let actualPort = port;
    const server = http.createServer(createApp(() => actualPort));
    const listen = (p) => server.listen(p, '0.0.0.0');
    server.on('listening', () => {
      actualPort = server.address().port;
      resolve({ server, port: actualPort, lanAddress: lanAddress() });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && actualPort !== 0) {
        actualPort = 0;
        listen(0);
      } else {
        reject(err);
      }
    });
    listen(port);
  });
}

module.exports = { startServer, lanAddress };

if (require.main === module) {
  startServer(Number(process.env.PORT) || 3000).then(({ port, lanAddress: ip }) => {
    console.log(`BlindYourFriends -> http://localhost:${port}`);
    if (ip) console.log(`Sur le même Wi-Fi  -> http://${ip}:${port}`);
  });
}
