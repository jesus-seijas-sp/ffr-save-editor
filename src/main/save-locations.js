// Finds Final Fantasy Resonance save folders.
//   Windows:       %LOCALAPPDATA%\FFRS\Steam\<SteamID64>\GameSaveData*.sav
//   Linux / Deck:  the game runs through Proton, so the same tree lives inside the Proton prefix:
//                  <library>/steamapps/compatdata/3259780/pfx/drive_c/users/steamuser/AppData/Local/FFRS/...
const fs = require('fs');
const path = require('path');

const APP_ID = '3259780';
const SLOT_FILE = /^GameSaveData\d+\.sav$/;
const PROTON_LOCAL = ['pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local'];

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function steamRoots({ platform, home, env }) {
  if (platform === 'win32') {
    return [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']
      .filter(Boolean).map((p) => path.win32.join(p, 'Steam'));
  }
  return [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'), // Flatpak
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),                // Snap
    path.join(home, 'Library', 'Application Support', 'Steam'),                            // macOS
  ];
}

// All Steam library folders: each root plus the "path" entries of steamapps/libraryfolders.vdf.
function steamLibraries(roots) {
  const libs = new Set();
  for (const root of roots) {
    if (!isDir(root)) continue;
    libs.add(root);
    const vdf = readText(path.join(root, 'steamapps', 'libraryfolders.vdf')) || readText(path.join(root, 'config', 'libraryfolders.vdf'));
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  return [...libs];
}

// SteamID64 -> persona name, from config/loginusers.vdf.
function steamAccounts(roots) {
  const names = {};
  for (const root of roots) {
    const vdf = readText(path.join(root, 'config', 'loginusers.vdf'));
    for (const m of vdf.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)) {
      const persona = /"PersonaName"\s+"([^"]*)"/.exec(m[2]);
      if (persona) names[m[1]] = persona[1];
    }
  }
  return names;
}

// Base "…/AppData/Local/FFRS" folders to scan, with a label for where they came from.
function baseFolders(opts) {
  const { platform, home, env } = opts;
  const bases = [];
  if (platform === 'win32' && env.LOCALAPPDATA) bases.push({ dir: path.win32.join(env.LOCALAPPDATA, 'FFRS'), source: 'Windows' });
  for (const lib of steamLibraries(steamRoots(opts))) {
    const prefix = path.join(lib, 'steamapps', 'compatdata', APP_ID);
    bases.push({ dir: path.join(prefix, ...PROTON_LOCAL, 'FFRS'), source: `Proton (${lib})` });
  }
  if (platform !== 'win32') {
    // in case a native build ever ships
    bases.push({ dir: path.join(home, '.local', 'share', 'FFRS'), source: 'Native' });
    bases.push({ dir: path.join(home, '.config', 'FFRS'), source: 'Native' });
  }
  return bases;
}

// Folders under `dir` (depth-limited) that directly contain GameSaveData*.sav.
function findSaveFolders(dir, depth = 3) {
  const out = [];
  const walk = (d, left) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    const saves = entries.filter((e) => e.isFile() && SLOT_FILE.test(e.name));
    if (saves.length) {
      const newest = Math.max(...saves.map((e) => { try { return fs.statSync(path.join(d, e.name)).mtimeMs; } catch { return 0; } }));
      out.push({ path: d, slots: saves.length, newest });
    }
    if (left > 0) for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name), left - 1);
  };
  walk(dir, depth);
  return out;
}

function detect(opts = {}) {
  const o = {
    platform: opts.platform || process.platform,
    home: opts.home || require('os').homedir(),
    env: opts.env || process.env,
  };
  const accounts = steamAccounts(steamRoots(o));
  const seen = new Set();
  const found = [];
  for (const { dir, source } of baseFolders(o)) {
    if (!isDir(dir)) continue;
    for (const f of findSaveFolders(dir)) {
      let key = f.path;
      try { key = fs.realpathSync(f.path); } catch { /* keep path */ }
      if (seen.has(key)) continue;
      seen.add(key);
      const id = path.basename(f.path);
      found.push({ ...f, source, account: /^\d{17}$/.test(id) ? (accounts[id] ? `${accounts[id]} (${id})` : id) : '' });
    }
  }
  return found.sort((a, b) => b.newest - a.newest);
}

// For a folder picked by hand: the folder itself if it holds saves, otherwise the saves found below it.
function resolvePicked(dir) {
  return findSaveFolders(dir, 4).sort((a, b) => b.newest - a.newest);
}

// The installed game: Steam's appmanifest_3259780.acf in any library gives the build id and folder.
function findGameInstall(opts = {}) {
  const o = { platform: opts.platform || process.platform, home: opts.home || require('os').homedir(), env: opts.env || process.env };
  for (const lib of steamLibraries(steamRoots(o))) {
    const acf = readText(path.join(lib, 'steamapps', `appmanifest_${APP_ID}.acf`));
    if (!acf) continue;
    const get = (k) => (new RegExp(`"${k}"\\s+"([^"]*)"`).exec(acf) || [])[1] || '';
    return { buildId: get('buildid'), installDir: path.join(lib, 'steamapps', 'common', get('installdir')), library: lib };
  }
  return null;
}

module.exports = { APP_ID, detect, resolvePicked, findSaveFolders, findGameInstall };
