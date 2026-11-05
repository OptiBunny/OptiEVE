import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { inspectContent, inspectPath, inspectPublicSource, requirePublicSource } from '../scripts/public-source.mjs';
import { createPublicArchive, verifyPublicArchive, writePublicArchive } from '../scripts/package-public-source.mjs';

const prefix = 'eve-source-regression-';
const manifest = Buffer.from('{"d1":"DB","r2":null,"capabilities":["mcp"]}\n');
const ignore = Buffer.from('/outputs/\n/dist/\n/node_modules/\n');
const dummyCredential = () => ['gh', 'p_', 'Q'.repeat(40)].join('');
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function fixture(t, extra = {}, { gitBacked = true } = {}) {
  const temporaryRoot = realpathSync(tmpdir());
  const temporary = mkdtempSync(join(temporaryRoot, prefix));
  const root = join(temporary, 'repository');
  const links = [];
  mkdirSync(root);
  t.after(() => {
    assert.equal(dirname(resolve(temporary)), temporaryRoot, 'cleanup must remain directly inside the temporary directory');
    assert.ok(basename(temporary).startsWith(prefix), 'cleanup requires the fixture prefix');
    assert.ok(!lstatSync(temporary).isSymbolicLink(), 'cleanup root must not be a link');
    for (const link of links.reverse()) {
      assert.ok(inside(temporary, link), 'link cleanup must remain in the fixture');
      try {
        if (lstatSync(link).isSymbolicLink()) rmSync(link, { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const git = (args, input) => execFileSync('git', [
    '-c', 'init.templateDir=', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    '-c', 'user.name=Source Test', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd: root, env: gitEnvironment, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  const write = (name, value) => {
    const filename = resolve(root, name);
    assert.ok(inside(root, filename), 'fixture files must remain below the repository');
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, value);
  };
  const files = { '.gitignore': ignore, '.openai/hosting.json': manifest, ...extra };
  for (const [name, bytes] of Object.entries(files)) write(name, bytes);
  if (gitBacked) {
    git(['init', '--quiet', '--initial-branch=main']);
    git(['add', '--all']);
    git(['commit', '--quiet', '-m', 'Synthetic fixture']);
  }
  return { root, temporary, links, write, git, files };
}

function expected(files) {
  return Object.entries(files).map(([name, bytes]) => ({ name, mode: '100644', bytes: Buffer.from(bytes) }));
}

function assertExactArchive(result, files) {
  const entries = expected(files);
  assert.equal(result.files, entries.length);
  assert.equal(result.sha256, createHash('sha256').update(result.archive).digest('hex'));
  assert.doesNotThrow(() => verifyPublicArchive(result.archive, entries));
}

function assertBlocked(root, pattern) {
  const report = inspectPublicSource(root);
  assert.ok(report.failures.some(message => pattern.test(message)), 'expected a matching source rejection');
  assert.throws(() => requirePublicSource(root), /Public-source check failed/);
  assert.throws(() => createPublicArchive(root), /Public-source check failed/);
}

test('exports current clean bytes and deletions instead of sensitive HEAD or index bytes', t => {
  const secret = dummyCredential();
  const f = fixture(t, { 'changed.txt': `${secret}\n`, 'deleted.txt': `${secret}\n` });
  const current = Buffer.from('Current public bytes\r\nSecond line\n');
  const addition = Buffer.from('Untracked public addition\n');
  f.write('changed.txt', current);
  f.write('new.txt', addition);
  rmSync(join(f.root, 'deleted.txt'));
  assert.equal(f.git(['show', 'HEAD:changed.txt']).trim(), secret);
  assert.equal(f.git(['show', ':changed.txt']).trim(), secret);
  const wanted = { '.gitignore': ignore, '.openai/hosting.json': manifest, 'changed.txt': current, 'new.txt': addition };
  assert.deepEqual(inspectPublicSource(f.root).failures, []);
  const entries = requirePublicSource(f.root);
  assert.deepEqual(entries.map(entry => entry.name).sort(), Object.keys(wanted).sort());
  for (const entry of entries) assert.deepEqual(entry.bytes, wanted[entry.name]);
  assertExactArchive(createPublicArchive(f.root), wanted);
});

test('rejects a sensitive working-tree edit even when HEAD and index are clean', t => {
  const f = fixture(t, { 'source.txt': 'Public content\n' });
  f.write('source.txt', dummyCredential());
  assertBlocked(f.root, /credential-like content/);
});

test('does not resurrect deleted required configuration from the index', t => {
  const f = fixture(t);
  rmSync(join(f.root, '.openai', 'hosting.json'));
  assertBlocked(f.root, /required source configuration is missing/);
});

test('rejects symbolic-link index mode even when the working file is regular', t => {
  const f = fixture(t, { 'indexed-link.txt': 'Ordinary current file\n' });
  const blob = f.git(['hash-object', '-w', '--stdin'], 'missing-target\n').trim();
  f.git(['update-index', '--add', '--cacheinfo', `120000,${blob},indexed-link.txt`]);
  assertBlocked(f.root, /symbolic link, or submodule/);
});

test('rejects a broken filesystem link even though its target does not exist', t => {
  const f = fixture(t, { 'broken-link': 'Tracked before replacement\n' });
  const link = join(f.root, 'broken-link');
  const target = join(f.temporary, 'missing-target');
  rmSync(link);
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Filesystem link creation is unavailable on this host.');
    throw error;
  }
  f.links.push(link);
  assert.equal(existsSync(link), false);
  assertBlocked(f.root, /Symbolic links and junctions/);
});

test('rejects submodule index entries without reading them as source', t => {
  const f = fixture(t);
  const commit = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['update-index', '--add', '--cacheinfo', `160000,${commit},nested-module`]);
  assertBlocked(f.root, /symbolic link, or submodule/);
});

test('rejects unresolved index stages even with a clean current file', t => {
  const f = fixture(t);
  f.write('conflict.txt', 'Public resolution not staged\n');
  const hashes = ['base\n', 'left\n', 'right\n'].map(value => f.git(['hash-object', '-w', '--stdin'], value).trim());
  f.git(['update-index', '--index-info'], hashes.map((hash, index) => `100644 ${hash} ${index + 1}\tconflict.txt\n`).join(''));
  assertBlocked(f.root, /unresolved index entry/);
});

test('rejects a tracked file reached through a replaced parent junction', t => {
  const f = fixture(t, { 'parent/source.txt': 'Public content\n' });
  const outside = join(f.temporary, 'outside-repository');
  mkdirSync(outside);
  writeFileSync(join(outside, 'source.txt'), 'External fixture content\n');
  const parent = join(f.root, 'parent');
  rmSync(join(parent, 'source.txt'));
  rmdirSync(parent);
  try {
    symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Parent junction creation is unavailable on this host.');
    throw error;
  }
  f.links.push(parent);
  assertBlocked(f.root, /Symbolic links and junctions/);
  assert.equal(readFileSync(join(outside, 'source.txt'), 'utf8'), 'External fixture content\n');
});

test('rejects renamed binary, archive and database content', () => {
  const samples = [
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from([0x41, 0x00, 0x42]),
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('synthetic payload')]),
    Buffer.from('SQLite format 3\0synthetic payload'),
    Buffer.from(' '.repeat(257) + 'ustar' + 'synthetic payload'),
  ];
  for (const sample of samples) {
    assert.ok(inspectContent('renamed-source.txt', sample).some(reason => /binary content|archive content/.test(reason)));
  }
});

test('rejects expanded private artifact formats even when their content is plain text', () => {
  const suffixes = ['7z', 'rar', 'tar', 'tgz', 'gz', 'bz2', 'xz', 'zst', 'xlsm', 'ods', 'sqlite-wal', 'sqlite3-shm', 'db-wal', 'db-shm', 'kdbx', 'har', 'log', 'bak', 'backup'];
  for (const suffix of suffixes) {
    assert.ok(inspectContent(`sample.${suffix}`, Buffer.from('synthetic placeholder')).some(reason => /private data/.test(reason)), `expected ${suffix} to require review`);
  }
});

test('rejects constructed credential signatures and personal machine paths', () => {
  const credentials = [
    dummyCredential(),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ['AK', 'IA', 'A'.repeat(16)].join(''),
    ['xo', 'xb-', 'A'.repeat(24)].join(''),
    ['ey', 'J', 'A'.repeat(16), '.', 'B'.repeat(16), '.', 'C'.repeat(20)].join(''),
    ['https://', 'fixture', ':', 'synthetic', '@', 'example.test/'].join(''),
  ];
  for (const value of credentials) assert.ok(inspectContent('example.txt', Buffer.from(value)).includes('credential-like content'));
  const ownerPaths = [
    ['C:', 'Users', 'fixture', 'project'].join('\\'),
    ['', 'Users', 'fixture', 'project'].join('/'),
    ['', 'home', 'fixture', 'project'].join('/'),
  ];
  for (const value of ownerPaths) assert.ok(inspectContent('example.txt', Buffer.from(value)).includes('personal machine path'));
});

test('rejects deployment identities and assigned example secrets while allowing reserved placeholders', () => {
  const deployment = ['app', 'gprj_', 'a'.repeat(32)].join('');
  assert.ok(inspectContent('config.txt', Buffer.from(deployment)).includes('configured deployment identifier'));
  const hosted = ['https://', 'fixture-deployment', '.chatgpt', '.site'].join('');
  assert.ok(inspectContent('config.txt', Buffer.from(hosted)).includes('specific hosted deployment URL'));
  const setting = ['EVE_', 'TOKEN_', 'KEY', '=', 'synthetic-only'].join('');
  assert.ok(inspectContent('.env.example', Buffer.from(setting)).some(reason => /environment example/.test(reason)));
  assert.deepEqual(inspectContent('.env.example', Buffer.from('EVE_SITE_ORIGIN=https://connector.example\n')), []);
  const tokenName = ['EVE_', 'TOKEN_', 'KEY'].join('');
  assert.deepEqual(inspectContent('.env.example', Buffer.from(`export EVE_SITE_ORIGIN="https://connector.example" # placeholder\nexport ${tokenName}=''\n`)), []);
  assert.ok(inspectContent('.env.example', Buffer.from(`export ${tokenName}='synthetic-only' # still assigned\n`)).length > 0);
  assert.ok(inspectContent('.env.example', Buffer.from('UNRELATED_SETTING=synthetic\n')).length > 0);
  assert.deepEqual(inspectContent('fixture.txt', Buffer.from('https://example.chatgpt.site\nhttps://login.eveonline.com\n')), []);
  assert.deepEqual(inspectContent('.openai/hosting.json', manifest), []);
});

test('excludes ignored generated outputs from the validated archive', t => {
  const f = fixture(t, { 'source.txt': 'Public content\n' });
  f.write('outputs/private.csv', dummyCredential());
  f.write('dist/generated.js', dummyCredential());
  assert.deepEqual(inspectPublicSource(f.root).failures, []);
  assertExactArchive(createPublicArchive(f.root), f.files);
});

test('rejects generated outputs if they have been explicitly tracked', t => {
  const f = fixture(t);
  f.write('outputs/generated.txt', 'Even harmless generated content needs exclusion\n');
  f.git(['add', '--force', 'outputs/generated.txt']);
  assertBlocked(f.root, /generated or local-only artifact/);
});

for (const gitBacked of [false, true]) {
  const mode = gitBacked ? 'Git-backed' : 'extracted';
  test(`${mode} source refuses hard links to files outside the source root`, t => {
    const f = fixture(t, { 'source.txt': 'Public fixture\n' }, { gitBacked });
    const outside = join(f.temporary, 'external-only.txt');
    const content = 'Synthetic external-only content\n';
    writeFileSync(outside, content);
    const destination = join(f.root, 'source.txt');
    rmSync(destination);
    try { linkSync(outside, destination); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return t.skip('Hard-link creation is unavailable on this host.');
      throw error;
    }
    assert.ok(lstatSync(destination).nlink > 1, 'fixture must share its underlying file');
    assertBlocked(f.root, /Hard-linked source files/);
    assert.equal(readFileSync(outside, 'utf8'), content, 'source rejection must leave the external fixture untouched');
  });

  test(`${mode} source rejects trailing-dot and trailing-space path aliases before filesystem lookup`, t => {
    const f = fixture(t, { 'app/source.ts': 'export const synthetic = true;\n' }, { gitBacked });
    const aliases = ['.env.', '.env ', 'app/source.ts.', 'app/source.ts ', 'nested/.git./config', 'nested/.git /config', 'nested/node_modules./fixture.txt', 'nested/.eve-private /fixture.txt'];
    for (const name of aliases) assert.throws(() => inspectPath(f.root, name), /Invalid source-relative path/);
    assertExactArchive(createPublicArchive(f.root), f.files);
  });

  test(`${mode} source rejects environment filename case variants at every depth`, t => {
    const f = fixture(t, { 'app/source.ts': 'export const synthetic = true;\n' }, { gitBacked });
    const names = ['.ENV', '.ENV.PRODUCTION', '.DEV.VARS', '.DEV.VARS.LOCAL', '.ENV.EXAMPLE', 'nested/.EnV', 'nested/.DeV.VaRs', 'nested/.env.example'];
    for (const name of names) {
      f.write(name, 'SYNTHETIC_SETTING=fixture-only\n');
      if (gitBacked) f.git(['add', '--force', '--', name]);
      assertBlocked(f.root, /private data, environment, key, or archive file/);
      if (gitBacked) f.git(['update-index', '--force-remove', '--', name]);
      rmSync(join(f.root, name));
    }
    assertExactArchive(createPublicArchive(f.root), f.files);
  });

  test(`${mode} source rejects nested runtime, private and dependency directories`, t => {
    const f = fixture(t, { 'app/source.ts': 'export const synthetic = true;\n' }, { gitBacked });
    const directories = ['node_modules', '.sites-runtime', '.wrangler', 'dist', '.next', '.vinext', 'out', 'outputs', 'coverage', '.agents', '.codex', 'work', '.eve-private'];
    for (const directory of directories) {
      for (const variant of [directory, directory.toUpperCase()]) {
        const name = `nested/${variant}/fixture.txt`;
        f.write(name, 'Synthetic local-only fixture\n');
        if (gitBacked) f.git(['add', '--force', '--', name]);
        assertBlocked(f.root, /generated or local-only artifact/);
        if (gitBacked) f.git(['update-index', '--force-remove', '--', name]);
        rmSync(join(f.root, name));
      }
    }
    assertExactArchive(createPublicArchive(f.root), f.files);
  });

  test(`${mode} source never exports nested Git metadata`, t => {
    const f = fixture(t, { 'app/source.ts': 'export const synthetic = true;\n' }, { gitBacked });
    const name = 'nested/.git/config';
    f.write(name, 'Synthetic metadata fixture\n');
    assert.ok(inspectContent(name, Buffer.from('fixture')).includes('generated or local-only artifact'));
    const report = inspectPublicSource(f.root);
    // Git itself may omit its protected .git path before source inspection.
    // Extracted trees must reject it; either mode must keep it out of the ZIP.
    if (!gitBacked || report.entries.some(entry => entry.name === name)) {
      assertBlocked(f.root, /generated or local-only artifact/);
    } else {
      assertExactArchive(createPublicArchive(f.root), f.files);
    }
  });

  test(`${mode} source keeps ordinary nested files and excludes root generated outputs`, t => {
    const f = fixture(t, {
      'app/source.ts': 'export const synthetic = true;\n',
      'docs/outputs.md': 'Source documentation, not a generated directory.\n',
      '.env.example': 'EVE_SITE_ORIGIN=https://connector.example\n',
    }, { gitBacked });
    for (const directory of ['outputs', 'dist', 'node_modules']) {
      f.write(`${directory}/fixture.txt`, 'Synthetic generated output\n');
    }
    assert.deepEqual(inspectPublicSource(f.root).failures, []);
    assertExactArchive(createPublicArchive(f.root), f.files);
    f.write('.eve-private/fixture.txt', 'Synthetic private-runtime marker\n');
    assertBlocked(f.root, /Private runtime/);
  });
}

test('case aliases of a Windows source root preserve Git ignored-file selection', t => {
  if (process.platform !== 'win32') return t.skip('Root case aliases require a case-insensitive Windows filesystem.');
  const f = fixture(t, { '.gitignore': Buffer.concat([ignore, Buffer.from('/local-note.txt\n')]), 'source.txt': 'Public fixture\n' });
  f.write('local-note.txt', 'Synthetic ignored local note\n');
  for (const alias of [f.root.toUpperCase(), f.root.toLowerCase()]) {
    const report = inspectPublicSource(alias);
    assert.deepEqual(report.failures, []);
    assert.equal(report.entries.some(entry => entry.name === 'local-note.txt'), false);
    assertExactArchive(createPublicArchive(alias), f.files);
  }
});

test('rejects source-root links and linked ancestors rather than changing Git selection', t => {
  const f = fixture(t, { '.gitignore': Buffer.concat([ignore, Buffer.from('/local-note.txt\n')]), 'source.txt': 'Public fixture\n' });
  f.write('local-note.txt', 'Synthetic ignored local note\n');
  const alias = join(f.temporary, 'source-alias');
  try { symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Directory link creation is unavailable on this host.');
    throw error;
  }
  f.links.push(alias);
  assertBlocked(alias, /Source root and its parents must be real directories/);
  const nested = join(f.root, 'nested-extracted');
  mkdirSync(join(nested, '.openai'), { recursive: true });
  writeFileSync(join(nested, '.openai', 'hosting.json'), manifest);
  assertBlocked(join(alias, 'nested-extracted'), /Source root and its parents must be real directories/);
});

test('corrupt own Git metadata fails closed instead of exporting ignored files', t => {
  const f = fixture(t, { '.gitignore': Buffer.concat([ignore, Buffer.from('/local-note.txt\n')]), 'source.txt': 'Public fixture\n' });
  f.write('local-note.txt', 'Synthetic ignored local note\n');
  writeFileSync(join(f.root, '.git', 'config'), '[synthetic invalid configuration\n');
  assertBlocked(f.root, /Git metadata is present but this repository could not be identified safely/);
});

test('inherited alternate Git index cannot add ignored files to the public source', t => {
  const f = fixture(t, { '.gitignore': Buffer.concat([ignore, Buffer.from('/local-note.txt\n')]), 'source.txt': 'Public fixture\n' });
  f.write('local-note.txt', 'Synthetic ignored local note\n');
  const alternate = join(f.temporary, 'alternate-index');
  const alternateGit = args => execFileSync('git', args, {
    cwd: f.root, env: { ...gitEnvironment, GIT_INDEX_FILE: alternate },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  alternateGit(['read-tree', 'HEAD']);
  alternateGit(['add', '--force', '--', 'local-note.txt']);
  assert.ok(alternateGit(['ls-files', '-z']).split('\0').includes('local-note.txt'), 'alternate index must include the otherwise ignored fixture');
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = alternate;
    const report = inspectPublicSource(f.root);
    assert.deepEqual(report.failures, []);
    assert.equal(report.entries.some(entry => entry.name === 'local-note.txt'), false);
    assertExactArchive(createPublicArchive(f.root), f.files);
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
});

test('an extracted source root remains usable when its parent is an unrelated repository', t => {
  const f = fixture(t);
  const nested = join(f.root, 'nested-extracted');
  mkdirSync(join(nested, '.openai'), { recursive: true });
  writeFileSync(join(nested, '.openai', 'hosting.json'), manifest);
  writeFileSync(join(nested, 'source.txt'), 'Public extracted fixture\n');
  assertExactArchive(createPublicArchive(nested), { '.openai/hosting.json': manifest, 'source.txt': 'Public extracted fixture\n' });
});

test('preserves exact CRLF and LF bytes despite export and text attributes', t => {
  const f = fixture(t, {
    'keep.txt': 'Required public source\r\n',
    'substitute.txt': '$Format:%H$\r\n',
    'mixed.txt': 'First\r\nSecond\nThird\r\n',
    'ident.txt': '$Id$\n',
  });
  const attributes = Buffer.from('keep.txt export-ignore\nsubstitute.txt export-subst\nmixed.txt text eol=lf\nident.txt ident\n');
  f.write('.gitattributes', attributes);
  f.git(['add', '.gitattributes']);
  assertExactArchive(createPublicArchive(f.root), { ...f.files, '.gitattributes': attributes });
});

test('verifier rejects unexpected, missing or altered expected bytes and damaged archives', t => {
  const f = fixture(t, { 'source.txt': 'Exact source bytes\n' });
  const result = createPublicArchive(f.root);
  const entries = expected(f.files);
  assert.doesNotThrow(() => verifyPublicArchive(result.archive, entries));
  assert.throws(() => verifyPublicArchive(result.archive, entries.filter(entry => entry.name !== 'source.txt')));
  assert.throws(() => verifyPublicArchive(result.archive, [...entries, { name: 'extra.txt', mode: '100644', bytes: Buffer.from('extra') }]));
  assert.throws(() => verifyPublicArchive(result.archive, entries.map(entry => entry.name === 'source.txt' ? { ...entry, bytes: Buffer.from('Different source bytes\n') } : entry)));
  const damaged = Buffer.from(result.archive);
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => verifyPublicArchive(damaged, entries));
  assert.throws(() => verifyPublicArchive(Buffer.concat([result.archive, Buffer.from('unexpected trailer')]), entries));
  assert.throws(() => verifyPublicArchive(result.archive.subarray(0, 10), entries));
});

test('verifier rejects unknown metadata extras and a changed matching CRC', t => {
  const f = fixture(t, { 'source.txt': 'Source payload for metadata checks\n' });
  const { archive } = createPublicArchive(f.root);
  const entries = expected(f.files);
  const central = archive.readUInt32LE(archive.length - 22 + 16);
  const local = archive.readUInt32LE(central + 42);
  const centralExtra = central + 46 + archive.readUInt16LE(central + 28);
  const localExtra = local + 30 + archive.readUInt16LE(local + 26);
  assert.equal(archive.readUInt16LE(centralExtra), 0x5455, 'fixture must contain the expected Git timestamp field');
  const unknownExtra = Buffer.from(archive);
  unknownExtra.writeUInt16LE(0xfefe, centralExtra);
  unknownExtra.writeUInt16LE(0xfefe, localExtra);
  assert.throws(() => verifyPublicArchive(unknownExtra, entries));
  const changedCrc = Buffer.from(archive);
  const invalidCrc = (archive.readUInt32LE(central + 16) ^ 1) >>> 0;
  changedCrc.writeUInt32LE(invalidCrc, central + 16);
  changedCrc.writeUInt32LE(invalidCrc, local + 14);
  assert.throws(() => verifyPublicArchive(changedCrc, entries));
});

test('verifier rejects a prefix even when directory and local offsets are adjusted', t => {
  const f = fixture(t, { 'source.txt': 'Public source\n' });
  const { archive } = createPublicArchive(f.root);
  const entries = expected(f.files);
  const prefixBytes = Buffer.from('synthetic unvalidated prefix');
  const prefixed = Buffer.concat([prefixBytes, archive]);
  const originalEnd = archive.length - 22;
  const end = prefixed.length - 22;
  let central = archive.readUInt32LE(originalEnd + 16) + prefixBytes.length;
  prefixed.writeUInt32LE(central, end + 16);
  // Mutate only header offsets; content/entry verification stays in the real API.
  for (let index = 0; index < archive.readUInt16LE(originalEnd + 10); index++) {
    assert.equal(prefixed.readUInt32LE(central), 0x02014b50);
    prefixed.writeUInt32LE(prefixed.readUInt32LE(central + 42) + prefixBytes.length, central + 42);
    central += 46 + prefixed.readUInt16LE(central + 28) + prefixed.readUInt16LE(central + 30) + prefixed.readUInt16LE(central + 32);
  }
  assert.equal(central, end);
  assert.throws(() => verifyPublicArchive(prefixed, entries));
});

test('verifier rejects unconsumed trailing bytes inside a deflate entry', t => {
  const f = fixture(t, { 'compressed.txt': 'Repeated public text for compression.\n'.repeat(300) });
  const { archive } = createPublicArchive(f.root);
  const entries = expected(f.files);
  const originalEnd = archive.length - 22;
  const directoryStart = archive.readUInt32LE(originalEnd + 16);
  const target = archive.indexOf(Buffer.from('compressed.txt'), directoryStart) - 46;
  assert.ok(target >= directoryStart);
  assert.equal(archive.readUInt32LE(target), 0x02014b50);
  assert.equal(archive.readUInt16LE(target + 10), 8, 'fixture must be compressed');
  const local = archive.readUInt32LE(target + 42);
  const compressedSize = archive.readUInt32LE(target + 20);
  const insertion = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28) + compressedSize;
  const suffix = Buffer.from('unconsumed synthetic bytes');
  const altered = Buffer.concat([archive.subarray(0, insertion), suffix, archive.subarray(insertion)]);
  altered.writeUInt32LE(compressedSize + suffix.length, local + 18);
  const end = altered.length - 22;
  let central = directoryStart + suffix.length;
  altered.writeUInt32LE(central, end + 16);
  for (let index = 0; index < archive.readUInt16LE(originalEnd + 10); index++) {
    assert.equal(altered.readUInt32LE(central), 0x02014b50);
    const previousLocal = altered.readUInt32LE(central + 42);
    if (previousLocal >= insertion) altered.writeUInt32LE(previousLocal + suffix.length, central + 42);
    if (central === target + suffix.length) altered.writeUInt32LE(compressedSize + suffix.length, central + 20);
    central += 46 + altered.readUInt16LE(central + 28) + altered.readUInt16LE(central + 30) + altered.readUInt16LE(central + 32);
  }
  assert.equal(central, end);
  assert.throws(() => verifyPublicArchive(altered, entries));
});

test('preserves the prior archive and checksum when a later source scan fails', t => {
  const f = fixture(t, { 'source.txt': 'Public content\n' });
  const original = writePublicArchive(f.root);
  assertExactArchive(original, f.files);
  const output = join(f.root, 'outputs', 'public-release');
  const name = 'OptiEVE-public-source.zip';
  const priorArchive = readFileSync(join(output, name));
  const priorChecksum = readFileSync(join(output, `${name}.sha256`));
  f.write('source.txt', dummyCredential());
  assert.throws(() => writePublicArchive(f.root), /Public-source check failed/);
  assert.deepEqual(readFileSync(join(output, name)), priorArchive);
  assert.deepEqual(readFileSync(join(output, `${name}.sha256`)), priorChecksum);
  assert.deepEqual(readdirSync(output).sort(), [name, `${name}.sha256`].sort());
});

test('preflights both temporary outputs before replacing an existing artifact pair', t => {
  const f = fixture(t, { 'source.txt': 'Original public content\n' });
  writePublicArchive(f.root);
  const output = join(f.root, 'outputs', 'public-release');
  const name = 'OptiEVE-public-source.zip';
  const priorArchive = readFileSync(join(output, name));
  const priorChecksum = readFileSync(join(output, `${name}.sha256`));
  const marker = Buffer.from('Existing interrupted output must remain untouched\n');
  writeFileSync(join(output, `${name}.sha256.tmp`), marker);
  f.write('source.txt', 'Changed, but still public content\n');
  assert.throws(() => writePublicArchive(f.root), /unfinished public export/);
  assert.deepEqual(readFileSync(join(output, name)), priorArchive);
  assert.deepEqual(readFileSync(join(output, `${name}.sha256`)), priorChecksum);
  assert.deepEqual(readFileSync(join(output, `${name}.sha256.tmp`)), marker);
  assert.equal(existsSync(join(output, `${name}.tmp`)), false);
});

test('rejects a checksum destination directory before replacing the existing archive', t => {
  const f = fixture(t, { 'source.txt': 'Original public content\n' });
  writePublicArchive(f.root);
  const output = join(f.root, 'outputs', 'public-release');
  const name = 'OptiEVE-public-source.zip';
  const priorArchive = readFileSync(join(output, name));
  const checksumDirectory = join(output, `${name}.sha256`);
  rmSync(checksumDirectory);
  mkdirSync(checksumDirectory);
  const marker = Buffer.from('Do not alter an unexpected destination directory\n');
  writeFileSync(join(checksumDirectory, 'marker.txt'), marker);
  f.write('source.txt', 'Changed public content\n');
  assert.throws(() => writePublicArchive(f.root), /destination must be a regular file/);
  assert.deepEqual(readFileSync(join(output, name)), priorArchive);
  assert.deepEqual(readFileSync(join(checksumDirectory, 'marker.txt')), marker);
  assert.equal(existsSync(join(output, `${name}.tmp`)), false);
  assert.equal(existsSync(join(output, `${name}.sha256.tmp`)), false);
});
