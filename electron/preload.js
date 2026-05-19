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
  financasAtProfile: async (payload) => {
    return ipcRenderer.invoke('wa:financas-at-profile', payload || {});
  },
  readClipboardText: async () => {
    return ipcRenderer.invoke('wa:read-clipboard-text');
  },
  notifyInboundMessage: (payload) => {
    ipcRenderer.send('wa:notify-inbound-message', payload || {});
  },
  openAsApp: (url) => {
    ipcRenderer.invoke('wa:open-as-app', url);
  },
});
