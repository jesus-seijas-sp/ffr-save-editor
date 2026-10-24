'use strict';
/* Keyboard navigation in the style of classic JRPG menus:
   arrows move the hand cursor, Enter confirms / goes deeper, Esc goes back.
   Uses globals from renderer.js (S, $, count, showTab, save, sfx, render*, openAddDialog, confirmAdd, addSel...). */

const KB = { zone: 'menu', menu: 0, panel: 0, table: 0 };
const ZONES = { chars: ['list', 'panel'], visions: ['list', 'panel'], inventory: ['table'], player: ['panel'], journal: ['panel'], bestiary: ['table'], quick: ['panel'], all: ['table'] };
const LIST_EL = { chars: 'charList', visions: 'visList' };
const PANEL_EL = { chars: 'charPanel', visions: 'visPanel', player: 'playerPanel', journal: 'journalPanel', quick: 'quickPanel' };
const TABLE_EL = { inventory: 'invTable', all: 'allTable', bestiary: 'bestTable' };
const SEARCH_EL = { inventory: 'invFilter', all: 'allFilter', bestiary: 'bestFilter' };
const KEY_HINTS = {
  menu: '↑↓ Choose   Enter Open   Ctrl+S Save',
  list: '↑↓ Choose   Enter Edit   Esc Back',
  panel: '↑↓ Move   ←→ Change (Shift ×10, Ctrl ×100)   Enter Type   Esc Back   Q/W Prev/Next',
  table: '↑↓ Move   ←→ Change (Shift ×10)   Enter Type   / Search   Esc Back',
  edit: 'Type a value   Enter Confirm   Esc Cancel',
  search: 'Type to filter   Enter / ↓ Go to list   Esc Back',
  dialog: '↑↓ Choose   ←→ Quantity   Enter Add   Type to search   Esc Close',
};

const currentTab = () => { const li = document.querySelector('#tabs li.active'); return li ? li.dataset.tab : 'chars'; };
const menuItems = () => [...$('tabs').querySelectorAll('[data-tab]'), $('btnSave')];
const wrap = (i, n) => ((i % n) + n) % n;
const isField = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');

function panelControls() {
  const el = $(PANEL_EL[currentTab()]);
  return el ? [...el.querySelectorAll('input:not([type=search]), select, button')].filter((c) => c.offsetParent !== null && !c.disabled) : [];
}
function tableRows() {
  const el = $(TABLE_EL[currentTab()]);
  return el ? [...el.querySelectorAll('tbody tr')] : [];
}
function kbTarget() {
  if (KB.zone === 'panel') { const c = panelControls(); if (!c.length) return null; KB.panel = Math.min(KB.panel, c.length - 1); return c[KB.panel]; }
  if (KB.zone === 'table') { const r = tableRows(); if (!r.length) return null; KB.table = Math.min(KB.table, r.length - 1); return r[KB.table]; }
  return null;
}
const targetControl = (t) => (t && t.tagName === 'TR' ? t.querySelector('input, select') : t);

function setZone(z) { KB.zone = z; kbRender(true); }

function kbRender(scroll = false) {
  document.body.dataset.zone = KB.zone;
  const items = menuItems();
  const onTab = items.findIndex((m) => m.classList.contains('active'));
  items.forEach((m, i) => m.classList.toggle('kb-cur', KB.zone === 'menu' ? i === KB.menu : i === onTab));
  for (const el of document.querySelectorAll('.kb-focus')) el.classList.remove('kb-focus');
  const t = kbTarget();
  if (t) {
    t.classList.add('kb-focus');
    if (scroll) t.scrollIntoView({ block: 'nearest' });
  }
  const ae = document.activeElement;
  let hint = KEY_HINTS[KB.zone];
  if ($('folderDialog').open) hint = '↑↓ Choose   Enter Select   Esc Close';
  else if ($('backupDialog').open) hint = '↑↓ Choose   Enter Restore   B Back up all slots now   Esc Close';
  else if ($('addDialog').open) hint = KEY_HINTS.dialog;
  else if (isField(ae)) hint = ae.type === 'search' ? KEY_HINTS.search : KEY_HINTS.edit;
  else if (KB.zone === 'table' && currentTab() === 'inventory') hint += '   A Add item';
  $('keys').textContent = hint;
  placeHand(t);
}

