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

// ── ESC/POS DIRECT USB PRINT ──
// Sends raw bytes directly to any USB thermal printer
// No Windows print system, no drivers, no paper size settings needed
// Works universally on Star, Rongta, Epson, and any 80mm thermal printer

function htmlToText(html) {
  return html
    .replace(/<div[^>]*>/gi, '')
    .replace(/<\/div>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<pre[^>]*>/gi, '')
    .replace(/<\/pre>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#10;/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildEscPos(text) {
  const ESC = 0x1B;
  const GS  = 0x1D;
  const LF  = 0x0A;

  const bytes = [];

  // Initialize printer
  bytes.push(ESC, 0x40);

  // Set character encoding to PC437
  bytes.push(ESC, 0x74, 0x00);

  // Normal mode
  bytes.push(ESC, 0x21, 0x00);

  // Print each line
  const lines = text.split('\n');
  for (const line of lines) {
    // Encode line as ASCII bytes
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      bytes.push(c < 128 ? c : 0x3F); // Replace non-ASCII with ?
    }
    bytes.push(LF);
  }

  // Feed 4 lines and cut
  bytes.push(LF, LF, LF, LF);
  bytes.push(GS, 0x56, 0x41, 0x03); // Partial cut

  return Buffer.from(bytes);
}

function printEscPos(ticketHtml) {
  return new Promise((resolve) => {
    try {
      const text = htmlToText(ticketHtml);
      const data = buildEscPos(text);
      const { exec } = require('child_process');
      const os = require('os');
      const path2 = require('path');

      // On Windows, try writing ESC/POS to USB printer ports directly
      // This works with SMJUSB (Star), standard USB printer ports, and COM ports
      if (process.platform === 'win32') {
        // Write ESC/POS data to a temp file
        const tmpFile = path2.join(os.tmpdir(), 'gateclerk_escpos_' + Date.now() + '.bin');
        fs.writeFileSync(tmpFile, data);

        // Try each possible printer port — USB001, USB002, COM3, COM4, etc.
        const ports = ['USB001', 'USB002', 'USB003', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6'];
        let tried = 0;
        let succeeded = false;

        const tryNextPort = (index) => {
          if (index >= ports.length || succeeded) {
            try { fs.unlinkSync(tmpFile); } catch(e) {}
            resolve(succeeded ? { success: true } : { success: false, error: 'no_port' });
            return;
          }

          exec(`copy /b "${tmpFile}" "\\\\.\\${ports[index]}"`, (error) => {
            if (!error) {
              succeeded = true;
              try { fs.unlinkSync(tmpFile); } catch(e) {}
              resolve({ success: true });
            } else {
              tryNextPort(index + 1);
            }
          });
        };

        tryNextPort(0);
        return;
      }

      // Non-Windows: use usb package
      const usb = require('usb');
      const devices = usb.getDeviceList();
      let printer = null;

      for (const device of devices) {
        try {
          device.open();
          const interfaces = device.interfaces || [];
          for (const iface of interfaces) {
            if (iface.descriptor.bInterfaceClass === 0x07) {
              printer = { device, iface };
              break;
            }
          }
          if (printer) break;
          device.close();
        } catch(e) {}
      }

      if (!printer) {
        resolve({ success: false, error: 'No USB printer found' });
        return;
      }

      const { device, iface } = printer;
      try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch(e) {}
      iface.claim();

      const endpoint = iface.endpoints.find(e => e.direction === 'out' && e.transferType === 2);
      if (!endpoint) {
        iface.release(() => device.close());
        resolve({ success: false, error: 'No OUT endpoint found' });
        return;
      }

      endpoint.transfer(data, (err) => {
        try { iface.release(() => { try { device.close(); } catch(e) {} }); } catch(e) {}
        resolve(err ? { success: false, error: err.message } : { success: true });
      });

    } catch(e) {
      resolve({ success: false, error: 'usb_unavailable' });
    }
  });
}

// ── PRINT FUNCTION (reusable) ──
function printHtml(ticketHtml) {
  return new Promise((resolve) => {
    const os = require('os');
    const path2 = require('path');
    const { exec } = require('child_process');

    // Add auto-print script to the HTML
    const fullHtml = `<!DOCTYPE html><html><head><style>
      @page { size: 80mm auto; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 2mm; font-family: monospace; font-size: 12px; font-weight: bold; line-height: 1.45; color: #000; background: #fff; width: 72mm; }
      pre { margin: 0; padding: 0; white-space: pre-wrap; word-break: break-word; }
      img { display: block; max-width: 100%; margin: 0 auto; }
      div { text-align: center; }
    </style>
    <script>window.onload = function() { window.print(); setTimeout(function(){ window.close(); }, 500); };</script>
    </head><body>${ticketHtml}</body></html>`;

    const tmpFile = path2.join(os.tmpdir(), 'gc_ticket_' + Date.now() + '.html');
    fs.writeFileSync(tmpFile, fullHtml, 'utf8');
    const fileUrl = 'file:///' + tmpFile.replace(/\\/g, '/');

    // Find Chrome or Edge
    const browserPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    let browserPath = null;
    for (const p of browserPaths) {
      try { if (p && fs.existsSync(p)) { browserPath = p; break; } } catch(e) {}
    }

    if (browserPath) {
      // Launch Chrome/Edge in app mode with kiosk-printing
      // This is IDENTICAL to how the browser shortcut with --kiosk-printing works
      // The page auto-prints via window.onload then closes itself
      const cmd = `"${browserPath}" --kiosk-printing --app="${fileUrl}"`;
      exec(cmd);
      // Give it time to print then clean up
      setTimeout(() => {
        try { fs.unlinkSync(tmpFile); } catch(e) {}
        resolve({ success: true });
      }, 5000);
    } else {
      // Fallback: Electron webContents.print
      const printWin = new BrowserWindow({
        width: 302, height: 1200, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: false }
      });
      printWin.loadFile(tmpFile);
      printWin.webContents.once('did-finish-load', () => {
        printWin.webContents.print(
          { silent: true, printBackground: false, deviceName: '',
            margins: { marginType: 'custom', top: 0, bottom: 0, left: 2, right: 2 },
            pageSize: { width: 80000, height: 297000 } },
          (success, errorType) => {
            printWin.destroy();
            setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch(e) {} }, 1000);
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
    }
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
