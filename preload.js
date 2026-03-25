const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waDesktop', {
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron,
  setUnreadCount: (count) => {
    ipcRenderer.send('wa:set-unread-total', Number(count) || 0);
  },
  setUnreadOverlay: (count, dataUrl) => {
    ipcRenderer.send('wa:set-unread-overlay', {
      count: Number(count) || 0,
      dataUrl: String(dataUrl || ''),
    });
  },
  financasAutologin: async (payload) => {
    return ipcRenderer.invoke('wa:financas-autologin', payload || {});
  },
  notifyInboundMessage: (payload) => {
    ipcRenderer.send('wa:notify-inbound-message', payload || {});
  },
});
