// Cloud library: keeps the library in a Google Drive / Yandex Disk folder, uploads songs,
// streams cloud songs on demand, and keeps offline copies on this PC.
//
// Track fields used here:
//   file   local file name (<id>.<ext>), present on disk when `here` is true
//   here   false when the song lives only in the cloud (missing means true)
//   cloud  { p: 'g'|'y', id, owned } where the song lives in the cloud
//   up     true while waiting to be uploaded
//   t      last change time, used to merge libraries
const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const drive = require('./drive');

const MANIFEST = 'cocoatune-library.json';
const CACHE_CAP = 2e9;
const SYNC_EVERY = 90 * 1000;
const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm', weba: 'audio/webm',
};
const SYNCED = ['id', 'title', 'source', 'origin', 'link', 'duration', 'added', 't', 'cloud', 'size'];

let ctx = null;            // { db, audioDir, save, push, uid, toast }
let status = 'off';        // off | syncing | synced | offline | auth | error
let lastError = '';
const accounts = {};
const folderIds = {};      // p -> { key, base, music }

const db = () => ctx.db();
const cfg = () => (db().cloud ||= { p: null, folder: null, store: 'cloud', offline: 'recent' });
const ext = t => path.extname(t.file || '').slice(1).toLowerCase();
const isHere = t => t.here !== false;
const filePath = t => path.join(ctx.audioDir(), t.file);
const now = () => Date.now();

function setStatus(s, err) {
  status = s;
  lastError = err ? (err.message || String(err)) : '';
  ctx.push();
}

function handleErr(e) {
  if (e?.needAuth) setStatus('auth', e);
  else if (e?.offline) setStatus('offline', e);
  else setStatus('error', e);
}

// ---------- state for the window ----------
function where(t) {
  if (t.up) return 'up';
  if (!t.cloud) return 'pc';
  return isHere(t) ? 'both' : 'cloud';
}

function info() {
  const c = cfg();
  const q = uploads.queue.length + (uploads.cur ? 1 : 0);
  return {
    p: c.p,
    configured: { g: drive.configured('g'), y: drive.configured('y') },
    connected: { g: drive.connected('g'), y: drive.connected('y') },
    accounts: { g: accounts.g || '', y: accounts.y || '' },
    folder: c.folder ? { name: c.folder.name, custom: true } : { name: 'CocoaTune', custom: false },
    store: c.store,
    offline: c.offline,
    status,
    error: lastError,
    upload: q ? { n: q, progress: uploads.progress } : null,
    localCount: db().tracks.filter(t => !t.cloud && !t.up).length,
  };
}

// ---------- folders ----------
async function folders(p = cfg().p) {
  const c = cfg();
  const key = JSON.stringify(c.folder || null);
  if (folderIds[p]?.key === key) return folderIds[p];
  const f = await drive.P[p].folders(p === c.p ? c.folder : null);
  folderIds[p] = { key, ...f };
  return folderIds[p];
}

// ---------- sync ----------
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

