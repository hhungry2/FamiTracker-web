// NSF/NSFe containers and initial memory mapping, independent of a music driver.
export class NsfDriverError extends Error {
  constructor(message) { super(message); this.name = 'NsfDriverError'; }
}
export const requireDriver = (condition, message) => { if (!condition) throw new NsfDriverError(message); };
const require = requireDriver;
const word = (bytes, at) => bytes[at] | bytes[at + 1] << 8;
const tag = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n));

export function nsfMemory(bytes) {
  require(bytes instanceof Uint8Array, 'invalid NSF bytes');
  let data, load, init, play, chips, songs, banks = new Uint8Array(8), opll = null;
  if (tag(bytes, 0, 5) === 'NESM\x1a') {
    require(bytes.length >= 128, 'truncated NSF header');
    require((bytes[5] === 1 || bytes[5] === 2) && !(bytes[0x7C] & 127), 'unsupported NSF execution flags');
    load = word(bytes, 8); init = word(bytes, 10); play = word(bytes, 12);
    chips = bytes[0x7B]; songs = bytes[6]; banks = bytes.slice(0x70, 0x78);
    const size = bytes[0x7D] | bytes[0x7E] << 8 | bytes[0x7F] << 16;
    require(!size || size <= bytes.length - 128, 'truncated NSF data');
    data = bytes.subarray(128, size ? 128 + size : bytes.length);
    if (bytes[5] === 2 && bytes[0x7C] & 128) {
      require(size > 0, 'missing NSF2 data length');
      for (let at = 128 + size; at < bytes.length;) {
        require(at + 8 <= bytes.length, 'truncated NSF2 metadata');
        const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
        require(length <= bytes.length - at - 8, 'truncated NSF2 chunk');
        if (tag(bytes, at + 4, 4) === 'VRC7') opll = bytes.slice(at + 8, at + 8 + length);
        at += 8 + length;
      }
    }
  } else if (tag(bytes, 0, 4) === 'NSFE') {
    let end = false;
    const chunks = new Map();
    for (let at = 4; at < bytes.length;) {
      require(at + 8 <= bytes.length, 'truncated NSFe chunk');
      const size = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
      const name = tag(bytes, at + 4, 4);
      require(!/^[A-Z]/.test(name) || ['INFO', 'DATA', 'BANK', 'RATE', 'VRC7', 'NEND'].includes(name), 'unsupported mandatory NSFe chunk');
      require(size <= bytes.length - at - 8, 'truncated NSFe data');
      require(!chunks.has(name), 'duplicate NSFe chunk');
      chunks.set(name, bytes.subarray(at + 8, at + 8 + size));
      at += 8 + size;
      if (name === 'NEND') { require(size === 0 && at === bytes.length, 'invalid NSFe end'); end = true; break; }
    }
    const info = chunks.get('INFO');
    require(end && info?.length >= 10 && chunks.has('DATA'), 'missing NSFe header or data');
    load = word(info, 0); init = word(info, 2); play = word(info, 4); chips = info[7]; songs = info[8];
    data = chunks.get('DATA');
    if (chunks.has('BANK')) { require(chunks.get('BANK').length <= 8, 'invalid NSF banks'); banks.set(chunks.get('BANK')); }
    opll = chunks.get('VRC7');
  } else throw new NsfDriverError('not an NSF/NSFe');
  require(load >= 0x8000 && init >= 0x8000 && play >= 0x8000 && songs > 0 && chips <= 63, 'unsupported NSF layout');
  const banked = banks.some(b => b !== 0);
  const memory = { load, init, play, chips, songs, banks, banked, data, opll };
  memory.offset = (address, mapping = banks) => {
    require(Number.isInteger(address) && address >= 0x8000 && address <= 0xFFFF, 'music pointer outside NSF memory');
    let offset = address - load;
    if (banked) {
      const bank = mapping[(address - 0x8000) >> 12];
      offset = bank * 4096 + (address & 4095) - (load & 4095);
    }
    require(offset >= 0 && offset < data.length, 'music pointer outside NSF data');
    return offset;
  };
  memory.byte = (a, b = banks) => data[memory.offset(a, b)];
  memory.word = (a, b = banks) => memory.byte(a, b) | memory.byte(a + 1, b) << 8;
  memory.bytes = (a, n, b = banks) => Uint8Array.from({ length: n }, (_, i) => data[memory.offset(a + i, b)]);
  return memory;
}
