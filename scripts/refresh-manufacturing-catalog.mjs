// Explicit public-data refresh. No account calls, deployment, scheduled work or Git writes.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffCatalogs, formatCatalogDiff, validateCatalog } from './manufacturing-catalog-diff.mjs';
import { inspectContent, inspectPath, requirePublicSource } from './public-source.mjs';
import { syncPrivateSource } from './sync-private-source.mjs';

const catalogName = 'app/data/manufacturing-catalog.json';
const prefix = 'optieve-catalog-review-';
const catalogLimit = 32 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const publicError = message => Object.assign(Error(message), { publicCatalogMessage: true });
// Verified against the official npm typescript@5.9.3 tarball and its SHA-512 integrity.
// Dependency upgrades require explicitly reviewing this pin; never execute an unknown compiler.
export const compilerPin = Object.freeze({ version: '5.9.3', sha256: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675' });
export const catalogValidationTests = Object.freeze(['tests/manufacturing-catalog.mjs', 'tests/manufacturing-estimate.mjs', 'tests/catalog-refresh.mjs']);

const exists = path => lstatSync(path, { throwIfNoEntry: false });
const contained = (parent, child) => {
  const part = relative(resolve(parent), resolve(child));
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const overlaps = (a, b) => contained(a, b) || contained(b, a);

// A private marker in any ancestor also disqualifies a nested source/validation folder.
export function realPublicDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = exists(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw publicError('Catalog workflow requires real directories without links or junctions');
    if (exists(join(current, '.eve-private'))) throw publicError('Catalog workflow cannot run from or validate against a private runtime');
  }
  return realpathSync(absolute);
}

function regularFile(path, limit, { hardLinks = false } = {}) {
  const stat = exists(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || !hardLinks && stat.nlink > 1 || stat.size > limit) throw publicError('Catalog workflow input must be a bounded regular file');
  return readFileSync(path);
}

function snapshot(entries) {
  return sha256(JSON.stringify(entries.map(entry => [entry.name, entry.mode, sha256(entry.bytes)]).sort((a, b) => a[0].localeCompare(b[0]))));
}

function parseCatalog(bytes) {
  if (bytes.length > catalogLimit || inspectContent(catalogName, bytes).length) throw Error('Staged catalog failed public-source inspection');
  let catalog;
  try { catalog = JSON.parse(bytes.toString('utf8')); } catch { throw Error('Staged catalog must contain valid JSON'); }
  validateCatalog(catalog);
  return catalog;
}

export function readValidationCompiler(validationDir, sourceRoot, targetRoot, entries) {
  const directory = realPublicDirectory(validationDir);
  if (overlaps(directory, sourceRoot) || overlaps(directory, targetRoot)) throw publicError('Validation dependencies must be outside development and the private runtime');
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const expected = entries.find(entry => entry.name === name);
    if (!expected || !inspectPath(directory, name) || !regularFile(join(directory, name), 4 * 1024 * 1024).equals(expected.bytes)) throw publicError('Validation dependency inputs must match the current development package and lockfile');
  }
  const manifest = JSON.parse(entries.find(entry => entry.name === 'package.json').bytes);
  if (manifest.devDependencies?.typescript !== compilerPin.version) throw publicError('Review the pinned catalog-validation compiler before upgrading TypeScript');
  const modules = realPublicDirectory(join(directory, 'node_modules'));
  const dependency = realpathSync(join(modules, 'typescript'));
  if (!contained(modules, dependency) || dependency === modules) throw publicError('TypeScript dependency must resolve inside the external validation node_modules');
  // A pnpm package link is allowed only after resolution inside that node_modules tree.
  realPublicDirectory(dependency);
  if (!inspectPath(dependency, 'package.json') || !inspectPath(dependency, 'lib/typescript.js')) throw publicError('Missing catalog-validation compiler');
  const packageInfo = JSON.parse(regularFile(join(dependency, 'package.json'), 65536, { hardLinks: true }));
  const compiler = regularFile(join(dependency, 'lib/typescript.js'), 16 * 1024 * 1024, { hardLinks: true });
  if (packageInfo.name !== 'typescript' || packageInfo.version !== compilerPin.version || sha256(compiler) !== compilerPin.sha256) throw publicError('Catalog-validation compiler does not match the reviewed TypeScript runtime');
  return compiler;
}

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:NODE_OPTIONS|NODE_PATH|TS_NODE.*|GIT_.*)$/i.test(name)));
}

