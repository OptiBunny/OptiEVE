import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePublicSource } from './public-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const entries = requirePublicSource(root);
  console.log(`PASS: ${entries.length} source files checked for private artifacts, credentials, machine paths and deployment bindings.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
