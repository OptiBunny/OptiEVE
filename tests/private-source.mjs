import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { requirePublicSource } from '../scripts/public-source.mjs';
import { createPublicArchive } from '../scripts/package-public-source.mjs';
import { syncPrivateSource } from '../scripts/sync-private-source.mjs';

const prefix = 'eve-private-source-regression-';
const marker = '.eve-private/source-manifest.json';
const hosting = '.openai/hosting.json';
const configuration = { d1: 'DB', r2: null, capabilities: ['mcp'] };
const ignore = '/outputs/\n/dist/\n/node_modules/\n/.wrangler/\n/.sites-runtime/\n/.env\n/.env.*\n!/.env.example\n/.dev.vars\n/.dev.vars.*\n';
const dummyCredential = () => ['gh', 'p_', 'Q'.repeat(40)].join('');
const dummyProject = () => ['app', 'gprj_', 'a'.repeat(32)].join('');
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function fixture(t, extra = {}, sourceName = 'source') {
  const temporary = mkdtempSync(join(tmpdir(), prefix));
  const source = join(temporary, sourceName);
  const target = join(temporary, 'private');
  const links = [];
  mkdirSync(source);
  t.after(() => {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()), 'cleanup must stay directly below the temporary directory');
    assert.ok(basename(temporary).startsWith(prefix), 'cleanup requires the fixture prefix');
    assert.ok(!lstatSync(temporary).isSymbolicLink(), 'cleanup root cannot be a link');
    for (const link of links.reverse()) {
      assert.ok(inside(temporary, link), 'link cleanup must stay inside the fixture');
      try {
        if (lstatSync(link).isSymbolicLink()) rmSync(link, { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const write = (root, name, value) => {
    const filename = resolve(root, name);
    assert.ok(inside(temporary, root) && inside(root, filename), 'fixture writes must stay below an owned root');
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, value);
  };
  const git = (args, input) => execFileSync('git', [
    '-c', 'init.templateDir=', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    '-c', 'user.name=Source Test', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd: source, env: gitEnvironment, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  const files = {
    '.gitignore': ignore,
    [hosting]: JSON.stringify(configuration, null, 2) + '\n',
    '.env.example': 'EVE_SITE_ORIGIN=https://optieve.example\nEVE_TOKEN_KEY=\n',
    'app/main.ts': 'export const version = 1;\r\n',
    ...extra,
  };
  for (const [name, bytes] of Object.entries(files)) write(source, name, bytes);
  git(['init', '--quiet', '--initial-branch=main']);
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'Synthetic fixture']);
  const linkDirectory = (destination, link) => {
    assert.ok(inside(temporary, link), 'fixture links must stay inside the temporary root');
    try {
      symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.skip('Filesystem link creation is unavailable on this host.');
        return false;
      }
      throw error;
    }
    links.push(link);
    return true;
  };
  return { temporary, source, target, write, git, linkDirectory };
}

// Hash private fixture bytes rather than displaying their values in diagnostics.
function snapshot(root) {
  if (!existsSync(root)) return null;
  const result = {};
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const filename = join(directory, name);
      const rel = relative(root, filename).replaceAll('\\', '/');
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) result[rel] = { type: 'link', modified: stat.mtimeMs };
      else if (stat.isDirectory()) {
        result[rel] = { type: 'directory', modified: stat.mtimeMs };
        visit(filename);
      } else result[rel] = { type: 'file', hash: sha256(readFileSync(filename)), modified: stat.mtimeMs };
    }
  };
  visit(root);
  return result;
}

function readManifest(target) {
  return JSON.parse(readFileSync(join(target, marker), 'utf8'));
}

function assertSelection(source, target, result) {
  const entries = requirePublicSource(source);
  const state = readManifest(target);
  assert.equal(result.files, entries.length);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.inSync, true);
  assert.equal(state.version, 1);
  assert.equal(state.mode, 'private');
  assert.equal(state.digest, result.digest);
  assert.deepEqual(Object.keys(state.files).sort(), entries.map(entry => entry.name).sort());
  for (const entry of entries) {
    const actual = readFileSync(join(target, entry.name));
    if (entry.name === hosting) {
      const generic = JSON.parse(actual);
      delete generic.project_id;
      assert.deepEqual(generic, JSON.parse(entry.bytes));
    } else assert.equal(sha256(actual), sha256(entry.bytes), `managed bytes match: ${entry.name}`);
  }
}

