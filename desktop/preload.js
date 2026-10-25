// The only bridge between the page and the PC. The page gets these calls and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['live:state', 'live:audio', 'live:heard', 'live:said', 'live:turn', 'live:interrupted', 'tool', 'asking', 'cursor', 'accent', 'hotkey', 'settings', 'say', 'memory', 'grab-frame', 'deep'];

contextBridge.exposeInMainWorld('atlas', {
  mode: ipcRenderer.sendSync('atlas:mode'),
  info: () => ipcRenderer.invoke('atlas:info'),
  saveSettings: s => ipcRenderer.invoke('atlas:settings', s),
  chat: body => ipcRenderer.invoke('atlas:chat', body),
  speak: text => ipcRenderer.invoke('atlas:speak', text),
  liveStart: () => ipcRenderer.send('atlas:live:start'),
  liveStop: () => ipcRenderer.send('atlas:live:stop'),
  liveAudio: u8 => ipcRenderer.send('atlas:live:audio', u8),
  liveText: text => ipcRenderer.send('atlas:live:text', text),
  ignoreMouse: on => ipcRenderer.send('atlas:mouse', on),
  setName: name => ipcRenderer.send('atlas:name', name),
  log: (kind, text) => ipcRenderer.send('atlas:log', kind, text),
  quit: () => ipcRenderer.send('atlas:quit'),
  frame: (id, b64) => ipcRenderer.send('atlas:frame', id, b64),
  on: (ch, cb) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (e, data) => cb(data)); }
});
