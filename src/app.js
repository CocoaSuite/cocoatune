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
  box.innerHTML = tabs.map(([id, label]) =>
    `<button class="tab${id === view ? ' a' : ''}" data-view="${esc(id)}">${esc(label)}</button>`).join('') +
    '<button class="tab add" id="addPl" title="New playlist">+</button>';
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
      ${t.source === 'link' ? '<span class="tag">LINK</span>' : ''}<span class="d">${t.duration ? fmt(t.duration) : '—'}</span>
      <button class="more" title="More"><svg><use href="#i-more"/></svg></button></div>`);
  });
  if (!rows.length) {
    const pl = S.playlists.find(p => p.id === view);
    rows.push(`<div class="empty">${query ? 'No matches.' : pl
      ? 'This playlist is empty.<br>Use ⋯ on a track to add it here.'
      : 'Drop audio files here, use + Files,<br>or paste a link above.'}</div>`);
  }
  box.innerHTML = rows.join('');
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

function render() { renderTabs(); renderList(); renderPlayer(); }

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
  const t = S.tracks.find(x => !x.duration && !probing.has(x.id));
  if (!t) return;
  probing.add(t.id);
  const a = new Audio();
  a.preload = 'metadata';
  const done = () => { a.removeAttribute('src'); a.load(); probeDurations(); };
  a.onloadedmetadata = () => { if (isFinite(a.duration)) api.setDuration(t.id, a.duration); done(); };
  a.onerror = done;
  a.src = t.url;
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
    renderTabs();
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
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}

api.onToast(toast);
api.onState(s => {
  S = s;
  if (cur && !byId(cur)) { audio.pause(); audio.removeAttribute('src'); cur = null; }
  render();
  probeDurations();
});
