import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';

// Distribution boundaries and high-confidence patterns; also run a secret scanner.
const localDirectories = new Set(['.git', 'node_modules', '.sites-runtime', '.wrangler', 'dist', '.next', '.vinext', 'out', 'outputs', 'coverage', '.agents', '.codex', 'work']);
const reservedDirectories = new Set([...localDirectories, '.eve-private']);
const privateArtifact = /(^|\/)(?:attachments|EVE_Connection_Codex_Export)(\/|$)|(^|\/)(?:CHAT_HISTORY|CODEX_HANDOFF|PROJECT_STATE)(?:[._-]|$)|\.(?:bundle|xlsx?|xlsm|ods|csv|tsv|sqlite3?|db|sqlite3?-(?:wal|shm)|db-(?:wal|shm)|pem|key|p12|pfx|kdbx|har|log|zip|7z|rar|tar|tgz|gz|bz2|xz|zst|bak|backup)$/i;
const localEnvironment = /(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/i;
const deploymentIdentifier = /\b(?:appgprj_|appgver_|appgdep_|plugin_asdk_app_sites_)[a-z0-9]{12,}\b/i;
const hostedUrl = /https?:\/\/([a-z0-9.-]+\.chatgpt\.site)\b/gi;
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/,
  /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/,
];
const personalPath = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/Users\/[^/\s"']+|\/home\/(?!oai(?:\/|$))[^/\s"']+\//;
const decoder = new TextDecoder('utf-8', { fatal: true });

function sourceRoot(path) {
  path = resolve(path);
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Source root and its parents must be real directories');
  }
  return realpathSync(path);
}

const sameDirectory = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

// Inspect every parent as well as the file. lstat catches even broken links.
export function inspectPath(root, name) {
  if (isAbsolute(name) || /[\\:\r\n\0]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('Invalid source-relative path');
  let absolute = resolve(root);
  const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    absolute = resolve(absolute, parts[index]);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Symbolic links and junctions are not permitted in a source export');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Source parent is not a directory');
    if (index === parts.length - 1) return stat;
  }
}

export function inspectContent(name, bytes) {
  const failures = [];
  // Runtime folders are never source, even when nested inside an authored tree.
  if (name.split('/').some(part => reservedDirectories.has(part.toLowerCase())) || /(?:^|\/)(?:next-env\.d\.ts|\.DS_Store|Thumbs\.db)$|\.tsbuildinfo$/i.test(name)) failures.push('generated or local-only artifact');
  if (privateArtifact.test(name) || (localEnvironment.test(name) && name !== '.env.example')) failures.push('private data, environment, key, or archive file');
  // This app's current distribution is text-only. Binary additions need review.
  let content;
  try {
    content = decoder.decode(bytes);
    if (content.includes('\0')) throw new Error('NUL byte');
  } catch {
    failures.push('binary content requires review before public distribution');
    return failures;
  }
  if (/^(?:PK\x03\x04|PK\x05\x06|SQLite format 3|Rar!)/.test(content) || content.slice(257, 262) === 'ustar') failures.push('embedded database or archive content');
  if (deploymentIdentifier.test(content)) failures.push('configured deployment identifier');
  for (const match of content.matchAll(hostedUrl)) {
    if (match[1].toLowerCase() !== 'example.chatgpt.site') failures.push('specific hosted deployment URL');
  }
  if (credentialPatterns.some(pattern => pattern.test(content))) failures.push('credential-like content');
  if (personalPath.test(content)) failures.push('personal machine path');
  if (name === '.env.example') {
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      const value = match && /^(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#'"\r\n]*))\s*(?:#.*)?$/.exec(match[2]);
      if (!match || !value) { failures.push('invalid environment example assignment'); continue; }
      const literal = value[1] ?? value[2] ?? value[3];
      if (match[1] === 'EVE_SITE_ORIGIN') {
        if (!/^https:\/\/(?:[a-z0-9-]+\.)*example(?::\d+)?\/?$/i.test(literal)) failures.push('environment example must use a reserved .example origin');
      } else if (match[1] !== 'EVE_TOKEN_KEY' || literal) {
        failures.push('environment example may only contain a reserved origin and an empty token key');
      }
    }
  }
  if (name === '.openai/hosting.json') {
    try {
      if (JSON.parse(content).project_id) failures.push('remove project_id from the public distribution');
    } catch { failures.push('invalid hosting JSON'); }
  }
  return [...new Set(failures)];
}

export function inspectPublicSource(root) {
  try { root = sourceRoot(root); }
  catch (error) { return { entries: [], failures: [error.code ? 'Source directory could not be inspected safely' : error.message] }; }
  try {
    lstatSync(resolve(root, '.eve-private'));
    return { entries: [], failures: ['Private runtime: public source checks and exports must run from development'] };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const candidates = new Map();
  const failures = [];
  const entries = [];
  // An inherited alternate index/worktree must not change which source is public.
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  const git = args => execFileSync('git', args, { cwd: root, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  let hasGitMetadata = false;
  try { lstatSync(resolve(root, '.git')); hasGitMetadata = true; }
  catch (error) { if (error.code !== 'ENOENT') return { entries: [], failures: ['Git metadata could not be inspected safely'] }; }
  let ownRepository = false;
  try { ownRepository = sameDirectory(realpathSync(resolve(git(['rev-parse', '--show-toplevel']).trim())), root); }
  catch { /* An extracted archive does not require Git. */ }
  if (hasGitMetadata && !ownRepository) return { entries: [], failures: ['Git metadata is present but this repository could not be identified safely'] };
  if (ownRepository) {
    for (const record of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const [, mode, , stage, name] = /^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record) ?? [];
      if (!name) throw new Error('Unable to parse Git index');
      if (stage !== '0' || !['100644', '100755'].includes(mode)) failures.push(`${name}: unresolved index entry, symbolic link, or submodule`);
      candidates.set(name, mode);
    }
    for (const name of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) candidates.set(name, '100644');
  } else {
    const walk = directory => {
      for (const name of readdirSync(directory)) {
        const absolute = resolve(directory, name);
        const rel = relative(root, absolute).replaceAll('\\', '/');
        const stat = lstatSync(absolute);
        if (stat.isDirectory()) {
          if (directory !== root || !localDirectories.has(name.toLowerCase())) walk(absolute);
        } else candidates.set(rel, stat.mode & 0o111 ? '100755' : '100644');
      }
    };
    walk(root);
  }
  for (const [name, mode] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const stat = inspectPath(root, name);
      if (!stat) continue; // Export these working-tree bytes, never an older HEAD.
      if (!stat.isFile()) throw new Error('Only regular source files are permitted');
      if (stat.nlink > 1) throw new Error('Hard-linked source files are not permitted');
      const bytes = readFileSync(resolve(root, name));
      failures.push(...inspectContent(name, bytes).map(reason => `${name}: ${reason}`));
      entries.push({ name, mode, bytes });
    } catch (error) {
      failures.push(`${name}: ${error.code ? 'unable to safely read source file' : error.message}`);
    }
  }
  if (!entries.some(entry => entry.name === '.openai/hosting.json')) failures.push('.openai/hosting.json: required source configuration is missing');
  return { entries, failures: [...new Set(failures)] };
}

export function requirePublicSource(root) {
  const result = inspectPublicSource(root);
  if (result.failures.length) throw new Error('Public-source check failed:\n' + result.failures.map(value => `- ${value}`).join('\n'));
  return result.entries;
}
