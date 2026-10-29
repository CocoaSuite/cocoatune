const api = window.cocoa;
const $ = id => document.getElementById(id);

let S = { tracks: [], playlists: [], jobs: [], pinned: false, mini: false };
let view = 'all';
let query = '';
let cur = null;
let queue = [];
let shuffle = false;
let repeat = 'off'; // off | all | one
const audio = new Audio();

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byId = id => S.tracks.find(t => t.id === id);
const icon = (el, name) => el.querySelector('use').setAttribute('href', '#i-' + name);

function fmt(s) {
  if (!isFinite(s) || s <= 0) return '0:00';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function visible() {
  const pl = S.playlists.find(p => p.id === view);
  let list = pl ? pl.trackIds.map(byId).filter(Boolean) : S.tracks.slice().reverse();
  if (view === 'local') list = list.filter(t => t.source === 'local');
  if (view === 'link') list = list.filter(t => t.source === 'link');
  if (query) {
    const q = query.toLowerCase();
    list = list.filter(t => `${t.title} ${t.origin}`.toLowerCase().includes(q));
  }
  return list;
}

// ---------- rendering ----------
function renderTabs() {
  const tabs = [['all', `All ${S.tracks.length}`], ['local', 'Local'], ['link', 'Links'],
    ...S.playlists.map(p => [p.id, p.name])];
  if (!tabs.some(t => t[0] === view)) view = 'all';
  const box = $('tabList');
  if (box.querySelector('.newPl')) return; // a playlist name is being typed
  setHtml(box, tabs.map(([id, label]) =>
    `<button class="tab${id === view ? ' a' : ''}" data-view="${esc(id)}">${esc(label)}</button>`).join('') +
    '<button class="tab add" id="addPl" title="New playlist">+</button>');
}

const STORE = {
  pc: ['i-pc', '', 'On this PC only'],
  up: ['i-cloud-up', '', 'Waiting to upload'],
  cloud: ['i-cloud', ' c', 'In the cloud · streams when played'],
  both: ['i-cloud-ok', ' c', 'In the cloud · saved on this PC'],
};
function storeIcon(t) {
  if (!S.cloud?.p) return '';
  const [ic, cls, tip] = STORE[t.where] || STORE.pc;
  return `<span class="st${cls}" title="${tip}"><svg><use href="#${ic}"/></svg></span>`;
}

// Replaces markup only when it changed, so frequent state updates don't swallow clicks.
function setHtml(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

function renderList() {
  const box = $('list');
  const rows = [];
  if (view === 'all' || view === 'link') {
    for (const j of S.jobs) {
      rows.push(`<div class="row job"><span class="n"></span><div class="t"><div>${esc(j.title)} ${j.progress ? Math.round(j.progress * 100) + '%' : ''}</div>
        <small>${esc(j.origin)}</small><div class="bar2"><i data-w="${(j.progress * 100).toFixed(1)}"></i></div></div>
        <span class="tag">LINK</span><span class="d">—</span><span class="more"></span></div>`);
    }
  }
  visible().forEach((t, i) => {
    const sub = t.source === 'local' ? `local · ${t.origin}` : t.origin;
    rows.push(`<div class="row${t.id === cur ? ' cur' : ''}" data-id="${t.id}">
      <span class="n">${i + 1}</span><div class="t"><div>${esc(t.title)}</div><small>${esc(sub)}</small></div>
      ${t.source === 'link' ? '<span class="tag">LINK</span>' : ''}${storeIcon(t)}<span class="d">${t.duration ? fmt(t.duration) : '—'}</span>
      <button class="more" title="More"><svg><use href="#i-more"/></svg></button></div>`);
  });
  if (!rows.length) {
    const pl = S.playlists.find(p => p.id === view);
    rows.push(`<div class="empty">${query ? 'No matches.' : pl
      ? 'This playlist is empty.<br>Use ⋯ on a track to add it here.'
      : 'Drop audio files here, use + Files,<br>or paste a link above.'}</div>`);
  }
  if (!setHtml(box, rows.join(''))) return;
  // Job progress widths are set through CSSOM so the CSP stays strict.
  box.querySelectorAll('.bar2 i').forEach(i => { i.style.width = i.dataset.w + '%'; });
}

function renderPlayer() {
  const t = byId(cur);
  const title = t ? t.title : 'Nothing playing';
  $('nowTitle').textContent = title;
  $('miniTitle').textContent = title;
  const playing = !audio.paused;
  for (const b of [$('play'), $('mPlay')]) { icon(b, playing ? 'pause' : 'play'); b.title = playing ? 'Pause' : 'Play'; }
  $('shuffle').classList.toggle('on', shuffle);
  $('repeat').classList.toggle('on', repeat !== 'off');
  $('repeat').classList.toggle('one', repeat === 'one');
  $('repeat').title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[repeat];
  $('pin').classList.toggle('on', S.pinned);
  document.body.classList.toggle('is-mini', S.mini);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.origin, album: 'CocoaTune' }) : null;
  }
  renderTime();
}

