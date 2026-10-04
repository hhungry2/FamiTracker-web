// Dn-FamiTracker web port - zip archives of files as they are (stored, not
// compressed), for exports that write more than one file.
//
//   const blob = zip([{name: 'music.bin', data: bytes}, ...]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k)
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; ++i)
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date and time
function dosTime(date) {
  return {
    time: date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >> 1,
    date: (date.getFullYear() - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate(),
  };
}

// files: [{name, data: Uint8Array}]; names in UTF-8
export function zip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const { time, date: day } = dosTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);
    local.setUint16(4, 10, true);          // version needed: 1.0
    local.setUint16(6, 0x0800, true);      // names in UTF-8
    local.setUint16(8, 0, true);           // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local, name, file.data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014B50, true);
    entry.setUint16(4, 20, true);          // made by: 2.0
    entry.setUint16(6, 10, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
