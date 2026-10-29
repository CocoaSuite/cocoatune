const { app, BrowserWindow, ipcMain, dialog, screen, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const ytdlp = require('./ytdlp');
const cloud = require('./cloud');

cloud.registerScheme();

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
    tracks: db.tracks.map(t => ({
      id: t.id, title: t.title, source: t.source, origin: t.origin, duration: t.duration, link: t.link,
      url: `ctune://track/${t.id}`, where: cloud.where(t),
    })),
    cloud: cloud.info(),
    playlists: db.playlists,
    jobs: [...jobs.values()],
    pinned,
    mini,
    theme: db.theme || null,
    canShortcut: canShortcut(),
    welcome: canShortcut() && !db.welcomeDone && !shortcutExists(),
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

function changed() { saveDb(); push(); cloud.scheduleSync(); }
function quietSave() { saveDb(); push(); }
const toast = m => { if (win && !win.isDestroyed()) win.webContents.send('toast', m); };

// ---------- adding audio ----------
async function importPaths(paths) {
  for (const p of paths) {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!AUDIO_EXT.has(ext)) continue;
    const id = uid();
    const file = `${id}.${ext}`;
    await fsp.copyFile(p, path.join(audioDir(), file));
    const t = {
      id, title: path.basename(p, path.extname(p)), source: 'local', origin: ext,
      file, duration: 0, added: Date.now(),
    };
    db.tracks.push(t);
    cloud.added(t);
  }
  changed();
}

function nameFromResponse(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  let name = m ? m[1] : path.posix.basename(new URL(url).pathname);
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  return name;
}
const stripExt = n => n.replace(/\.[a-z0-9]{2,5}$/i, '');

// Turns Google Drive and Yandex Disk share links into direct download links.
async function resolveShare(url) {
  const h = url.hostname.replace(/^www\./, '');
  if (h === 'drive.google.com' || h === 'docs.google.com') {
    const id = (url.pathname.match(/\/d\/([\w-]{10,})/) || [])[1] || url.searchParams.get('id');
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }
  if (/^(disk\.yandex\.[a-z.]+|yadi\.sk|disk\.360\.yandex\.[a-z.]+)$/.test(h)) {
    const r = await fetch('https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=' + encodeURIComponent(url.href));
    if (!r.ok) throw new Error('This Yandex Disk link is not public or no longer exists');
    return (await r.json()).href;
  }
  return null;
}

// Direct audio files are streamed straight to disk; anything else returns null.
async function tryDirect(url, id, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const name = nameFromResponse(res, url);
  const pathExt = (path.extname(name).slice(1) || path.extname(new URL(res.url).pathname).slice(1)).toLowerCase();
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
  return { file, title: stripExt(name) || new URL(url).hostname, duration: 0 };
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
    const shared = await resolveShare(url);
    let got = await tryDirect(shared || url.href, id, onProgress).catch(e => { if (shared) throw e; return null; });
    if (shared && !got) throw new Error('That shared file is not audio');
    if (!got) {
      job.title = 'Preparing…';
      push();
      got = await ytdlp.download(url.href, audioDir(), id, onProgress);
    }
    const t = {
      id, title: got.title || url.hostname, source: 'link', origin: url.hostname,
      link: url.href, file: got.file, duration: got.duration || 0, added: Date.now(),
    };
    db.tracks.push(t);
    cloud.added(t);
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
    detail: t.cloud?.owned ? 'It will also be moved to the trash in the cloud, for everyone who shares this library.'
      : t.cloud ? 'The original file stays in your cloud.' : undefined,
  });
  if (response !== 0) return;
  cloud.removed(t);
  db.tracks = db.tracks.filter(x => x.id !== id);
  for (const p of db.playlists) {
    if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter(x => x !== id); p.t = Date.now(); }
  }
  if (cloud.isHere(t)) await fsp.unlink(path.join(audioDir(), t.file)).catch(() => {});
  changed();
}

// ---------- shortcuts (Windows) ----------
const canShortcut = () => process.platform === 'win32' && app.isPackaged;
const shortcutPaths = () => ({
  desktop: path.join(app.getPath('desktop'), 'CocoaTune.lnk'),
  startMenu: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CocoaTune.lnk'),
});
const shortcutExists = () => Object.values(shortcutPaths()).some(p => fs.existsSync(p));