function renderTime() {
  const d = audio.duration || byId(cur)?.duration || 0;
  const pct = d ? Math.min(100, (audio.currentTime / d) * 100) : 0;
  const txt = `${fmt(audio.currentTime)} / ${fmt(d)}`;
  $('nowTime').textContent = txt;
  $('miniTime').textContent = txt;
  $('progFill').style.width = pct + '%';
  $('miniFill').style.width = pct + '%';
}

function render() { renderTabs(); renderList(); renderPlayer(); renderCloud(); }

// ---------- playback ----------
function play(id, list) {
  const t = byId(id);
  if (!t) return;
  if (list) queue = list.map(x => x.id);
  if (!queue.includes(id)) queue = visible().map(x => x.id);
  cur = id;
  audio.src = t.url;
  audio.play().catch(e => toast(`Can't play this file: ${e.message}`));
  renderList();
  renderPlayer();
}

function toggle() {
  if (!cur) { const first = visible()[0]; if (first) play(first.id, visible()); return; }
  audio.paused ? audio.play() : audio.pause();
}

function step(dir, auto = false) {
  queue = queue.filter(id => byId(id));
  if (!queue.length) return;
  if (auto && repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  let i = queue.indexOf(cur);
  if (shuffle && queue.length > 1) {
    let j;
    do { j = Math.floor(Math.random() * queue.length); } while (j === i);
    i = j;
  } else {
    i += dir;
    if (i >= queue.length || i < 0) {
      if (!auto || repeat === 'all') i = (i + queue.length) % queue.length;
      else { audio.pause(); audio.currentTime = 0; renderPlayer(); return; }
    }
  }
  play(queue[i]);
}

function prev() {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else step(-1);
}

audio.addEventListener('play', renderPlayer);
audio.addEventListener('pause', renderPlayer);
audio.addEventListener('timeupdate', renderTime);
audio.addEventListener('ended', () => step(1, true));
audio.addEventListener('loadedmetadata', () => {
  const t = byId(cur);
  if (t && !t.duration && isFinite(audio.duration)) api.setDuration(t.id, audio.duration);
});
audio.addEventListener('error', () => { if (cur) toast("This track couldn't be played."); });

// Fill in missing durations one at a time in the background.
const probing = new Set();
function probeDurations() {
  const t = S.tracks.find(x => !x.duration && x.where !== 'cloud' && !probing.has(x.id));
  if (!t) return;
  probing.add(t.id);
  const a = new Audio();
  a.preload = 'metadata';
  const done = () => { a.removeAttribute('src'); a.load(); probeDurations(); };
  a.onloadedmetadata = () => { if (isFinite(a.duration)) api.setDuration(t.id, a.duration); done(); };
  a.onerror = done;
  a.src = t.url + '?probe=1';
}

// ---------- seeking ----------
function seekFromEvent(e) {
  const r = $('prog').getBoundingClientRect();
  const d = audio.duration;
  if (!d || !isFinite(d)) return;
  audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
  renderTime();
}
$('prog').addEventListener('pointerdown', e => {
  $('prog').setPointerCapture(e.pointerId);
  seekFromEvent(e);
  const move = ev => seekFromEvent(ev);
  $('prog').addEventListener('pointermove', move);
  $('prog').addEventListener('pointerup', () => $('prog').removeEventListener('pointermove', move), { once: true });
});

// ---------- UI events ----------
$('play').onclick = $('mPlay').onclick = toggle;
$('next').onclick = $('mNext').onclick = () => step(1);
$('prev').onclick = $('mPrev').onclick = prev;
$('shuffle').onclick = () => { shuffle = !shuffle; renderPlayer(); };
$('repeat').onclick = () => { repeat = { off: 'all', all: 'one', one: 'off' }[repeat]; renderPlayer(); };
$('pin').onclick = () => api.setPinned(!S.pinned);
$('toMini').onclick = () => api.setMini(true);
$('expand').onclick = () => api.setMini(false);
$('menu').onclick = () => api.appMenu();
$('close').onclick = () => api.close();
$('minimize').onclick = () => api.minimize();
$('addFiles').onclick = () => api.importDialog().catch(toast);
$('mini').addEventListener('dblclick', e => { if (!e.target.closest('button')) api.setMini(false); });

$('linkForm').onsubmit = e => {
  e.preventDefault();
  const url = $('link').value.trim();
  if (!url) return;
  $('link').value = '';
  api.saveLink(url).then(() => toast('Saved to library')).catch(toast);
};

$('q').oninput = e => { query = e.target.value.trim(); renderList(); };

$('tabList').onclick = e => {
  const b = e.target.closest('.tab');
  if (!b) return;
  if (b.id === 'addPl') return newPlaylistInput(b);
  view = b.dataset.view;
  render();
};
$('tabList').oncontextmenu = e => {
  const b = e.target.closest('.tab');
  if (b && S.playlists.some(p => p.id === b.dataset.view)) { e.preventDefault(); api.playlistMenu(b.dataset.view); }
};

function newPlaylistInput(btn) {
  const input = document.createElement('input');
  input.className = 'newPl';
  input.placeholder = 'Playlist name';
  btn.replaceWith(input);
  input.focus();
  let finished = false;
  const finish = async ok => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (ok && name) view = await api.createPlaylist(name);
    input.remove();
    $('tabList')._html = null;
    render();
  };
  input.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

$('list').onclick = e => {
  const row = e.target.closest('.row[data-id]');
  if (!row) return;
  if (e.target.closest('.more')) return api.trackMenu(row.dataset.id, view);
  if (row.dataset.id === cur) return toggle();
  play(row.dataset.id, visible());
};
$('list').oncontextmenu = e => {
  const row = e.target.closest('.row[data-id]');
  if (row) { e.preventDefault(); api.trackMenu(row.dataset.id, view); }
};

// Drag and drop audio files from the desktop.
const app = $('full');
let dragDepth = 0;
app.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; app.classList.add('drop'); });
app.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; app.classList.remove('drop'); } });
app.addEventListener('dragover', e => e.preventDefault());
app.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('drop');
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (e.dataTransfer.files.length) api.importFiles(e.dataTransfer.files).catch(toast);
  else if (/^https?:\/\//.test(url)) api.saveLink(url.trim()).then(() => toast('Saved to library')).catch(toast);
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input')) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  if (e.code === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { e.preventDefault(); setVol((muted ? 0 : vol) + (e.code === 'ArrowUp' ? 0.05 : -0.05)); }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}

// ---------- theme ----------
const DEFAULT_THEME = { accent: '#D70C0C', bg: '#161616', text: '#F6F1EB' };
const PRESETS = [
  ['Cocoa', DEFAULT_THEME],
  ['Cream', { accent: '#D70C0C', bg: '#F6F1EB', text: '#1C1717' }],
  ['Mocha', { accent: '#C8743A', bg: '#1D1714', text: '#F3E6DA' }],
  ['Mint', { accent: '#21A366', bg: '#121615', text: '#EAF4EF' }],
  ['Ocean', { accent: '#2F7DF6', bg: '#11141A', text: '#E8EEF8' }],
  ['Grape', { accent: '#9B5CF6', bg: '#151219', text: '#F0EAF8' }],
];
let theme = { ...DEFAULT_THEME };

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = h => { const [r, g, b] = rgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

function applyTheme(t) {
  theme = { ...DEFAULT_THEME, ...t };
  const { accent, bg, text } = theme;
  const dark = lum(bg) < 0.5;
  const vars = {
    '--bg': bg, '--text': text, '--red': accent,
    '--panel': mix(bg, text, 0.03), '--hover': mix(bg, text, 0.025), '--row': mix(bg, text, 0.06),
    '--line': mix(bg, text, 0.1), '--mut': mix(text, bg, 0.45),
    '--field': dark ? mix(bg, '#000000', 0.3) : mix(bg, '#ffffff', 0.6),
    '--red-hi': mix(accent, dark ? '#ffffff' : '#000000', 0.12),
    '--on-red': lum(accent) > 0.62 ? '#111111' : '#F6F1EB',
  };
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  document.querySelectorAll('.sRow input').forEach(i => { i.value = theme[i.dataset.key]; });
  const key = JSON.stringify(theme).toLowerCase();
  $('presets').innerHTML = PRESETS.map(([name, p], i) =>
    `<button class="preset${JSON.stringify({ ...DEFAULT_THEME, ...p }).toLowerCase() === key ? ' a' : ''}" data-i="${i}">` +
    `<i data-c="${p.accent}"></i>${esc(name)}</button>`).join('');
  $('presets').querySelectorAll('i').forEach(i => { i.style.background = i.dataset.c; });
}

let themeTimer;
function setTheme(t) {
  applyTheme(t);
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => api.setTheme(theme), 150);
}

$('presets').onclick = e => { const b = e.target.closest('.preset'); if (b) setTheme(PRESETS[b.dataset.i][1]); };
document.querySelectorAll('.sRow input').forEach(i => { i.oninput = () => setTheme({ ...theme, [i.dataset.key]: i.value }); });
$('sReset').onclick = () => setTheme(DEFAULT_THEME);
$('sBack').onclick = () => document.body.classList.remove('is-settings');
$('sShortcut').onclick = () => api.createShortcuts({ desktop: true, startMenu: true })
  .then(() => toast('Shortcuts created')).catch(toast);
api.onOpenSettings(() => { api.setMini(false); document.body.classList.add('is-settings'); });

// ---------- first-run shortcut prompt ----------
$('wSkip').onclick = () => { document.body.classList.remove('is-welcome'); api.dismissWelcome(); };
$('wCreate').onclick = () => {
  document.body.classList.remove('is-welcome');
  api.createShortcuts({ desktop: $('wDesktop').checked, startMenu: $('wStart').checked })
    .then(() => toast('Shortcut created')).catch(toast);
};

applyTheme(DEFAULT_THEME);
// ---------- volume ----------
let vol = 0.8, muted = false;
try { const v = JSON.parse(localStorage.getItem('ct-volume')); if (v) { vol = Math.min(1, Math.max(0, +v.vol || 0)); muted = !!v.muted; } } catch { /* defaults */ }

function applyVol(save = true) {
  audio.volume = vol;
  audio.muted = muted;
  const shown = muted ? 0 : vol;
  $('vfill').style.height = shown * 100 + '%';
  $('vknob').style.bottom = shown * 100 + '%';
  $('vval').textContent = muted ? 'Mute' : Math.round(vol * 100);
  $('vpop').classList.toggle('muted', muted);
  icon($('vol'), muted || vol === 0 ? 'mute' : vol < 0.5 ? 'vol-low' : 'vol');
  $('vol').title = muted ? 'Volume: muted' : `Volume: ${Math.round(vol * 100)}`;
  if (save) { try { localStorage.setItem('ct-volume', JSON.stringify({ vol, muted })); } catch { /* not saved */ } }
}
function setVol(v) { vol = Math.min(1, Math.max(0, Math.round(v * 100) / 100)); muted = false; applyVol(); }
const nudge = e => { e.preventDefault(); setVol((muted ? 0 : vol) + (e.deltaY < 0 ? 0.05 : -0.05)); };
function showVol(on) { $('vpop').classList.toggle('open', on); $('vol').classList.toggle('open', on); }

$('vol').onclick = e => { e.stopPropagation(); showVol(!$('vpop').classList.contains('open')); };
$('vol').ondblclick = () => { muted = !muted; applyVol(); };
$('vol').addEventListener('wheel', nudge, { passive: false });
$('vpop').addEventListener('wheel', nudge, { passive: false });
$('mini').addEventListener('wheel', nudge, { passive: false });
$('vpop').onclick = e => e.stopPropagation();
document.addEventListener('click', () => showVol(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') showVol(false); });

const volFrom = e => { const r = $('vtr').getBoundingClientRect(); return (r.bottom - e.clientY) / r.height; };
$('vtr').addEventListener('pointerdown', e => {
  $('vtr').setPointerCapture(e.pointerId);
  setVol(volFrom(e));
  const move = ev => setVol(volFrom(ev));
  $('vtr').addEventListener('pointermove', move);
  $('vtr').addEventListener('pointerup', () => $('vtr').removeEventListener('pointermove', move), { once: true });
});
applyVol(false);

api.onToast(toast);
api.onOpenCloudImport(() => { api.setMini(false); openDlg('import', S.cloud?.p || 'g'); });
let themeLoaded = false;
api.onState(s => {
  S = s;
  if (!themeLoaded) {
    themeLoaded = true;
    applyTheme(s.theme || DEFAULT_THEME);
    document.body.classList.toggle('is-win', !!s.canShortcut);
    document.body.classList.toggle('is-welcome', !!s.welcome);
  }
  if (cur && !byId(cur)) { audio.pause(); audio.removeAttribute('src'); cur = null; }
  render();
  probeDurations();
});

// ---------- cloud ----------
const PN = { g: 'Google Drive', y: 'Yandex Disk' };
const busy = new Set();

async function act(key, fn, okMsg) {
  if (busy.has(key)) return;
  busy.add(key);
  renderCloud();
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; }
  catch (e) { toast(e.message || e); }
  finally { busy.delete(key); renderCloud(); }
}

function chipText(c) {
  return {
    syncing: ['i-cloud', 'Syncing…'], synced: ['i-cloud-ok', `${PN[c.p]} · synced`], offline: ['i-cloud-off', 'Offline'],
    auth: ['i-cloud-off', 'Sign in again'], error: ['i-cloud-off', 'Sync problem'],
  }[c.status] || ['i-cloud', PN[c.p]];
}

function renderCloud() {
  const c = S.cloud;
  if (!c) return;
  document.body.classList.toggle('has-cloud', !!c.p);
  const [ic, txt] = chipText(c);
  icon($('cloudChip'), ic.slice(2));
  $('cloudChip').querySelector('span').textContent = txt;
  $('cloudChip').classList.toggle('warn', ['offline', 'auth', 'error'].includes(c.status));
  $('cloudChip').title = c.error || 'Cloud library';

  document.body.classList.toggle('has-pill', !!c.upload);
  if (c.upload) {
    $('upText').textContent = `Uploading ${c.upload.n} song${c.upload.n === 1 ? '' : 's'}`;
    $('upFill').style.width = (c.upload.progress * 100).toFixed(1) + '%';
    $('upPct').textContent = Math.round(c.upload.progress * 100) + '%';
  }

  const prov = p => {
    const on = c.connected[p], active = c.p === p, b = busy.has('c' + p);
    const sub = !c.configured[p] ? 'Not available in this build'
      : on ? (c.accounts[p] || 'Connected') + (active ? '' : ' · not used for the library')
      : b ? 'Finish signing in in your browser…' : 'Not connected';
    const btns = !c.configured[p] ? ''
      : on ? (active ? '' : `<button class="b g" data-use="${p}">Use</button>`) + `<button class="b g" data-out="${p}">Sign out</button>`
      : `<button class="b r" data-in="${p}"${b ? ' disabled' : ''}>${b ? 'Waiting…' : 'Connect'}</button>`;
    return `<div class="prov"><span class="lg ${p}">${p === 'g' ? 'G' : 'Я'}</span><div>${PN[p]}<small${active ? ' class="act"' : ''}>${esc(sub)}</small></div><span class="btns">${btns}</span></div>`;
  };
  const off = c.p ? '' : ' off';
  const seg = (key, opts) => `<span class="seg${off}">${opts.map(([v, l]) => `<button data-${key}="${v}" class="${c[key] === v ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  const err = c.p && ['offline', 'auth', 'error'].includes(c.status) && c.error ? `<p class="hint err">${esc(c.error)}</p>` : '';
  setHtml($('cloudSet'), prov('g') + prov('y') +
    `<div class="sRow"><span>Library folder</span><span class="fold"><em>${esc(c.folder.name)}${c.folder.custom ? '' : ' (only you)'}</em>` +
    (c.p ? `<button class="b g" id="cfChange">Change…</button>` : '') + (c.folder.custom ? `<button class="b g" id="cfReset">Reset</button>` : '') + `</span></div>` +
    `<p class="hint">Pick a shared folder to share the library with someone else.</p>` +
    `<div class="sRow"><span>Store new music</span>${seg('store', [['local', 'This PC'], ['cloud', 'Cloud']])}</div>` +
    `<div class="sRow"><span>Offline copies</span>${seg('offline', [['none', 'None'], ['recent', 'Recent 2 GB'], ['all', 'All']])}</div>` +
    `<p class="hint">Cloud songs stream when you play them. Recently played songs are kept on this PC so they play offline.</p>` + err +
    `<div class="cloudBtns">` +
    (c.p && c.localCount ? `<button class="b g" id="cMove">Move ${c.localCount} song${c.localCount === 1 ? '' : 's'} from this PC to the cloud</button>` : '') +
    (c.p ? `<button class="b g" id="cSync">${c.status === 'syncing' ? 'Syncing…' : 'Sync now'}</button>` : '') + `</div>`);
}

$('cloudChip').onclick = () => document.body.classList.add('is-settings');
$('cloudSet').onclick = e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const d = b.dataset, cl = api.cloud;
  if (d.in) act('c' + d.in, () => cl.connect(d.in), `${PN[d.in]} connected`);
  else if (d.out) { if (confirm(`Sign out of ${PN[d.out]}? Songs that are only in the cloud won't play until you sign in again.`)) act('o', () => cl.signOut(d.out)); }
  else if (d.use) act('u', () => cl.use(d.use), `Library now uses ${PN[d.use]}`);
  else if (d.store) cl.set({ store: d.store });
  else if (d.offline) cl.set({ offline: d.offline });
  else if (b.id === 'cfChange') S.cloud.p === 'g' ? act('f', () => cl.folderGoogle()) : openDlg('folder', 'y');
  else if (b.id === 'cfReset') act('f', () => cl.folderSet(null));
  else if (b.id === 'cMove') act('m', () => cl.moveAll());
  else if (b.id === 'cSync') act('s', () => cl.sync());
};

// Dialog for adding cloud files (import) or choosing a Yandex Disk folder (folder).
const D = { mode: 'import', p: 'g', dir: 'disk:/', items: null, picked: new Set(), loading: false };
const kb = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.ceil(n / 1e3)) + ' KB';
const AUD = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|weba)$/i;

