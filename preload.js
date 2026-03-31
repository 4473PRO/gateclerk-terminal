const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, limited API to the renderer (gate.html)
// The renderer cannot access Node.js directly — only these specific functions
contextBridge.exposeInMainWorld('electronAPI', {

  // Print a single ticket — pass raw HTML content
  // Returns { success: true } or { success: false, error: '...' }
  printTicket: (ticketHtml) => {
    return ipcRenderer.invoke('print-ticket', ticketHtml);
  },

  // Get list of available printers
  getPrinters: () => {
    return ipcRenderer.invoke('get-printers');
  },

  // Let the renderer know it's running inside Electron
  isElectron: true

});
