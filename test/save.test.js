// Round-trip and editing tests against a real save. Usage: npm test [-- <GameSaveDataN.sav>]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../src/shared/ffrs-save');
const { decryptSave, encryptSave } = require('../src/main/save-crypto');

function findSave() {
  if (process.argv[2]) return process.argv[2];
  const root = path.join(process.env.LOCALAPPDATA || '', 'FFRS', 'Steam');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, 'GameSaveData1.sav');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const file = findSave();
if (!file) { console.log('No save found — pass a path: npm test -- <GameSaveDataN.sav>'); process.exit(0); }

const raw = fs.readFileSync(file); // read only — the save itself is never written
const { header, plain } = decryptSave(raw);
assert(encryptSave(header, plain).equals(raw), 'decrypt/encrypt round trip must be byte-identical');

const bytes = new Uint8Array(plain);
const p = F.parse(bytes);
assert(p.fields.size > 100, 'expected editable fields');
assert(p.fields.has('Player.currentMoney'));

// in-place edit
const b1 = bytes.slice();
F.setField(b1, p.fields.get('Player.currentMoney'), '123456');
assert.strictEqual(F.getField(b1, F.parse(b1).fields.get('Player.currentMoney')), 123456);
assert.throws(() => F.setField(b1, p.fields.get('Player.currentMoney'), 'abc'));
assert.throws(() => F.setField(b1, p.fields.get('Player.currentMoney'), '1.5'));

// inventory: new item appended, existing item updated, everything else intact
const invCount = (b, q) => { let i = 0; while (q.fields.has(`inventory[${i}].ItemId`)) i++; return i; };
const n0 = invCount(bytes, p);
let b2 = F.addInventoryItem(bytes, 99999, 7);
let q = F.parse(b2);
assert.strictEqual(invCount(b2, q), n0 + 1);
assert.strictEqual(F.getField(b2, q.fields.get(`inventory[${n0}].ItemId`)), 99999);
assert.strictEqual(F.getField(b2, q.fields.get(`inventory[${n0}].Num`)), 7);
assert.strictEqual(b2.length % 16, 0, 'body must stay AES block aligned');
const firstId = F.getField(bytes, p.fields.get('inventory[0].ItemId'));
b2 = F.addInventoryItem(b2, firstId, 42);
q = F.parse(b2);
assert.strictEqual(invCount(b2, q), n0 + 1);
assert.strictEqual(F.getField(b2, q.fields.get('inventory[0].Num')), 42);
for (const [k, f] of p.fields) {
  if (k.startsWith('inventory[')) continue;
  assert.strictEqual(F.getField(b2, q.fields.get(k)), F.getField(bytes, f), `unchanged field ${k}`);
}

// accessory appended to a character's list
const acc = (b, qq, c) => { let i = 0; while (qq.fields.has(`unitParameterList[${c}].EquipAccessoryIdList[${i}]`)) i++; return i; };
const a0 = acc(bytes, p, 0);
const b3 = F.addAccessory(bytes, 0, 12001);
const q3 = F.parse(b3);
assert.strictEqual(acc(b3, q3, 0), a0 + 1);
assert.strictEqual(F.getField(b3, q3.fields.get(`unitParameterList[0].EquipAccessoryIdList[${a0}]`)), 12001);
decryptSave(encryptSave(header, Buffer.from(b3)));

// bools: tagged (flag bit) and plain-byte bools flip in place
const tagged = [...p.boolRefs].find(([, r]) => r.tagged), plainB = [...p.boolRefs].find(([, r]) => !r.tagged);
for (const [k, ref] of [tagged, plainB].filter(Boolean)) {
  const b = bytes.slice();
  F.setBool(b, ref, !p.bools.get(k));
  assert.strictEqual(F.parse(b).bools.get(k), !p.bools.get(k), `flipped ${k}`);
  assert.strictEqual(b.length, bytes.length);
}

