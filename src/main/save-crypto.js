// SVHD container: "SVHD" + u16 + u16 + SHA-1(body) + 4 zero bytes, then the AES-256-ECB encrypted GVAS body.
// Key from https://github.com/zabo-dev/ffr-save-tracker
const crypto = require('crypto');

const KEY = Buffer.from('wwrqPkdwzPvgfchQ8kTYHVbn4umTf3d7');
const HEADER_SIZE = 32;

function decryptSave(raw) {
  if (raw.subarray(0, 4).toString('latin1') !== 'SVHD') throw new Error('Not a Final Fantasy Resonance save (missing SVHD header)');
  const body = raw.subarray(HEADER_SIZE);
  const sha = crypto.createHash('sha1').update(body).digest();
  if (!sha.equals(raw.subarray(8, 28))) throw new Error('Save checksum mismatch');
  const d = crypto.createDecipheriv('aes-256-ecb', KEY, null);
  d.setAutoPadding(false);
  return { header: Buffer.from(raw.subarray(0, HEADER_SIZE)), plain: Buffer.concat([d.update(body), d.final()]) };
}

function encryptSave(header, plain) {
  if (plain.length % 16) throw new Error('Body length must be a multiple of 16');
  const c = crypto.createCipheriv('aes-256-ecb', KEY, null);
  c.setAutoPadding(false);
  const body = Buffer.concat([c.update(plain), c.final()]);
  const out = Buffer.concat([header.subarray(0, HEADER_SIZE), body]);
  crypto.createHash('sha1').update(body).digest().copy(out, 8);
  return out;
}

module.exports = { decryptSave, encryptSave };