test('initial sync copies validated current source, without history, ignored secrets, dependencies, or outputs', t => {
  const f = fixture(t, { 'app/current.ts': `${dummyCredential()}\n`, 'app/deleted.ts': `${dummyCredential()}\n` });
  f.write(f.source, 'app/current.ts', 'export const current = true;\n');
  f.write(f.source, 'app/added.ts', 'export const added = true;\n');
  rmSync(join(f.source, 'app/deleted.ts'));
  for (const name of ['.env', '.dev.vars', '.wrangler/state/state.txt', 'node_modules/local.txt', 'outputs/private.txt', 'dist/generated.txt']) {
    f.write(f.source, name, dummyCredential());
  }
  const result = syncPrivateSource(f.source, f.target);
  assertSelection(f.source, f.target, result);
  assert.deepEqual(
    Object.entries(snapshot(f.target)).filter(([, entry]) => entry.type === 'file').map(([name]) => name).sort(),
    [...requirePublicSource(f.source).map(entry => entry.name), marker].sort(),
    'initial target contains only selected source and its private manifest',
  );
  for (const name of ['.git', '.env', '.dev.vars', '.wrangler', 'node_modules', 'outputs', 'dist', 'app/deleted.ts']) {
    assert.equal(existsSync(join(f.target, name)), false, `excluded source must not be copied: ${name}`);
  }
  assert.throws(() => requirePublicSource(f.target), /Private runtime/);
  assert.throws(() => createPublicArchive(f.target), /Private runtime/);
});

test('an existing empty destination can be initialized and repeated sync reports parity', t => {
  const f = fixture(t);
  mkdirSync(f.target);
  const first = syncPrivateSource(f.source, f.target);
  const second = syncPrivateSource(f.source, f.target);
  assertSelection(f.source, f.target, second);
  assert.equal(second.digest, first.digest);
});

test('source additions, updates, and deletions preserve unmanaged runtime state', t => {
  const f = fixture(t, { 'app/remove.ts': 'export const removed = true;\n' });
  syncPrivateSource(f.source, f.target);
  const privateNames = ['.env', '.dev.vars', '.wrangler/state/v3/local.txt', '.sites-runtime/state.txt', 'outputs/runtime.txt', 'node_modules/local.txt'];
  for (const name of privateNames) f.write(f.target, name, `${name}\n${dummyCredential()}\n`);
  const before = new Map(privateNames.map(name => [name, sha256(readFileSync(join(f.target, name)))]));
  f.write(f.source, 'app/main.ts', 'export const version = 2;\n');
  f.write(f.source, 'app/new.ts', 'export const added = true;\n');
  rmSync(join(f.source, 'app/remove.ts'));
  const result = syncPrivateSource(f.source, f.target);
  assertSelection(f.source, f.target, result);
  assert.equal(existsSync(join(f.target, 'app/remove.ts')), false);
  for (const name of privateNames) assert.equal(sha256(readFileSync(join(f.target, name))), before.get(name), `private state is preserved: ${name}`);
});

test('private hosting project binding survives generic source configuration updates and check-only parity', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  const project = dummyProject();
  f.write(f.target, hosting, JSON.stringify({ project_id: project, capabilities: ['mcp'], r2: null, d1: 'DB' }) + '\n');
  assert.equal(syncPrivateSource(f.source, f.target, { checkOnly: true }).inSync, true);
  const generic = { ...configuration, capabilities: ['mcp', 'example'], r2: 'FILES' };
  f.write(f.source, hosting, JSON.stringify(generic) + '\n');
  const result = syncPrivateSource(f.source, f.target);
  assertSelection(f.source, f.target, result);
  const targetHosting = JSON.parse(readFileSync(join(f.target, hosting), 'utf8'));
  assert.equal(targetHosting.project_id, project);
  assert.deepEqual(targetHosting, { ...generic, project_id: project });
  assert.equal(syncPrivateSource(f.source, f.target, { checkOnly: true }).inSync, true);
});

