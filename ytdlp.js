// Manages a private copy of yt-dlp: downloads it on first use, keeps it updated,
// and uses it to save the audio track from page links (YouTube, SoundCloud, ...).
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform];
const binDir = () => path.join(app.getPath('userData'), 'bin');
const binPath = () => path.join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const stampPath = () => path.join(binDir(), 'last-update');
const UPDATE_EVERY = 3 * 24 * 3600 * 1000;

let installing = null;

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function install() {
  if (!ASSET) throw new Error('Link saving is not supported on this platform');
  await fsp.mkdir(binDir(), { recursive: true });
  const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`);
  if (!res.ok) throw new Error(`Could not download yt-dlp (${res.status})`);
  const tmp = binPath() + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, binPath());
  await fsp.writeFile(stampPath(), String(Date.now()));
}

function ensure() {
  if (!installing) {
    installing = (async () => { if (!(await exists(binPath()))) await install(); })()
      .finally(() => { installing = null; });
  }
  return installing;
}

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(binPath(), args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    let err = '';
    const feed = (buf, isErr) => {
      const text = buf.toString('utf8');
      if (isErr) err += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line);
    };
    p.stdout.on('data', b => feed(b, false));
    p.stderr.on('data', b => feed(b, true));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) return resolve();
      const msg = (err.match(/ERROR:\s*(.+)/) || [])[1] || `yt-dlp exited with code ${code}`;
      reject(new Error(msg.trim()));
    });
  });
}

async function update(force = false) {
  await ensure();
  if (!force) {
    const last = Number(await fsp.readFile(stampPath(), 'utf8').catch(() => 0));
    if (Date.now() - last < UPDATE_EVERY) return;
  }
  await run(['-U']);
  await fsp.writeFile(stampPath(), String(Date.now()));
}

// Saves the best available audio stream without re-encoding, so no ffmpeg is needed.
async function download(url, dir, id, onProgress) {
  await ensure();
  let result = null;
  await run([
    '--no-playlist', '--no-warnings', '--newline', '--progress', '--no-simulate',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '-o', path.join(dir, `${id}.%(ext)s`),
    '--print', 'after_move:CTUNE\t%(title)s\t%(duration)s\t%(filepath)s',
    url,
  ], line => {
    const pct = line.match(/\[download\]\s+([\d.]+)%/);
    if (pct) onProgress(Number(pct[1]) / 100);
    if (line.startsWith('CTUNE\t')) {
      const [, title, duration, filepath] = line.split('\t');
      result = { title, duration: Number(duration) || 0, file: path.basename(filepath) };
    }
  });
  if (!result) throw new Error('No audio was found at that link');
  return result;
}

module.exports = { ensure, update, download };
