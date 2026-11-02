// Final Fantasy Resonance save format (decrypted GVAS body): parsing and in-place editing.
// Works in the renderer (window.FFRS) and in Node (require) — no Node APIs used here.
// Encryption (AES-256-ECB) and the SVHD header checksum live in the main process.
(function (root) {
  'use strict';

  const SCALARS = {
    IntProperty: ['getInt32', 'setInt32', 4],
    UInt32Property: ['getUint32', 'setUint32', 4],
    Int64Property: ['getBigInt64', 'setBigInt64', 8],
    FloatProperty: ['getFloat32', 'setFloat32', 4],
    DoubleProperty: ['getFloat64', 'setFloat64', 8],
    Int16Property: ['getInt16', 'setInt16', 2],
    ByteValue: ['getUint8', 'setUint8', 1],
  };
  const FLOATS = new Set(['FloatProperty', 'DoubleProperty']);

  class Reader {
    constructor(bytes) {
      this.b = bytes;
      this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.o = 0;
    }
    int() { const x = this.v.getInt32(this.o, true); this.o += 4; return x; }
    byte() { return this.b[this.o++]; }
    skip(n) { this.o += n; }
    string() {
      const n = this.int();
      if (!n) return '';
      if (n < 0) {
        const s = new TextDecoder('utf-16le').decode(this.b.subarray(this.o, this.o - n * 2 - 2));
        this.o += -n * 2; return s;
      }
      const s = new TextDecoder('utf-8').decode(this.b.subarray(this.o, this.o + n - 1));
      this.o += n; return s;
    }
    type() {
      const name = this.string();
      const n = this.int();
      const sub = [];
      for (let i = 0; i < n; i++) sub.push(this.type());
      return [name, sub];
    }
  }

  // Parses the body and returns:
  //   fields: path -> {off, kind}   editable scalars
  //   tags:   path -> size-field offset of each property tag
  //   arrays: path -> {countOff, end, inner}
  //   maps:   path -> {countOff, end}
  //   boolRefs: path -> {off, tagged}  where each bool lives (tag flag bit 0x10, or a plain byte)
  //   vectors: path -> offset of a Vector struct (three doubles: X, Y, Z)
  //   stringRefs: path -> offset of the FString of a Str / Name / Enum value (see setString)
  //   end:    end offset of the serialized data (zero padding follows)
  function parse(bytes) {
    const r = new Reader(bytes);
    const fields = new Map(), tags = new Map(), arrays = new Map(), maps = new Map();
    const bools = new Map();   // path -> boolean
    const boolRefs = new Map();
    const strings = new Map(); // path -> string value of Str/Name/Enum properties
    const vectors = new Map(), stringRefs = new Map();
    let flagsOff = 0;
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    if (magic !== 'GVAS') throw new Error('Not a GVAS save body');
    r.skip(4); r.int(); r.int(); r.int(); r.skip(10); r.string(); r.int();
    const n = r.int(); r.skip(n * 20);
    r.string(); r.byte();

    function props(path) {
      for (;;) {
        const name = r.string();
        if (name === 'None') return;
        const t = r.type();
        const sizeOff = r.o;
        const size = r.int();
        flagsOff = r.o;
        const flags = r.byte();
        if (flags & 1) r.int();
        if (flags & 2) r.skip(16);
        const end = r.o + size;
        const p = path ? `${path}.${name}` : name;
        tags.set(p, sizeOff);
        if (t[0] === 'ArrayProperty') arrays.set(p, { countOff: r.o, end, inner: t[1][0][0] });
        if (t[0] === 'MapProperty') maps.set(p, { countOff: r.o + 4, end }); // after the removed-keys count
        try { val(p, t, size, flags); } catch (e) { /* unknown layout: skip by size */ }
        r.o = end;
      }
    }

    function val(path, t, size, flags) {
      const [k, sub] = t;
      if (SCALARS[k]) { fields.set(path, { off: r.o, kind: k }); r.skip(SCALARS[k][2]); return; }
      if (k === 'BoolProperty') {
        // tagged bools keep their value in the tag flags (0x10); untagged ones (map/array values) are one byte
        if (size === 0) { bools.set(path, !!(bytes[flagsOff] & 0x10)); boolRefs.set(path, { off: flagsOff, tagged: true }); }
        else { bools.set(path, !!bytes[r.o]); boolRefs.set(path, { off: r.o, tagged: false }); r.skip(1); }
        return;
      }
      if (k === 'StrProperty' || k === 'NameProperty' || k === 'EnumProperty') { stringRefs.set(path, r.o); strings.set(path, r.string()); return; }
      if (k === 'ByteProperty') {
        if (size === 1) { fields.set(path, { off: r.o, kind: 'ByteValue' }); r.skip(1); } else strings.set(path, r.string());
        return;
      }
      if (k === 'ArrayProperty') {
        const c = r.int();
        for (let i = 0; i < c; i++) val(`${path}[${i}]`, sub[0], null, 0);
        return;
      }
      if (k === 'MapProperty') {
        const removed = r.int();
        for (let i = 0; i < removed; i++) val(`${path}{removed}`, sub[0], null, 0);
        const c = r.int();
        for (let i = 0; i < c; i++) {
          val(`${path}{${i}}.key`, sub[0], null, 0);
          val(`${path}{${i}}.value`, sub[1], null, 0);
        }
        return;
      }
      if (k === 'StructProperty') {
        const st = sub.length ? sub[0][0] : '';
        if (st === 'DateTime') { r.skip(8); return; }
        if (st === 'Vector') { vectors.set(path, r.o); r.skip(24); return; }
        if (!(flags & 8)) { props(path); return; }
      }
      if (size === null) throw new Error('unsized ' + k);
      r.skip(size);
    }

    props('');
    return { fields, tags, arrays, maps, bools, boolRefs, strings, vectors, stringRefs, end: r.o };
  }

  // Sets a bool in place (no sizes change).
  function setBool(bytes, ref, value) {
    if (ref.tagged) bytes[ref.off] = value ? bytes[ref.off] | 0x10 : bytes[ref.off] & ~0x10;
    else bytes[ref.off] = value ? 1 : 0;
  }

  function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

  function getField(bytes, f) {
    const [getter] = SCALARS[f.kind];
    const v = view(bytes)[getter](f.off, true);
    return typeof v === 'bigint' ? Number(v) : v;
  }

  // Validates and writes; throws on bad input.
  function setField(bytes, f, text) {
    const s = String(text).trim();
    if (s === '' || isNaN(Number(s))) throw new Error(`"${text}" is not a number`);
    const num = Number(s);
    if (!FLOATS.has(f.kind) && !Number.isInteger(num)) throw new Error(`"${text}" must be a whole number`);
    const [, setter, width] = SCALARS[f.kind];
    if (!FLOATS.has(f.kind)) {
      const signed = f.kind !== 'UInt32Property' && f.kind !== 'ByteValue';
      const bits = width * 8;
      const min = signed ? -(2 ** (bits - 1)) : 0;
      const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
      if (num < min || num > max) throw new Error(`${num} is out of range (${min}..${max})`);
    }
    view(bytes)[setter](f.off, f.kind === 'Int64Property' ? BigInt(num) : num, true);
  }

  // A Vector (X, Y, Z doubles) in place.
  function getVector(bytes, off) { const v = view(bytes); return [0, 8, 16].map((k) => v.getFloat64(off + k, true)); }
  function setVector(bytes, off, xyz) {
    if (xyz.length !== 3 || xyz.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('A position needs three numbers');
    const v = view(bytes);
    xyz.forEach((n, k) => v.setFloat64(off + k * 8, n, true));
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function int32(v) { const b = new Uint8Array(4); view(b).setInt32(0, v, true); return b; }

  function fstring(text) {
    const s = new TextEncoder().encode(text + '\0');
    return concat([int32(s.length), s]);
  }

  function intTag(name, value) {
    const tail = new Uint8Array(13);
    const v = view(tail);
    v.setInt32(0, 0, true); v.setInt32(4, 4, true); v.setUint8(8, 0); v.setInt32(9, value, true);
    return concat([fstring(name), fstring('IntProperty'), tail]);
  }

  function boolTag(name, value) {
    const tail = new Uint8Array(9);
    tail[8] = value ? 0x10 : 0; // inner type count 0, size 0, flags (value in bit 0x10)
    return concat([fstring(name), fstring('BoolProperty'), tail]);
  }

  // Appends a serialized element to the array (or a key + value entry to the map) at `path`, fixing the
  // element count, the size of that tag and of every enclosing tag, and the AES padding. Returns a new Uint8Array.
  function appendToArray(bytes, path, data) { return appendEntry(bytes, path, data, 'arrays'); }
  function appendToMap(bytes, path, data, n = 1) { return appendEntry(bytes, path, data, 'maps', n); }

  // `data` may hold `n` serialized entries back to back.
  function appendEntry(bytes, path, data, kind, n = 1, p = parse(bytes)) {
    const arr = p[kind].get(path);
    if (!arr) throw new Error(`No ${kind === 'maps' ? 'map' : 'array'} at ${path}`);
    const out = new Uint8Array(p.end + data.length + 4 + 16);
    out.set(bytes.subarray(0, arr.end), 0);
    out.set(data, arr.end);
    out.set(bytes.subarray(arr.end, p.end), arr.end + data.length);
    const v = view(out);
    v.setInt32(arr.countOff, v.getInt32(arr.countOff, true) + n, true);
    for (const [tp, sizeOff] of p.tags) {
      if (tp === path || path.startsWith(tp + '.') || path.startsWith(tp + '[') || path.startsWith(tp + '{')) {
        v.setInt32(sizeOff, v.getInt32(sizeOff, true) + data.length, true);
      }
    }
    // trailing int32 0 after the final "None", then zero padding to the AES block size
    let len = p.end + data.length + 4;
    len += (16 - (len % 16)) % 16;
    return out.slice(0, len);
  }

  // Replaces the Str / Name / Enum value at `path` (ASCII only), fixing the size of its tag and of every enclosing
  // tag, and the AES padding. Returns a new Uint8Array.
  function setString(bytes, path, text, p = parse(bytes)) {
    if (!/^[ -~]*$/.test(text)) throw new Error('Only plain ASCII text can be written');
    const off = p.stringRefs.get(path);
    if (off === undefined) throw new Error(`No text value at ${path}`);
    const n = view(bytes).getInt32(off, true);
    if (n < 0) throw new Error(`${path} is stored as UTF-16`);
    const oldLen = 4 + n, data = fstring(text), delta = data.length - oldLen;
    const out = new Uint8Array(p.end + delta + 4 + 16);
    out.set(bytes.subarray(0, off), 0);
    out.set(data, off);
    out.set(bytes.subarray(off + oldLen, p.end), off + data.length);
    const v = view(out);
    for (const [tp, sizeOff] of p.tags) {
      if (sizeOff < off && (tp === path || path.startsWith(tp + '.') || path.startsWith(tp + '[') || path.startsWith(tp + '{'))) {
        v.setInt32(sizeOff, v.getInt32(sizeOff, true) + delta, true);
      }
    }
    let len = p.end + delta + 4;
    len += (16 - (len % 16)) % 16;
    return out.slice(0, len);
  }

  function addInventoryItem(bytes, itemId, num) {
    const p = parse(bytes);
    for (let i = 0; p.fields.has(`inventory[${i}].ItemId`); i++) {
      if (getField(bytes, p.fields.get(`inventory[${i}].ItemId`)) === itemId) {
        const out = bytes.slice();
        setField(out, p.fields.get(`inventory[${i}].Num`), num);
        return out;
      }
    }
    return appendToArray(bytes, 'inventory', concat([intTag('ItemId', itemId), intTag('Num', num), fstring('None')]));
  }

  function addAccessory(bytes, charIdx, itemId) {
    return appendToArray(bytes, `unitParameterList[${charIdx}].EquipAccessoryIdList`, int32(itemId));
  }

  // Finds the index of the map entry whose int key is `key`, or -1.
  function mapIndex(bytes, p, path, key) {
    for (let i = 0; p.fields.has(`${path}{${i}}.key`); i++) {
      if (getField(bytes, p.fields.get(`${path}{${i}}.key`)) === key) return i;
    }
    return -1;
  }

  // Adds an artifact (or switches an existing one) in artifactList: int item id -> {IsActive}.
  function setArtifact(bytes, itemId, active) {
    const p = parse(bytes);
    const i = mapIndex(bytes, p, 'artifactList', itemId);
    if (i >= 0) {
      const out = bytes.slice();
      setBool(out, p.boolRefs.get(`artifactList{${i}}.value.IsActive`), active);
      return out;
    }
    return appendToMap(bytes, 'artifactList', concat([int32(itemId), boolTag('IsActive', active), fstring('None')]));
  }

  // Sets the known / visited / cleared flags of a map in Map.perMapSaveDataMap, adding the entry if needed.
  function setMapFlags(bytes, mapId, flags) { return setManyMapFlags(bytes, [mapId], flags); }

  // Same for several maps at once: existing entries change in place, missing ones are added in one insert.
  function setManyMapFlags(bytes, mapIds, flags) {
    const path = 'Map.perMapSaveDataMap';
    const p = parse(bytes);
    const index = new Map();
    for (let i = 0; p.fields.has(`${path}{${i}}.key`); i++) index.set(getField(bytes, p.fields.get(`${path}{${i}}.key`)), i);
    const out = bytes.slice();
    const added = [];
    for (const id of new Set(mapIds)) {
      const i = index.get(id);
      if (i === undefined) { added.push(id); continue; }
      for (const [k, v] of Object.entries(flags)) {
        const ref = p.boolRefs.get(`${path}{${i}}.value.${k}`);
        if (ref) setBool(out, ref, v);
      }
    }
    if (!added.length) return out;
    const f = { bIsKnown: false, bIsVisited: false, bIsCleared: false, ...flags };
    const data = concat(added.map((id) => concat([int32(id),
      boolTag('bIsKnown', f.bIsKnown), boolTag('bIsVisited', f.bIsVisited), boolTag('bIsCleared', f.bIsCleared), fstring('None')])));
    return appendEntry(out, path, data, 'maps', added.length, p);
  }

  // A dungeon's save point counts as reached when Map.mapGimmick{map}.gimmickState holds its unique id with Value 1:
  // the dungeon's other save points can Teleport to it. Sets an existing entry, or adds one copied from another
  // "reached" entry in this save (only the key changes), so the layout is the game's own. Returns a new Uint8Array.
  // Throws if the save has no entry for the map yet (the dungeon was never visited).
  function unlockSavePoint(bytes, mapId, uniqueId) {
    const p = parse(bytes);
    const mi = mapIndex(bytes, p, 'Map.mapGimmick', mapId);
    if (mi < 0) throw new Error('This dungeon has never been visited in this save: go in once first');
    const path = `Map.mapGimmick{${mi}}.value.gimmickState`;
    if (!p.maps.has(path)) throw new Error('This dungeon has no object states in the save');
    const si = mapIndex(bytes, p, path, uniqueId);
    if (si >= 0) {
      const out = bytes.slice();
      setField(out, p.fields.get(`${path}{${si}}.value.Value`), 1);
      return out;
    }
    // a template: any entry of any map whose Value is 1 and value2 -1 (a reached save point or a used switch)
    let tpl = null;
    for (const [mp, m] of p.maps) {
      if (!/^Map\.mapGimmick\{\d+\}\.value\.gimmickState$/.test(mp)) continue;
      for (let j = 0; p.fields.has(`${mp}{${j}}.key`); j++) {
        const v = p.fields.get(`${mp}{${j}}.value.Value`), v2 = p.fields.get(`${mp}{${j}}.value.value2`);
        if (!v || !v2 || getField(bytes, v) !== 1 || getField(bytes, v2) !== -1) continue;
        const start = p.fields.get(`${mp}{${j}}.key`).off;
        const end = p.fields.has(`${mp}{${j + 1}}.key`) ? p.fields.get(`${mp}{${j + 1}}.key`).off : m.end;
        tpl = bytes.slice(start, end);
        break;
      }
      if (tpl) break;
    }
    if (!tpl) throw new Error('No reached save point in this save to copy the layout from');
    view(tpl).setInt32(0, uniqueId, true);
    return appendEntry(bytes, path, tpl, 'maps', 1, p);
  }

  const api = { parse, getField, setField, setBool, appendToArray, appendToMap, addInventoryItem, addAccessory, unlockSavePoint,
    setArtifact, setMapFlags, setManyMapFlags, getVector, setVector, setString, intTag, boolTag, fstring };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FFRS = api;
})(typeof self !== 'undefined' ? self : this);
