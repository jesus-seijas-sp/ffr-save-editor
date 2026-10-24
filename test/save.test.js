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

console.log(`OK — ${p.fields.size} fields, ${n0} inventory entries (${path.basename(file)})`);