function runNode(args, cwd, phase) {
  return new Promise((accept, reject) => {
    execFile(process.execPath, args, { cwd, env: cleanEnvironment(), windowsHide: true, timeout: 300000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      // Child output may include local paths. Return a bounded generic failure instead.
      if (error) reject(Error(`${phase} failed; canonical catalog has not passed this stage`));
      else accept(stdout);
    });
  });
}

function cleanupTemporary(temporary, temporaryRoot) {
  if (dirname(resolve(temporary)) !== temporaryRoot || !basename(temporary).startsWith(prefix) || exists(temporary)?.isSymbolicLink()) throw Error('Refusing unsafe catalog-validation cleanup');
  rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function writeAtomicCatalog(root, bytes) {
  const stat = inspectPath(root, catalogName);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw Error('Unsafe canonical catalog destination');
  const temporaryName = `${catalogName}.${randomUUID()}.tmp`;
  const temporary = join(root, temporaryName);
  if (inspectPath(root, temporaryName)) throw Error('Catalog commit staging path already exists');
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    // Recheck parents immediately before the only canonical-file replacement.
    const destination = inspectPath(root, catalogName);
    if (!destination?.isFile() || destination.isSymbolicLink() || destination.nlink > 1) throw Error('Canonical catalog destination changed during refresh');
    renameSync(temporary, join(root, catalogName));
  } finally {
    if (exists(temporary)) unlinkSync(temporary);
  }
}

export class CatalogRefreshError extends Error {
  constructor(phase, developmentUpdated, reason = '') {
    const syncPending = developmentUpdated || phase.startsWith('private source');
    super((syncPending
      ? `Catalog ${phase} failed. ${developmentUpdated ? 'The development catalog was updated.' : 'The development catalog is unchanged.'} Private source parity is pending; resolve the failure and run the guarded sync and parity check. No private rollback or forced sync was attempted.`
      : `Catalog ${phase} failed before commit. The workflow did not replace the development catalog or sync private source.`) + (reason ? ` ${reason}.` : ''));
    this.name = 'CatalogRefreshError';
    this.phase = phase;
    this.developmentUpdated = developmentUpdated;
    this.privateSyncPending = syncPending;
  }
}

