// Google Drive and Yandex Disk: sign-in, tokens and the raw file operations CocoaTune needs.
// Sign-in uses the same desktop flow as CocoaCut: the browser opens the provider's consent page
// and redirects back to a one-shot local server (PKCE, no embedded web views).
const { app, safeStorage, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/cb`;
const NAMES = { g: 'Google Drive', y: 'Yandex Disk' };
const GA = 'https://www.googleapis.com/';
const YA = 'https://cloud-api.yandex.net/v1/disk';
const GF = 'application/vnd.google-apps.folder';
const SD = 'supportsAllDrives=true';

// Client IDs come from keys.json, which the build writes from repository secrets.
// A keys.json next to the app's resources folder also works, for builds made without the secret.
let KEYS = {};
for (const f of [path.join(__dirname, 'keys.json'), path.join(process.resourcesPath || '', 'keys.json')]) {
  try { const k = JSON.parse(fs.readFileSync(f, 'utf8')); if (k.g?.id || k.y?.id) { KEYS = k; break; } } catch { /* try next */ }
}
if (process.env.CT_KEYS) { try { KEYS = JSON.parse(process.env.CT_KEYS); } catch { /* ignore */ } }

class NeedAuth extends Error {
  constructor(p) { super(`Sign in to ${NAMES[p]} again`); this.needAuth = true; this.p = p; }
}
class HttpError extends Error {
  constructor(status, msg) { super(msg || `HTTP ${status}`); this.status = status; }
}

// ---------- token storage ----------
const tokFile = () => path.join(app.getPath('userData'), 'cloud-tokens.bin');
let TOK = null;

function loadTokens() {
  if (TOK) return TOK;
  TOK = {};
  try {
    const raw = fs.readFileSync(tokFile());
    const txt = safeStorage.isEncryptionAvailable() && raw[0] !== 0x7b ? safeStorage.decryptString(raw) : raw.toString('utf8');
    TOK = JSON.parse(txt) || {};
  } catch { /* none yet */ }
  return TOK;
}

function saveTokens() {
  const txt = JSON.stringify(TOK || {});
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt);
  fs.writeFileSync(tokFile(), data);
}

const connected = p => !!loadTokens()[p]?.rt;
const configured = p => !!KEYS[p]?.id;

// ---------- sign-in ----------
let authBusy = null;

function postToken(p, body) {
  const c = KEYS[p];
  if (c.sec) body.client_secret = c.sec;
  return fetch(p === 'g' ? 'https://oauth2.googleapis.com/token' : 'https://oauth.yandex.ru/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  }).then(r => r.json());
}

const toTok = (j, rt) => j && j.access_token
  ? { at: j.access_token, rt: j.refresh_token || rt, exp: Date.now() + (j.expires_in || 3600) * 1000 }
  : null;

// Opens the consent page. `pick` ('file' | 'folder') asks Google to show its file picker
// during sign-in; the chosen IDs come back on the redirect.
async function signIn(p, pick) {
  if (!configured(p)) throw new Error('Cloud isn’t set up in this build yet.');
  if (authBusy) throw new Error('Finish the sign-in that is already open in your browser.');
  const G = p === 'g';
  const c = KEYS[p];
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = G
    ? {
        client_id: c.id, redirect_uri: REDIRECT, response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive.file', code_challenge: challenge,
        code_challenge_method: 'S256', access_type: 'offline', prompt: 'select_account consent',
        ...(pick ? { trigger_onepick: 'true', allow_multiple: String(pick === 'file'), allow_folder_selection: String(pick === 'folder') } : {}),
      }
    : { client_id: c.id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', force_confirm: 'yes' };

  let picked = [];
  authBusy = new Promise((resolve, reject) => {
    let timer;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/cb') { res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<body style="background:#161616;color:#F6F1EB;font:20px system-ui,sans-serif;text-align:center;padding-top:30vh">' +
        'CocoaTune ✓<br><small style="color:#8f8780;font-size:14px">You can close this tab.</small></body>');
      clearTimeout(timer);
      srv.close();
      BrowserWindow.getAllWindows()[0]?.focus();
      picked = (u.searchParams.get('picked_file_ids') || '').split(',').filter(Boolean);
      const code = u.searchParams.get('code');
      code ? resolve(code) : reject(new Error(u.searchParams.get('error') === 'access_denied' ? 'Sign-in was cancelled' : 'Sign-in failed'));
    });
    srv.on('error', e => reject(e.code === 'EADDRINUSE' ? new Error('Another CocoaSuite app is signing in. Finish that first.') : e));
    srv.listen(PORT, '127.0.0.1', () => {
      shell.openExternal((G ? 'https://accounts.google.com/o/oauth2/v2/auth?' : 'https://oauth.yandex.ru/authorize?') + new URLSearchParams(params));
    });
    timer = setTimeout(() => { srv.close(); reject(new Error('Sign-in timed out')); }, 5 * 60 * 1000);
  });

  try {
    const code = await authBusy;
    const t = toTok(await postToken(p, { grant_type: 'authorization_code', code, client_id: c.id, redirect_uri: REDIRECT, code_verifier: verifier }), loadTokens()[p]?.rt);
    if (!t) throw new Error('Sign-in failed');
    TOK[p] = t;
    saveTokens();
    return picked;
  } finally {
    authBusy = null;
  }
}

async function token(p, force) {
  const t = loadTokens()[p];
  if (!t?.rt) throw new NeedAuth(p);
  if (!force && t.exp > Date.now() + 60000) return t.at;
  let j;
  try {
    j = await postToken(p, { grant_type: 'refresh_token', refresh_token: t.rt, client_id: KEYS[p].id });
  } catch (e) { throw netErr(e); }
  const nt = toTok(j, t.rt);
  if (!nt) {
    if (j && /invalid_grant|bad_verification_code|unauthorized/i.test(j.error || '')) { delete TOK[p]; saveTokens(); throw new NeedAuth(p); }
    throw new Error('Could not refresh sign-in');
  }
  TOK[p] = nt;
  saveTokens();
  return nt.at;
}

function signOut(p) {
  const t = loadTokens()[p];
  delete TOK[p];
  saveTokens();
  if (p === 'g' && t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.rt || t.at), { method: 'POST' }).catch(() => {});
}

const authHeader = (p, at) => ({ Authorization: (p === 'g' ? 'Bearer ' : 'OAuth ') + at });

function netErr(e) {
  if (e instanceof HttpError || e.needAuth) return e;
  const err = new Error('No internet connection');
  err.offline = true;
  return err;
}

async function api(p, url, opts = {}, retried = false) {
  const at = await token(p, retried);
  let r;
  try {
    r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...authHeader(p, at) } });
  } catch (e) { throw netErr(e); }
  if (r.status === 401 && !retried) return api(p, url, opts, true);
  if (!r.ok && r.status !== 308) {
    let msg = '';
    try { const j = await r.json(); msg = j.error?.message || j.message || j.description || ''; } catch { /* no body */ }
    throw new HttpError(r.status, msg ? `${NAMES[p]}: ${msg}` : undefined);
  }
  return r;
}
const apiJson = async (p, url, opts) => (await api(p, url, opts)).json();

// Streams a local file to a URL with progress (fetch has no upload progress).
function putFile(url, filePath, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const req = https.request(new URL(url), { method: 'PUT', headers: { ...headers, 'Content-Length': size } }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 300) return reject(new HttpError(res.statusCode));
        try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
      });
      res.on('error', e => reject(netErr(e)));
    });
    req.on('error', e => reject(netErr(e)));
    let sent = 0;
    const rs = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    rs.on('data', c => { sent += c.length; onProgress?.(size ? sent / size : 1); });
    rs.on('error', reject);
    rs.pipe(req);
  });
}

// ---------- Google Drive ----------
const G = {
  async account() {
    const j = await apiJson('g', GA + 'drive/v3/about?fields=user(emailAddress,displayName)');
    return j.user?.emailAddress || j.user?.displayName || '';
  },
  async meta(id) {
    return apiJson('g', `${GA}drive/v3/files/${id}?${SD}&fields=id,name,size,mimeType`);
  },
  async findChild(parent, name, folder) {
    const q = `'${parent}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false` + (folder ? ` and mimeType='${GF}'` : '');
    const j = await apiJson('g', GA + 'drive/v3/files?' + new URLSearchParams({ q, fields: 'files(id,name)', supportsAllDrives: true, includeItemsFromAllDrives: true }));
    return j.files[0]?.id || null;
  },
  async mkdir(parent, name) {
    return (await this.findChild(parent, name, true)) ||
      (await apiJson('g', GA + 'drive/v3/files?' + SD, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: GF, parents: [parent] }),
      })).id;
  },
  // Returns { base, music } folder IDs, creating them when missing.
  async folders(folder) {
    const base = folder?.id || await this.mkdir('root', 'CocoaTune');
    return { base, music: await this.mkdir(base, 'Music') };
  },
  async readJson(dir, name) {
    const id = await this.findChild(dir, name);
    if (!id) return null;
    return (await api('g', `${GA}drive/v3/files/${id}?alt=media&${SD}`)).json();
  },
  async writeJson(dir, name, obj) {
    const id = await this.findChild(dir, name);
    const body = JSON.stringify(obj);
    if (id) {
      await api('g', `${GA}upload/drive/v3/files/${id}?uploadType=media&${SD}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      return;
    }
    const b = 'ctune' + crypto.randomBytes(8).toString('hex');
    const multi = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [dir] })}\r\n` +
      `--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    await api('g', `${GA}upload/drive/v3/files?uploadType=multipart&${SD}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: multi });
  },
  async upload(dir, filePath, name, mime, onProgress) {
    const size = fs.statSync(filePath).size;
    const r = await api('g', `${GA}upload/drive/v3/files?uploadType=resumable&${SD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name, parents: [dir] }),
    });
    const loc = r.headers.get('location');
    if (!loc) throw new Error('Google Drive did not accept the upload');
    const j = await putFile(loc, filePath, { 'Content-Type': mime }, onProgress);
    return j.id;
  },
  async target(id) {
    return { url: `${GA}drive/v3/files/${id}?alt=media&${SD}`, headers: authHeader('g', await token('g')) };
  },
  async remove(id) {
    await api('g', `${GA}drive/v3/files/${id}?${SD}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  },
};