function manifest() {
  const d = db();
  return {
    v: 1,
    tracks: d.tracks.filter(t => t.cloud && !t.up).map(t => ({ ...pick(t, SYNCED), ext: ext(t) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    playlists: d.playlists.map(p => ({ id: p.id, name: p.name, trackIds: p.trackIds, t: p.t || 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    deleted: d.deleted || {},
  };
}

function pruneTombstones() {
  const d = db();
  const old = now() - 90 * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(d.deleted || {})) if (v < old) delete d.deleted[k];
}

// Merges a library from the cloud into this one. Newer `t` wins; deletions win.
function merge(remote) {
  const d = db();
  d.deleted ||= {};
  for (const [k, v] of Object.entries(remote.deleted || {})) d.deleted[k] = Math.max(d.deleted[k] || 0, v);
  pruneTombstones();

  for (const t of d.tracks.filter(x => d.deleted[x.id])) {
    if (t.file) fsp.unlink(filePath(t)).catch(() => {});
  }
  d.tracks = d.tracks.filter(t => !d.deleted[t.id]);

  for (const rt of remote.tracks || []) {
    if (d.deleted[rt.id]) continue;
    const lt = d.tracks.find(x => x.id === rt.id);
    if (!lt) {
      d.tracks.push({ ...pick(rt, SYNCED), file: `${rt.id}.${rt.ext || 'mp3'}`, here: false });
    } else if ((rt.t || 0) > (lt.t || 0)) {
      Object.assign(lt, pick(rt, SYNCED));
    }
  }

  d.playlists = d.playlists.filter(p => !d.deleted[p.id]);
  for (const rp of remote.playlists || []) {
    if (d.deleted[rp.id]) continue;
    const lp = d.playlists.find(x => x.id === rp.id);
    if (!lp) d.playlists.push({ id: rp.id, name: rp.name, trackIds: rp.trackIds || [], t: rp.t || 0 });
    else if ((rp.t || 0) > (lp.t || 0)) Object.assign(lp, { name: rp.name, trackIds: rp.trackIds || [], t: rp.t });
  }
}

let syncing = null;
let syncAgain = false;
let syncTimer = null;

async function syncNow() {
  const c = cfg();
  if (!c.p) return;
  if (!drive.connected(c.p)) { setStatus('auth'); return; }
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    setStatus('syncing');
    try {
      const f = await folders();
      const P = drive.P[c.p];
      const remote = await P.readJson(f.base, MANIFEST);
      if (remote) merge(remote);
      const out = manifest();
      if (!remote || JSON.stringify(out) !== JSON.stringify({ v: 1, tracks: remote.tracks, playlists: remote.playlists, deleted: remote.deleted })) {
        await P.writeJson(f.base, MANIFEST, out);
      }
      ctx.save();
      setStatus('synced');
      if (c.offline === 'all') queueAllOffline();
    } catch (e) {
      handleErr(e);
    } finally {
      syncing = null;
      if (syncAgain) { syncAgain = false; scheduleSync(500); }
    }
  })();
  return syncing;
}

function scheduleSync(ms = 4000) {
  if (!cfg().p) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}

// ---------- uploads ----------
const uploads = { queue: [], cur: null, progress: 0, done: 0, total: 0, timer: null };

function queueUpload(t) {
  if (!cfg().p || t.cloud) return;
  t.up = true;
  if (!uploads.queue.includes(t.id)) { uploads.queue.push(t.id); uploads.total++; }
  ctx.save();
  runUploads();
}

async function runUploads() {
  if (uploads.cur || !uploads.queue.length) return;
  const c = cfg();
  const id = uploads.queue[0];
  const t = db().tracks.find(x => x.id === id);
  if (!t || t.cloud || !isHere(t)) { uploads.queue.shift(); if (t) delete t.up; return runUploads(); }
  uploads.cur = id;
  const report = v => { uploads.progress = uploads.total ? (uploads.done + v) / uploads.total : v; ctx.push(); };
  report(0);
  try {
    const f = await folders();
    const e = ext(t);
    const ref = await drive.P[c.p].upload(f.music, filePath(t), `${t.id}.${e}`, MIME[e] || 'application/octet-stream', report);
    t.cloud = { p: c.p, id: ref, owned: true };
    t.size = (await fsp.stat(filePath(t))).size;
    t.t = now();
    delete t.up;
    t.played = t.played || now();
    uploads.queue.shift();
    uploads.done++;
    if (c.offline === 'none') dropCopy(t);
    ctx.save();
    evict();
    scheduleSync(1500);
  } catch (e) {
    handleErr(e);
    uploads.cur = null;
    if (e.needAuth) return;
    clearTimeout(uploads.timer);
    uploads.timer = setTimeout(runUploads, 30000);
    return;
  }
  uploads.cur = null;
  if (!uploads.queue.length) { uploads.done = 0; uploads.total = 0; uploads.progress = 0; }
  ctx.push();
  runUploads();
}

function resumeUploads() {
  for (const t of db().tracks) if (t.up && !uploads.queue.includes(t.id)) { uploads.queue.push(t.id); uploads.total++; }
  runUploads();
}

// ---------- offline copies ----------
const downloads = { queue: [], cur: null };

function dropCopy(t) {
  if (!t.cloud || !isHere(t)) return;
  t.here = false;
  fsp.unlink(filePath(t)).catch(() => {});
}

function queueOffline(t) {
  if (!t.cloud || isHere(t) || downloads.cur === t.id || downloads.queue.includes(t.id)) return;
  downloads.queue.push(t.id);
  runDownloads();
}

function queueAllOffline() {
  for (const t of db().tracks) if (t.cloud && !isHere(t)) queueOffline(t);
}

async function runDownloads() {
  if (downloads.cur || !downloads.queue.length) return;
  const id = downloads.queue.shift();
  const t = db().tracks.find(x => x.id === id);
  if (!t || !t.cloud || isHere(t) || !drive.connected(t.cloud.p)) return runDownloads();
  downloads.cur = id;
  const part = filePath(t) + '.part';
  try {
    const r = await openCloud(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(part));
    await fsp.rename(part, filePath(t));
    t.here = true;
    t.size = (await fsp.stat(filePath(t))).size;
    ctx.save();
    evict();
  } catch {
    fsp.unlink(part).catch(() => {});
  }
  downloads.cur = null;
  runDownloads();
}

// Keeps cloud copies on this PC under the cap, dropping the least recently played first.
function evict() {
  const c = cfg();
  const copies = db().tracks.filter(t => t.cloud && isHere(t) && !t.up).sort((a, b) => (b.played || 0) - (a.played || 0));
  if (c.offline === 'all') return;
  const keepFirst = copies[0]?.id;
  if (c.offline === 'none') {
    for (const t of copies) if (t.id !== keepFirst) dropCopy(t);
  } else {
    let total = 0;
    for (const t of copies) {
      total += t.size || 0;
      if (total > CACHE_CAP && t.id !== keepFirst) dropCopy(t);
    }
  }
  ctx.save();
}

// ---------- streaming ----------
async function openCloud(t, range) {
  const P = drive.P[t.cloud.p];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { url, headers } = await P.target(t.cloud.id);
    let r;
    try {
      r = await fetch(url, { headers: { ...headers, ...(range ? { Range: range } : {}) } });
    } catch (e) { throw drive.netErr(e); }
    if ((r.status === 403 || r.status === 410) && t.cloud.p === 'y' && attempt === 0) {
      drive.hrefCache.delete(t.cloud.id);
      continue;
    }
    return r;
  }
}

function serveFile(file, range, type) {
  const size = fs.statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  }
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: {
      'Content-Type': type, 'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
    },
  });
}