// The injected operations are an in-process regression-test seam, never CLI options.
// Production always uses the fixed updater, pinned compiler, source checker and guarded sync.
export async function refreshCatalog(options, operations = {}) {
  let phase = 'preflight', developmentUpdated = false, temporary, temporaryRoot;
  const report = operations.report ?? (message => console.log(message));
  try {
    const sourceRoot = realPublicDirectory(options.sourceRoot);
    const targetRoot = resolve(options.targetRoot ?? join(dirname(sourceRoot), 'OptiEVE'));
    if (overlaps(sourceRoot, targetRoot)) throw Error('Private sync target must be separate from development');
    const entries = requirePublicSource(sourceRoot), originalSnapshot = snapshot(entries);
    const originalEntry = entries.find(entry => entry.name === catalogName);
    if (!originalEntry) throw Error('Canonical manufacturing catalog is missing');
    const original = parseCatalog(originalEntry.bytes);
    let archive;
    if (options.archive) {
      archive = resolve(options.archive);
      realPublicDirectory(dirname(archive));
      if (contained(sourceRoot, archive) || contained(targetRoot, archive)) throw Error('SDE archives must remain outside development and the private runtime');
      regularFile(archive, 160 * 1024 * 1024);
    }
    const compiler = operations.compiler ?? readValidationCompiler(options.validationDir, sourceRoot, targetRoot, entries);
    temporaryRoot = realPublicDirectory(tmpdir());
    if (contained(sourceRoot, temporaryRoot) || contained(targetRoot, temporaryRoot)) throw Error('Temporary validation storage must be separate from source and private runtime');
    temporary = mkdtempSync(join(temporaryRoot, prefix));
    const stage = join(temporary, 'source');
    mkdirSync(stage);
    for (const entry of entries) {
      const destination = join(stage, entry.name);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, entry.bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    }
    const stagedCatalog = join(stage, catalogName);
    phase = 'official SDE staging';
    if (operations.stage) await operations.stage({ stage, stagedCatalog, archive });
    else await runNode(['scripts/update-manufacturing-catalog.mjs', ...(archive ? ['--archive', archive] : ['--download']), '--output', stagedCatalog], stage, 'Official SDE staging');
    const candidateBytes = regularFile(stagedCatalog, catalogLimit), candidate = parseCatalog(candidateBytes);
    // Refresh is deliberately forward-only. Use a separately reviewed code change for a rollback.
    if (candidate.provenance.buildNumber < original.provenance.buildNumber || Date.parse(candidate.provenance.releaseDate) < Date.parse(original.provenance.releaseDate)) throw Error('Catalog refresh refuses an older official release');
    const diff = diffCatalogs(original, candidate);
    report(formatCatalogDiff(diff));
    report(`Candidate SHA-256: ${sha256(candidateBytes)}. Archive SHA-256: ${candidate.provenance.archiveSha256}.`);
    if (archive) report('Offline archive supplied by the operator; provenance records its content hash, not an independent authenticity signature.');
    phase = 'staged public-source validation';
    requirePublicSource(stage);
    phase = 'catalog regression validation';
    if (operations.validate) await operations.validate({ stage, diff });
    else {
      const dependency = join(stage, 'node_modules/typescript');
      mkdirSync(join(dependency, 'lib'), { recursive: true });
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'typescript', version: compilerPin.version, main: 'lib/typescript.js', type: 'commonjs' }), { flag: 'wx' });
      writeFileSync(join(dependency, 'lib/typescript.js'), compiler, { flag: 'wx' });
      await runNode(['--test', ...catalogValidationTests], stage, 'Catalog regression validation');
    }
    // Test execution must not rewrite the reviewed catalog or any staged source.
    phase = 'precommit source validation';
    const expectedEntries = entries.map(entry => entry.name === catalogName ? { ...entry, bytes: candidateBytes } : entry);
    if (snapshot(requirePublicSource(stage)) !== snapshot(expectedEntries)) throw Error('Staged source changed during catalog validation');
    if (snapshot(requirePublicSource(sourceRoot)) !== originalSnapshot) throw Error('Development source changed during catalog validation; review and rerun');
    report('PASS: isolated catalog regression tests and staged/public development source checks.');
    if (!options.apply) {
      report('CHECK ONLY: development catalog and private source were not changed.');
      return { diff, developmentUpdated: false, applied: false, privateInSync: null };
    }
    phase = 'catalog commit';
    if (diff.classification !== 'unchanged') {
      writeAtomicCatalog(sourceRoot, candidateBytes);
      developmentUpdated = true;
    }
    phase = 'postcommit public-source validation';
    requirePublicSource(sourceRoot);
    phase = 'private source synchronization';
    const synchronize = operations.synchronize ?? syncPrivateSource;
    synchronize(sourceRoot, targetRoot);
    phase = 'private source parity check';
    const result = synchronize(sourceRoot, targetRoot, { checkOnly: true });
    if (!result.inSync) throw Error('Private source parity is pending');
    report(`PASS: ${developmentUpdated ? 'reviewed catalog applied' : 'catalog already current'}; validated source synchronized and parity verified. Runtime rebuild/redeployment is a separate explicit action.`);
    return { diff, developmentUpdated, applied: true, privateInSync: true };
  } catch (error) {
    // Fixed phase labels avoid including private target paths or arbitrary subprocess output.
    if (operations.onFailure) operations.onFailure(error);
    throw new CatalogRefreshError(phase, developmentUpdated, error.publicCatalogMessage === true ? error.message : '');
  } finally {
    if (temporary) cleanupTemporary(temporary, temporaryRoot);
  }
}

export function parseRefreshArguments(args) {
  const options = { apply: false }, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--check', '--apply', '--validation-dir', '--archive', '--target'].includes(flag) || seen.has(flag)) throw Error('Unsupported or repeated catalog refresh option');
    seen.add(flag);
    if (flag === '--check' || flag === '--apply') options.apply = flag === '--apply';
    else {
      const value = args[++index];
      if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) throw Error('Catalog refresh option requires a path');
      options[flag === '--validation-dir' ? 'validationDir' : flag === '--archive' ? 'archive' : 'targetRoot'] = resolve(value);
    }
  }
  if (seen.has('--check') && seen.has('--apply') || !options.validationDir) throw Error('Choose --check or --apply and supply --validation-dir');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseRefreshArguments(process.argv.slice(2));
    await refreshCatalog({ ...options, sourceRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..') });
  } catch (error) {
    console.error(error instanceof CatalogRefreshError ? error.message : 'Usage: node scripts/refresh-manufacturing-catalog.mjs [--check | --apply] --validation-dir <external installed source copy> [--archive <official JSONL ZIP>] [--target <private directory>]');
    process.exitCode = 1;
  }
}
