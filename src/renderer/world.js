'use strict';
/* Artifacts and Maps screens.
   Artifacts you own are inventory items; artifactList only holds the on/off state of the ones that
   have been switched (item id -> IsActive). Maps: Map.perMapSaveDataMap (map id -> known / visited /
   cleared) plus the treasure chests in Map.mapGimmick, both keyed by the same map ids (data/maps.json).
   Uses globals from renderer.js (S, CAT, FFRS, $, h, get, has, count, reparse, setDirty, status, sfx,
   inventoryMap, itemIcon, nameOf) and journal.js (bool). */

// ---------- shared ----------
function applyBytes(bytes, msg) {
  S.bytes = bytes;
  reparse();
  setDirty(true);
  sfx('confirm');
  status(`${msg} Unsaved — choose Save in the menu.`);
}

function setFlag(path, value) {
  const ref = S.parsed.boolRefs.get(path);
  if (!ref) return false;
  FFRS.setBool(S.bytes, ref, value);
  S.parsed.bools.set(path, value);
  return true;
}

function mapEntryIndex(path, key) {
  for (let i = 0; has(`${path}{${i}}.key`); i++) if (get(`${path}{${i}}.key`) === key) return i;
  return -1;
}

// ---------- artifacts ----------
const ARTIFACT_SKINS = [29500, 29520]; // key items the game also switches through artifactList
const ARTIFACT_NOTES = {
  30018: 'No English text in the game files — possibly a bonus item from another edition.',
};
const artifactNote = (e) => ARTIFACT_NOTES[e.id] || (/\[TEMP\]/.test(e.name) ? 'Unfinished ([TEMP]) — may have no effect in the game.' : '');

function artifactState(id) {
  const i = mapEntryIndex('artifactList', id);
  return i < 0 ? 'default' : bool(`artifactList{${i}}.value.IsActive`) ? 'on' : 'off';
}

function renderArtifacts() {
  const panel = $('artifactPanel');
  if (!S.parsed) return;
  if (!S.parsed.maps.has('artifactList')) {
    panel.replaceChildren(h('h2', {}, 'Artifacts'), h('div', { class: 'subtitle' }, 'This save has no artifact list.'));
    return;
  }
  const have = inventoryMap();
  const list = [...CAT.items.values()].filter((e) => e.kind === 'artifact' || ARTIFACT_SKINS.includes(e.id))
    .sort((a, b) => a.id - b.id);

  const rows = list.map((e) => {
    const owned = (have.get(e.id) || 0) > 0;
    const st = artifactState(e.id);
    const sel = h('select', { title: 'Switch this artifact on or off' },
      st === 'default' ? h('option', { value: 'default' }, 'Game default') : '',
      h('option', { value: 'on' }, 'On'), h('option', { value: 'off' }, 'Off'));
    sel.value = st;
    sel.addEventListener('change', () => {
      if (sel.value === 'default') return;
      applyBytes(FFRS.setArtifact(S.bytes, e.id, sel.value === 'on'), `${nameOf('item', e.id)} switched ${sel.value}.`);
      renderArtifacts();
    });
    const get1 = h('button', { class: 'cmd small', onclick: () => {
      applyBytes(FFRS.addInventoryItem(S.bytes, e.id, 1), `${nameOf('item', e.id)} added.`);
      renderArtifacts();
    } }, 'Get');
    const note = artifactNote(e);
    return h('tr', {},
      h('td', {}, h('div', { class: 'name' }, itemIcon(e.id), e.name), note ? h('div', { class: 'dim' }, note) : ''),
      h('td', { class: 'desc' }, e.description),
      h('td', { class: owned ? 'owned' : '' }, owned ? '✔ Owned' : get1),
      h('td', {}, sel));
  });

  panel.replaceChildren(
    h('h2', {}, 'Artifacts'),
    h('div', { class: 'subtitle' }, 'Artifacts are passive boosters. Get adds one to your items; On / Off sets its switch. "Game default" means it has never been switched, so the game uses its own setting.'),
    h('table', { class: 'journal-table wide artifact-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Artifact'), h('th', {}, 'Effect'), h('th', {}, 'Owned'), h('th', {}, 'Switch'))),
      h('tbody', {}, rows)),
    h('div', { class: 'hint' }, 'Unfinished artifacts are in the game files but never handed out, so they may do nothing. Check in the game, and keep the automatic backup in case.'),
  );
}

// ---------- maps ----------
const MAP_TYPES = { world: 'World', town: 'Town', dungeon: 'Dungeon', cave: 'Cave', sanctum: 'Sanctum', area: 'Area', event: 'Event', other: 'Other' };
const MAPS = { region: '', events: false };
const MAP_FLAGS = [['bIsKnown', 'Known'], ['bIsVisited', 'Visited'], ['bIsCleared', 'Cleared']];

function mapCatalog() {
  const list = (CAT.maps || []).slice();
  const known = new Set(list.map((m) => m.id));
  // maps in the save that the game tables don't name (event-only areas)
  for (let i = 0; has(`Map.perMapSaveDataMap{${i}}.key`); i++) {
    const id = get(`Map.perMapSaveDataMap{${i}}.key`);
    if (!known.has(id)) { list.push({ id, name: `Map #${id}`, region: 'Other', type: 'other' }); known.add(id); }
  }
  return list;
}

function mapStates() {
  const m = new Map();
  for (let i = 0; has(`Map.perMapSaveDataMap{${i}}.key`); i++) {
    const p = `Map.perMapSaveDataMap{${i}}.value`;
    m.set(get(`Map.perMapSaveDataMap{${i}}.key`), Object.fromEntries(MAP_FLAGS.map(([k]) => [k, !!bool(`${p}.${k}`)])));
  }
  return m;
}

