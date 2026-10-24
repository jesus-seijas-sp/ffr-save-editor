'use strict';
/* global FFRS, api */

const ARMOR_OK = { 1001: [9, 10], 1002: [9, 10], 1003: [10, 11], 1004: [9, 10], 1005: [10, 11], 1006: [10, 11], 1007: [9, 10], 1008: [10, 11] };
const MAX_ACCESSORIES = 2;
const SLOT_LABELS = { 0: 'Autosave', 1: 'Slot 1', 2: 'Slot 2', 3: 'Slot 3' };
const CATEGORIES = { All: null, Weapons: 'weapon', Armor: 'armor', Accessories: 'accessory', Consumables: 'consumable', 'Key items': 'key item', Artifacts: 'artifact' };

const S = { dir: '', saves: [], file: null, header: null, bytes: null, parsed: null, counts: new Map(), dirty: false, charIdx: 0, visIdx: 0 };
const CAT = { names: {}, equip: new Map(), items: new Map(), prog: {}, journal: {} };

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function status(msg, kind = '') {
  $('statusMsg').textContent = msg; $('status').className = `win help ${kind}`;
  if (kind === 'error') sfx('error');
}

// ---------- menu sounds (synthesized, no audio files) ----------
let audio = null;
let soundOn = (() => { try { return localStorage.getItem('sound') !== 'off'; } catch { return true; } })();
const SFX = {
  cursor: [[1320, 0.035]],
  confirm: [[990, 0.04], [1480, 0.06]],
  error: [[180, 0.12, 'sawtooth']],
  save: [[784, 0.08], [988, 0.08], [1175, 0.08], [1568, 0.18]],
};
function sfx(name) {
  if (!soundOn) return;
  try {
    audio = audio || new AudioContext();
    let t = audio.currentTime;
    for (const [freq, dur, type] of SFX[name]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur);
      t += dur * 0.9;
    }
  } catch { /* audio unavailable */ }
}
function toggleSound() {
  soundOn = !soundOn;
  try { localStorage.setItem('sound', soundOn ? 'on' : 'off'); } catch { /* ignore */ }
  $('btnSound').textContent = soundOn ? '♪ On' : '♪ Off';
  sfx('confirm');
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join(':');
}
function updateGilTime() {
  $('gil').textContent = has('Player.currentMoney') ? get('Player.currentMoney').toLocaleString('en-US') : '0';
  $('time').textContent = has('Player.PlayTime') ? fmtTime(get('Player.PlayTime')) : '--:--:--';
}

function nameOf(kind, id) { return CAT.names[`${kind}:${id}`] || `#${id}`; }
function itemInfo(id) { return CAT.equip.get(id) || CAT.items.get(id); }
// ---------- pictures (extracted from the local game install into data/images) ----------
const IMG = '../../data/images';
const WEAPON_ICON = { 1: 'Brade', 2: 'Katana', 3: 'Bow', 4: 'Hummer', 5: 'Book', 6: 'Gun', 7: 'Rod', 8: 'Whip' };
const ARMOR_ICON = { 9: 'HeavyArmor', 10: 'LightArmor', 11: 'Dress' };
function iconName(id) {
  const e = itemInfo(id);
  if (!e) return null;
  if (e.kind === 'weapon') return WEAPON_ICON[e.subtype];
  if (e.kind === 'armor') return ARMOR_ICON[e.subtype];
  if (e.kind === 'accessory') return 'Ling';
  if (e.kind === 'consumable') return 'Bug';
  if (e.kind === 'artifact') return 'Kira';
  if (/key|card/i.test(e.name)) return 'Key';
  if (/stone|magicite|jade|crystal/i.test(e.name)) return 'Crystal';
  if (/adamant|shard|ruby/i.test(e.name)) return 'Material02';
  return 'Material01';
}
function img(src, cls) {
  const el = h('img', { class: cls, src, alt: '', draggable: false });
  el.addEventListener('error', () => { el.style.visibility = 'hidden'; });
  return el;
}
function itemIcon(id) { const n = iconName(id); return n ? img(`${IMG}/items/${n}.png`, 'icon') : h('span', { class: 'icon' }); }
const faceImg = (uid, cls = 'face') => img(`${IMG}/faces/${uid}.png`, cls);
const visionImg = (vid, cls = 'face') => img(`${IMG}/visions/${vid}.png`, cls);

function statsText(e) { return Object.entries(e.stats || {}).map(([k, v]) => `${k} ${v}`).join(' '); }

