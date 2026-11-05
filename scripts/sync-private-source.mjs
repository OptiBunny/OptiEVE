import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectContent, inspectPath, requirePublicSource } from './public-source.mjs';

const manifestName = '.eve-private/source-manifest.json';
const hostingName = '.openai/hosting.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
const privateDirectories = new Set(['.git', '.eve-private', 'node_modules', '.sites-runtime', '.wrangler', 'outputs', 'dist', '.next', '.vinext', 'out', 'coverage', '.agents', '.codex', 'work']);

function statOrNull(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function safeRoot(path, mustExist) {
  path = resolve(path);
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = statOrNull(current);
    if (!stat) { if (mustExist) throw new Error('Source and destination parent directories must exist'); return path; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Source and destination roots and parents must be real directories');
  }
  return realpathSync(path);
}

function contains(parent, child) {
  const distance = relative(parent, child);
  return !distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`));
}

function allowedName(name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || /[\\:\r\n\0]/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || privateDirectories.has(part.toLowerCase()))) return false;
  if (parts.some(part => /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/i.test(part)) && name !== '.env.example') return false;
  // A modified manifest must never turn private runtime files into deletion targets.
  return inspectContent(name, Buffer.from(name === hostingName ? '{}' : '')).length === 0;
}

function hosting(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${hostingName}: invalid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${hostingName}: expected an object`);
  if (Object.hasOwn(value, 'project_id') && value.project_id !== null && typeof value.project_id !== 'string') throw new Error(`${hostingName}: invalid private binding`);
  return value;
}

function contentHash(name, bytes) {
  if (name !== hostingName) return sha256(bytes);
  const value = hosting(bytes);
  delete value.project_id;
  return sha256(canonical(value));
}

function readManaged(root, name) {
  if (!allowedName(name)) throw new Error('Invalid managed source path');
  const stat = inspectPath(root, name);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink > 1) throw new Error(`${name}: managed source must be a regular, unshared file`);
  return readFileSync(resolve(root, name));
}

function readBaseline(root) {
  const stat = inspectPath(root, manifestName);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink > 1) throw new Error('Private source manifest must be a regular, unshared file');
  let value;
  try { value = JSON.parse(readFileSync(resolve(root, manifestName), 'utf8')); }
  catch { throw new Error('Private source manifest is invalid'); }
  if (!value || value.version !== 1 || value.mode !== 'private' || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)
    || Object.keys(value).some(key => !['version', 'mode', 'files', 'digest'].includes(key))) throw new Error('Private source manifest is invalid');
  for (const [name, hash] of Object.entries(value.files)) {
    if (!allowedName(name) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Private source manifest contains an invalid managed entry');
  }
  if (!Object.hasOwn(value.files, hostingName) || value.digest !== sha256(canonical(value.files))) throw new Error('Private source manifest integrity check failed');
  return value;
}

function anchorName(digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid source snapshot digest');
  return `outputs/private-sync/manifests/${digest}.json`;
}

function requireAnchor(root, files, digest) {
  const name = anchorName(digest);
  const stat = inspectPath(root, name);
  if (!stat || !stat.isFile() || stat.nlink > 1) throw new Error('Trusted development source manifest is missing or unsafe');
  let value;
  try { value = JSON.parse(readFileSync(resolve(root, name), 'utf8')); }
  catch { throw new Error('Trusted development source manifest is invalid'); }
  if (canonical(value) !== canonical({ version: 1, files, digest })) throw new Error('Private baseline does not match the trusted development source manifest');
}