test('editing managed code aborts additions and deletions before destination mutation', t => {
  const f = fixture(t, { 'app/remove.ts': 'export const removed = true;\n' });
  syncPrivateSource(f.source, f.target);
  f.write(f.target, 'app/main.ts', 'export const privateEdit = true;\n');
  f.write(f.source, 'app/new.ts', 'export const added = true;\n');
  rmSync(join(f.source, 'app/remove.ts'));
  const before = snapshot(f.target);
  assert.throws(() => syncPrivateSource(f.source, f.target, { checkOnly: true }), /conflict|modified|changed|drift/i);
  assert.deepEqual(snapshot(f.target), before);
  assert.throws(() => syncPrivateSource(f.source, f.target), /conflict|modified|changed|drift/i);
  assert.deepEqual(snapshot(f.target), before);
});

test('private hosting changes outside project_id are conflicts and are preserved', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  f.write(f.target, hosting, JSON.stringify({ ...configuration, project_id: dummyProject(), d1: 'PRIVATE_DB' }) + '\n');
  f.write(f.source, 'app/new.ts', 'export const added = true;\n');
  const before = snapshot(f.target);
  assert.throws(() => syncPrivateSource(f.source, f.target), /conflict|modified|changed|drift/i);
  assert.deepEqual(snapshot(f.target), before);
});

test('new source paths cannot overwrite preexisting unmanaged private files', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  f.write(f.target, 'app/new.ts', 'Private local notes\n');
  f.write(f.source, 'app/new.ts', 'export const added = true;\n');
  const before = snapshot(f.target);
  assert.throws(() => syncPrivateSource(f.source, f.target), /conflict|unmanaged|already exists|overwrite/i);
  assert.deepEqual(snapshot(f.target), before);
});

test('check-only missing target creates neither destination nor lock', t => {
  const f = fixture(t);
  const before = snapshot(f.temporary);
  assert.throws(() => syncPrivateSource(f.source, f.target, { checkOnly: true }), /not initialized/i);
  assert.deepEqual(snapshot(f.temporary), before);
});

test('check-only parity and source drift leave all destination files and timestamps unchanged', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  f.write(f.target, '.env', dummyCredential());
  const before = snapshot(f.target);
  assert.equal(syncPrivateSource(f.source, f.target, { checkOnly: true }).inSync, true);
  assert.deepEqual(snapshot(f.target), before);
  f.write(f.source, 'app/main.ts', 'export const version = 2;\n');
  assert.equal(syncPrivateSource(f.source, f.target, { checkOnly: true }).inSync, false);
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(existsSync(join(f.temporary, `.${basename(f.target)}.source-sync.lock`)), false);
});

test('the CLI defaults from OptiEVE-dev to sibling OptiEVE regardless of cwd and preserves explicit targets', t => {
  const f = fixture(t, {}, 'OptiEVE-dev');
  for (const name of ['public-source.mjs', 'sync-private-source.mjs']) {
    f.write(f.source, `scripts/${name}`, readFileSync(new URL(`../scripts/${name}`, import.meta.url)));
  }
  const run = (...args) => spawnSync(process.execPath, [join(f.source, 'scripts/sync-private-source.mjs'), ...args], {
    cwd: f.temporary, env: gitEnvironment, encoding: 'utf8', windowsHide: true,
  });
  const target = join(f.temporary, 'OptiEVE');
  const missing = run('--check');
  assert.equal(missing.status, 1);
  assert.equal(existsSync(target), false);
  const initialized = run();
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.deepEqual(readFileSync(join(target, 'app/main.ts')), readFileSync(join(f.source, 'app/main.ts')));
  assert.equal(existsSync(join(target, marker)), true);
  assert.equal(existsSync(join(target, '.git')), false);
  assert.equal(existsSync(join(f.temporary, 'OptiEVE Private')), false);
  const before = snapshot(target);
  const matching = run('--check');
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(matching.stdout, /PASS/);
  assert.deepEqual(snapshot(target), before);
  const overridden = run('--target', f.target);
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(existsSync(join(f.target, marker)), true);
  assert.deepEqual(snapshot(target), before);
  assert.equal(run('--target', f.target, '--check').status, 0);
});