// map entries: synthesized entries match the game's own bytes, and adding one keeps everything else
const mapPath = 'Map.perMapSaveDataMap';
if (p.maps.has(mapPath) && p.fields.has(`${mapPath}{1}.key`)) {
  const k0 = p.fields.get(`${mapPath}{0}.key`).off, k1 = p.fields.get(`${mapPath}{1}.key`).off;
  const flag = (n) => p.bools.get(`${mapPath}{0}.value.${n}`);
  const syn = Buffer.concat([Buffer.from(bytes.subarray(k0, k0 + 4)),
    ...['bIsKnown', 'bIsVisited', 'bIsCleared'].map((n) => Buffer.from(F.boolTag(n, flag(n)))), Buffer.from(F.fstring('None'))]);
  assert(syn.equals(Buffer.from(bytes.subarray(k0, k1))), 'synthesized map entry must match the game bytes');

  const mapCount = (qq) => { let i = 0; while (qq.fields.has(`${mapPath}{${i}}.key`)) i++; return i; };
  const m0 = mapCount(p);
  let b4 = F.setMapFlags(bytes, 99001, { bIsKnown: true });
  let q4 = F.parse(b4);
  assert.strictEqual(mapCount(q4), m0 + 1);
  assert.strictEqual(F.getField(b4, q4.fields.get(`${mapPath}{${m0}}.key`)), 99001);
  assert.strictEqual(q4.bools.get(`${mapPath}{${m0}}.value.bIsKnown`), true);
  assert.strictEqual(q4.bools.get(`${mapPath}{${m0}}.value.bIsVisited`), false);
  b4 = F.setMapFlags(b4, 99001, { bIsCleared: true }); // existing entry: in place
  q4 = F.parse(b4);
  assert.strictEqual(mapCount(q4), m0 + 1);
  assert.strictEqual(q4.bools.get(`${mapPath}{${m0}}.value.bIsCleared`), true);

  b4 = F.setArtifact(b4, 30000, true);
  b4 = F.setArtifact(b4, 30000, false);
  q4 = F.parse(b4);
  const ai = (() => { for (let i = 0; q4.fields.has(`artifactList{${i}}.key`); i++) if (F.getField(b4, q4.fields.get(`artifactList{${i}}.key`)) === 30000) return i; return -1; })();
  assert(ai >= 0, 'artifact entry added');
  assert.strictEqual(q4.bools.get(`artifactList{${ai}}.value.IsActive`), false);
  assert.strictEqual(b4.length % 16, 0, 'body must stay AES block aligned');
  const tail = b4.subarray(q4.end);
  assert(tail.length < 32 && tail.every((x) => x === 0), 'only zero padding after the data');
  for (const [k, f] of p.fields) {
    if (k.startsWith(mapPath) || k.startsWith('artifactList')) continue;
    assert.strictEqual(F.getField(b4, q4.fields.get(k)), F.getField(bytes, f), `unchanged field ${k}`);
  }
  decryptSave(encryptSave(header, Buffer.from(b4)));
}

// a story status (EnumProperty, the text changes length) and the party's position (Vector, in place)
{
  const joinPath = [...p.stringRefs.keys()].find((k) => /^unitParameterList\[\d+\]\.JoinStatus$/.test(k));
  if (joinPath) {
    const was = p.strings.get(joinPath);
    const other = was === 'eUnitJoinStatus::TemporalLeave' ? 'eUnitJoinStatus::Join' : 'eUnitJoinStatus::TemporalLeave';
    const b5 = F.setString(bytes, joinPath, other, p);
    const q5 = F.parse(b5);
    assert.strictEqual(q5.strings.get(joinPath), other, 'status written');
    assert.strictEqual(b5.length % 16, 0, 'body must stay AES block aligned');
    for (const [k, f] of p.fields) assert.strictEqual(F.getField(b5, q5.fields.get(k)), F.getField(bytes, f), `unchanged field ${k}`);
    for (const [k, v] of p.strings) if (k !== joinPath) assert.strictEqual(q5.strings.get(k), v, `unchanged text ${k}`);
    const back = F.setString(b5, joinPath, was, q5);
    assert(Buffer.from(back).equals(Buffer.from(bytes)), 'setting it back gives the original bytes');
    decryptSave(encryptSave(header, Buffer.from(b5)));
  }
  const loc = p.vectors.get('Map.unitLocation');
  if (loc !== undefined) {
    const b6 = bytes.slice();
    const xyz = F.getVector(b6, loc);
    F.setVector(b6, loc, [xyz[0] + 100, xyz[1], xyz[2]]);
    assert.strictEqual(F.getVector(b6, loc)[0], xyz[0] + 100, 'position written');
    assert.strictEqual(F.parse(b6).fields.size, p.fields.size, 'still parses');
  }
}

// a dungeon save point marked as reached: an entry added inside Map.mapGimmick{map} (sizes of every enclosing tag)
{
  const gm = [...p.maps.keys()].find((k) => /^Map\.mapGimmick\{\d+\}\.value\.gimmickState$/.test(k) && p.fields.has(`${k}{0}.key`));
  if (gm) {
    const mapId = F.getField(bytes, p.fields.get(gm.replace('.value.gimmickState', '.key')));
    const b7 = F.unlockSavePoint(bytes, mapId, 9999);
    const q7 = F.parse(b7);
    assert.strictEqual(q7.fields.size, p.fields.size + 3, 'one entry (key, Value, value2) added');
    for (const [k, f] of p.fields) assert.strictEqual(F.getField(b7, q7.fields.get(k)), F.getField(bytes, f), `unchanged field ${k}`);
    assert.strictEqual(b7.length % 16, 0, 'body must stay AES block aligned');
    decryptSave(encryptSave(header, Buffer.from(b7)));
  }
}

console.log(`OK — ${p.fields.size} fields, ${n0} inventory entries (${path.basename(file)})`);
