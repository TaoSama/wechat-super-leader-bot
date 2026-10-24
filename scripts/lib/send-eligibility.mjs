import { createRequire } from 'node:module';

const controllerRequire = createRequire(new URL('../../controller/package.json', import.meta.url));
let contract;

/** Load the Controller's current contract only for diagnostics that need it. */
export async function loadSendEligibility() {
  if (!contract) {
    let tsImport;
    try {
      ({ tsImport } = controllerRequire('tsx/esm/api'));
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      throw new Error('Send diagnostics require Controller dependencies; run pnpm --dir controller install --frozen-lockfile', { cause: error });
    }
    contract = tsImport('../../controller/src/sessions/send-eligibility.ts', import.meta.url);
  }
  return contract;
}