function reparse() {
  S.parsed = FFRS.parse(S.bytes);
  S.counts = new Map();
  for (const key of S.parsed.fields.keys()) {
    const re = /\[(\d+)\]/g; let m;
    while ((m = re.exec(key))) {
      const prefix = key.slice(0, m.index), n = Number(m[1]) + 1;
      if ((S.counts.get(prefix) || 0) < n) S.counts.set(prefix, n);
    }
  }
}
const has = (p) => S.parsed.fields.has(p);
const get = (p) => FFRS.getField(S.bytes, S.parsed.fields.get(p));
const count = (prefix) => S.counts.get(prefix) || 0;

function setDirty(v) {
  S.dirty = v;
  $('btnSave').disabled = !S.file || !v;
  $('btnSave').classList.toggle('dirty', v);
  api.setDirty(v);
}

function setValue(path, text) {
  try {
    const before = get(path);
    FFRS.setField(S.bytes, S.parsed.fields.get(path), text);
    if (get(path) !== before) { setDirty(true); status('Unsaved changes — choose Save in the menu to write them.'); sfx('confirm'); updateGilTime(); }
    return true;
  } catch (e) {
    status(`${path}: ${e.message}`, 'error');
    return false;
  }
}

// Number input bound to a save path; applies on change, reverts on invalid input.
function numInput(path, cls = 'num', range = null) {
  const el = h('input', { class: cls, value: String(get(path)), title: path });
  el.addEventListener('focus', () => { el.dataset.orig = el.value; });
  el.addEventListener('change', () => {
    if (range && (Number(el.value) < range.min || Number(el.value) > range.max)) {
      status(`${path}: must be between ${range.min} and ${range.max}`, 'error');
      el.value = String(get(path)); return;
    }
    if (setValue(path, el.value)) { el.classList.remove('invalid'); el.classList.add('changed'); el.value = String(get(path)); }
    else { el.classList.add('invalid'); el.value = String(get(path)); }
  });
  return el;
}

// ---------- progression (tables extracted from the game: levels and vision mastery) ----------
const levelCurve = (uid) => (CAT.prog.levelExp || {})[uid] || null;     // cumulative EXP for levels 1..99
const masteryCurve = (vid) => (CAT.prog.masteryMrp || {})[vid] || null; // cumulative MRP for ranks 0..9
const awakeningMax = () => CAT.prog.awakeningMax || 4;
function levelOf(uid, exp) {
  const c = levelCurve(uid);
  if (!c) return null;
  let lv = 1;
  while (lv < c.length && c[lv] <= exp) lv++;
  return lv;
}
function expForLevel(uid, lv) { const c = levelCurve(uid); return c ? c[Math.max(1, Math.min(c.length, lv)) - 1] : null; }
function rankOf(vid, mrp) {
  const c = masteryCurve(vid);
  if (!c) return null;
  let r = 0;
  while (r + 1 < c.length && c[r + 1] <= mrp) r++;
  return r;
}
const stars = (n, max) => '★'.repeat(Math.max(0, Math.min(n, max))) + '☆'.repeat(Math.max(0, max - n));

function inventoryMap() {
  const m = new Map();
  for (let i = 0; i < count('inventory'); i++) m.set(get(`inventory[${i}].ItemId`), get(`inventory[${i}].Num`));
  return m;
}

// ---------- loading ----------
async function init() {
  const cat = await api.catalog();
  CAT.names = cat.names;
  CAT.prog = cat.progression || {};
  CAT.journal = cat.journal || {};
  for (const e of cat.equipment) CAT.equip.set(e.id, e);
  for (const e of cat.items) CAT.items.set(e.id, e);

  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.addEventListener('click', () => { sfx('cursor'); showTab(b.dataset.tab); });
  $('btnSound').addEventListener('click', toggleSound);
  $('btnSound').textContent = soundOn ? '♪ On' : '♪ Off';
  $('btnDir').addEventListener('click', () => openFolderDialog());
  $('folderDialog').querySelector('[data-close]').addEventListener('click', () => $('folderDialog').close());
  $('slot').addEventListener('change', () => openSave($('slot').value));
  $('btnReload').addEventListener('click', () => S.file && openSave(S.file));
  $('btnSave').addEventListener('click', save);
  $('invFilter').addEventListener('input', renderInventory);
  $('allFilter').addEventListener('input', debounce(renderAll, 150));
  $('btnAddItem').addEventListener('click', openAddDialog);
  initAddDialog();
  renderQuick();

  const q = new URLSearchParams(location.search);
  await setDir(await api.defaultDir());
  if (q.get('tab') === 'folder') openFolderDialog();
  else if (q.get('tab') === 'backups') openBackupDialog();
  else if (q.get('tab') === 'additem') { showTab('inventory'); openAddDialog(); $('addFilter').value = 'potion'; renderAddTable(); }
  else if (q.get('tab')) {
    showTab(q.get('tab'));
    if (typeof KB !== 'undefined') { KB.menu = Math.max(0, menuItems().findIndex((m) => m.dataset.tab === q.get('tab'))); kbRender(); }
  }
  if (q.get('screenshot')) document.fonts.ready.then(() => setTimeout(() => api.screenshot(), 600));
}

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

