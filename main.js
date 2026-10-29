const { app, BrowserWindow, ipcMain, dialog, screen, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const ytdlp = require('./ytdlp');

const FULL = { width: 400, height: 560 };
const MINI = { width: 340, height: 44 };
const MARGIN = 16;
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'webm', 'weba']);
const TYPE_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'webm',
};

let win = null;
let fullBounds = null;
let mini = false;
let pinned = false;
let db = { tracks: [], playlists: [] };
const jobs = new Map();

const dataDir = () => path.join(app.getPath('userData'), 'library');
const audioDir = () => path.join(dataDir(), 'audio');
const dbFile = () => path.join(dataDir(), 'library.json');
const uid = () => crypto.randomBytes(6).toString('hex');

// ---------- library storage ----------
async function loadDb() {
  await fsp.mkdir(audioDir(), { recursive: true });
  try { db = JSON.parse(await fsp.readFile(dbFile(), 'utf8')); } catch { /* first run */ }
  db.tracks ||= [];
  db.playlists ||= [];
  pinned = !!db.pinned;
}

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    db.pinned = pinned;
    const tmp = dbFile() + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db, null, 1));
    await fsp.rename(tmp, dbFile());
  }, 150);
}

function state() {
  return {
    tracks: db.tracks.map(t => ({ ...t, url: pathToFileURL(path.join(audioDir(), t.file)).href })),
    playlists: db.playlists,
    jobs: [...jobs.values()],
    pinned,
    mini,
  };
}

let pushQueued = false;
function push() {
  if (pushQueued) return;
  pushQueued = true;
  setTimeout(() => {
    pushQueued = false;
    if (win && !win.isDestroyed()) win.webContents.send('state', state());
  }, 50);
}

function changed() { saveDb(); push(); }

// ---------- adding audio ----------
async function importPaths(paths) {
  for (const p of paths) {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!AUDIO_EXT.has(ext)) continue;
    const id = uid();
    const file = `${id}.${ext}`;
    await fsp.copyFile(p, path.join(audioDir(), file));
    db.tracks.push({
      id, title: path.basename(p, path.extname(p)), source: 'local', origin: ext,
      file, duration: 0, added: Date.now(),
    });
  }
  changed();
}

function nameFromResponse(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  let name = m ? m[1] : path.posix.basename(new URL(url).pathname);
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  return name.replace(/\.[a-z0-9]{2,5}$/i, '') || new URL(url).hostname;
}

// Direct audio files are streamed straight to disk; anything else returns null.
async function tryDirect(url, id, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const pathExt = path.extname(new URL(res.url).pathname).slice(1).toLowerCase();
  const isAudio = type.startsWith('audio/') || type === 'application/ogg' ||
    ((type === 'application/octet-stream' || !type) && AUDIO_EXT.has(pathExt));
  if (!res.ok || !isAudio) { await res.body?.cancel().catch(() => {}); return null; }

  const ext = TYPE_EXT[type] || (AUDIO_EXT.has(pathExt) ? pathExt : 'mp3');
  const file = `${id}.${ext}`;
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', c => { got += c.length; if (total) onProgress(got / total); });
  await pipeline(body, fs.createWriteStream(path.join(audioDir(), file)));
  return { file, title: nameFromResponse(res, url), duration: 0 };
}