function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'ctune', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

function handleProtocol() {
  protocol.handle('ctune', async req => {
    const u = new URL(req.url);
    const id = u.pathname.slice(1);
    const probe = u.searchParams.has('probe');
    const t = db().tracks.find(x => x.id === id);
    if (!t) return new Response('Not found', { status: 404 });
    const range = req.headers.get('range');
    const type = MIME[ext(t)] || 'audio/mpeg';
    const start = Number((/bytes=(\d+)-/.exec(range || '') || [0, 0])[1]);
    if (!probe && start === 0) { t.played = now(); ctx.save(); }

    if (isHere(t) && t.file && fs.existsSync(filePath(t))) return serveFile(filePath(t), range, type);
    if (!t.cloud) return new Response('Missing file', { status: 404 });
    if (!drive.connected(t.cloud.p)) {
      ctx.toast(`Sign in to ${drive.NAMES[t.cloud.p]} to play this song`);
      return new Response('Sign in', { status: 401 });
    }
    try {
      const r = await openCloud(t, range);
      if (!probe && cfg().offline !== 'none') queueOffline(t);
      const headers = {};
      for (const k of ['content-length', 'content-range', 'accept-ranges']) {
        const v = r.headers.get(k);
        if (v) headers[k] = v;
      }
      headers['content-type'] = type;
      return new Response(r.body, { status: r.status, headers });
    } catch (e) {
      if (!probe) ctx.toast(e.offline ? 'You’re offline and this song isn’t saved on this PC' : e.message);
      return new Response('Unavailable', { status: 503 });
    }
  });
}

// ---------- actions from the window ----------
async function refreshAccount(p) {
  try { accounts[p] = await drive.P[p].account(); } catch { /* shown as signed in anyway */ }
  ctx.push();
}

async function connect(p) {
  await drive.signIn(p);
  const c = cfg();
  if (!c.p || !drive.connected(c.p)) {
    if (c.p && c.p !== p) c.folder = null;
    c.p = p;
  }
  ctx.save();
  refreshAccount(p);
  await syncNow();
  resumeUploads();
}

function useProvider(p) {
  const c = cfg();
  if (c.p === p) return;
  c.p = p;
  c.folder = null;
  ctx.save();
  syncNow();
}

function signOut(p) {
  drive.signOut(p);
  delete accounts[p];
  const c = cfg();
  if (c.p === p) {
    const other = p === 'g' ? 'y' : 'g';
    c.folder = null;
    c.p = drive.connected(other) ? other : null;
    if (!c.p) setStatus('off');
    else syncNow();
  }
  for (const t of db().tracks) if (t.up && !c.p) delete t.up;
  uploads.queue = c.p ? uploads.queue : [];
  ctx.save();
}

