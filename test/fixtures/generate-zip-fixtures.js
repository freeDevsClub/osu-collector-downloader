// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const FIXTURES_DIR = path.join(__dirname, 'zip');

/**
 * @typedef {Object} ZipFileEntry
 * @property {string} name
 * @property {string | Buffer} content
 * @property {number} [method] 0 for store, 8 for deflate (default)
 * @property {number} [crc] override crc
 * @property {number} [compSize] override compSize
 * @property {number} [uncompSize] override uncompSize
 * @property {number} [localHeaderOffset] override localHeaderOffset
 * @property {number} [localHeaderMagic] override localHeaderMagic (default 0x04034b50)
 * @property {number} [cdHeaderMagic] override cdHeaderMagic (default 0x02014b50)
 */

/**
 * Создает валидный или намеренно кастомизированный ZIP-буфер.
 * @param {ZipFileEntry[]} entries
 * @param {Object} [options]
 * @param {string} [options.comment]
 * @param {boolean} [options.truncateBytes]
 * @param {number} [options.truncateLength]
 * @returns {Buffer}
 */
function buildZip(entries, options = {}) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8');
    const method = entry.method ?? 8;
    const deflated = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = typeof entry.crc === 'number' ? entry.crc : zlib.crc32(raw);
    const uncompLen = typeof entry.uncompSize === 'number' ? entry.uncompSize : raw.length;
    const compLen = typeof entry.compSize === 'number' ? entry.compSize : deflated.length;
    const lhMagic = entry.localHeaderMagic ?? 0x04034b50;

    // Local Header
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(lhMagic, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // general purpose flags
    lh.writeUInt16LE(method, 8); // compression method
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compLen, 18);
    lh.writeUInt32LE(uncompLen, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra field len
    nameBuf.copy(lh, 30);

    const localEntryOffset = entry.localHeaderOffset ?? offset;
    localParts.push(lh, deflated);
    offset += lh.length + deflated.length;

    // Central Directory Header
    const cdMagic = entry.cdHeaderMagic ?? 0x02014b50;
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(cdMagic, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); // time
    ch.writeUInt16LE(0, 14); // date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compLen, 20);
    ch.writeUInt32LE(uncompLen, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(localEntryOffset, 42);
    nameBuf.copy(ch, 46);
    cdParts.push(ch);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const ch of cdParts) centralSize += ch.length;

  const commentBuf = options.comment ? Buffer.from(options.comment, 'utf8') : Buffer.alloc(0);
  const eocd = Buffer.alloc(22 + commentBuf.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk num
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(cdParts.length, 8); // entries on disk
  eocd.writeUInt16LE(cdParts.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  if (commentBuf.length > 0) commentBuf.copy(eocd, 22);

  let full = Buffer.concat([...localParts, ...cdParts, eocd]);
  if (options.truncateLength && options.truncateLength < full.length) {
    full = full.subarray(0, options.truncateLength);
  }
  return full;
}

/**
 * Создает валидный ZIP64-буфер.
 * @param {ZipFileEntry[]} entries
 * @returns {Buffer}
 */
function buildZip64(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8');
    const method = entry.method ?? 8;
    const deflated = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = typeof entry.crc === 'number' ? entry.crc : zlib.crc32(raw);

    // Local Header (ZIP64 format)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4); // ZIP64 version
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    const localEntryOffset = offset;
    localParts.push(lh, deflated);
    offset += lh.length + deflated.length;

    // Central Directory Header with ZIP64 Extra Field (0x0001)
    const extraField = Buffer.alloc(28);
    extraField.writeUInt16LE(0x0001, 0); // tag
    extraField.writeUInt16LE(24, 2); // data size
    extraField.writeBigUInt64LE(BigInt(raw.length), 4); // uncompressed
    extraField.writeBigUInt64LE(BigInt(deflated.length), 12); // compressed
    extraField.writeBigUInt64LE(BigInt(localEntryOffset), 20); // offset

    const ch = Buffer.alloc(46 + nameBuf.length + extraField.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 4); // version made by 4.5
    ch.writeUInt16LE(45, 6); // version needed 4.5
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(0xffffffff, 20); // compSize indicator
    ch.writeUInt32LE(0xffffffff, 24); // uncompSize indicator
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(extraField.length, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(0xffffffff, 42); // offset indicator
    nameBuf.copy(ch, 46);
    extraField.copy(ch, 46 + nameBuf.length);
    cdParts.push(ch);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const ch of cdParts) centralSize += ch.length;

  // ZIP64 EOCD Record (PK\x06\x06)
  const eocd64 = Buffer.alloc(56);
  eocd64.writeUInt32LE(0x06064b50, 0);
  eocd64.writeBigUInt64LE(44n, 4); // size of remaining record
  eocd64.writeUInt16LE(45, 12); // version made by
  eocd64.writeUInt16LE(45, 14); // version needed
  eocd64.writeUInt32LE(0, 16); // disk num
  eocd64.writeUInt32LE(0, 20); // start disk
  eocd64.writeBigUInt64LE(BigInt(cdParts.length), 24); // entries on disk
  eocd64.writeBigUInt64LE(BigInt(cdParts.length), 32); // total entries
  eocd64.writeBigUInt64LE(BigInt(centralSize), 40); // CD size
  eocd64.writeBigUInt64LE(BigInt(centralOffset), 48); // CD offset

  // ZIP64 EOCD Locator (PK\x06\x07)
  const locator64 = Buffer.alloc(20);
  locator64.writeUInt32LE(0x07064b50, 0);
  locator64.writeUInt32LE(0, 4); // disk with eocd64
  locator64.writeBigUInt64LE(BigInt(offset + centralSize), 8); // offset of eocd64
  locator64.writeUInt32LE(1, 16); // total disks

  // Standard EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...cdParts, eocd64, locator64, eocd]);
}

function generateFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  const standardOsu = `osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: 45000
Countdown: 0
SampleSet: Soft
StackLeniency: 0.7
Mode: 0
LetterboxInBreaks: 0
WidescreenStoryboard: 0

[Metadata]
Title:Test Beatmap
TitleUnicode:Test Beatmap
Artist:Test Artist
ArtistUnicode:Test Artist
Creator:Mapper
Version:Normal
Source:
Tags:fixture test
BeatmapID:10001
BeatmapSetID:12345

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1

[HitObjects]
256,192,1000,1,0,0:0:0:0:
`;

  // 1. Валидный стандартный .osz (Deflate сжатие, валидный .osu, audio, bg, storyboard)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'valid-standard.osz'),
    buildZip([
      { name: 'audio.mp3', content: Buffer.from('FAKE_ID3_MP3_STREAM_CONTENT_FIXTURE_BYTE_PAYLOAD') },
      { name: 'Test Artist - Test Beatmap (Mapper) [Normal].osu', content: standardOsu },
      { name: 'bg.jpg', content: Buffer.from('FAKE_JPEG_EXIF_IMAGE_CONTENT_BYTES') },
      { name: 'sb/sprites/particle.png', content: Buffer.from('FAKE_PNG_CHUNK_BYTES') },
    ]),
  );

  // 2. Валидный архив со STORED (без сжатия, method 0)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'valid-stored.osz'),
    buildZip([
      { name: 'audio.mp3', content: 'STORED_AUDIO_BYTES_UNCOMPRESSED', method: 0 },
      { name: 'map.osu', content: standardOsu, method: 0 },
      { name: 'bg.jpg', content: 'STORED_BG_BYTES', method: 0 },
    ]),
  );

  // 3. Валидный архив по спецификации ZIP64 (EOCD64, locator, extra tag 0x0001)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'valid-zip64.osz'),
    buildZip64([
      { name: 'audio.mp3', content: 'ZIP64_AUDIO_PAYLOAD_TEST' },
      { name: 'map.osu', content: standardOsu },
      { name: 'bg.jpg', content: 'ZIP64_BACKGROUND_DATA' },
    ]),
  );

  // 4. Поврежденный архив: несовпадение CRC32
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'corrupted-crc.osz'),
    buildZip([
      { name: 'valid.osu', content: standardOsu },
      { name: 'audio.mp3', content: 'good payload', crc: 0xbaadc0de },
    ]),
  );

  // 5. Усеченный архив: файл обрезан в середине deflated данных
  const validFull = buildZip([
    { name: 'map.osu', content: standardOsu },
    { name: 'audio.mp3', content: 'x'.repeat(1000) },
  ]);
  fs.writeFileSync(path.join(FIXTURES_DIR, 'corrupted-truncated.osz'), validFull.subarray(0, validFull.length - 80));

  // 6. Некорректный файл без сигнатуры EOCD (мусорные байты)
  fs.writeFileSync(path.join(FIXTURES_DIR, 'corrupted-no-eocd.bin'), Buffer.alloc(128, 0xef));

  // 7. Поврежденная сигнатура локального заголовка (0x04034b00)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'corrupted-bad-local-magic.osz'),
    buildZip([
      { name: 'audio.mp3', content: 'audio content', localHeaderMagic: 0x04034b00 },
      { name: 'map.osu', content: standardOsu },
    ]),
  );

  // 8. Небезопасный архив: Zip Slip (выход за пределы директории через ../)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'unsafe-zip-slip.osz'),
    buildZip([
      { name: 'map.osu', content: standardOsu },
      { name: '../../evil-file.txt', content: 'malicious payload outside staging' },
      { name: 'nested/../../../evil2.txt', content: 'another malicious escape' },
    ]),
  );

  // 9. Небезопасный архив: NTFS Alternate Data Streams (:)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'unsafe-ntfs-ads.osz'),
    buildZip([
      { name: 'map.osu', content: standardOsu },
      { name: 'audio.mp3:hidden_stream', content: 'hidden ads data' },
      { name: 'valid.txt', content: 'regular file' },
    ]),
  );

  // 10. Небезопасный архив: зарезервированные системные имена Windows (CON, NUL, AUX, COM1)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'unsafe-windows-reserved.osz'),
    buildZip([
      { name: 'map.osu', content: standardOsu },
      { name: 'CON', content: 'device file con' },
      { name: 'nul.txt', content: 'device file nul' },
      { name: 'AUX.mp3', content: 'device file aux' },
      { name: 'com1.dat', content: 'device file com1' },
    ]),
  );

  // 11. Пустой ZIP-архив (0 файлов, только корректный EOCD)
  const emptyEocd = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(FIXTURES_DIR, 'empty.zip'), emptyEocd);

  // 12. Валидный ZIP, но невалидный .osz (нет файлов карт .osu)
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'invalid-no-osu.osz'),
    buildZip([
      { name: 'audio.mp3', content: 'some audio' },
      { name: 'bg.jpg', content: 'some image' },
    ]),
  );

  // 13. .osz с файлом .osu без заголовка osu format
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'invalid-bad-osu-header.osz'),
    buildZip([
      { name: 'audio.mp3', content: 'some audio' },
      { name: 'corrupted.osu', content: 'This is plain text without osu file format header' },
    ]),
  );

  // 14. .osz с несовпадающим BeatmapSetID (содержит 99999, ожидается 12345)
  const mismatchedOsu = standardOsu.replace('BeatmapSetID:12345', 'BeatmapSetID:99999');
  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'invalid-mismatched-setid.osz'),
    buildZip([
      { name: 'audio.mp3', content: 'audio content' },
      { name: 'song.osu', content: mismatchedOsu },
    ]),
  );

  console.log(`Generated 14 ZIP/OSZ fixtures in ${FIXTURES_DIR}`);
}

if (require.main === module) {
  generateFixtures();
}

module.exports = {
  buildZip,
  buildZip64,
  generateFixtures,
  FIXTURES_DIR,
};
