const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  printTicket: (ticketHtml) => ipcRenderer.invoke('print-ticket', ticketHtml),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  saveShortcode: (shortcode) => ipcRenderer.invoke('save-shortcode', shortcode),
  resetShortcode: () => ipcRenderer.invoke('reset-shortcode'),
  getShortcode: () => ipcRenderer.invoke('get-shortcode'),
  confirmClose: () => ipcRenderer.invoke('confirm-close'),
  isElectron: true
});
