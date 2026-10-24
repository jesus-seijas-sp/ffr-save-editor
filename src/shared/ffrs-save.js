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
  //   end:    end offset of the serialized data (zero padding follows)
  function parse(bytes) {
    const r = new Reader(bytes);
    const fields = new Map(), tags = new Map(), arrays = new Map();
    const bools = new Map();   // path -> boolean (read-only)
    const strings = new Map(); // path -> string value of Str/Name/Enum properties (read-only)
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
        try { val(p, t, size, flags); } catch (e) { /* unknown layout: skip by size */ }
        r.o = end;
      }
    }

    function val(path, t, size, flags) {
      const [k, sub] = t;
      if (SCALARS[k]) { fields.set(path, { off: r.o, kind: k }); r.skip(SCALARS[k][2]); return; }
      if (k === 'BoolProperty') {
        // tagged bools keep their value in the tag flags (0x10); untagged ones (map/array values) are one byte
        if (size === 0) bools.set(path, !!(bytes[flagsOff] & 0x10));
        else { bools.set(path, !!bytes[r.o]); r.skip(1); }
        return;
      }
      if (k === 'StrProperty' || k === 'NameProperty' || k === 'EnumProperty') { strings.set(path, r.string()); return; }
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
        if (st === 'Vector') { r.skip(24); return; }
        if (!(flags & 8)) { props(path); return; }
      }
      if (size === null) throw new Error('unsized ' + k);
      r.skip(size);
    }

    props('');
    return { fields, tags, arrays, bools, strings, end: r.o };
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

  // Appends a serialized element to the array at `path`, fixing the element count, the size of that
  // tag and of every enclosing tag, and the AES padding. Returns a new Uint8Array.
  function appendToArray(bytes, path, data) {
    const p = parse(bytes);
    const arr = p.arrays.get(path);
    if (!arr) throw new Error('No array at ' + path);
    const out = new Uint8Array(p.end + data.length + 4 + 16);
    out.set(bytes.subarray(0, arr.end), 0);
    out.set(data, arr.end);
    out.set(bytes.subarray(arr.end, p.end), arr.end + data.length);
    const v = view(out);
    v.setInt32(arr.countOff, v.getInt32(arr.countOff, true) + 1, true);
    for (const [tp, sizeOff] of p.tags) {
      if (tp === path || path.startsWith(tp + '.') || path.startsWith(tp + '[')) {
        v.setInt32(sizeOff, v.getInt32(sizeOff, true) + data.length, true);
      }
    }
    // trailing int32 0 after the final "None", then zero padding to the AES block size
    let len = p.end + data.length + 4;
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

  const api = { parse, getField, setField, appendToArray, addInventoryItem, addAccessory, intTag, fstring };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FFRS = api;
})(typeof self !== 'undefined' ? self : this);
