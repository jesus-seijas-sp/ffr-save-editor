// Backups/restore, game-build lookup and the running-game check, in a temp directory.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const safety = require('../src/main/safety');
const { findGameInstall, APP_ID } = require('../src/main/save-locations');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffrs-safety-'));
  try {
    const saves = path.join(tmp, 'Steam', '76561198000000001');
    const root = path.join(tmp, 'backups');
    fs.mkdirSync(saves, { recursive: true });
    const write = (f, s) => fs.writeFileSync(path.join(saves, f), s);
    const read = (f) => fs.readFileSync(path.join(saves, f), 'utf8');
    write('GameSaveData0.sav', 'auto-v1'); write('GameSaveData1.sav', 'slot1-v1');

    // full backup, then the files change
    const b = safety.backupAll(root, saves);
    assert.strictEqual(b.files, 2);
    write('GameSaveData1.sav', 'slot1-v2');
    write('GameSaveData1.sav.20260101-120000.bak', 'slot1-old'); // a per-save backup made by the editor

    let list = safety.listBackups(root, saves);
    assert.strictEqual(list.filter((x) => x.type === 'full').length, 1);
    const bak = list.find((x) => x.type === 'file');
    assert.strictEqual(bak.target, 'GameSaveData1.sav');

    // restore a single .bak: current files are kept as a "before-restore" backup first
    let r = safety.restoreBackup(root, saves, bak);
    assert.strictEqual(r.restored, 1);
    assert.strictEqual(read('GameSaveData1.sav'), 'slot1-old');
    assert(fs.readFileSync(path.join(r.safety, 'GameSaveData1.sav'), 'utf8') === 'slot1-v2', 'pre-restore copy kept');

    // restore the full backup
    const full = safety.listBackups(root, saves).find((x) => x.type === 'full' && !x.label);
    r = safety.restoreBackup(root, saves, full);
    assert.strictEqual(r.restored, 2);
    assert.strictEqual(read('GameSaveData1.sav'), 'slot1-v1');
    assert.strictEqual(read('GameSaveData0.sav'), 'auto-v1');
    list = safety.listBackups(root, saves);
    assert.strictEqual(list.filter((x) => x.label === 'before-restore').length, 2);

    // a .bak path outside the save folder is refused
    const elsewhere = path.join(tmp, 'GameSaveData1.sav.20260101-120000.bak');
    fs.writeFileSync(elsewhere, 'evil');
    assert.throws(() => safety.restoreBackup(root, saves, { type: 'file', path: elsewhere, target: 'GameSaveData1.sav' }));

    // game build from a Steam manifest (Linux layout)
    const home = path.join(tmp, 'home');
    const steamapps = path.join(home, '.local', 'share', 'Steam', 'steamapps');
    fs.mkdirSync(steamapps, { recursive: true });
    fs.writeFileSync(path.join(steamapps, `appmanifest_${APP_ID}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${APP_ID}"\n\t"installdir"\t\t"FINAL FANTASY RESONANCE"\n\t"buildid"\t\t"24250053"\n}\n`);
    const g = findGameInstall({ platform: 'linux', home, env: {} });
    assert.strictEqual(g.buildId, '24250053');
    assert(safety.KNOWN_BUILDS[g.buildId], 'current build is known');
    assert.strictEqual(findGameInstall({ platform: 'linux', home: path.join(tmp, 'nobody'), env: {} }), null);

    // running check returns a boolean
    assert.strictEqual(typeof (await safety.isGameRunning()), 'boolean');

    console.log('OK — backups, restore (file and full, undoable), path check, game build, running check');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
