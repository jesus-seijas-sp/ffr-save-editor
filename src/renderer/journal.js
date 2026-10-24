'use strict';
/* Journal (story, quests, substories, Colosseum, areas) and Bestiary.
   Names and quest stages from zabo-dev/ffr-save-tracker (MIT), see data/journal.json.
   Story and quest counters are shown read-only: they drive the game's events.
   Uses globals from renderer.js (S, CAT, $, h, get, has, count, numInput, status). */

const J = () => CAT.journal || {};
const bool = (p) => S.parsed.bools.get(p);
const str = (p) => S.parsed.strings.get(p);
const tail = (s) => (s || '').split('::').pop();
const FULLWIDTH = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

function colosseumName(key) {
  const [rank, battle] = key.split('_');
  const ranks = J().colosseumRanks || {};
  const label = FULLWIDTH((battle || '').replace(/^(初級|中級|上級|最上級)/, '').replace('バトル', 'Battle ')).trim();
  return `${ranks[rank] || rank} · ${label || key}`;
}

function questState(q) {
  const v = has(`Progress.Progress[${q.k}]`) ? get(`Progress.Progress[${q.k}]`) : 0;
  const reached = q.stages.filter((s) => v >= s).length;
  if (v >= q.done) return { text: 'Completed', cls: 'owned', mark: '✔', stage: q.stages.length };
  if (reached > 0) return { text: `Stage ${reached}/${q.stages.length}`, cls: '', mark: '◐', stage: reached };
  return { text: 'Not started', cls: 'dim', mark: '○', stage: 0 };
}

function areaRows() {
  const visited = new Map();
  for (let i = 0; has(`Map.perMapSaveDataMap{${i}}.key`); i++) {
    visited.set(get(`Map.perMapSaveDataMap{${i}}.key`), !!bool(`Map.perMapSaveDataMap{${i}}.value.bIsVisited`));
  }
  const rows = [];
  for (let i = 0; has(`Map.mapGimmick{${i}}.key`); i++) {
    const id = get(`Map.mapGimmick{${i}}.key`);
    const base = `Map.mapGimmick{${i}}.value.treasureBox.treasureBoxList`;
    const n = count(base);
    if (!n) continue;
    let chests = 0, chestsOpen = 0, spots = 0, spotsOpen = 0;
    for (let j = 0; j < n; j++) {
      const open = !!bool(`${base}[${j}].IsOpen`);
      if (get(`${base}[${j}].ID`) === -1) { spots++; if (open) spotsOpen++; } else { chests++; if (open) chestsOpen++; }
    }
    rows.push({ id, name: (J().areas || {})[id] || `Area ${id}`, chests, chestsOpen, spots, spotsOpen, visited: visited.get(id) });
  }
  return { rows: rows.sort((a, b) => a.name.localeCompare(b.name)), visitedCount: [...visited.values()].filter(Boolean).length };
}

function table(head, rows, cls = 'journal-table') {
  return h('table', { class: cls }, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))), h('tbody', {}, rows));
}

function renderJournal() {
  const panel = $('journalPanel');
  if (!S.parsed) return;
  const story = has('Progress.Progress[0]') ? get('Progress.Progress[0]') : 0;
  const joined = Array.from({ length: count('unitParameterList') }, (_, i) => str(`unitParameterList[${i}].JoinStatus`)).filter((s) => tail(s) === 'Join').length;
  const quests = (J().quests || []).map((q) => ({ q, st: questState(q) }));
  const done = quests.filter((x) => x.st.stage === x.q.stages.length).length;
  const areas = areaRows();
  const tot = areas.rows.reduce((a, r) => ({ c: a.c + r.chests, co: a.co + r.chestsOpen, s: a.s + r.spots, so: a.so + r.spotsOpen }), { c: 0, co: 0, s: 0, so: 0 });

  const requests = [];
  for (let i = 0; has(`request.DataMap{${i}}.key`); i++) {
    const id = get(`request.DataMap{${i}}.key`);
    requests.push({ id, state: tail(str(`request.DataMap{${i}}.value.State`)) });
  }
  const colosseum = [];
  for (let i = 0; str(`colosseumProgress.RankBattle{${i}}.key`) != null; i++) {
    colosseum.push({ i, name: colosseumName(str(`colosseumProgress.RankBattle{${i}}.key`)), status: tail(str(`colosseumProgress.RankBattle{${i}}.value.Status`)) });
  }

  panel.replaceChildren(
    h('h2', {}, 'Journal'),
    h('div', { class: 'subtitle' }, 'Your progress at a glance. Story and quest counters are read-only — they drive the game\'s events.'),
    h('div', { class: 'records' },
      h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Story'), h('span', {}, `Chapter ${Math.max(1, Math.floor(story / 1000))}`, h('span', { class: 'dim' }, `  (counter ${story})`))),
      h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Party members joined'), h('span', {}, `${joined} / ${count('unitParameterList')}`)),
      h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Side quests completed'), h('span', {}, `${done} / ${quests.length}`)),
      h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Treasure chests opened'), h('span', {}, `${tot.co} / ${tot.c}`)),
      h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Areas visited'), h('span', {}, String(areas.visitedCount))),
      has('Map.encountCount') ? h('div', { class: 'rec' }, h('label', { class: 'lbl' }, 'Encounters'), numInput('Map.encountCount')) : ''),

    h('h3', {}, 'Side quests'),
    table(['', 'Quest', 'Progress'], quests.map(({ q, st }) => h('tr', {},
      h('td', { class: st.cls }, st.mark), h('td', {}, q.name), h('td', { class: st.cls }, st.text)))),

    requests.length ? h('h3', {}, 'Requests in progress / done') : '',
    requests.length ? table(['', 'Request', 'State'], requests.map((r) => h('tr', {},
      h('td', { class: r.state === 'Completed' ? 'owned' : '' }, r.state === 'Completed' ? '✔' : '◐'),
      h('td', {}, CAT.names[`quest:${r.id}`] || `Request #${r.id}`), h('td', {}, r.state)))) : '',

    h('h3', {}, 'Colosseum'),
    table(['Battle', 'Status', 'Clears'], colosseum.map((c) => h('tr', {},
      h('td', {}, c.name), h('td', { class: c.status === 'Locked' ? 'dim' : 'owned' }, c.status === 'UnLocked' ? 'Unlocked' : c.status),
      h('td', { class: 'right' }, numInput(`colosseumProgress.RankBattle{${c.i}}.value.ClearCount`, 'num small'))))),

    h('h3', {}, 'Areas — chests and item spots opened'),
    table(['Area', 'Visited', 'Chests', 'Item spots'], areas.rows.map((r) => h('tr', {},
      h('td', {}, r.name, h('span', { class: 'dim' }, `  #${r.id}`)),
      h('td', { class: r.visited ? 'owned' : 'dim' }, r.visited ? '✔' : '○'),
      h('td', { class: r.chests && r.chestsOpen === r.chests ? 'owned' : '' }, r.chests ? `${r.chestsOpen} / ${r.chests}` : '—'),
      h('td', { class: r.spots && r.spotsOpen === r.spots ? 'owned' : '' }, r.spots ? `${r.spotsOpen} / ${r.spots}` : '—')))),
    h('div', { class: 'hint' }, `Item spots are loose pickups; in several areas they are Tablet Shards. Names and quest stages: ${J().source || 'community data'}.`),
  );
}

