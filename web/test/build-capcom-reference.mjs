// Build stock engines with newly authored test notes, never game melodies/ROMs.
// Downloads pinned, publicly documented disassemblies into ignored web/build/.
// Requires ca65/ld65; on Windows uses the existing WSL installation.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CAPCOM_DRIVERS, capcomFingerprint } from '../html/dnft-nsf-capcom.mjs';

export const REFERENCE_DIR = resolve('web/build/capcom-reference');
const pins = ['b606a84840aea70f1298ddd9cf832bda69d99d27', '8e378590488ce589c526f0d24ad4dee60afd14a3'];
for (const [index, pin] of pins.entries()) {
  const game = `mm${index + 1}`, dir = resolve(REFERENCE_DIR, game);
  for (const file of ['ram/ram.asm', 'constants/track.asm', 'constants/nes.asm', 'constants/audio.asm', 'macros/audio.asm', 'audio/engine.asm']) {
    const path = resolve(dir, file);
    await mkdir(resolve(path, '..'), { recursive: true });
    let source;
    try { source = await readFile(path, 'utf8'); }
    catch {
      const response = await fetch(`https://raw.githubusercontent.com/lsmmega/${game}/${pin}/${file}`);
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      source = await response.text(); await writeFile(path, source);
    }
  }
  const asm = `.include "ram/ram.asm"
.include "constants/track.asm"
.include "constants/nes.asm"
.include "constants/audio.asm"
.segment "BANK0C"
.org $8000
.include "audio/engine.asm"
track_pointers:
.word song0, song1, effect
song0:
.byte $0F
.word lead, harmony, bass, noise, modulation
song1:
.byte $0F
.word stopped, silent, silent, silent, modulation
lead:
.byte 0,6, 3,$3D, 2,$80, 5,35, 8,1, 7,$86,$10
leadloop:
.byte $81,$85,$88,$80, 4,1
.word leadloop
.byte 6,$81, $30,$81, $30,$85, $30,$88, $21,$81,$85
.byte 4,0
.word leadloop
harmony:
.byte 0,12, 3,$3B, 2,$40, 5,23, 8,0
harmonyloop:
.byte $61,$65,$68,$60, 4,0
.word harmonyloop
bass:
.byte 0,6, 3,$25, 5,23, 8,0
bassloop:
.byte $81,$85,$88,$80, 4,0
.word bassloop
noise:
.byte 0,6, 3,$38, 2,0, 8,0, 7,$86,$20, 1,1
noiseloop:
.byte $84,$80,$88,$80, 4,0
.word noiseloop
stopped:
.byte 0,6, 3,$3F, 2,$80, 5,35, 8,0, $81,6,$85,$88,$80,9
silent:
.byte 9
modulation:
.byte 0,0,$80,0, 2,$62,$80,0
effect:
.byte $20,1, 2,$80,3,$3F,0,8,$80,$D5,0,8,$80,$A9,6
.res $BF00-*,0
init:
tax
lda #15
sta $4015
lda #$40
sta $4017
lda songmap,x
jmp _nmi_audio_track_queue
songmap:
.byte 1,0,2
`;
  await writeFile(resolve(dir, 'fixture.asm'), asm);
  await writeFile(resolve(dir, 'fixture.cfg'), 'MEMORY { BANK: start = $8000, size = $4000, file = %O, fill = yes; } SEGMENTS { BANK0C: load = BANK, type = ro; }');
  if (process.platform === 'win32') {
    const linux = dir.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replaceAll('\\', '/');
    execFileSync('wsl', ['bash', '-lc', `cd '${linux}' && ca65 fixture.asm -o fixture.o && ld65 -C fixture.cfg fixture.o -o fixture.bin`], { stdio: 'inherit' });
  } else {
    execFileSync('ca65', ['fixture.asm', '-o', 'fixture.o'], { cwd: dir });
    execFileSync('ld65', ['-C', 'fixture.cfg', 'fixture.o', '-o', 'fixture.bin'], { cwd: dir });
  }
  const data = await readFile(resolve(dir, 'fixture.bin'));
  if (capcomFingerprint(data.subarray(0, CAPCOM_DRIVERS[index].size)) !== CAPCOM_DRIVERS[index].hash) throw new Error(`${game}: stock engine fingerprint mismatch`);
  const bytes = Buffer.alloc(128 + data.length);
  bytes.write('NESM\x1A'); bytes[5] = 1; bytes[6] = 3; bytes[7] = 1;
  bytes.writeUInt16LE(0x8000, 8); bytes.writeUInt16LE(0xBF00, 10); bytes.writeUInt16LE(0x8000, 12);
  bytes.writeUInt16LE(16639, 0x6E); bytes.writeUInt16LE(19997, 0x78); bytes[0x7A] = 2;
  bytes.write(`Capcom ${game} synthetic notes`, 14); data.copy(bytes, 128);
  await writeFile(resolve(REFERENCE_DIR, `${game}.nsf`), bytes);
  console.log(`built ${game}: pinned stock engine, synthetic music + SFX, non-identity song map`);
}
