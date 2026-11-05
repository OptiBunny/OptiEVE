// Refresh reviewed public source data from CCP's versioned SDE; never reads accounts.
// Run with --download, or --archive <official-jsonl-zip>. Archives stay outside source.
import { createReadStream, createWriteStream, openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, lstatSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInflateRaw } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { resolve, dirname, join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const latestUrl = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl';
const sourceUrl = build => `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${build}-jsonl.zip`;
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archiveLimit = 160 * 1024 * 1024, fileLimit = 256 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = (value, min = 1) => Number.isSafeInteger(value) && value >= min;
const fail = message => { throw Error(message); };
const name = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value) ? value.trim() : fail('Invalid English SDE name');
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => { let crc = index; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; return crc >>> 0; });
const crcUpdate = (crc, bytes) => { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return crc; };

function zipIndex(path) {
  const size = statSync(path).size;
  if (size < 22 || size > archiveLimit) fail('Official SDE archive is outside the reviewed size bound');
  const fd = openSync(path, 'r');
  try {
    const tail = Buffer.alloc(Math.min(size, 65557)); readSync(fd, tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) fail('Unsupported or split SDE ZIP');
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
    if (count === 65535 || length === 0xffffffff || start === 0xffffffff || length > 4 * 1024 * 1024 || start + length > size) fail('Unsupported SDE ZIP directory');
    const directory = Buffer.alloc(length); readSync(fd, directory, 0, length, start);
    const entries = new Map(); let offset = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > length || directory.readUInt32LE(offset) !== 0x02014b50) fail('Invalid ZIP central directory');
      const nameLength = directory.readUInt16LE(offset + 28), extra = directory.readUInt16LE(offset + 30), comment = directory.readUInt16LE(offset + 32);
      const next = offset + 46 + nameLength + extra + comment;
      if (next > length) fail('Invalid ZIP entry length');
      const entryName = directory.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      if (entries.has(entryName)) fail('Duplicate ZIP entry');
      entries.set(entryName, { flags: directory.readUInt16LE(offset + 8), method: directory.readUInt16LE(offset + 10), crc: directory.readUInt32LE(offset + 16), compressed: directory.readUInt32LE(offset + 20), size: directory.readUInt32LE(offset + 24), offset: directory.readUInt32LE(offset + 42) });
      offset = next;
    }
    if (offset !== length) fail('Unexpected ZIP directory bytes');
    return entries;
  } finally { closeSync(fd); }
}

async function rowsFromZip(path, entries, entryName, consume) {
  const entry = entries.get(entryName);
  if (!entry || entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > fileLimit || entry.compressed < 1 || entry.compressed > archiveLimit) fail('Unsupported required SDE entry');
  const fd = openSync(path, 'r'), header = Buffer.alloc(30);
  let start;
  try { readSync(fd, header, 0, 30, entry.offset); if (header.readUInt32LE(0) !== 0x04034b50) fail('Invalid ZIP local entry'); start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28); }
  finally { closeSync(fd); }
  const source = createReadStream(path, { start, end: start + entry.compressed - 1 });
  const decoded = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
  const decoder = new StringDecoder('utf8'), hash = createHash('sha256');
  let pending = '', bytes = 0, count = 0, crc = 0xffffffff;
  const row = text => { if (!text.trim()) return; const value = JSON.parse(text); if (!record(value)) fail('SDE row must be an object'); consume(value); count++; };
  try {
    for await (const chunk of decoded) {
      bytes += chunk.length; if (bytes > fileLimit || bytes > entry.size) fail('SDE decompression bound exceeded');
      hash.update(chunk); crc = crcUpdate(crc, chunk); pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\n')) !== -1) { row(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 10 * 1024 * 1024) fail('SDE row exceeds review bound');
    }
    pending += decoder.end(); row(pending);
    if (bytes !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('SDE ZIP size or CRC mismatch');
    return { name: entryName, sha256: hash.digest('hex'), bytes, rows: count };
  } finally { decoded.destroy(); source.destroy(); }
}