function openDlg(mode, p) {
  Object.assign(D, { mode, p, dir: 'disk:/', items: null, picked: new Set() });
  document.body.classList.add('is-dlg');
  renderDlg();
  if (p === 'y' && S.cloud?.connected.y) loadDir();
}
function closeDlg() { document.body.classList.remove('is-dlg'); }

async function loadDir() {
  D.loading = true; D.items = null; renderDlg();
  try { D.items = await api.cloud.list('y', D.dir); }
  catch (e) { D.items = { error: e.message || String(e) }; }
  D.loading = false; renderDlg();
}

function renderDlg() {
  const c = S.cloud || { connected: {} };
  const folder = D.mode === 'folder';
  $('cdTitle').textContent = folder ? 'Choose a library folder' : 'Add from cloud';
  $('cdTabs').innerHTML = folder ? '' : ['g', 'y'].map(p => `<button data-p="${p}" class="${D.p === p ? 'on' : ''}">${PN[p]}</button>`).join('');
  const list = $('cdList'), msg = $('cdMsg'), ok = $('cdOk');
  list.innerHTML = ''; msg.innerHTML = ''; $('cdPath').textContent = ''; $('cdInfo').textContent = '';
  ok.hidden = false;

  if (!c.connected[D.p]) {
    msg.innerHTML = `Connect ${PN[D.p]} first.<br><button class="b r" id="cdConnect">${busy.has('c' + D.p) ? 'Waiting…' : 'Connect'}</button>`;
    ok.hidden = true;
    return;
  }
  if (D.p === 'g') {
    msg.textContent = 'Google Drive opens its own file picker in your browser. Pick songs there and they’re added here. They stay in your Drive.';
    ok.textContent = busy.has('pg') ? 'Waiting…' : 'Choose in Google Drive…';
    return;
  }
  $('cdPath').textContent = ['Disk', ...D.dir.replace(/^disk:\/?/, '').split('/').filter(Boolean)].join(' / ');
  ok.textContent = folder ? 'Use this folder' : 'Add';
  if (D.loading || !D.items) { msg.textContent = 'Loading…'; return; }
  if (D.items.error) { msg.textContent = D.items.error; return; }
  const rows = [];
  if (D.dir !== 'disk:/') rows.push(`<button data-dir="${esc(D.dir.replace(/\/[^/]+\/?$/, '') || 'disk:/')}"><svg><use href="#i-back"/></svg><span>Back</span></button>`);
  for (const d of D.items.dirs) rows.push(`<button data-dir="${esc(d.id)}"><svg><use href="#i-folder"/></svg><span>${esc(d.name)}</span></button>`);
  if (!folder) {
    for (const f of D.items.files) {
      const audio = f.audio || AUD.test(f.name);
      rows.push(`<label class="${audio ? '' : 'na'}"><input type="checkbox" data-f="${esc(f.id)}"${D.picked.has(f.id) ? ' checked' : ''}${audio ? '' : ' disabled'}>` +
        `<span>${esc(f.name)}</span><small>${audio ? kb(f.size) : 'not audio'}</small></label>`);
    }
  }
  list.innerHTML = rows.join('');
  if (!rows.length || (folder && !D.items.dirs.length)) msg.textContent = folder ? 'No folders inside. Shared folders show up once you accept the invite.' : 'This folder is empty.';
  if (!folder) {
    $('cdInfo').textContent = D.picked.size ? `${D.picked.size} selected · stays in the cloud` : '';
    ok.disabled = !D.picked.size;
  } else ok.disabled = false;
}