async function setDir(dir) {
  S.dir = dir || '';
  $('dir').textContent = S.dir || 'No save folder — choose Folder';
  $('dir').title = S.dir;
  S.saves = await api.listSaves(S.dir);
  const sel = $('slot');
  sel.replaceChildren(...S.saves.map((s) => h('option', { value: s.path },
    `${SLOT_LABELS[s.slot] || `Slot ${s.slot}`} — ${s.file} (${new Date(s.mtime).toLocaleString()})`)));
  const pick = S.saves.find((s) => s.slot === 1) || S.saves[0];
  if (pick) { await openSave(pick.path, true); return true; }
  status(S.dir ? 'No GameSaveData*.sav files in this folder.' : 'No save folder found — choose one.', 'error');
  await openFolderDialog(S.dir ? 'That folder has no saves. Pick another one:' : 'No save folder was found automatically. Pick one:');
  return false;
}

// ---------- save folder dialog ----------
const FOLDER = { items: [], idx: 0 };

async function openFolderDialog(msg = '') {
  const dlg = $('folderDialog');
  $('folderMsg').textContent = msg || 'Detected save folders (newest first):';
  $('folderCurrent').textContent = S.dir ? `Current: ${S.dir}` : '';
  renderFolderList(await api.detectDirs());
  if (!dlg.open) dlg.showModal();
}

function renderFolderList(found) {
  FOLDER.items = [
    ...found.map((f) => ({ type: 'dir', ...f })),
    { type: 'browse' },
  ];
  FOLDER.idx = Math.max(0, FOLDER.items.findIndex((f) => f.path === S.dir));
  if (!found.length) $('folderMsg').textContent += ' — none found automatically.';
  $('folderList').replaceChildren(...FOLDER.items.map((f, i) => {
    const li = f.type === 'browse'
      ? h('li', {}, h('div', {}, h('div', {}, 'Browse for a folder…'),
        h('div', { class: 'folder-sub' }, 'Pick the folder that contains GameSaveData0.sav … GameSaveData3.sav (or any folder above it).')))
      : h('li', {}, h('div', { class: 'folder-info' },
        h('div', {}, f.account || 'Save folder', f.path === S.dir ? h('span', { class: 'owned' }, '  (current)') : ''),
        h('div', { class: 'folder-sub' }, f.path),
        h('div', { class: 'folder-sub' }, `${f.slots} save file${f.slots === 1 ? '' : 's'} · last saved ${new Date(f.newest).toLocaleString()} · ${f.source}`)));
    li.addEventListener('mouseenter', () => { FOLDER.idx = i; markFolder(); });
    li.addEventListener('click', () => { FOLDER.idx = i; chooseFolderItem(); });
    return li;
  }));
  markFolder();
}

