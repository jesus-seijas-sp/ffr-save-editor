'use strict';
/* Quick actions: bulk edits applied to the loaded save in one go, plus named presets of them.
   Uses globals from renderer.js (S, CAT, get, has, count, setValue, reparse, setDirty, FFRS,
   inventoryMap, levelCurve, expForLevel, masteryCurve, awakeningMax, renderAllTabs, status, sfx, h, $). */

const QUICK_ACTIONS = [
  { key: 'gil', label: 'Set Gil to', value: 9999999,
    run: (v) => (has('Player.currentMoney') && setValue('Player.currentMoney', v) ? `Gil ${Number(v).toLocaleString('en-US')}` : null) },
  { key: 'consumables', label: 'Set every consumable to', value: 99, extra: { key: 'addMissing', label: 'also add the ones you don\'t have' },
    run: (v, opts) => {
      const n = Number(v);
      let changed = 0;
      for (let i = 0; i < count('inventory'); i++) {
        const id = get(`inventory[${i}].ItemId`);
        if (CAT.items.get(id)?.kind === 'consumable' && setValue(`inventory[${i}].Num`, n)) changed++;
      }
      if (opts.addMissing) {
        const have = inventoryMap();
        for (const e of CAT.items.values()) {
          if (e.kind !== 'consumable' || have.has(e.id)) continue;
          S.bytes = FFRS.addInventoryItem(S.bytes, e.id, n); reparse(); changed++;
        }
      }
      return `${changed} consumables → ${n}`;
    } },
  { key: 'level', label: 'Raise every character to at least level', value: 30,
    run: (v) => {
      const lv = Number(v);
      let changed = 0;
      for (let i = 0; i < count('unitParameterList'); i++) {
        const uid = get(`unitParameterList[${i}].UnitId`);
        const p = `unitParameterList[${i}].Experience`;
        const need = expForLevel(uid, lv);
        if (need != null && has(p) && get(p) < need && setValue(p, need)) changed++;
      }
      return `${changed} characters raised to Lv ${lv}`;
    } },
  { key: 'mastery', label: 'Max Mastery Rank on every vision, for every character',
    run: () => {
      let changed = 0;
      for (let i = 0; i < count('visionList'); i++) {
        const c = masteryCurve(get(`visionList[${i}].ID`));
        if (!c) continue;
        for (let j = 0; has(`visionList[${i}].synchroPoints{${j}}.value`); j++) {
          const p = `visionList[${i}].synchroPoints{${j}}.value`;
          if (get(p) < c[c.length - 1] && setValue(p, c[c.length - 1])) changed++;
        }
      }
      return `${changed} vision/character pairs at max rank`;
    } },
  { key: 'awakening', label: 'Set every vision\'s awakening to', value: 3,
    run: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > awakeningMax()) { status(`Awakening must be 0–${awakeningMax()}`, 'error'); return null; }
      let changed = 0;
      for (let i = 0; i < count('visionList'); i++) if (has(`visionList[${i}].awakeningPoint`) && setValue(`visionList[${i}].awakeningPoint`, n)) changed++;
      return `${changed} visions awakened to ${n}`;
    } },
  { key: 'artifacts', label: 'Add every artifact (skips the unfinished [TEMP] ones)',
    run: () => {
      const have = inventoryMap();
      let added = 0;
      for (const e of CAT.items.values()) {
        if (e.kind !== 'artifact' || have.has(e.id) || /\[TEMP\]|[぀-ヿ]/.test(e.name)) continue;
        S.bytes = FFRS.addInventoryItem(S.bytes, e.id, 1); reparse(); added++;
      }
      return `${added} artifacts added`;
    } },
];

const PRESET_KEY = 'quickPresets';
function loadPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || {}; } catch { return {}; } }
function storePresets(p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }

const quickForm = {}; // key -> {check, value, extra}

