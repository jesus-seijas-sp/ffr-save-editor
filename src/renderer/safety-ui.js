'use strict';
/* Game status line (running / build), save-format check, and the Backups window.
   Uses globals from renderer.js (S, $, h, api, status, sfx, setDir, has). */

// ---------- game status ----------
const GAME = { running: false, build: null };

async function refreshGameState() {
  try { Object.assign(GAME, await api.gameInfo()); } catch { return; }
  const el = $('gameState');
  const b = GAME.build;
  const build = !b ? 'game install not found' : b.known ? `build ${b.buildId} ✓` : `build ${b.buildId} — untested!`;
  el.textContent = `${GAME.running ? '● Game running' : '○ Game closed'} · ${build}`;
  el.className = `game-state ${GAME.running ? 'running' : ''} ${b && !b.known ? 'untested' : ''}`;
  el.title = b ? `${b.installDir}${b.known ? `\n${b.label}` : '\nThis game build has not been tested with the editor. A game update may have changed the save format.'}` : '';
}

// ---------- save-format check ----------
// Confirms a decrypted save has the layout the editor understands before allowing writes.
// Only data after the end is blocking: it means the parser lost its place, so field offsets can't be trusted.
// Missing sections (no Gil, no items yet...) just leave those screens empty.
function checkSaveFormat() {
  const p = S.parsed;
  const missing = ['Player.currentMoney'].filter((k) => !has(k))
    .concat(['inventory', 'unitParameterList', 'visionList'].filter((k) => !p.arrays.has(k)));
  const tail = S.bytes.subarray(p.end);
  const tailOk = tail.length < 32 && tail.every((b) => b === 0);
  S.readOnly = tailOk ? '' : `unexpected data at the end: ${tail.length} bytes after offset ${p.end} of ${S.bytes.length}`;
  if (S.readOnly) {
    status(`Unrecognized save layout (${S.readOnly}) — opened read-only, saving is disabled.`, 'error');
    return false;
  }
  if (missing.length) {
    status(`Loaded ${S.file.split(/[\\/]/).pop()} — this save has no ${missing.join(', ')}; those screens stay empty.`);
    return false;
  }
  return true;
}

// ---------- backups window ----------
const BACKUPS = { items: [], idx: 0 };

async function openBackupDialog() {
  if (!S.dir) { status('Choose a save folder first.', 'error'); return; }
  await renderBackupList();
  if (!$('backupDialog').open) $('backupDialog').showModal();
}

async function renderBackupList(msg = '') {
  BACKUPS.items = await api.listBackups(S.dir);
  BACKUPS.idx = Math.min(BACKUPS.idx, Math.max(0, BACKUPS.items.length - 1));
  $('backupMsg').textContent = msg || (BACKUPS.items.length ? 'Choose a backup to restore (newest first):' : 'No backups yet for this save folder.');
  $('backupList').replaceChildren(...BACKUPS.items.map((b, i) => {
    const when = new Date(b.time).toLocaleString();
    const li = b.type === 'full'
      ? h('li', {}, h('div', { class: 'folder-info' },
        h('div', {}, `All slots — ${when}`, b.label ? h('span', { class: 'owned' }, `  (${b.label})`) : ''),
        h('div', { class: 'folder-sub' }, `${b.files.length} save files · ${b.path}`)))
      : h('li', {}, h('div', { class: 'folder-info' },
        h('div', {}, `${b.target} — ${when}`),
        h('div', { class: 'folder-sub' }, `Copy made before saving · ${b.name}`)));
    li.addEventListener('mouseenter', () => { BACKUPS.idx = i; markBackup(); });
    li.addEventListener('click', () => { BACKUPS.idx = i; restoreSelected(); });
    return li;
  }));
  markBackup();
}

function markBackup() {
  [...$('backupList').children].forEach((li, i) => li.classList.toggle('active', i === BACKUPS.idx));
  const cur = $('backupList').children[BACKUPS.idx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

async function restoreSelected() {
  const b = BACKUPS.items[BACKUPS.idx];
  if (!b) return;
  if (S.dirty && !confirm('Discard unsaved changes and restore a backup?')) return;
  sfx('confirm');
  try {
    const r = await api.restoreBackup(S.dir, b.path);
    if (!r) return;
    $('backupDialog').close();
    await setDir(S.dir);
    sfx('save');
    status(`Restored ${r.restored} file${r.restored === 1 ? '' : 's'}. The previous files were backed up to ${r.safety}`, 'ok');
  } catch (e) {
    status(`Restore failed: ${e.message}`, 'error');
  }
}

async function backupAllNow() {
  try {
    const r = await api.backupAll(S.dir);
    if (!r) return;
    sfx('save');
    await renderBackupList(`Backed up ${r.files} files to ${r.path}`);
  } catch (e) {
    status(`Backup failed: ${e.message}`, 'error');
  }
}

function backupKey(e) {
  const k = e.key;
  if ((k === 'ArrowUp' || k === 'ArrowDown') && BACKUPS.items.length) {
    e.preventDefault();
    BACKUPS.idx = (BACKUPS.idx + (k === 'ArrowUp' ? -1 : 1) + BACKUPS.items.length) % BACKUPS.items.length;
    markBackup(); sfx('cursor');
  } else if (k === 'Enter' || k === ' ') { e.preventDefault(); restoreSelected(); }
  else if (k.toLowerCase() === 'b') { e.preventDefault(); backupAllNow(); }
}

$('btnBackups').addEventListener('click', openBackupDialog);
$('btnBackupAll').addEventListener('click', backupAllNow);
$('btnBackupFolder').addEventListener('click', () => api.openBackupFolder(S.dir));
$('backupDialog').querySelector('[data-close]').addEventListener('click', () => $('backupDialog').close());
refreshGameState();
setInterval(refreshGameState, 5000);