// Chests per map id: [{path, open}] — item spots (ID -1) are loose pickups, not chests.
function mapChests() {
  const m = new Map();
  for (let i = 0; has(`Map.mapGimmick{${i}}.key`); i++) {
    const base = `Map.mapGimmick{${i}}.value.treasureBox.treasureBoxList`;
    const list = [];
    for (let j = 0; j < count(base); j++) {
      if (get(`${base}[${j}].ID`) === -1) continue;
      list.push({ path: `${base}[${j}].IsOpen`, open: !!bool(`${base}[${j}].IsOpen`) });
    }
    if (list.length) m.set(get(`Map.mapGimmick{${i}}.key`), list);
  }
  return m;
}

function setMapFlag(id, flag, value) {
  const name = (mapCatalog().find((m) => m.id === id) || {}).name || `Map #${id}`;
  applyBytes(FFRS.setMapFlags(S.bytes, id, { [flag]: value }), `${name}: ${flag.slice(3).toLowerCase()} ${value ? 'on' : 'off'}.`);
}

function resetChests(ids) {
  const chests = mapChests();
  let n = 0;
  for (const id of ids) for (const c of chests.get(id) || []) if (c.open && setFlag(c.path, false)) n++;
  if (!n) { status('No opened chests to reset.'); return; }
  setDirty(true); sfx('confirm');
  status(`${n} chest${n === 1 ? '' : 's'} closed again — they can be looted once more. Unsaved — choose Save in the menu.`);
  renderMaps();
}

// Ids of the non-event maps in `list` that aren't known yet.
function unknownMaps(list) {
  const states = mapStates();
  return list.filter((m) => m.type !== 'event' && !(states.get(m.id) || {}).bIsKnown).map((m) => m.id);
}

function revealMaps(list) {
  const ids = unknownMaps(list);
  if (!ids.length) { status('Every map shown is already known.'); return; }
  applyBytes(FFRS.setManyMapFlags(S.bytes, ids, { bIsKnown: true }), `${ids.length} map${ids.length === 1 ? '' : 's'} marked as known.`);
  renderMaps();
}

function renderMaps() {
  const panel = $('mapPanel');
  if (!S.parsed) return;
  if (!S.parsed.maps.has('Map.perMapSaveDataMap')) {
    panel.replaceChildren(h('h2', {}, 'Maps'), h('div', { class: 'subtitle' }, 'This save has no map list.'));
    return;
  }
  const all = mapCatalog();
  const states = mapStates();
  const chests = mapChests();
  const regions = [...new Set(all.map((m) => m.region))];
  const shown = all.filter((m) => (!MAPS.region || m.region === MAPS.region) && (MAPS.events || m.type !== 'event'));

  const regionSel = h('select', { title: 'Region' }, h('option', { value: '' }, 'All regions'), ...regions.map((r) => h('option', { value: r }, r)));
  regionSel.value = MAPS.region;
  regionSel.addEventListener('change', () => { MAPS.region = regionSel.value; renderMaps(); });
  const events = h('input', { type: 'checkbox', checked: MAPS.events, title: 'Show event maps' });
  events.addEventListener('change', () => { MAPS.events = events.checked; renderMaps(); });

  const sections = regions.filter((r) => shown.some((m) => m.region === r)).map((r) => {
    const maps = shown.filter((m) => m.region === r);
    const knownN = maps.filter((m) => (states.get(m.id) || {}).bIsKnown).length;
    const rows = maps.map((m) => {
      const st = states.get(m.id) || {};
      const cl = chests.get(m.id) || [];
      const open = cl.filter((c) => c.open).length;
      return h('tr', {},
        h('td', {}, m.name, h('span', { class: 'dim' }, `  #${m.id} · ${MAP_TYPES[m.type] || m.type}`)),
        ...MAP_FLAGS.map(([k, label]) => {
          const cb = h('input', { type: 'checkbox', checked: !!st[k], title: `${m.name}: ${label}` });
          cb.addEventListener('change', () => { setMapFlag(m.id, k, cb.checked); renderMaps(); });
          return h('td', { class: 'center' }, cb);
        }),
        h('td', { class: cl.length && open === cl.length ? 'owned' : '' }, cl.length ? `${open} / ${cl.length}` : '—'),
        h('td', {}, open ? h('button', { class: 'cmd small', title: `Close the opened chests in ${m.name}`, onclick: () => resetChests([m.id]) }, 'Reset') : ''));
    });
    return [h('h3', {}, `${r}  `, h('span', { class: 'dim' }, `${knownN} / ${maps.length} known`)),
      h('table', { class: 'journal-table wide map-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Map'), ...MAP_FLAGS.map(([, l]) => h('th', { class: 'center' }, l)), h('th', {}, 'Chests'), h('th', {}, ''))),
        h('tbody', {}, rows))];
  });

  const totalKnown = all.filter((m) => m.type !== 'event' && (states.get(m.id) || {}).bIsKnown).length;
  panel.replaceChildren(
    h('h2', {}, 'Maps'),
    h('div', { class: 'subtitle' }, `${totalKnown} of ${all.filter((m) => m.type !== 'event').length} maps known. Known reveals a map; travelling there may still depend on the story.`),
    h('div', { class: 'bar mt' }, regionSel, h('label', { class: 'quick-sub' }, events, ' Show event maps'),
      h('button', { class: 'cmd', onclick: () => revealMaps(shown) }, 'Reveal shown maps'),
      h('button', { class: 'cmd', onclick: () => resetChests(shown.map((m) => m.id)) }, 'Reset shown chests')),
    h('div', { class: 'hint' }, 'Reveal sets Known only. Visited and Cleared may control story scenes and rewards, so change them one map at a time. Event maps are hidden: they are one-off story areas.'),
    ...sections.flat(),
  );
}