test('a source checkout named OptiEVE refuses its default self-target without changing files', t => {
  const f = fixture(t, {}, 'OptiEVE');
  for (const name of ['public-source.mjs', 'sync-private-source.mjs']) {
    f.write(f.source, `scripts/${name}`, readFileSync(new URL(`../scripts/${name}`, import.meta.url)));
  }
  const before = snapshot(f.temporary);
  const result = spawnSync(process.execPath, [join(f.source, 'scripts/sync-private-source.mjs')], {
    cwd: f.temporary, env: gitEnvironment, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /overlap/i);
  assert.deepEqual(snapshot(f.temporary), before);
});

test('the check-only CLI reports missing, matching, and stale source without changing the private copy', t => {
  const f = fixture(t);
  for (const name of ['public-source.mjs', 'sync-private-source.mjs']) {
    f.write(f.source, `scripts/${name}`, readFileSync(new URL(`../scripts/${name}`, import.meta.url)));
  }
  const check = () => spawnSync(process.execPath, [join(f.source, 'scripts/sync-private-source.mjs'), '--target', f.target, '--check'], {
    cwd: f.source, env: gitEnvironment, encoding: 'utf8', windowsHide: true,
  });
  const missingBefore = snapshot(f.temporary);
  const missing = check();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not initialized/i);
  assert.deepEqual(snapshot(f.temporary), missingBefore);
  syncPrivateSource(f.source, f.target);
  const before = snapshot(f.target);
  const matching = check();
  assert.equal(matching.status, 0);
  assert.match(matching.stdout, /PASS/);
  assert.deepEqual(snapshot(f.target), before);
  f.write(f.source, 'app/main.ts', 'export const version = 2;\n');
  const changed = check();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /OUT OF SYNC/);
  assert.deepEqual(snapshot(f.target), before);
});

test('nonempty unregistered destination is never adopted or overwritten', t => {
  const f = fixture(t);
  f.write(f.target, '.env', dummyCredential());
  const before = snapshot(f.target);
  assert.throws(() => syncPrivateSource(f.source, f.target), /empty|unregistered|initialized/i);
  assert.deepEqual(snapshot(f.target), before);
});

test('source guard failure cannot initialize a target or update an existing private copy', t => {
  const f = fixture(t);
  const uninitialized = join(f.temporary, 'uninitialized');
  syncPrivateSource(f.source, f.target);
  const before = snapshot(f.target);
  f.write(f.source, 'app/main.ts', dummyCredential());
  assert.throws(() => syncPrivateSource(f.source, uninitialized), /Public-source check failed/);
  assert.equal(existsSync(uninitialized), false);
  assert.throws(() => syncPrivateSource(f.source, f.target), /Public-source check failed/);
  assert.deepEqual(snapshot(f.target), before);
});

test('source and target must be separate non-overlapping directories', t => {
  const f = fixture(t);
  const before = snapshot(f.temporary);
  for (const target of [f.source, join(f.source, 'nested'), f.temporary]) {
    assert.throws(() => syncPrivateSource(f.source, target), /overlap|separate|inside|contain|same/i);
  }
  assert.deepEqual(snapshot(f.temporary), before);
});

test('a missing destination parent is not created implicitly', t => {
  const f = fixture(t);
  const target = join(f.temporary, 'missing-parent', 'private');
  const before = snapshot(f.temporary);
  assert.throws(() => syncPrivateSource(f.source, target), /parent|exist|director/i);
  assert.deepEqual(snapshot(f.temporary), before);
});

test('source and destination root links are rejected without following their targets', t => {
  const f = fixture(t);
  const sourceLink = join(f.temporary, 'source-link');
  const destination = join(f.temporary, 'other');
  mkdirSync(destination);
  f.write(destination, 'canary.txt', 'Unmanaged directory\n');
  if (!f.linkDirectory(f.source, sourceLink) || !f.linkDirectory(destination, f.target)) return;
  const before = snapshot(destination);
  assert.throws(() => syncPrivateSource(sourceLink, join(f.temporary, 'new-target')), /link|junction|real directories/i);
  assert.throws(() => syncPrivateSource(f.source, f.target), /link|junction|real directories/i);
  assert.equal(existsSync(join(f.temporary, 'new-target')), false);
  assert.deepEqual(snapshot(destination), before);
});

test('linked ancestors of source or destination are rejected', t => {
  const f = fixture(t);
  const linkedParent = join(f.temporary, 'parent-link');
  if (!f.linkDirectory(f.temporary, linkedParent)) return;
  assert.throws(() => syncPrivateSource(join(linkedParent, 'source'), f.target), /link|junction|real directories/i);
  assert.throws(() => syncPrivateSource(f.source, join(linkedParent, 'private')), /link|junction|real directories/i);
  assert.equal(existsSync(f.target), false);
});