function renderQuick() {
  const panel = $('quickPanel');
  const rows = QUICK_ACTIONS.map((a) => {
    const check = h('input', { type: 'checkbox', title: a.label });
    const value = 'value' in a ? h('input', { class: 'num', value: String(a.value) }) : null;
    const extra = a.extra ? h('input', { type: 'checkbox', title: a.extra.label }) : null;
    quickForm[a.key] = { check, value, extra };
    return h('div', { class: 'quick-row' }, check,
      h('div', {}, h('div', {}, a.label), a.extra ? h('label', { class: 'quick-sub' }, extra, ' ', a.extra.label) : ''),
      h('div', { class: 'opts' }, value || ''));
  });

  const presetSel = h('select', {});
  const presetName = h('input', { placeholder: 'Preset name' });
  const refreshPresets = () => {
    const p = loadPresets();
    presetSel.replaceChildren(h('option', { value: '' }, Object.keys(p).length ? '— presets —' : '(no presets yet)'),
      ...Object.keys(p).sort().map((n) => h('option', { value: n }, n)));
  };
  refreshPresets();

  panel.replaceChildren(
    h('h2', {}, 'Quick'),
    h('div', { class: 'subtitle' }, 'Tick the edits you want and apply them to the loaded save in one go. Nothing is written until you choose Save.'),
    h('h3', {}, 'Actions'),
    ...rows,
    h('div', { class: 'bar mt' },
      h('button', { class: 'cmd', onclick: applyQuick }, 'Apply checked'),
      h('button', { class: 'cmd', onclick: () => { for (const f of Object.values(quickForm)) f.check.checked = true; } }, 'Check all'),
      h('button', { class: 'cmd', onclick: () => { for (const f of Object.values(quickForm)) f.check.checked = false; } }, 'Clear')),
    h('h3', {}, 'Presets'),
    h('div', { class: 'hint' }, 'A preset remembers which actions are ticked and their values, so you can reuse them on any save.'),
    h('div', { class: 'bar mt' }, presetSel,
      h('button', { class: 'cmd', onclick: () => { if (presetSel.value) { fillQuick(loadPresets()[presetSel.value]); status(`Preset "${presetSel.value}" loaded — choose Apply checked.`); } } }, 'Load'),
      h('button', { class: 'cmd', onclick: () => {
        if (!presetSel.value) return;
        const p = loadPresets(); delete p[presetSel.value]; storePresets(p); refreshPresets(); status('Preset deleted.');
      } }, 'Delete')),
    h('div', { class: 'bar mt' }, presetName,
      h('button', { class: 'cmd', onclick: () => {
        const name = presetName.value.trim();
        if (!name) { status('Type a name for the preset first.', 'error'); return; }
        const p = loadPresets(); p[name] = readQuick(); storePresets(p); refreshPresets(); presetSel.value = name;
        sfx('confirm'); status(`Preset "${name}" saved.`);
      } }, 'Save preset')),
  );
}

function readQuick() {
  const out = {};
  for (const [k, f] of Object.entries(quickForm)) out[k] = { on: f.check.checked, value: f.value ? f.value.value : null, extra: f.extra ? f.extra.checked : false };
  return out;
}

function fillQuick(preset) {
  if (!preset) return;
  for (const [k, f] of Object.entries(quickForm)) {
    const p = preset[k];
    if (!p) { f.check.checked = false; continue; }
    f.check.checked = !!p.on;
    if (f.value && p.value != null) f.value.value = p.value;
    if (f.extra) f.extra.checked = !!p.extra;
  }
}

function applyQuick() {
  if (!S.parsed) return;
  const done = [];
  for (const a of QUICK_ACTIONS) {
    const f = quickForm[a.key];
    if (!f.check.checked) continue;
    const msg = a.run(f.value ? f.value.value : null, { addMissing: f.extra && f.extra.checked });
    if (msg == null) return; // validation failed; the error is already in the help window
    done.push(msg);
  }
  if (!done.length) { status('Tick at least one action first.', 'error'); return; }
  setDirty(true);
  renderAllTabs();
  sfx('confirm');
  status(`Applied: ${done.join(' · ')}. Unsaved — choose Save in the menu.`);
}