async function build(archivePath) {
  const entries = zipIndex(archivePath), files = [], metadata = [];
  files.push(await rowsFromZip(archivePath, entries, '_sde.jsonl', row => metadata.push(row)));
  if (metadata.length !== 1 || metadata[0]._key !== 'sde' || !int(metadata[0].buildNumber) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(metadata[0].releaseDate) || !Number.isFinite(Date.parse(metadata[0].releaseDate))) fail('Invalid SDE build provenance');
  const categories = new Map(), groups = new Map(), types = new Map();
  files.push(await rowsFromZip(archivePath, entries, 'categories.jsonl', row => { if (!int(row._key, 0) || categories.has(row._key)) fail('Invalid SDE category'); categories.set(row._key, [row._key, name(row.name?.en)]); }));
  files.push(await rowsFromZip(archivePath, entries, 'groups.jsonl', row => { if (!int(row._key, 0) || !int(row.categoryID, 0) || !categories.has(row.categoryID) || groups.has(row._key)) fail('Invalid SDE group'); groups.set(row._key, [row._key, name(row.name?.en), row.categoryID]); }));
  files.push(await rowsFromZip(archivePath, entries, 'types.jsonl', row => {
    if (!int(row._key, 0) || !int(row.groupID, 0) || !groups.has(row.groupID) || typeof row.published !== 'boolean' || types.has(row._key)) fail('Invalid SDE inventory type');
    const volume = row.volume === undefined ? null : typeof row.volume === 'number' && Number.isFinite(row.volume) && row.volume >= 0 ? row.volume : fail('Invalid SDE item volume');
    const marketGroup = row.marketGroupID === undefined ? null : int(row.marketGroupID) ? row.marketGroupID : fail('Invalid SDE market group');
    types.set(row._key, { typeId: row._key, name: name(row.name?.en), groupId: row.groupID, volume, marketGroup, published: row.published });
  }));
  const recipes = [], seen = new Set(); let omittedUnpublished = 0, nonManufacturing = 0;
  files.push(await rowsFromZip(archivePath, entries, 'blueprints.jsonl', row => {
    if (!int(row._key) || row._key !== row.blueprintTypeID || seen.has(row._key) || !record(row.activities)) fail('Invalid blueprint identity');
    seen.add(row._key);
    const manufacture = row.activities.manufacturing;
    if (manufacture === undefined) { nonManufacturing++; return; }
    const blueprint = types.get(row._key);
    if (!blueprint || !blueprint.published) { omittedUnpublished++; return; }
    if (!record(manufacture) || !int(manufacture.time) || !Array.isArray(manufacture.products) || !manufacture.products.length || !int(row.maxProductionLimit)) fail('Invalid manufacturing activity');
    const products = quantities(manufacture.products, types), materials = quantities(manufacture.materials ?? [], types);
    if (products.some(product => !types.get(product.typeId).published)) { omittedUnpublished++; return; }
    const skillSeen = new Set();
    if (manufacture.skills !== undefined && !Array.isArray(manufacture.skills)) fail('Invalid manufacturing skills');
    const skills = (manufacture.skills ?? []).map(skill => {
      if (!record(skill) || !int(skill.typeID) || !int(skill.level, 0) || skill.level > 5 || !types.has(skill.typeID) || skillSeen.has(skill.typeID)) fail('Invalid manufacturing skill');
      skillSeen.add(skill.typeID); return { typeId: skill.typeID, name: types.get(skill.typeID).name, level: skill.level };
    }).sort((a, b) => a.typeId - b.typeId);
    recipes.push({ blueprintTypeId: row._key, blueprintName: blueprint.name, activity: 'manufacturing', timeSeconds: manufacture.time, maxProductionLimit: row.maxProductionLimit, materials, products, skills });
  }));
  recipes.sort((a, b) => a.blueprintTypeId - b.blueprintTypeId);
  const archiveHash = createHash('sha256'); for await (const chunk of createReadStream(archivePath)) archiveHash.update(chunk);
  return { formatVersion: 1, provenance: { provider: 'CCP Games', dataset: 'EVE Online Static Data Export', buildNumber: metadata[0].buildNumber, releaseDate: metadata[0].releaseDate, sourceUrl: sourceUrl(metadata[0].buildNumber), latestManifestUrl: latestUrl, archiveSha256: archiveHash.digest('hex'), sourceFiles: files, selection: 'Published inventory types and published blueprint manufacturing activities with published products; invention, reactions and unpublished recipes are excluded.', omittedUnpublishedRecipes: omittedUnpublished, nonManufacturingBlueprints: nonManufacturing }, itemColumns: ['typeId', 'name', 'groupId', 'volumeM3', 'marketGroupId'], items: [...types.values()].filter(type => type.published && type.typeId > 0).sort((a, b) => a.typeId - b.typeId).map(type => [type.typeId, type.name, type.groupId, type.volume, type.marketGroup]), groupColumns: ['groupId', 'name', 'categoryId'], groups: [...groups.values()].sort((a, b) => a[0] - b[0]), categoryColumns: ['categoryId', 'name'], categories: [...categories.values()].sort((a, b) => a[0] - b[0]), recipes };
}
function quantities(rows, types) {
  if (!Array.isArray(rows) || rows.length > 1000) fail('Invalid manufacturing quantities');
  const seen = new Set();
  return rows.map(row => {
    if (!record(row) || !int(row.typeID) || !int(row.quantity) || !types.has(row.typeID) || seen.has(row.typeID) || row.probability !== undefined && row.probability !== 1) fail('Invalid or probabilistic manufacturing component');
    seen.add(row.typeID); return { typeId: row.typeID, name: types.get(row.typeID).name, quantity: row.quantity };
  }).sort((a, b) => a.typeId - b.typeId);
}