function createShortcuts({ desktop, startMenu }) {
  if (!canShortcut()) throw new Error('Shortcuts are only available in the Windows app');
  const opts = {
    target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath, iconIndex: 0,
    description: 'CocoaTune music player', appUserModelId: 'com.cocoasuite.cocoatune',
  };
  const paths = shortcutPaths();
  const wanted = [desktop && paths.desktop, startMenu && paths.startMenu].filter(Boolean);
  for (const p of wanted) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!shell.writeShortcutLink(p, fs.existsSync(p) ? 'replace' : 'create', opts)) throw new Error('Could not create the shortcut');
  }
  db.welcomeDone = true;
  saveDb();
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
    icon: path.join(__dirname, 'src', 'icon.png'),
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
  if (t && d > 0 && Math.abs((t.duration || 0) - d) > 0.5) { t.duration = d; quietSave(); }
});
ipcMain.handle('set-pinned', (_, on) => {
  pinned = !!on;
  if (!mini) win.setAlwaysOnTop(pinned, 'floating');
  changed();
});
ipcMain.handle('set-mini', (_, on) => setMini(!!on));
ipcMain.handle('close', () => win.close());
ipcMain.handle('minimize', () => win.minimize());
ipcMain.handle('set-theme', (_, t) => {
  const ok = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  if (t && ok(t.accent) && ok(t.bg) && ok(t.text)) { db.theme = { accent: t.accent, bg: t.bg, text: t.text }; saveDb(); }
});
ipcMain.handle('cloud-connect', (_, p) => cloud.connect(p));
ipcMain.handle('cloud-signout', (_, p) => cloud.signOut(p));
ipcMain.handle('cloud-use', (_, p) => cloud.useProvider(p));
ipcMain.handle('cloud-set', (_, o) => cloud.set(o || {}));
ipcMain.handle('cloud-folder-google', () => cloud.pickGoogleFolder());
ipcMain.handle('cloud-folder-set', (_, f) => cloud.setFolder(f && typeof f.id === 'string' ? { id: f.id, name: String(f.name || f.id) } : null));
ipcMain.handle('cloud-list', (_, p, dir) => cloud.list(p, dir));
ipcMain.handle('cloud-add', (_, p, files) => cloud.addCloudFiles(p, Array.isArray(files) ? files : []));
ipcMain.handle('cloud-pick-google', () => cloud.pickGoogleFiles());
ipcMain.handle('cloud-move-all', () => cloud.moveAll());
ipcMain.handle('cloud-sync', () => cloud.syncNow());
ipcMain.handle('create-shortcuts', (_, o) => createShortcuts(o || {}));
ipcMain.handle('dismiss-welcome', () => { db.welcomeDone = true; saveDb(); });

ipcMain.handle('playlist-create', (_, name) => {
  const p = { id: uid(), name: String(name).trim().slice(0, 60) || 'Playlist', trackIds: [], t: Date.now() };
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
      click: () => { p.trackIds.push(id); p.t = Date.now(); changed(); },
    })),
  }];
  const pl = db.playlists.find(p => p.id === playlistId);
  if (pl) items.push({ label: `Remove from ${pl.name}`, click: () => { pl.trackIds = pl.trackIds.filter(x => x !== id); pl.t = Date.now(); changed(); } });
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
    click: () => { db.playlists = db.playlists.filter(x => x.id !== id); cloud.playlistRemoved(id); changed(); },
  }]).popup({ window: win });
});

ipcMain.handle('app-menu', () => {
  Menu.buildFromTemplate([
    { label: 'Add files…', click: importDialog },
    { label: 'Add from cloud…', click: () => win.webContents.send('open-cloud-import') },
    { label: 'Settings', click: () => win.webContents.send('open-settings') },
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
    if (process.platform === 'win32') app.setAppUserModelId('com.cocoasuite.cocoatune');
    await loadDb();
    cloud.init({ db: () => db, audioDir, save: quietSave, push, uid, toast });
    createWindow();
    ytdlp.update().catch(() => {}); // quiet background refresh
  });
  app.on('window-all-closed', () => app.quit());
}