// Floating hand for fields and table rows (the menu and the lists draw their own).
function placeHand(t) {
  const hand = $('kbHand');
  if (!t || $('addDialog').open || $('folderDialog').open || $('backupDialog').open) { hand.hidden = true; return; }
  let anchor = t;
  if (t.tagName !== 'TR') {
    let cell = t;
    while (cell.parentElement && !cell.parentElement.classList.contains('form')) cell = cell.parentElement;
    if (t.closest('.rec')) anchor = t.closest('.rec');
    else if (t.closest('.grid5 > div')) anchor = t.closest('.grid5 > div');
    else if (cell.parentElement && cell.previousElementSibling && cell.previousElementSibling.tagName === 'LABEL') anchor = cell.previousElementSibling;
  }
  const r = anchor.getBoundingClientRect();
  const box = (t.closest('.panel, .table-wrap') || document.body).getBoundingClientRect();
  if (r.bottom < box.top + 4 || r.top > box.bottom - 4) { hand.hidden = true; return; }
  hand.hidden = false;
  hand.style.left = `${Math.max(2, r.left - (t.tagName === 'TR' ? 30 : 40))}px`;
  hand.style.top = `${r.top + r.height / 2 - 12}px`;
}

function adjust(ctrl, dir, e) {
  if (!ctrl) return;
  if (ctrl.tagName === 'SELECT') {
    const n = ctrl.options.length;
    if (n < 2) return;
    ctrl.selectedIndex = wrap(ctrl.selectedIndex + dir, n);
    ctrl.dispatchEvent(new Event('change'));
    sfx('cursor');
  } else if (ctrl.type === 'checkbox') {
    ctrl.click(); sfx('cursor');
  } else if (ctrl.tagName === 'INPUT') {
    const step = e.ctrlKey ? 100 : e.shiftKey ? 10 : 1;
    ctrl.value = String(Math.max(0, (Number(ctrl.value) || 0) + dir * step));
    ctrl.dispatchEvent(new Event('change'));
  }
}

function confirmControl(ctrl) {
  if (!ctrl) return;
  if (ctrl.tagName === 'BUTTON' || ctrl.type === 'checkbox') { sfx('confirm'); ctrl.click(); return; }
  ctrl.focus();
  if (ctrl.tagName === 'SELECT') { try { ctrl.showPicker(); } catch { /* not supported */ } }
  kbRender();
}

function switchUnit(dir) {
  const tab = currentTab();
  if (tab === 'chars' && count('unitParameterList')) { S.charIdx = wrap(S.charIdx + dir, count('unitParameterList')); renderCharList(); }
  else if (tab === 'visions' && count('visionList')) { S.visIdx = wrap(S.visIdx + dir, count('visionList')); renderVisList(); }
  else return;
  sfx('cursor'); kbRender(true);
}

function back() {
  const zones = ZONES[currentTab()];
  const i = zones.indexOf(KB.zone);
  sfx('cursor');
  setZone(i > 0 ? zones[i - 1] : 'menu');
}

function onKey(e) {
  if ($('folderDialog').open) { folderKey(e); return; }
  if ($('backupDialog').open) { backupKey(e); return; }
  if ($('addDialog').open) { dialogKey(e); return; }
  if (!S.parsed) return;
  const k = e.key;
  if (e.ctrlKey && k.toLowerCase() === 's') { e.preventDefault(); save(); return; }

  const ae = document.activeElement;
  if (isField(ae)) {
    if (ae.type === 'search') {
      if (k === 'Escape' || k === 'Enter' || k === 'ArrowDown') {
        e.preventDefault(); ae.blur();
        if (k === 'Escape') setZone('menu'); else { KB.table = 0; setZone('table'); }
      }
      return;
    }
    if (k === 'Enter') { e.preventDefault(); ae.blur(); kbRender(); }
    else if (k === 'Escape') {
      e.preventDefault();
      if (ae.tagName === 'INPUT' && ae.dataset.orig != null) ae.value = ae.dataset.orig;
      ae.blur(); kbRender();
    }
    return; // let the field handle typing and caret keys
  }

  const up = k === 'ArrowUp', down = k === 'ArrowDown', left = k === 'ArrowLeft', right = k === 'ArrowRight';
  const ok = k === 'Enter' || k === ' ';
  const cancel = k === 'Escape' || k === 'Backspace';
  const page = k === 'PageUp' || k === 'PageDown';
  if (up || down || left || right || ok || cancel || page) e.preventDefault();
  const tab = currentTab();

  if (LIST_EL[tab] && (k === 'q' || k === 'w' || page)) { switchUnit(k === 'q' || k === 'PageUp' ? -1 : 1); return; }

  if (KB.zone === 'menu') {
    const items = menuItems();
    if (up || down) {
      KB.menu = wrap(KB.menu + (up ? -1 : 1), items.length);
      const it = items[KB.menu];
      if (it.dataset.tab) showTab(it.dataset.tab);
      sfx('cursor'); kbRender();
    } else if (ok || right) {
      const it = items[KB.menu];
      if (it === $('btnSave')) { if (it.disabled) sfx('error'); else save(); return; }
      sfx('confirm'); KB.panel = 0; KB.table = 0; setZone(ZONES[tab][0]);
    }
  } else if (KB.zone === 'list') {
    if (up || down) switchUnit(up ? -1 : 1);
    else if (ok || right) { sfx('confirm'); KB.panel = 0; setZone('panel'); }
    else if (cancel || left) back();
  } else {
    const zone = KB.zone;
    const rows = zone === 'panel' ? panelControls() : tableRows();
    if ((up || down || page) && rows.length) {
      if (page) KB[zone] = Math.max(0, Math.min(rows.length - 1, KB[zone] + (k === 'PageUp' ? -10 : 10)));
      else KB[zone] = wrap(KB[zone] + (up ? -1 : 1), rows.length);
      sfx('cursor'); kbRender(true);
    } else if (left || right) adjust(targetControl(kbTarget()), left ? -1 : 1, e);
    else if (ok) confirmControl(targetControl(kbTarget()));
    else if (cancel) back();
    else if (k === '/' && SEARCH_EL[tab]) { e.preventDefault(); $(SEARCH_EL[tab]).focus(); kbRender(); }
    else if (k.toLowerCase() === 'a' && tab === 'inventory') { e.preventDefault(); openAddDialog(); }
    else if (/^[0-9]$/.test(k)) {
      // start typing a number directly
      const c = targetControl(kbTarget());
      if (c && c.tagName === 'INPUT') { e.preventDefault(); c.focus(); c.value = k; kbRender(); }
    }
  }
}