function recordAnchor(root, files, digest) {
  const name = anchorName(digest);
  if (inspectPath(root, name)) { requireAnchor(root, files, digest); return; }
  inspectPath(root, 'outputs/private-sync/manifests');
  mkdirSync(resolve(root, 'outputs/private-sync/manifests'), { recursive: true });
  inspectPath(root, name);
  try {
    writeFileSync(resolve(root, name), `${JSON.stringify({ version: 1, files: sorted(files), digest }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  requireAnchor(root, files, digest);
}

function planSync(root, entries, hashes, digest, sourceRoot) {
  if (statOrNull(join(root, '.git'))) throw new Error('Private destination must not contain Git metadata');
  const exists = statOrNull(root);
  const baseline = exists ? readBaseline(root) : null;
  if (baseline) requireAnchor(sourceRoot, baseline.files, baseline.digest);
  if (!baseline && exists && readdirSync(root).length) throw new Error('Private destination is not initialized and is not empty');
  const previous = baseline?.files ?? {};
  const source = new Map(entries.map(entry => [entry.name, entry]));
  const conflicts = [], writes = [], deletions = [];
  let parity = Boolean(baseline && baseline.digest === digest);
  for (const name of [...new Set([...Object.keys(previous), ...source.keys()])].sort()) {
    const oldHash = Object.hasOwn(previous, name) ? previous[name] : undefined;
    const entry = source.get(name);
    let bytes, current;
    try { bytes = exists ? readManaged(root, name) : null; current = bytes === null ? null : contentHash(name, bytes); }
    catch { conflicts.push(name); continue; }
    if (!entry) {
      if (current === null) continue;
      parity = false;
      if (current !== oldHash) conflicts.push(name);
      else deletions.push({ name, beforeHash: sha256(bytes) });
      continue;
    }
    if (current !== hashes[name]) parity = false;
    if (current !== null && oldHash === undefined) { conflicts.push(name); continue; }
    if (oldHash !== undefined && (current === null || (current !== oldHash && current !== hashes[name]))) { conflicts.push(name); continue; }
    if (current === hashes[name]) continue;
    let next = entry.bytes;
    if (name === hostingName && bytes !== null) {
      const local = hosting(bytes), generic = hosting(entry.bytes);
      delete generic.project_id;
      if (Object.hasOwn(local, 'project_id')) generic.project_id = local.project_id;
      next = Buffer.from(`${JSON.stringify(sorted(generic), null, 2)}\n`);
    }
    writes.push({ name, bytes: next, mode: entry.mode, beforeHash: bytes === null ? null : sha256(bytes) });
  }
  if (conflicts.length) throw new Error(`Private source conflicts:\n${conflicts.map(name => `- ${name}`).join('\n')}`);
  if (exists && inspectPath(root, `${manifestName}.tmp`)) throw new Error('An unfinished private source manifest already exists');
  return { baseline, writes, deletions, inSync: parity };
}

function requireUnchanged(root, entry) {
  const bytes = readManaged(root, entry.name);
  if ((bytes === null ? null : sha256(bytes)) !== entry.beforeHash) throw new Error(`Private source conflicts:\n- ${entry.name}`);
}

/** Copy only validated generic source into an independently configured private directory. */
export function syncPrivateSource(sourceRoot, targetRoot, { checkOnly = false } = {}) {
  try {
    sourceRoot = safeRoot(sourceRoot, true);
    const requestedTarget = resolve(targetRoot);
    const parent = safeRoot(dirname(requestedTarget), true);
    targetRoot = safeRoot(join(parent, basename(requestedTarget)), false);
    if (contains(sourceRoot, targetRoot) || contains(targetRoot, sourceRoot)) throw new Error('Source and private destination must not overlap');
    const entries = requirePublicSource(sourceRoot);
    const hashes = Object.create(null);
    for (const entry of entries) {
      if (!allowedName(entry.name)) throw new Error('Public source includes a reserved private path');
      hashes[entry.name] = contentHash(entry.name, entry.bytes);
    }
    const digest = sha256(canonical(hashes));
    const lock = join(parent, `.${basename(targetRoot)}.source-sync.lock`);
    if (statOrNull(lock)) throw new Error('Private source synchronization is already locked');
    let plan = planSync(targetRoot, entries, hashes, digest, sourceRoot);
    if (checkOnly) {
      if (!plan.baseline) throw new Error('Private source is not initialized');
      return { files: entries.length, digest, inSync: plan.inSync };
    }
    if (plan.inSync) return { files: entries.length, digest, inSync: true };
    const descriptor = openSync(lock, 'wx', 0o600);
    const staged = [];
    let manifestTemporary = false;
    try {
      // Recheck all conflicts after taking the lock and before changing private source.
      safeRoot(targetRoot, false);
      plan = planSync(targetRoot, entries, hashes, digest, sourceRoot);
      recordAnchor(sourceRoot, hashes, digest);
      if (!statOrNull(targetRoot)) mkdirSync(targetRoot);
      inspectPath(targetRoot, '.eve-private');
      mkdirSync(join(targetRoot, '.eve-private'), { recursive: true });
      for (const entry of plan.writes) {
        const temporaryName = `.eve-private/pending-${randomUUID()}`;
        inspectPath(targetRoot, temporaryName);
        const temporary = resolve(targetRoot, temporaryName);
        writeFileSync(temporary, entry.bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
        staged.push({ ...entry, temporary });
      }
      for (const entry of [...plan.writes, ...plan.deletions]) requireUnchanged(targetRoot, entry);
      for (const entry of staged) {
        requireUnchanged(targetRoot, entry);
        inspectPath(targetRoot, entry.name);
        mkdirSync(dirname(resolve(targetRoot, entry.name)), { recursive: true });
        renameSync(entry.temporary, resolve(targetRoot, entry.name));
      }
      for (const entry of plan.deletions) {
        requireUnchanged(targetRoot, entry);
        unlinkSync(resolve(targetRoot, entry.name));
      }
      // Verify actual source parity before recording the successful new baseline.
      for (const entry of entries) {
        const bytes = readManaged(targetRoot, entry.name);
        if (bytes === null || contentHash(entry.name, bytes) !== hashes[entry.name]) throw new Error(`Private source verification failed: ${entry.name}`);
      }
      for (const { name } of plan.deletions) if (inspectPath(targetRoot, name)) throw new Error(`Private source verification failed: ${name}`);
      inspectPath(targetRoot, manifestName);
      inspectPath(targetRoot, `${manifestName}.tmp`);
      writeFileSync(resolve(targetRoot, `${manifestName}.tmp`), `${JSON.stringify({ version: 1, mode: 'private', files: sorted(hashes), digest }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      manifestTemporary = true;
      renameSync(resolve(targetRoot, `${manifestName}.tmp`), resolve(targetRoot, manifestName));
      manifestTemporary = false;
      return { files: entries.length, digest, inSync: true };
    } finally {
      for (const entry of staged) if (statOrNull(entry.temporary)) unlinkSync(entry.temporary);
      if (manifestTemporary && statOrNull(resolve(targetRoot, `${manifestName}.tmp`))) unlinkSync(resolve(targetRoot, `${manifestName}.tmp`));
      closeSync(descriptor);
      unlinkSync(lock);
    }
  } catch (error) {
    if (error.code) throw new Error('Private source synchronization failed because a filesystem or tool operation could not complete');
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    let targetRoot = join(dirname(sourceRoot), 'OptiEVE');
    let checkOnly = false;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--check') checkOnly = true;
      else if (args[index] === '--target' && args[index + 1]) targetRoot = resolve(args[++index]);
      else throw new Error('Usage: node scripts/sync-private-source.mjs [--check] [--target directory]');
    }
    const result = syncPrivateSource(sourceRoot, targetRoot, { checkOnly });
    console.log(`${result.inSync ? 'PASS' : 'OUT OF SYNC'}: ${result.files} managed source files; digest ${result.digest}`);
    if (!result.inSync) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
