// Safety helpers: game-running detection, backups and restore, known game builds.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const GAME_EXE = 'FFRS-Win64-Shipping.exe';
// Steam builds whose save format this editor was verified against.
const KNOWN_BUILDS = { '24250053': 'Oct 2026 release (verified)' };
const SLOT_FILE = /^GameSaveData(\d+)\.sav$/;
const BAK_FILE = /^(GameSaveData\d+\.sav)\.(\d{8}-\d{6})(?:-[\w-]+)?\.bak$/;

// Resolves true when the game process is running (Windows natively, or under Proton/Wine on Linux).
function isGameRunning(platform = process.platform) {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile('tasklist', ['/FI', `IMAGENAME eq ${GAME_EXE}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, out) => {
        resolve(!err && out.toLowerCase().includes(GAME_EXE.toLowerCase()));
      });
    } else {
      execFile('ps', ['-eo', 'args'], (err, out) => resolve(!err && out.includes(GAME_EXE)));
    }
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const parseStamp = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)).getTime();

// Full backups live outside the game folder (so Steam Cloud never syncs them):
//   <backupRoot>/<save folder name>/<timestamp>/GameSaveData*.sav
const folderBackups = (backupRoot, saveDir) => path.join(backupRoot, path.basename(saveDir));

function backupAll(backupRoot, saveDir, label = '') {
  const files = fs.readdirSync(saveDir).filter((f) => SLOT_FILE.test(f));
  if (!files.length) throw new Error('No GameSaveData*.sav files to back up.');
  const suffix = label ? `-${label}` : '';
  let dest = path.join(folderBackups(backupRoot, saveDir), stamp() + suffix);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(folderBackups(backupRoot, saveDir), `${stamp()}-n${i}${suffix}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(saveDir, f), path.join(dest, f));
  return { path: dest, files: files.length };
}

// Every backup for a save folder: full-folder backups and the single-file .bak copies made on save.
function listBackups(backupRoot, saveDir) {
  const out = [];
  const root = folderBackups(backupRoot, saveDir);
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d);
      let files = [];
      try { files = fs.readdirSync(p).filter((f) => SLOT_FILE.test(f)); } catch { continue; }
      if (!files.length) continue;
      const m = /^(\d{8}-\d{6})(?:-n\d+)?(?:-(.+))?$/.exec(d);
      out.push({ type: 'full', path: p, name: d, files, label: m && m[2] ? m[2] : '', time: m ? parseStamp(m[1]) : fs.statSync(p).mtimeMs });
    }
  }
  if (fs.existsSync(saveDir)) {
    for (const f of fs.readdirSync(saveDir)) {
      const m = BAK_FILE.exec(f);
      if (m) out.push({ type: 'file', path: path.join(saveDir, f), name: f, target: m[1], time: parseStamp(m[2]) });
    }
  }
  return out.sort((a, b) => b.time - a.time);
}

// Restores a backup. The current files are backed up first (labelled "before-restore") so a restore can be undone.
function restoreBackup(backupRoot, saveDir, item) {
  const safety = backupAll(backupRoot, saveDir, 'before-restore');
  if (item.type === 'full') {
    for (const f of item.files) fs.copyFileSync(path.join(item.path, f), path.join(saveDir, f));
    return { restored: item.files.length, safety: safety.path };
  }
  if (item.type === 'file') {
    if (path.resolve(path.dirname(item.path)) !== path.resolve(saveDir) ||!BAK_FILE.test(path.basename(item.path))) throw new Error('Not a backup of this folder.');
    fs.copyFileSync(item.path, path.join(saveDir, item.target));
    return { restored: 1, safety: safety.path };
  }
  throw new Error('Unknown backup type.');
}

module.exports = { GAME_EXE, KNOWN_BUILDS, isGameRunning, backupAll, listBackups, restoreBackup, stamp };
