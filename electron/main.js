'use strict';

// Lanceur BlindYourFriends : démarre le serveur de la page et l'ouvre dans une fenêtre.
// L'hôte y fait tourner la partie ; les amis rejoignent depuis leur navigateur ou le lanceur.

const { app, BrowserWindow, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('../server');

// Pas de bouton "Activer le son" dans le lanceur : la lecture auto est autorisée.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

async function createWindow() {
  const { port } = await startServer(Number(process.env.PORT) || 3000);

  win = new BrowserWindow({
    width: 520,
    height: 900,
    minWidth: 360,
    minHeight: 560,
    title: 'BlindYourFriends',
    backgroundColor: '#12081f',
    autoHideMenuBar: true,
    webPreferences: {
      // L'hôte fait tourner les minuteurs de la partie : ils ne doivent pas ralentir
      // quand la fenêtre est réduite ou en arrière-plan.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Les liens externes s'ouvrent dans le navigateur, pas dans le lanceur.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://localhost:${port}/`)) event.preventDefault();
  });

  if (process.env.BYF_DEBUG) {
    win.webContents.on('console-message', (event) => console.log(`[page] ${event.message}`));
    win.webContents.on('did-finish-load', () => console.log('[byf] page chargée'));
  }

  await win.loadURL(`http://localhost:${port}/`);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Mises à jour depuis les releases GitHub : téléchargées en arrière-plan,
// installées à la fermeture du lanceur (jamais en pleine partie).
function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdatesAndNotify().catch((err) => console.warn('[update]', err.message));
}

app.whenReady().then(async () => {
  await createWindow();
  checkForUpdates();
  setInterval(checkForUpdates, 60 * 60 * 1000);
});
app.on('window-all-closed', () => app.quit());