$('cdTabs').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  D.p = b.dataset.p; D.items = null; D.picked.clear();
  renderDlg();
  if (D.p === 'y' && S.cloud?.connected.y) loadDir();
};
$('cdList').onclick = e => {
  const b = e.target.closest('button[data-dir]');
  if (b) { D.dir = b.dataset.dir; loadDir(); }
};
$('cdList').onchange = e => {
  const id = e.target.dataset.f;
  if (!id) return;
  e.target.checked ? D.picked.add(id) : D.picked.delete(id);
  renderDlg();
};
$('cdMsg').onclick = e => {
  if (e.target.id !== 'cdConnect') return;
  const p = D.p;
  act('c' + p, () => api.cloud.connect(p), `${PN[p]} connected`).then(() => { renderDlg(); if (p === 'y') loadDir(); });
  renderDlg();
};
$('cdCancel').onclick = closeDlg;
$('cdOk').onclick = async () => {
  if (D.p === 'g') {
    const n = await act('pg', () => api.cloud.pickGoogle());
    renderDlg();
    if (n != null) { closeDlg(); toast(n ? `Added ${n} song${n === 1 ? '' : 's'}` : 'Nothing new to add'); }
    return;
  }
  if (D.mode === 'folder') {
    const name = D.dir === 'disk:/' ? 'Disk' : D.dir.split('/').pop();
    closeDlg();
    act('f', () => api.cloud.folderSet({ id: D.dir, name }), `Library folder: ${name}`);
    return;
  }
  const files = D.items.files.filter(f => D.picked.has(f.id));
  closeDlg();
  act('a', () => api.cloud.add('y', files), n => n ? `Added ${n} song${n === 1 ? '' : 's'}` : 'Nothing new to add');
};
