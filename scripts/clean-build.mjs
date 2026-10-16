import { lstat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMPONENTS = new Set(['controller', 'gateway']);

export async function cleanBuild(component, tests = false) {
  if (!COMPONENTS.has(component)) throw new Error('Choose --component controller or gateway');
  const componentPath = join(ROOT, component);
  const outputPath = join(componentPath, tests ? 'dist-test' : 'dist');
  // Never follow a component/output link into a different checkout or runtime directory.
  for (const directory of [componentPath, outputPath]) {
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Build output must be a real directory: ${directory}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT' && directory === outputPath) return;
      throw error;
    }
  }
  if (dirname(outputPath) !== componentPath) throw new Error('Invalid build output path');
  await rm(outputPath, { recursive: true, force: false });
}

async function main() {
  const { values } = parseArgs({ options: {
    component: { type: 'string' }, tests: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/clean-build.mjs --component controller|gateway [--tests]\nRemoves only the selected generated dist (or dist-test) directory before compilation.');
    return;
  }
  await cleanBuild(values.component, values.tests);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