// ---------- bestiary ----------
function renderBestiary() {
  if (!S.parsed) return;
  const names = J().enemies || {};
  const q = $('bestFilter').value.toLowerCase();
  const mode = $('bestMode').value;
  const all = [];
  for (let i = 0; i < count('unitList'); i++) {
    const id = get(`unitList[${i}].SaveId`);
    const name = names[id];
    if (!name) continue; // party members, Visions and unnamed entries
    all.push({ i, id, name, n: get(`unitList[${i}].defeatNum`), libra: !!bool(`unitList[${i}].IsAnalyzed`) });
  }
  const defeated = all.filter((e) => e.n > 0).length;
  $('bestCount').textContent = `Defeated ${defeated} of ${all.length} named enemies · ${all.filter((e) => e.libra).length} scanned`;
  const shown = all
    .filter((e) => (mode === 'defeated' ? e.n > 0 : mode === 'missing' ? e.n === 0 : mode === 'unscanned' ? !e.libra : true))
    .filter((e) => !q || e.name.toLowerCase().includes(q) || String(e.id).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  BEST.shown = shown.map((e) => e.i);
  const rows = shown.map((e) => {
    const cb = h('input', { type: 'checkbox', checked: e.libra, title: `${e.name}: scanned with Libra` });
    cb.addEventListener('change', () => {
      const n = libraScan([e.i], cb.checked);
      setDirty(true); sfx('confirm');
      status(`${e.name}: ${cb.checked ? `scanned${n.el ? ', weaknesses revealed' : ''}` : 'scan removed'}. Unsaved — choose Save in the menu.`);
      renderBestiary();
    });
    return h('tr', {},
      h('td', { class: e.n > 0 ? 'owned' : 'dim' }, e.n > 0 ? '✔' : '○'),
      h('td', { class: 'id' }, e.id), h('td', {}, e.name),
      h('td', { class: 'center' }, cb),
      h('td', { class: 'right' }, numInput(`unitList[${e.i}].defeatNum`, 'num small')));
  });
  $('bestTable').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'ID'), h('th', {}, 'Enemy'), h('th', { class: 'center' }, 'Libra'), h('th', {}, 'Times defeated'))),
    h('tbody', {}, rows));
}

const BEST = { shown: [] }; // unitList indexes in the current view

// Sets the Libra flag on unitList entries; scanning also reveals every element weakness, as Libra does.
// Unscanning leaves the weaknesses alone: the game also learns those by hitting enemies.
function libraScan(indexes, value = true) {
  const n = { units: 0, el: 0 };
  for (const i of indexes) {
    if (!!bool(`unitList[${i}].IsAnalyzed`) !== value && setFlag(`unitList[${i}].IsAnalyzed`, value)) n.units++;
    if (!value) continue;
    for (let j = 0; S.parsed.boolRefs.has(`unitList[${i}].analyzedElments{${j}}.value`); j++) {
      const p = `unitList[${i}].analyzedElments{${j}}.value`;
      if (!bool(p) && setFlag(p, true)) n.el++;
    }
  }
  return n;
}

$('bestFilter').addEventListener('input', renderBestiary);
$('bestMode').addEventListener('change', renderBestiary);
$('bestLibra').addEventListener('click', () => {
  if (!S.parsed) return;
  const n = libraScan(BEST.shown);
  if (!n.units && !n.el) { status('Every enemy shown is already scanned.'); return; }
  setDirty(true); sfx('confirm');
  status(`${n.units} enem${n.units === 1 ? 'y' : 'ies'} scanned with Libra, weaknesses included. Unsaved — choose Save in the menu.`);
  renderBestiary();
});