function dialogKey(e) {
  const k = e.key;
  const rows = [...$('addTable').querySelectorAll('tbody tr')];
  const ids = rows.map((r) => Number(r.firstChild.textContent));
  const ae = document.activeElement;
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    if (ae === $('addFilter')) ae.blur(); // ←→ now change the quantity; typing returns to the search
    if (!rows.length) return;
    const i = ids.indexOf(addSel);
    const n = i < 0 ? 0 : wrap(i + (k === 'ArrowUp' ? -1 : 1), rows.length);
    addSel = ids[n];
    rows.forEach((r, j) => r.classList.toggle('selected', j === n));
    rows[n].scrollIntoView({ block: 'nearest' });
    sfx('cursor');
  } else if (k === 'Enter') {
    e.preventDefault();
    if (addSel == null && rows.length) addSel = ids[0];
    confirmAdd();
  } else if ((k === 'ArrowLeft' || k === 'ArrowRight') && ae !== $('addFilter')) {
    e.preventDefault();
    const q = $('addQty');
    q.value = String(Math.max(0, (Number(q.value) || 0) + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)));
    sfx('cursor');
  } else if (k === 'Tab') {
    e.preventDefault();
    (ae === $('addFilter') ? $('addQty') : $('addFilter')).focus();
  } else if (k.length === 1 && !isField(ae) && !e.ctrlKey) {
    e.preventDefault();
    const f = $('addFilter'); f.focus(); f.value += k; f.dispatchEvent(new Event('input'));
  }
}

function initKeyboard() {
  document.addEventListener('keydown', onKey);
  // keep the keyboard cursor in sync with the mouse
  $('tabs').addEventListener('click', (e) => {
    const li = e.target.closest('[data-tab]');
    if (li) { KB.menu = menuItems().indexOf(li); setZone('menu'); }
  });
  for (const id of ['charList', 'visList']) $(id).addEventListener('click', () => setZone('list'));
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    const c = panelControls().indexOf(t);
    if (c >= 0) { KB.panel = c; KB.zone = 'panel'; }
    const row = t.closest ? t.closest('tbody tr') : null;
    const r = row ? tableRows().indexOf(row) : -1;
    if (r >= 0) { KB.table = r; KB.zone = 'table'; }
    kbRender();
  });
  document.addEventListener('focusout', () => setTimeout(() => kbRender(), 0));
  $('addDialog').addEventListener('close', () => kbRender());
  $('folderDialog').addEventListener('close', () => kbRender());
  $('backupDialog').addEventListener('close', () => kbRender());
  // re-place the hand whenever content re-renders, scrolls or the window resizes
  let pending = false;
  const later = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; kbRender(); }); } };
  new MutationObserver(later).observe(document.querySelector('.content'), { childList: true, subtree: true });
  document.addEventListener('scroll', later, true);
  window.addEventListener('resize', later);
  kbRender();
}

initKeyboard();