let temporary;
try {
  const args = process.argv.slice(2); let archive, output = join(project, 'app/data/manufacturing-catalog.json'), download = false;
  while (args.length) { const flag = args.shift(); if (flag === '--download') download = true; else if (flag === '--archive' && args.length) archive = resolve(args.shift()); else if (flag === '--output' && args.length) output = resolve(args.shift()); else fail('Use --download or --archive <official JSONL ZIP>, optionally --output <JSON path>'); }
  if (Boolean(archive) === download) fail('Choose exactly one of --download and --archive');
  if (download) {
    const latest = await fetch(latestUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!latest.ok || Number(latest.headers.get('content-length') ?? 0) > 8192) fail('Unable to read official SDE manifest');
    const body = await latest.text(); if (body.length > 8192) fail('Oversized SDE manifest');
    const rows = body.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)), meta = rows.find(row => row._key === 'sde');
    if (!meta || !int(meta.buildNumber)) fail('Invalid official latest SDE manifest');
    temporary = mkdtempSync(join(tmpdir(), 'optieve-sde-')); archive = join(temporary, 'sde.zip');
    const response = await fetch(sourceUrl(meta.buildNumber), { redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > archiveLimit) fail('Official SDE download unavailable');
    let total = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { total += chunk.length; callback(total > archiveLimit ? Error('SDE archive size exceeded') : null, chunk); } }), createWriteStream(archive, { flags: 'wx' }));
  }
  if (lstatSync(archive).isSymbolicLink() || !lstatSync(archive).isFile()) fail('Archive must be a regular file');
  const catalog = await build(archive);
  mkdirSync(dirname(output), { recursive: true });
  const existing = lstatSync(output, { throwIfNoEntry: false }); if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) fail('Unsafe catalog output');
  if (!output.endsWith('.json')) fail('Catalog output must be JSON');
  const staged = output + '.tmp'; if (lstatSync(staged, { throwIfNoEntry: false })) fail('Unfinished catalog output exists');
  writeFileSync(staged, JSON.stringify(catalog) + '\n', { flag: 'wx' }); renameSync(staged, output);
  console.log(JSON.stringify({ buildNumber: catalog.provenance.buildNumber, releaseDate: catalog.provenance.releaseDate, items: catalog.items.length, recipes: catalog.recipes.length, multiProductRecipes: catalog.recipes.filter(recipe => recipe.products.length !== 1).length, archiveSha256: catalog.provenance.archiveSha256, catalogSha256: createHash('sha256').update(JSON.stringify(catalog) + '\n').digest('hex') }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (temporary) {
    const relativePath = relative(resolve(tmpdir()), resolve(temporary));
    if (!isAbsolute(relativePath) && !relativePath.startsWith('..') && basename(temporary).startsWith('optieve-sde-')) rmSync(temporary, { recursive: true, force: true });
  }
}