test('a managed destination replaced by a link is rejected without touching the linked directory', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  const external = join(f.temporary, 'external');
  mkdirSync(external);
  f.write(external, 'canary.txt', 'Unmanaged directory\n');
  rmSync(join(f.target, 'app/main.ts'));
  if (!f.linkDirectory(external, join(f.target, 'app/main.ts'))) return;
  const before = snapshot(f.target);
  const externalBefore = snapshot(external);
  assert.throws(() => syncPrivateSource(f.source, f.target), /link|junction|conflict/i);
  assert.deepEqual(snapshot(f.target), before);
  assert.deepEqual(snapshot(external), externalBefore);
});

test('a linked parent of managed destination files is rejected', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  const external = join(f.temporary, 'external');
  mkdirSync(external);
  f.write(external, 'main.ts', readFileSync(join(f.target, 'app/main.ts')));
  const managedDirectory = resolve(f.target, 'app');
  assert.ok(inside(f.target, managedDirectory));
  assert.ok(!lstatSync(managedDirectory).isSymbolicLink());
  rmSync(managedDirectory, { recursive: true });
  if (!f.linkDirectory(external, managedDirectory)) return;
  const before = snapshot(external);
  assert.throws(() => syncPrivateSource(f.source, f.target), /link|junction|conflict/i);
  assert.deepEqual(snapshot(external), before);
});

test('existing sync lock blocks writes and remains owned by the existing operation', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  const lock = join(f.temporary, `.${basename(f.target)}.source-sync.lock`);
  writeFileSync(lock, 'Existing lock\n', { flag: 'wx' });
  f.write(f.source, 'app/main.ts', 'export const version = 2;\n');
  const before = snapshot(f.target);
  assert.throws(() => syncPrivateSource(f.source, f.target), /lock|progress|running|busy/i);
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(readFileSync(lock, 'utf8'), 'Existing lock\n');
});

test('tampered manifest paths, hashes, digest, and mode are rejected before writes', async t => {
  const cases = [
    ['parent traversal', state => { state.files['../escape.txt'] = '0'.repeat(64); }],
    ['private environment', state => { state.files['.env'] = '0'.repeat(64); }],
    ['private runtime state', state => { state.files['.wrangler/state.txt'] = '0'.repeat(64); }],
    ['invalid hash', state => { state.files['app/main.ts'] = 'invalid'; }],
    ['invalid digest', state => { state.digest = '0'.repeat(64); }],
    ['invalid mode', state => { state.mode = 'public'; }],
  ];
  for (const [name, tamper] of cases) {
    await t.test(name, t => {
      const f = fixture(t);
      syncPrivateSource(f.source, f.target);
      const state = readManifest(f.target);
      tamper(state);
      f.write(f.target, marker, JSON.stringify(state) + '\n');
      f.write(f.source, 'app/new.ts', 'export const added = true;\n');
      const before = snapshot(f.target);
      assert.throws(() => syncPrivateSource(f.source, f.target), /manifest|path|hash|digest|private|mode/i);
      assert.deepEqual(snapshot(f.target), before);
      assert.equal(existsSync(join(f.temporary, 'escape.txt')), false);
    });
  }
});

test('a self-consistent forged private manifest cannot authorize deletion of private files', t => {
  const f = fixture(t);
  syncPrivateSource(f.source, f.target);
  const privateFile = 'private-notes.md';
  f.write(f.target, privateFile, 'Synthetic private notes that must remain local.\n');
  const state = readManifest(f.target);
  state.files[privateFile] = sha256(readFileSync(join(f.target, privateFile)));
  state.digest = sha256(JSON.stringify(Object.fromEntries(Object.keys(state.files).sort().map(name => [name, state.files[name]]))));
  f.write(f.target, marker, JSON.stringify(state) + '\n');
  f.write(f.source, 'app/new.ts', 'export const added = true;\n');
  const before = snapshot(f.target);
  assert.throws(() => syncPrivateSource(f.source, f.target, { checkOnly: true }), /trusted|anchor|baseline|manifest/i);
  assert.deepEqual(snapshot(f.target), before);
  assert.throws(() => syncPrivateSource(f.source, f.target), /trusted|anchor|baseline|manifest/i);
  assert.deepEqual(snapshot(f.target), before);
});
