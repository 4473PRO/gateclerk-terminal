const { app, BrowserWindow, ipcMain, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Enable kiosk printing — same as Chrome --kiosk-printing flag
// This makes Electron use the printer's default paper size, identical to Chrome behavior
app.commandLine.appendSwitch('kiosk-printing');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); }

let mainWindow = null;
let isClosing = false;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function getSavedConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8').trim();
    const cfg = JSON.parse(raw);
    if (cfg.shortcode) return cfg;
    return null;
  } catch(e) {
    // Legacy: try old shortcode.txt
    try {
      const legacyPath = path.join(app.getPath('userData'), 'shortcode.txt');
      const sc = fs.readFileSync(legacyPath, 'utf8').trim();
      if (sc) return { shortcode: sc, type: 'gate' };
    } catch(e2) {}
    return null;
  }
}

function saveConfig(shortcode, type) {
  fs.writeFileSync(getConfigPath(), JSON.stringify({ shortcode: shortcode.trim(), type: type || 'gate' }), 'utf8');
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('error', (err) => { console.error('Auto-updater error:', err); });

// ── PRINT FUNCTION (reusable) ──
function printHtml(ticketHtml) {
  return new Promise((resolve) => {
    const printWin = new BrowserWindow({
      width: 400, height: 1200, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false }
    });

    const fullHtml = `<!DOCTYPE html><html><head><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body { padding: 2mm; font-family: monospace; font-size: 12px; font-weight: bold; line-height: 1.45; color: #000; background: #fff; }
      pre { margin: 0; padding: 0; white-space: pre-wrap; word-break: break-word; }
      img { display: block; max-width: 100%; margin: 0 auto; }
      div { text-align: center; }
    </style></head><body>${ticketHtml}</body></html>`;

    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));

    printWin.webContents.once('did-finish-load', () => {
      printWin.webContents.print(
        { silent: true, printBackground: false, deviceName: '',
          margins: { marginType: 'none' } },
        (success, errorType) => {
          printWin.destroy();
          resolve(success ? { success: true } : { success: false, error: errorType });
        }
      );
    });

    setTimeout(() => {
      if (!printWin.isDestroyed()) {
        printWin.destroy();
        resolve({ success: false, error: 'timeout' });
      }
    }, 10000);
  });
}