function markFolder() {
  [...$('folderList').children].forEach((li, i) => li.classList.toggle('active', i === FOLDER.idx));
  const cur = $('folderList').children[FOLDER.idx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

async function chooseFolderItem() {
  const it = FOLDER.items[FOLDER.idx];
  if (!it) return;
  sfx('confirm');
  if (it.type === 'browse') {
    const r = await api.pickDir(S.dir);
    if (!r) return;
    if (r.choices) { $('folderMsg').textContent = 'Several save folders are inside that folder. Pick one:'; renderFolderList(r.choices); return; }
    if (r.none) { $('folderMsg').textContent = `No GameSaveData*.sav files in ${r.dir}. Pick another folder:`; sfx('error'); return; }
    return useFolder(r.dir);
  }
  return useFolder(it.path);
}

async function useFolder(dir) {
  if (S.dirty && dir !== S.dir && !confirm('Discard unsaved changes and switch folder?')) return;
  $('folderDialog').close();
  if (await setDir(dir)) await api.rememberDir(dir);
}

function folderKey(e) {
  const k = e.key;
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    FOLDER.idx = (FOLDER.idx + (k === 'ArrowUp' ? -1 : 1) + FOLDER.items.length) % FOLDER.items.length;
    markFolder(); sfx('cursor');
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault(); chooseFolderItem();
  }
}

async function openSave(file, force = false) {
  if (!force && S.dirty && !confirm('Discard unsaved changes?')) { $('slot').value = S.file; return; }
  try {
    const { header, plain } = await api.openSave(file);
    S.file = file; S.header = header; S.bytes = new Uint8Array(plain);
    reparse();
  } catch (e) {
    status(`Could not read ${file}: ${e.message}`, 'error');
    return;
  }
  $('slot').value = file;
  S.charIdx = 0; S.visIdx = 0;
  setDirty(false);
  renderAllTabs();
  if (checkSaveFormat()) status(`Loaded ${file.split(/[\\/]/).pop()} — choose a command from the menu.`);
}

async function save() {
  if (!S.file || !S.dirty) return;
  if (S.readOnly) { status(`This save has a layout the editor does not recognize (${S.readOnly}) — saving is disabled to protect it.`, 'error'); return; }
  try {
    const bak = await api.writeSave(S.file, S.header, S.bytes);
    if (!bak) return;
    setDirty(false);
    for (const el of document.querySelectorAll('.changed')) el.classList.remove('changed');
    status(`Saved. Backup: ${bak}`, 'ok');
    sfx('save');
  } catch (e) {
    status(`Save failed: ${e.message}`, 'error');
  }
}

function showTab(name) {
  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${name}`);
  if (!S.parsed) return;
  // refresh the views that can show values edited elsewhere
  if (name === 'inventory') renderInventory();
  if (name === 'all') renderAll();
  if (name === 'player') renderPlayer();
  if (name === 'chars') renderChar();
  if (name === 'visions') renderVision();
  if (name === 'journal') renderJournal();
  if (name === 'bestiary') renderBestiary();
}

function renderAllTabs() {
  renderPlayer(); renderCharList(); renderVisList(); renderInventory(); renderAll(); renderJournal(); renderBestiary(); updateGilTime();
}

// ---------- player ----------
const PLAYER_LABELS = { currentMoney: 'Gil', PlayTime: 'Play time (seconds)', WinNum: 'Battles won', spentMoney: 'Gil spent', earnedMoney: 'Gil earned', breakCount: 'Breaks', finishblowCount: 'Finishing blows' };

function renderPlayer() {
  const paths = [...S.parsed.fields.keys()].filter((p) => p.startsWith('Player.'));
  $('playerPanel').replaceChildren(
    h('h2', {}, 'Records'),
    h('div', { class: 'subtitle' }, 'Gil and play time also show in the window under the menu.'),
    h('h3', {}, 'Player'),
    h('div', { class: 'records' }, paths.map((p) => {
      const key = p.slice(7);
      return h('div', { class: 'rec' }, h('label', { class: 'lbl' }, PLAYER_LABELS[key] || key), numInput(p));
    })),
    ...tabletShardsSection());
}

function tabletShardsSection() {
  const id = CAT.prog.tabletShardItem;
  if (!id) return [];
  const have = inventoryMap().get(id) || 0;
  // shards handed in to the princess sit in the transfer inventory
  const handedPaths = [...S.parsed.fields.keys()].filter((p) => /^tranferTargetInventory\..*\.inventoryList\[\d+\]\.ItemId$/.test(p) && get(p) === id)
    .map((p) => p.replace(/ItemId$/, 'Num'));
  const handed = handedPaths.reduce((a, p) => a + get(p), 0);
  const el = h('input', { class: 'num', value: String(have), title: 'Tablet Shards in your inventory' });
  el.addEventListener('focus', () => { el.dataset.orig = el.value; });
  el.addEventListener('change', () => {
    const n = Number(el.value);
    if (!Number.isInteger(n) || n < 0 || n > 999) { status('Tablet Shards must be 0–999', 'error'); el.value = String(have); return; }
    if (n === have) return;
    S.bytes = FFRS.addInventoryItem(S.bytes, id, n);
    reparse(); setDirty(true); sfx('confirm');
    status(`Tablet Shards set to ${n}. Unsaved — choose Save in the menu.`);
    renderPlayer(); renderInventory();
  });
  const ladder = CAT.prog.shardLadder || [];
  return [
    h('h3', {}, 'Tablet Shards'),
    h('div', { class: 'records' },
      h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Shards carried'), el),
      h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Handed in to the princess'),
        handedPaths.length === 1 ? numInput(handedPaths[0]) : h('span', {}, String(handed)))),
    h('div', { class: 'hint' }, handedPaths.length
      ? 'Chests open by the number handed in. ✔ = unlocked; ◐ = reachable once you hand in what you carry.'
      : 'Nothing handed in yet. Hand in at least one shard in the game, then the handed-in count becomes editable here.'),
    ladder.length ? h('table', { class: 'ladder' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Chamber'), h('th', {}, 'Chest'), h('th', {}, 'Shards'), h('th', {}, 'Reward'), h('th', {}, ''))),
      h('tbody', {}, ladder.map((c) => h('tr', { class: handed >= c.shards ? 'reached' : '' },
        h('td', {}, c.chamber), h('td', {}, c.chest), h('td', { class: 'right' }, c.shards), h('td', {}, c.reward),
        h('td', { class: 'owned' }, handed >= c.shards ? '✔' : handed + have >= c.shards ? '◐' : ''))))) : '',
    ladder.length ? h('div', { class: 'hint' }, `Chest list from ${CAT.prog.shardLadderSource || 'a community guide'}.`) : '',
  ];
}

// ---------- characters ----------
function renderCharListTags() {
  [...$('charList').children].forEach((li, i) => {
    const uid = get(`unitParameterList[${i}].UnitId`);
    const tag = li.querySelector('.tag');
    if (tag && tag.firstChild && tag.firstChild.nodeType === 3 && levelCurve(uid)) tag.firstChild.textContent = `Lv ${levelOf(uid, get(`unitParameterList[${i}].Experience`))}`;
  });
}
function renderCharList() {
  const party = new Set([...S.parsed.fields.keys()].filter((p) => p.startsWith('Party.partyList[')).map(get));
  const n = count('unitParameterList');
  $('charList').replaceChildren(...Array.from({ length: n }, (_, i) => {
    const uid = get(`unitParameterList[${i}].UnitId`);
    return h('li', { class: i === S.charIdx ? 'active' : '', onclick: () => { sfx('cursor'); S.charIdx = i; renderCharList(); } },
      h('span', { class: 'who' }, faceImg(uid), h('span', {}, nameOf('unit', uid))),
      h('span', { class: 'tag' }, has(`unitParameterList[${i}].Experience`) && levelCurve(uid) ? `Lv ${levelOf(uid, get(`unitParameterList[${i}].Experience`))}` : '',
        party.has(uid) ? h('span', { class: 'star', title: 'In party' }, ' ★') : ''));
  }));
  renderChar();
}

function equipLabel(id, owned) {
  if (id < 0) return '(none)';
  const e = CAT.equip.get(id);
  if (!e) return `${nameOf('item', id)}  [${id}]`;
  return `${owned.has(id) ? '✔ ' : ''}${e.name}  [${id}]  ${statsText(e)}`;
}

function equipOptions(uid, slot, current) {
  const owned = inventoryMap();
  let opts;
  if (slot === 'vision') {
    const vids = Array.from({ length: count('visionList') }, (_, i) => get(`visionList[${i}].ID`));
    opts = [[-1, '(none)'], ...vids.map((v) => [v, `${nameOf('vis', v)}  [${v}]`])];
  } else {
    let ids;
    if (slot === 'weapon') { const pre = 101 + (uid - 1001); ids = [...CAT.equip.values()].filter((e) => e.kind === 'weapon' && Math.floor(e.id / 100) === pre); }
    else if (slot === 'armor') { const ok = ARMOR_OK[uid] || [9, 10, 11]; ids = [...CAT.equip.values()].filter((e) => e.kind === 'armor' && ok.includes(e.subtype)); }
    else ids = [...CAT.equip.values()].filter((e) => e.kind === 'accessory');
    ids = ids.map((e) => e.id).sort((a, b) => (owned.has(b) - owned.has(a)) || a - b);
    opts = [...(slot === 'weapon' ? [] : [[-1, '(none)']]), ...ids.map((i) => [i, equipLabel(i, owned)])];
  }
  if (!opts.some(([v]) => v === current)) opts.unshift([current, slot === 'vision' ? `${nameOf('vis', current)}  [${current}]` : equipLabel(current, owned)]);
  return opts;
}

function equipSelect(uid, slot, current, onPick) {
  const sel = h('select', {}, equipOptions(uid, slot, current).map(([v, label]) => h('option', { value: String(v), selected: v === current }, label)));
  const pic = (id) => (id < 0 ? h('span', { class: 'icon' }) : slot === 'vision' ? visionImg(id, 'icon face-icon') : itemIcon(id));
  const box = h('div', { class: 'with-icon' }, pic(current), sel);
  sel.addEventListener('change', () => { box.firstChild.replaceWith(pic(Number(sel.value))); onPick(Number(sel.value)); sel.classList.add('changed'); });
  return box;
}

function renderChar() {
  const panel = $('charPanel');
  if (!count('unitParameterList')) { panel.replaceChildren('No characters in this save.'); return; }
  const base = `unitParameterList[${S.charIdx}]`;
  const uid = get(`${base}.UnitId`);
  const form = h('div', { class: 'form' });
  const row = (label, el) => form.append(h('label', {}, label), h('div', {}, el));

  const expPath = `${base}.Experience`;
  if (has(expPath) && levelCurve(uid)) {
    const curve = levelCurve(uid);
    const expEl = numInput(expPath);
    const lvEl = h('input', { class: 'num small', title: 'Level' });
    const info = h('span', { class: 'dim' });
    const sync = () => {
      const lv = levelOf(uid, get(expPath));
      lvEl.value = String(lv);
      info.textContent = lv >= curve.length ? '  Max level' : `  ${(expForLevel(uid, lv + 1) - get(expPath)).toLocaleString('en-US')} EXP to Lv ${lv + 1}`;
    };
    lvEl.addEventListener('focus', () => { lvEl.dataset.orig = lvEl.value; });
    lvEl.addEventListener('change', () => {
      const lv = Number(lvEl.value);
      if (!Number.isInteger(lv) || lv < 1 || lv > curve.length) { status(`Level must be 1–${curve.length}`, 'error'); sync(); return; }
      if (levelOf(uid, get(expPath)) !== lv && setValue(expPath, expForLevel(uid, lv))) {
        expEl.value = String(get(expPath)); expEl.classList.add('changed'); lvEl.classList.add('changed');
        renderCharListTags();
      }
      sync();
    });
    expEl.addEventListener('change', () => { sync(); renderCharListTags(); });
    sync();
    row('Level', h('div', { class: 'inline' }, lvEl, info));
    row('Experience', expEl);
  } else if (has(expPath)) row('Experience', numInput(expPath));
  for (const [f, label] of [['HitPoint', 'HP'], ['MagicPoint', 'MP'], ['defeatUnitNum', 'Enemies defeated']]) {
    if (has(`${base}.${f}`)) row(label, numInput(`${base}.${f}`));
  }

  const eq = h('div', { class: 'form' });
  const erow = (label, el) => eq.append(h('label', {}, label), h('div', {}, el));
  for (const [f, label, slot] of [['EquipWeaponId', 'Weapon', 'weapon'], ['EquipArmorId', 'Armor', 'armor'], ['equipVisionId', 'Vision', 'vision']]) {
    const p = `${base}.${f}`;
    if (has(p)) erow(label, equipSelect(uid, slot, get(p), (id) => setValue(p, id)));
  }
  const nAcc = count(`${base}.EquipAccessoryIdList`);
  for (let j = 0; j < nAcc; j++) {
    const p = `${base}.EquipAccessoryIdList[${j}]`;
    erow(`Accessory ${j + 1}`, equipSelect(uid, 'accessory', get(p), (id) => setValue(p, id)));
  }
  for (let j = nAcc; j < MAX_ACCESSORIES; j++) {
    erow(`Accessory ${j + 1}`, equipSelect(uid, 'accessory', -1, (id) => {
      if (id <= 0) return;
      S.bytes = FFRS.addAccessory(S.bytes, S.charIdx, id);
      reparse(); setDirty(true);
      status(`${nameOf('item', id)} added to ${nameOf('unit', uid)}. Unsaved — choose Save in the menu.`);
      renderChar();
    }));
  }

  const nb = count(`${base}.baseParameterList`);
  const grid = h('div', { class: 'grid5' });
  for (let j = 0; j < nb; j++) {
    grid.append(h('div', {}, h('label', {}, `[${j}] `), numInput(`${base}.baseParameterList[${j}]`, 'num small')));
  }

  // name + stats beside the portrait, equipment and bonus stats full width below
  panel.replaceChildren(
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-main' },
        h('h2', {}, nameOf('unit', uid)),
        h('div', { class: 'subtitle' }, `UnitId ${uid}`),
        h('h3', {}, 'Stats'), form,
        h('div', { class: 'hint' }, 'The game may recalculate level and stats from Experience.')),
      h('div', { class: 'portrait-col' }, img(`${IMG}/portraits/${uid}.png`, 'portrait'))),
    h('h3', {}, 'Equipment'), eq,
    h('div', { class: 'hint' }, '✔ = in your inventory. Only weapons and armor this character can use are listed. Empty accessory slots can be filled.'),
    nb ? h('h3', {}, 'Bonus stats (baseParameterList — meaning per index unknown)') : '', nb ? grid : '',
  );
}

// ---------- visions ----------
function renderVisList() {
  const n = count('visionList');
  $('visList').replaceChildren(...Array.from({ length: n }, (_, i) => {
    const vid = get(`visionList[${i}].ID`);
    return h('li', { class: i === S.visIdx ? 'active' : '', onclick: () => { sfx('cursor'); S.visIdx = i; renderVisList(); } },
      h('span', { class: 'who' }, visionImg(vid), h('span', {}, nameOf('vis', vid))), h('span', { class: 'tag' }, CAT.names[`vistype:${vid}`] || ''));
  }));
  renderVision();
}

function renderVision() {
  const panel = $('visPanel');
  if (!count('visionList')) { panel.replaceChildren('No visions in this save.'); return; }
  const base = `visionList[${S.visIdx}]`;
  const vid = get(`${base}.ID`);
  const form = h('div', { class: 'form' });
  const awPath = `${base}.awakeningPoint`;
  if (has(awPath)) {
    const max = awakeningMax();
    const st = h('span', { class: 'stars' });
    const el = numInput(awPath, 'num small', { min: 0, max });
    const syncSt = () => { st.textContent = '  ' + stars(get(awPath), max); };
    el.addEventListener('change', syncSt); syncSt();
    form.append(h('label', {}, 'Awakening'), h('div', { class: 'inline' }, el, st, h('span', { class: 'dim' }, `  (0–${max})`)));
  }

  const curve = masteryCurve(vid);
  const mrp = h('div', { class: 'form' });
  const inputs = [];
  for (let j = 0; has(`${base}.synchroPoints{${j}}.value`); j++) {
    const p = `${base}.synchroPoints{${j}}.value`;
    const el = numInput(p);
    const cells = [el];
    if (curve) {
      const rk = h('input', { class: 'num small', title: 'Mastery Rank' });
      const syncR = () => { rk.value = String(rankOf(vid, get(p))); };
      rk.addEventListener('focus', () => { rk.dataset.orig = rk.value; });
      rk.addEventListener('change', () => {
        const r = Number(rk.value);
        if (!Number.isInteger(r) || r < 0 || r >= curve.length) { status(`Mastery Rank must be 0–${curve.length - 1}`, 'error'); syncR(); return; }
        if (rankOf(vid, get(p)) !== r && setValue(p, curve[r])) { el.value = String(get(p)); el.classList.add('changed'); rk.classList.add('changed'); }
        syncR();
      });
      el.addEventListener('change', syncR); syncR();
      cells.push(h('span', { class: 'lbl rank-lbl' }, 'MR'), rk);
    }
    inputs.push([p, el]);
    mrp.append(h('label', {}, nameOf('unit', get(`${base}.synchroPoints{${j}}.key`))), h('div', { class: 'inline' }, cells));
  }
  const allVal = h('input', { class: 'num', placeholder: 'MRP' });
  const applyAll = (val) => {
    for (const [p, el] of inputs) {
      if (setValue(p, val)) { el.value = String(get(p)); el.classList.add('changed'); el.dispatchEvent(new Event('change')); } else return;
    }
  };
  const setAll = h('button', { class: 'cmd', onclick: () => applyAll(allVal.value) }, 'Set all MRP');
  const maxAll = curve ? h('button', { class: 'cmd', onclick: () => applyAll(curve[curve.length - 1]) }, `All max rank (${curve[curve.length - 1].toLocaleString('en-US')} MRP)`) : '';

  panel.replaceChildren(
    visionImg(vid, 'vision-big'),
    h('h2', {}, nameOf('vis', vid)),
    h('div', { class: 'subtitle' }, `ID ${vid}${CAT.names[`vistype:${vid}`] ? ' · ' + CAT.names[`vistype:${vid}`] : ''}`),
    form,
    h('h3', {}, curve ? `MRP and Mastery Rank (0–${curve.length - 1}) per character` : 'MRP per character (synchroPoints)'), mrp,
    h('div', { class: 'bar mt' }, allVal, setAll, maxAll),
  );
}

// ---------- inventory ----------
function renderInventory() {
  const q = $('invFilter').value.toLowerCase();
  const rows = [];
  for (let i = 0; i < count('inventory'); i++) {
    const id = get(`inventory[${i}].ItemId`);
    const name = nameOf('item', id);
    if (q && !name.toLowerCase().includes(q) && !String(id).includes(q)) continue;
    const info = itemInfo(id);
    rows.push(h('tr', {},
      h('td', { class: 'id' }, id), h('td', { class: 'name' }, itemIcon(id), name), h('td', { class: 'kind' }, info ? info.kind : ''),
      h('td', { class: 'right' }, numInput(`inventory[${i}].Num`, 'num small')),
      h('td', { class: 'desc' }, info ? [statsText(info), info.description].filter(Boolean).join(' · ') : '')));
  }
  $('invTable').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Name'), h('th', {}, 'Category'), h('th', {}, 'Quantity'), h('th', {}, 'Stats / effect'))),
    h('tbody', {}, rows));
}

// ---------- all values ----------
function renderAll() {
  const q = $('allFilter').value.toLowerCase();
  const all = [...S.parsed.fields.keys()];
  const paths = q ? all.filter((p) => p.toLowerCase().includes(q)) : all;
  $('allCount').textContent = `${paths.length} of ${all.length} values`;
  $('allTable').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Path'), h('th', {}, 'Value'))),
    h('tbody', {}, paths.map((p) => h('tr', {}, h('td', { class: 'path' }, p), h('td', {}, numInput(p))))));
}

// ---------- add item dialog ----------
let addSel = null;

function initAddDialog() {
  const dlg = $('addDialog');
  $('addCat').replaceChildren(...Object.keys(CATEGORIES).map((c) => h('option', { value: c }, c)));
  $('addCat').addEventListener('change', renderAddTable);
  $('addFilter').addEventListener('input', debounce(renderAddTable, 100));
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  $('btnAddConfirm').addEventListener('click', confirmAdd);
}

function openAddDialog() {
  if (!S.parsed) return;
  addSel = null;
  renderAddTable();
  $('addDialog').showModal();
  $('addFilter').focus();
}

function renderAddTable() {
  const kind = CATEGORIES[$('addCat').value];
  const q = $('addFilter').value.toLowerCase();
  const owned = inventoryMap();
  const rows = [];
  for (const e of [...CAT.equip.values(), ...CAT.items.values()]) {
    if (kind && e.kind !== kind) continue;
    const info = [statsText(e), e.description].filter(Boolean).join(' · ');
    if (q && !e.name.toLowerCase().includes(q) && !String(e.id).includes(q) && !info.toLowerCase().includes(q)) continue;
    const tr = h('tr', { class: e.id === addSel ? 'selected' : '' },
      h('td', { class: 'id' }, e.id),
      h('td', { class: 'name' }, itemIcon(e.id), e.name, owned.has(e.id) ? h('span', { class: 'owned' }, `  (have ${owned.get(e.id)})`) : ''),
      h('td', { class: 'kind' }, e.kind), h('td', { class: 'desc' }, info));
    tr.addEventListener('click', () => {
      sfx('cursor');
      addSel = e.id;
      for (const r of tr.parentNode.children) r.classList.remove('selected');
      tr.classList.add('selected');
    });
    tr.addEventListener('dblclick', () => { addSel = e.id; confirmAdd(); });
    rows.push(tr);
  }
  $('addTable').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Name'), h('th', {}, 'Category'), h('th', {}, 'Stats / effect'))),
    h('tbody', {}, rows));
}

function confirmAdd() {
  if (addSel == null) { status('Select an item first.', 'error'); return; }
  const n = Number($('addQty').value);
  if (!Number.isInteger(n) || n < 0) { status('Quantity must be a whole number.', 'error'); return; }
  try {
    S.bytes = FFRS.addInventoryItem(S.bytes, addSel, n);
  } catch (e) { status(e.message, 'error'); return; }
  reparse(); setDirty(true);
  status(`${nameOf('item', addSel)} set to quantity ${n}. Unsaved — choose Save in the menu.`);
  sfx('confirm');
  renderAddTable(); renderInventory(); renderAll();
}

// Start only after every script (quick.js, journal.js, safety-ui.js, keyboard.js…) has loaded:
// starting right here raced with the scripts below and could fail with "renderQuick is not defined".
window.addEventListener('DOMContentLoaded', () => init().catch((e) => status(`Startup failed: ${e.message}`, 'error')));
