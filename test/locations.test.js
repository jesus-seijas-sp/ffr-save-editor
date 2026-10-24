// Save-folder detection against fake Windows and Linux (Proton) layouts in a temp directory.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect, resolvePicked, APP_ID } = require('../src/main/save-locations');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffrs-loc-'));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const touch = (dir, name, mtime) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); if (mtime) fs.utimesSync(f, mtime, mtime); };
const PROTON = ['pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'FFRS', 'Steam'];

try {
  // --- Windows: %LOCALAPPDATA%\FFRS\Steam\<id> for two accounts, Steam persona names
  const local = mk('win', 'AppData', 'Local');
  const a = mk('win', 'AppData', 'Local', 'FFRS', 'Steam', '76561198000000001');
  const b = mk('win', 'AppData', 'Local', 'FFRS', 'Steam', '76561198000000002');
  touch(a, 'GameSaveData0.sav', new Date('2026-01-01')); touch(a, 'GameSaveData1.sav', new Date('2026-01-02'));
  touch(b, 'GameSaveData1.sav', new Date('2026-03-01'));
  const pf = mk('win', 'Program Files (x86)');
  mk('win', 'Program Files (x86)', 'Steam', 'config');
  fs.writeFileSync(path.join(pf, 'Steam', 'config', 'loginusers.vdf'),
    '"users"\n{\n\t"76561198000000001"\n\t{\n\t\t"AccountName"\t"acc1"\n\t\t"PersonaName"\t"Cloud"\n\t}\n}\n');
  let r = detect({ platform: 'win32', home: tmp, env: { LOCALAPPDATA: local, 'ProgramFiles(x86)': pf } });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].path, b, 'newest folder first');
  assert.strictEqual(r[1].account, 'Cloud (76561198000000001)', 'persona name from loginusers.vdf');
  assert.strictEqual(r[1].slots, 2);
  assert.strictEqual(r[0].source, 'Windows');

  // --- Linux: Steam in ~/.local/share/Steam, game installed in a second library listed in libraryfolders.vdf
  const home = mk('linux-home');
  const steam = mk('linux-home', '.local', 'share', 'Steam', 'steamapps');
  const lib2 = mk('games', 'SteamLibrary');
  fs.writeFileSync(path.join(steam, 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${path.join(home, '.local', 'share', 'Steam').replace(/\\/g, '\\\\')}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib2.replace(/\\/g, '\\\\')}"\n\t}\n}\n`);
  const deck = mk('games', 'SteamLibrary', 'steamapps', 'compatdata', APP_ID, ...PROTON, '76561198000000003');
  touch(deck, 'GameSaveData0.sav'); touch(deck, 'GameSaveData2.sav');
  r = detect({ platform: 'linux', home, env: {} });
  assert.strictEqual(r.length, 1, 'found the Proton prefix in the second library');
  assert.strictEqual(r[0].path, deck);
  assert(r[0].source.startsWith('Proton'), r[0].source);
  assert.strictEqual(r[0].slots, 2);

  // --- Linux: Flatpak Steam, default library
  const home2 = mk('flatpak-home');
  const fp = mk('flatpak-home', '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam', 'steamapps', 'compatdata', APP_ID, ...PROTON, '76561198000000004');
  touch(fp, 'GameSaveData1.sav');
  r = detect({ platform: 'linux', home: home2, env: {} });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].path, fp);

  // --- nothing installed
  assert.deepStrictEqual(detect({ platform: 'linux', home: mk('empty-home'), env: {} }), []);

  // --- manual pick of a parent folder finds the save folders below it
  const picked = resolvePicked(path.join(local, 'FFRS'));
  assert.deepStrictEqual(picked.map((f) => f.path).sort(), [a, b].sort());

  console.log('OK — save folder detection (Windows, Proton second library, Flatpak, none, manual pick)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