function set(o) {
  const c = cfg();
  if (o.store === 'cloud' || o.store === 'local') c.store = o.store;
  if (['none', 'recent', 'all'].includes(o.offline)) {
    c.offline = o.offline;
    if (c.offline === 'all') queueAllOffline();
    else evict();
  }
  ctx.save();
}

function setFolder(folder) {
  cfg().folder = folder;
  ctx.save();
  syncNow();
}

// Google: the folder is chosen in Google's own picker during a sign-in.
async function pickGoogleFolder() {
  const ids = await drive.signIn('g', 'folder');
  if (!ids.length) return;
  const m = await drive.P.g.meta(ids[0]);
  if (m.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Pick a folder, not a file');
  cfg().p = 'g';
  setFolder({ id: m.id, name: m.name });
  refreshAccount('g');
}

async function list(p, dir) {
  if (p !== 'y') throw new Error('Folder browsing is only available for Yandex Disk');
  return drive.P.y.list(dir || 'disk:/');
}

const isAudioName = n => AUDIO_RE.test(n || '');
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|weba)$/i;

// Adds files that are already in the cloud. They are not re-uploaded.
function addCloudFiles(p, files) {
  let n = 0;
  for (const f of files) {
    const e = (AUDIO_RE.exec(f.name) || [])[1]?.toLowerCase() || (/mpeg/.test(f.mime || '') ? 'mp3' : '');
    if (!e) continue;
    if (db().tracks.some(t => t.cloud?.p === p && t.cloud.id === f.id)) continue;
    const id = ctx.uid();
    db().tracks.push({
      id, title: f.name.replace(/\.[a-z0-9]{2,5}$/i, ''), source: 'cloud', origin: drive.NAMES[p],
      file: `${id}.${e}`, here: false, cloud: { p, id: f.id, owned: false }, size: Number(f.size) || 0,
      duration: 0, added: now(), t: now(),
    });
    n++;
  }
  ctx.save();
  scheduleSync(500);
  if (cfg().offline === 'all') queueAllOffline();
  return n;
}

async function pickGoogleFiles() {
  const ids = await drive.signIn('g', 'file');
  if (!cfg().p) { cfg().p = 'g'; ctx.save(); syncNow(); }
  refreshAccount('g');
  const metas = await Promise.all(ids.map(id => drive.P.g.meta(id).catch(() => null)));
  const files = metas.filter(m => m && (m.mimeType?.startsWith('audio/') || isAudioName(m.name)))
    .map(m => ({ id: m.id, name: isAudioName(m.name) ? m.name : `${m.name}.mp3`, size: m.size, mime: m.mimeType }));
  if (ids.length && !files.length) throw new Error('None of the picked files are audio');
  return addCloudFiles('g', files);
}

function moveAll() {
  if (!cfg().p) throw new Error('Connect a cloud first');
  for (const t of db().tracks) if (!t.cloud && !t.up) queueUpload(t);
}

// Called when a song is added on this PC.
function added(t) {
  t.t = now();
  if (cfg().p && cfg().store === 'cloud') queueUpload(t);
}

// Called before a song is removed from the library.
function removed(t) {
  (db().deleted ||= {})[t.id] = now();
  uploads.queue = uploads.queue.filter(x => x !== t.id);
  if (t.cloud?.owned && drive.connected(t.cloud.p)) drive.P[t.cloud.p].remove(t.cloud.id).catch(() => {});
  scheduleSync();
}

function playlistRemoved(id) {
  (db().deleted ||= {})[id] = now();
  scheduleSync();
}

function init(c) {
  ctx = c;
  handleProtocol();
  const conf = cfg();
  if (conf.p && !drive.connected(conf.p)) conf.p = drive.connected('g') ? 'g' : drive.connected('y') ? 'y' : null;
  for (const p of ['g', 'y']) if (drive.connected(p)) refreshAccount(p);
  if (conf.p) syncNow().then(resumeUploads);
  setInterval(() => { if (cfg().p && !syncing) syncNow(); }, SYNC_EVERY);
}

module.exports = {
  registerScheme, init, info, where, syncNow, scheduleSync, connect, useProvider, signOut, set, setFolder,
  pickGoogleFolder, pickGoogleFiles, list, addCloudFiles, moveAll, added, removed, playlistRemoved,
  isHere,
};
