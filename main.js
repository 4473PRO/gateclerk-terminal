const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// ── SINGLE INSTANCE LOCK ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow = null;

// ── AUTO UPDATER CONFIG ──
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', () => {
  console.log('Update available — downloading...');
});

autoUpdater.on('update-downloaded', () => {
  // Silently install on next quit
  console.log('Update downloaded — will install on next restart.');
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err);
});

// ── CREATE WINDOW ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    fullscreen: false,
    title: 'GateClerk',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false // Don't show until ready
  });

  // Load the gate login screen
  mainWindow.loadURL('https://gateclerk.com/g/');

  // Show window when ready to avoid white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Handle external links — open in default browser, not in the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  // Prevent navigation away from gateclerk.com
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('https://gateclerk.com');
    if (!allowed) {
      event.preventDefault();
      console.log('Blocked navigation to:', url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── PRINT HANDLER ──
// Called from renderer via ipcRenderer.invoke('print-ticket', ticketHtml)
ipcMain.handle('print-ticket', async (event, ticketHtml) => {
  return new Promise((resolve) => {
    // Create a hidden browser window to render and print the ticket
    const printWin = new BrowserWindow({
      width: 400,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<style>
  @page { size: 80mm auto; margin: 2mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: monospace; font-size: 12px; font-weight: bold; line-height: 1.45; color: #000; background: #fff; }
  pre { margin: 0; padding: 0; white-space: pre-wrap; word-break: break-word; }
  img { display: block; max-width: 100%; }
</style>
</head>
<body>${ticketHtml}</body>
</html>`;

    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));

    printWin.webContents.once('did-finish-load', () => {
      printWin.webContents.print(
        {
          silent: true,           // No print dialog
          printBackground: false,
          deviceName: '',         // Use default printer
          margins: {
            marginType: 'custom',
            top: 0,
            bottom: 0,
            left: 2,
            right: 2
          },
          pageSize: {
            width: 80000,         // 80mm in microns
            height: 0             // 0 = auto height based on content
          }
        },
        (success, errorType) => {
          printWin.destroy();
          if (success) {
            resolve({ success: true });
          } else {
            console.error('Print error:', errorType);
            resolve({ success: false, error: errorType });
          }
        }
      );
    });
  });
});

// ── GET PRINTERS ──
ipcMain.handle('get-printers', async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map(p => ({ name: p.name, isDefault: p.isDefault }));
});

// ── APP READY ──
app.whenReady().then(() => {
  createWindow();

  // Check for updates after a short delay (don't block startup)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.log('Update check skipped:', err.message);
    });
  }, 5000);
});

// ── SECOND INSTANCE ──
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── QUIT ──
app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