async function saveLink(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new Error('That is not a valid link'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https links are supported');

  const id = uid();
  const job = { id, title: 'Saving…', origin: url.hostname, progress: 0 };
  jobs.set(id, job);
  push();
  const onProgress = p => { job.progress = Math.min(1, p); push(); };

  try {
    let got = await tryDirect(url.href, id, onProgress).catch(() => null);
    if (!got) {
      job.title = 'Preparing…';
      push();
      got = await ytdlp.download(url.href, audioDir(), id, onProgress);
    }
    db.tracks.push({
      id, title: got.title || url.hostname, source: 'link', origin: url.hostname,
      link: url.href, file: got.file, duration: got.duration || 0, added: Date.now(),
    });
  } finally {
    jobs.delete(id);
    changed();
  }
}

async function deleteTrack(id) {
  const t = db.tracks.find(x => x.id === id);
  if (!t) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Delete "${t.title}" from the library?`,
  });
  if (response !== 0) return;
  db.tracks = db.tracks.filter(x => x.id !== id);
  for (const p of db.playlists) p.trackIds = p.trackIds.filter(x => x !== id);
  await fsp.unlink(path.join(audioDir(), t.file)).catch(() => {});
  changed();
}

// ---------- window ----------
function setBoundsSafe(b) {
  win.setResizable(true);
  win.setBounds(b);
  win.setResizable(false);
}

function setMini(on) {
  if (on === mini) return;
  mini = on;
  if (on) {
    fullBounds = win.getBounds();
    const wa = screen.getDisplayMatching(fullBounds).workArea;
    setBoundsSafe({
      x: wa.x + wa.width - MINI.width - MARGIN,
      y: wa.y + wa.height - MINI.height - MARGIN,
      ...MINI,
    });
    win.setAlwaysOnTop(true, 'floating');
  } else {
    setBoundsSafe(fullBounds || { ...FULL });
    win.setAlwaysOnTop(pinned, 'floating');
  }
  push();
}

function createWindow() {
  win = new BrowserWindow({
    ...FULL,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'CocoaTune',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(pinned, 'floating');
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', push);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------- IPC ----------
async function importDialog() {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXT] }],
  });
  if (!r.canceled) await importPaths(r.filePaths);
}
ipcMain.handle('import-dialog', importDialog);
ipcMain.handle('import-paths', (_, paths) => importPaths(paths));
ipcMain.handle('save-link', (_, url) => saveLink(url));
ipcMain.handle('set-duration', (_, id, d) => {
  const t = db.tracks.find(x => x.id === id);
  if (t && d > 0) { t.duration = d; changed(); }
});
ipcMain.handle('set-pinned', (_, on) => {
  pinned = !!on;
  if (!mini) win.setAlwaysOnTop(pinned, 'floating');
  changed();
});
ipcMain.handle('set-mini', (_, on) => setMini(!!on));
ipcMain.handle('close', () => win.close());

ipcMain.handle('playlist-create', (_, name) => {
  const p = { id: uid(), name: String(name).trim().slice(0, 60) || 'Playlist', trackIds: [] };
  db.playlists.push(p);
  changed();
  return p.id;
});

ipcMain.handle('track-menu', (_, id, playlistId) => {
  const t = db.tracks.find(x => x.id === id);
  if (!t) return;
  const items = [{
    label: 'Add to playlist',
    enabled: db.playlists.length > 0,
    submenu: db.playlists.map(p => ({
      label: p.name,
      enabled: !p.trackIds.includes(id),
      click: () => { p.trackIds.push(id); changed(); },
    })),
  }];
  const pl = db.playlists.find(p => p.id === playlistId);
  if (pl) items.push({ label: `Remove from ${pl.name}`, click: () => { pl.trackIds = pl.trackIds.filter(x => x !== id); changed(); } });
  if (t.link) items.push({ label: 'Open source link', click: () => shell.openExternal(t.link) });
  items.push({ type: 'separator' }, { label: 'Delete from library…', click: () => deleteTrack(id) });
  if (db.playlists.length === 0) items[0].submenu = [{ label: 'No playlists yet', enabled: false }];
  Menu.buildFromTemplate(items).popup({ window: win });
});

ipcMain.handle('playlist-menu', (_, id) => {
  const p = db.playlists.find(x => x.id === id);
  if (!p) return;
  Menu.buildFromTemplate([{
    label: `Delete playlist "${p.name}"`,
    click: () => { db.playlists = db.playlists.filter(x => x.id !== id); changed(); },
  }]).popup({ window: win });
});

ipcMain.handle('app-menu', () => {
  Menu.buildFromTemplate([
    { label: 'Add files…', click: importDialog },
    { label: 'Open library folder', click: () => shell.openPath(dataDir()) },
    {
      label: 'Update link downloader',
      click: () => ytdlp.update(true)
        .then(() => win.webContents.send('toast', 'Link downloader is up to date'))
        .catch(e => win.webContents.send('toast', e.message)),
    },
    { type: 'separator' },
    { label: 'Quit CocoaTune', click: () => app.quit() },
  ]).popup({ window: win });
});

// ---------- app ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (mini) setMini(false);
    win.show();
    win.focus();
  });
  app.whenReady().then(async () => {
    await loadDb();
    createWindow();
    ytdlp.update().catch(() => {}); // quiet background refresh
  });
  app.on('window-all-closed', () => app.quit());
}