// ---------- Yandex Disk ----------
const yPath = (dir, name) => dir + (dir.endsWith('/') ? '' : '/') + name;
const hrefCache = new Map();

const Y = {
  async account() {
    const j = await apiJson('y', YA);
    return j.user?.login || j.user?.display_name || '';
  },
  async mkdir(p) {
    try { await api('y', `${YA}/resources?path=${encodeURIComponent(p)}`, { method: 'PUT' }); }
    catch (e) { if (e.status !== 409) throw e; }
    return p;
  },
  async folders(folder) {
    const base = folder?.id || await this.mkdir('app:/CocoaTune');
    return { base, music: await this.mkdir(yPath(base, 'Music')) };
  },
  async list(dir) {
    const j = await apiJson('y', `${YA}/resources?` + new URLSearchParams({ path: dir, limit: 1000, sort: 'name' }));
    const items = j._embedded?.items || [];
    return {
      dirs: items.filter(i => i.type === 'dir').map(i => ({ id: i.path, name: i.name })),
      files: items.filter(i => i.type === 'file').map(i => ({ id: i.path, name: i.name, size: i.size || 0, mime: i.mime_type || '', audio: i.media_type === 'audio' })),
    };
  },
  async href(p, kind) {
    return (await apiJson('y', `${YA}/resources/${kind}?` + new URLSearchParams({ path: p, ...(kind === 'upload' ? { overwrite: 'true' } : {}) }))).href;
  },
  async readJson(dir, name) {
    let h;
    try { h = await this.href(yPath(dir, name), 'download'); }
    catch (e) { if (e.status === 404) return null; throw e; }
    try { return await (await fetch(h)).json(); } catch (e) { throw netErr(e); }
  },
  async writeJson(dir, name, obj) {
    const h = await this.href(yPath(dir, name), 'upload');
    let r;
    try { r = await fetch(h, { method: 'PUT', body: JSON.stringify(obj) }); } catch (e) { throw netErr(e); }
    if (!r.ok) throw new HttpError(r.status);
  },
  async upload(dir, filePath, name, mime, onProgress) {
    const p = yPath(dir, name);
    await putFile(await this.href(p, 'upload'), filePath, {}, onProgress);
    return p;
  },
  async target(p) {
    const c = hrefCache.get(p);
    if (c && c.exp > Date.now()) return { url: c.url, headers: {} };
    const url = await this.href(p, 'download');
    hrefCache.set(p, { url, exp: Date.now() + 10 * 60 * 1000 });
    return { url, headers: {} };
  },
  async remove(p) {
    await api('y', `${YA}/resources?path=${encodeURIComponent(p)}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });
  },
};

module.exports = { NAMES, P: { g: G, y: Y }, signIn, signOut, connected, configured, NeedAuth, netErr, hrefCache };
