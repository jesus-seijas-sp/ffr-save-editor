const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { decryptSave, encryptSave } = require('./save-crypto');
const locations = require('./save-locations');
const safety = require('./safety');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SLOT_FILE = /^GameSaveData(\d+)\.sav$/;

let win;
let dirty = false;

// Testing aids for screenshots: FFRS_SCALE renders at a fixed scale, FFRS_SIZE=WxH sets the content size.
if (process.env.FFRS_SCREENSHOT && process.env.FFRS_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.FFRS_SCALE);
const shotSize = process.env.FFRS_SCREENSHOT && /^(\d+)x(\d+)$/.exec(process.env.FFRS_SIZE || '');

// ---------- settings (remembered save folder) ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const hasSaves = (dir) => { try { return fs.readdirSync(dir).some((f) => SLOT_FILE.test(f)); } catch { return false; } };

// Startup folder: env override (testing) > remembered folder > newest detected folder.
function startDir() {
  if (process.env.FFRS_SAVE_DIR) return process.env.FFRS_SAVE_DIR;
  const remembered = loadSettings().saveDir;
  if (remembered && hasSaves(remembered)) return remembered;
  const found = locations.detect();
  return found.length ? found[0].path : '';
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

ipcMain.handle('saves:defaultDir', () => startDir());

ipcMain.handle('saves:detect', () => locations.detect());

ipcMain.handle('saves:remember', (_e, dir) => { saveSettings({ saveDir: dir }); return true; });

// Browse for a folder. Returns {dir} when it holds saves, {choices} when saves were found below it,
// {none: true} when there are none, or null when cancelled.
ipcMain.handle('saves:pickDir', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the Final Fantasy Resonance save folder',
    defaultPath: current || app.getPath('home'),
    properties: ['openDirectory', 'showHiddenFiles'],
  });
  if (r.canceled) return null;
  const dir = r.filePaths[0];
  if (hasSaves(dir)) return { dir };
  const below = locations.resolvePicked(dir);
  if (below.length === 1) return { dir: below[0].path };
  if (below.length > 1) return { choices: below.map((f) => ({ ...f, source: 'Inside the chosen folder', account: path.basename(f.path) })) };
  return { none: true, dir };
});

ipcMain.handle('saves:list', (_e, dir) => {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => SLOT_FILE.test(f))
    .map((f) => ({ file: f, path: path.join(dir, f), slot: Number(SLOT_FILE.exec(f)[1]), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.slot - b.slot);
});

ipcMain.handle('save:open', (_e, file) => {
  const { header, plain } = decryptSave(fs.readFileSync(file));
  return { header: new Uint8Array(header), plain: new Uint8Array(plain) };
});

// ---------- safety: running game, game build, backups ----------
const backupRoot = () => path.join(app.getPath('userData'), 'backups');

function gameBuild() {
  const g = locations.findGameInstall();
  if (!g) return null;
  return { ...g, known: !!safety.KNOWN_BUILDS[g.buildId], label: safety.KNOWN_BUILDS[g.buildId] || '' };
}

async function refuseIfRunning(action) {
  if (await safety.isGameRunning()) {
    await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['OK'], message: `Close the game before you ${action}.`,
      detail: 'Final Fantasy Resonance is running. It can overwrite the save files or load a half-written one.',
    });
    return true;
  }
  return false;
}

ipcMain.handle('game:info', async () => ({ running: await safety.isGameRunning(), build: gameBuild() }));

ipcMain.handle('backup:list', (_e, dir) => (dir ? safety.listBackups(backupRoot(), dir) : []));

ipcMain.handle('backup:all', async (_e, dir) => {
  if (await refuseIfRunning('back up the saves')) return null;
  return safety.backupAll(backupRoot(), dir);
});

ipcMain.handle('backup:restore', async (_e, dir, itemPath) => {
  // look the backup up again here instead of trusting what the page sent
  const item = safety.listBackups(backupRoot(), dir).find((b) => b.path === itemPath);
  if (!item) throw new Error('Backup not found.');
  if (await refuseIfRunning('restore a backup')) return null;
  const what = item.type === 'full' ? `all ${item.files.length} save files from ${new Date(item.time).toLocaleString()}` : `${item.target} from ${new Date(item.time).toLocaleString()}`;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Restore ${what}?`,
    detail: 'The current save files are backed up first (labelled "before-restore"), so this can be undone.',
  });
  if (response !== 0) return null;
  return safety.restoreBackup(backupRoot(), dir, item);
});

ipcMain.handle('backup:openFolder', (_e, dir) => {
  const p = dir ? path.join(backupRoot(), path.basename(dir)) : backupRoot();
  fs.mkdirSync(p, { recursive: true });
  return shell.openPath(p);
});

ipcMain.handle('save:write', async (_e, file, header, plain) => {
  if (await refuseIfRunning('save')) return null;
  const build = gameBuild();
  const buildNote = build && !build.known
    ? `\n\nWarning: game build ${build.buildId} has not been tested with this editor. A game update may have changed the save format.`
    : '';
  const { response } = await dialog.showMessageBox(win, {
    type: build && !build.known ? 'warning' : 'question', buttons: ['Save', 'Cancel'], defaultId: build && !build.known ? 1 : 0, cancelId: 1,
    message: 'Write changes to the save file?',
    detail: `${path.basename(file)}\n\nA backup copy is made first.${buildNote}`,
  });
  if (response !== 0) return null;
  const data = encryptSave(Buffer.from(header), Buffer.from(plain));
  decryptSave(data); // sanity check before touching the file
  const bak = `${file}.${timestamp()}.bak`;
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, data);
  return bak;
});

ipcMain.handle('catalog:get', () => {
  const read = (f, def) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return def; } };
  return { names: read('names_en.json', {}), equipment: read('equipment.json', []), items: read('items.json', []), progression: read('progression.json', {}), journal: read('journal.json', {}), maps: read('maps.json', []) };
});

ipcMain.on('state:dirty', (_e, value) => { dirty = !!value; });

ipcMain.handle('debug:screenshot', async () => {
  const out = process.env.FFRS_SCREENSHOT;
  if (!out) return;
  // FFRS_KEYS="Down,Enter,Shift+Right" — simulated key presses before the capture (testing aid)
  for (const token of (process.env.FFRS_KEYS || '').split(',').filter(Boolean)) {
    const parts = token.split('+');
    const keyCode = parts.pop();
    const modifiers = parts.map((m) => m.toLowerCase());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 10; i++) {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      break;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  app.quit();
});

function createWindow() {
  win = new BrowserWindow({
    width: shotSize ? +shotSize[1] : 1180, height: shotSize ? +shotSize[2] : 760, useContentSize: !!shotSize, minWidth: 900, minHeight: 560,
    title: 'FFR Save Editor',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: '#07081a',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { tab: process.env.FFRS_TAB || '', screenshot: process.env.FFRS_SCREENSHOT ? '1' : '' },
  });
  if (process.env.FFRS_SCREENSHOT) {
    win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message || ''}`));
  }
  win.on('close', (e) => {
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Discard changes', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'You have unsaved changes.', detail: 'Close the editor and discard them?',
    });
    if (r !== 0) e.preventDefault();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