function centerText(text, width) {
  text = String(text).substring(0, width);
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function createWindow() {
  const config = getSavedConfig();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'GateClerk',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      sandbox: false
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false
  });

  if (config) {
    mainWindow.loadURL(`https://gateclerk.com/chooser/${config.shortcode}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isGateClerk = url.startsWith('https://gateclerk.com');
    const isLocal = url.startsWith('file://');
    if (!isGateClerk && !isLocal) {
      event.preventDefault();
    }
  });

  // ── INTERCEPT CLOSE — detect terminal type and print appropriate Z-tape ──
  mainWindow.on('close', async (e) => {
    if (isClosing) return;
    e.preventDefault();
    isClosing = true;

    const currentUrl = mainWindow.webContents.getURL();
    const isRegister = currentUrl.includes('/r/') || currentUrl.includes('/register/');
    const isGate = currentUrl.includes('/g/') || currentUrl.includes('/terminal/gate') || currentUrl.includes('gate.html');

    try {
      if (isRegister) {
        // ── REGISTER Z-TAPE ──
        const regData = await mainWindow.webContents.executeJavaScript(`
          (function() {
            try {
              const saved = JSON.parse(localStorage.getItem('gc_register_session') || 'null');
              if (!saved || !saved.regToken) return null;
              return {
                venueName: saved.venueName || 'GATECLERK',
                registerName: saved.registerName || 'REGISTER',
                sessionId: saved.sessionId,
                cashTotal: window._sessionCashTotal || 0,
                cardTotal: window._sessionCardTotal || 0,
                saleCount: window._sessionSaleCount || 0
              };
            } catch(e) { return null; }
          })()
        `);

        if (regData) {
          const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
          const sessionTotal = regData.cashTotal + regData.cardTotal;
          const zLines = [
            `================================`,
            centerText('*** Z TAPE ***', 32),
            centerText('END OF SESSION REPORT', 32),
            `================================`,
            centerText(regData.venueName, 32),
            centerText(regData.registerName, 32),
            `  ${now}`,
            `================================`,
            `  TOTAL SALES:       ${regData.saleCount}`,
            `  CASH TOTAL:        $${regData.cashTotal.toFixed(2)}`,
            `  CARD TOTAL:        $${regData.cardTotal.toFixed(2)}`,
            `================================`,
            centerText('SESSION TOTAL', 32),
            centerText(`$${sessionTotal.toFixed(2)}`, 32),
            `================================`,
            ``, ``, ``, ``
          ].join('\n');

          if (regData.sessionId) {
            mainWindow.webContents.executeJavaScript(`
              fetch('https://gateclerk-api.onrender.com/register/logout-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  session_id: '${regData.sessionId}',
                  sale_count: ${regData.saleCount},
                  cash_total: ${regData.cashTotal},
                  card_total: ${regData.cardTotal}
                })
              }).catch(() => {});
            `).catch(() => {});
          }

          await printHtml(`<pre>${zLines}</pre>`);

          // Clear register session
          mainWindow.webContents.executeJavaScript(`
            try { localStorage.removeItem('gc_register_session'); } catch(e) {}
          `).catch(() => {});
        }

      } else if (isGate) {
        // ── GATE TERMINAL Z-TAPE ──
        const sessionData = await mainWindow.webContents.executeJavaScript(`
          (function() {
            try {
              const terminalToken = localStorage.getItem('gc_terminal_token');
              if (!terminalToken) return null;
              const sessionSales = JSON.parse(localStorage.getItem(
                'gc_session_sales_' + localStorage.getItem('gc_terminal_id') + '_' + new Date().toISOString().split('T')[0]
              ) || '{}');
              const entries = Object.values(sessionSales);
              let totalTickets = 0, cashTotal = 0, cardTotal = 0;
              entries.forEach(s => {
                totalTickets += (s.cashQty || 0) + (s.cardQty || 0);
                cashTotal += s.cashTotal || 0;
                cardTotal += s.cardTotal || 0;
              });
              return {
                entries, totalTickets, cashTotal, cardTotal,
                terminalName: localStorage.getItem('gc_terminal_name') || 'GATE',
                venueName: localStorage.getItem('gc_terminal_venue_name') || 'GATECLERK',
                sessionId: localStorage.getItem('gc_gate_session_id'),
                eventId: window.selectedEventId || null
              };
            } catch(e) { return null; }
          })()
        `);

        if (sessionData && sessionData.terminalName) {
          const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
          const sessionTotal = sessionData.cashTotal + sessionData.cardTotal;

          let ticketLines = '';
          if (sessionData.entries.length === 0) {
            ticketLines = '  No sales this session.\n';
          } else {
            sessionData.entries.forEach(s => {
              const qty = (s.cashQty || 0) + (s.cardQty || 0);
              const total = (s.cashTotal || 0) + (s.cardTotal || 0);
              ticketLines += `  ${(s.name || 'Ticket').substring(0, 18).padEnd(18)} x${qty}  $${total.toFixed(2)}\n`;
              if (s.cashQty > 0) ticketLines += `    Cash: ${s.cashQty} tickets  $${(s.cashTotal||0).toFixed(2)}\n`;
              if (s.cardQty > 0) ticketLines += `    Card: ${s.cardQty} tickets  $${(s.cardTotal||0).toFixed(2)}\n`;
            });
          }

          const zLines = [
            `================================`,
            centerText('*** Z TAPE ***', 32),
            centerText('END OF SESSION REPORT', 32),
            `================================`,
            centerText(sessionData.venueName, 32),
            centerText(sessionData.terminalName, 32),
            `  ${now}`,
            `================================`,
            `  TICKET BREAKDOWN`,
            `================================`,
            ticketLines.trimEnd(),
            `================================`,
            `  TOTAL TICKETS:    ${sessionData.totalTickets}`,
            `  CASH TOTAL:       $${sessionData.cashTotal.toFixed(2)}`,
            `  CARD TOTAL:       $${sessionData.cardTotal.toFixed(2)}`,
            `================================`,
            centerText('SESSION TOTAL', 32),
            centerText(`$${sessionTotal.toFixed(2)}`, 32),
            `================================`,
            ``, ``, ``, ``
          ].join('\n');

          if (sessionData.sessionId) {
            mainWindow.webContents.executeJavaScript(`
              fetch('https://gateclerk-api.onrender.com/terminal/logout-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  session_id: '${sessionData.sessionId}',
                  event_id: ${sessionData.eventId ? `'${sessionData.eventId}'` : 'null'},
                  ticket_count: ${sessionData.totalTickets},
                  cash_total: ${sessionData.cashTotal},
                  card_total: ${sessionData.cardTotal}
                })
              }).catch(() => {});
            `).catch(() => {});
          }

          await printHtml(`<pre>${zLines}</pre>`);

          mainWindow.webContents.executeJavaScript(`
            try {
              const termId = localStorage.getItem('gc_terminal_id');
              const today = new Date().toISOString().split('T')[0];
              localStorage.removeItem('gc_session_sales_' + termId + '_' + today);
              localStorage.removeItem('gc_gate_session_id');
              localStorage.removeItem('gc_terminal_token');
              localStorage.removeItem('gc_terminal_id');
              localStorage.removeItem('gc_terminal_name');
              localStorage.removeItem('gc_terminal_account_id');
              localStorage.removeItem('gc_terminal_venue_name');
              localStorage.removeItem('gc_terminal_logo_url');
              localStorage.removeItem('gc_terminal_shortcode');
            } catch(e) {}
          `).catch(() => {});
        }
      }
    } catch(err) {
      console.error('Close Z-tape error:', err);
    }

    mainWindow.destroy();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('save-config', (event, shortcode, type) => {
  saveConfig(shortcode, type);
  if (mainWindow) { mainWindow.loadURL(`https://gateclerk.com/chooser/${shortcode}`); }
  return { success: true };
});

// Legacy support
ipcMain.handle('save-shortcode', (event, shortcode) => {
  saveConfig(shortcode, 'gate');
  if (mainWindow) { mainWindow.loadURL(`https://gateclerk.com/chooser/${shortcode}`); }
  return { success: true };
});

ipcMain.handle('reset-shortcode', () => {
  try { fs.unlinkSync(getConfigPath()); } catch(e) {}
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'shortcode.txt')); } catch(e) {}
  if (mainWindow) { mainWindow.loadFile(path.join(__dirname, 'setup.html')); }
  return { success: true };
});

ipcMain.handle('get-shortcode', () => {
  const cfg = getSavedConfig();
  return cfg ? cfg.shortcode : null;
});

ipcMain.handle('print-ticket', async (event, ticketHtml) => {
  return printHtml(ticketHtml);
});

ipcMain.handle('get-printers', async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map(p => ({ name: p.name, isDefault: p.isDefault }));
});

ipcMain.handle('confirm-close', () => {
  if (mainWindow) { mainWindow.destroy(); }
});

app.whenReady().then(() => {
  session.defaultSession.setPreloads([path.join(__dirname, 'preload.js')]);
  createWindow();
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 5000);
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
});
