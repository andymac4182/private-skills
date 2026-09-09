import { randomBytes } from 'node:crypto';
import { open, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd();
const unscanned = process.argv.includes('--allow-unscanned');
const token = () => randomBytes(32).toString('base64url');
const configuration = {
  PSKILLS_ENVIRONMENT: 'development',
  PSKILLS_PUBLIC_ORIGIN: 'http://localhost:5173',
  PSKILLS_ORGANIZATION_ID: 'default',
  PSKILLS_BOOTSTRAP_ROLES: 'owner',
  PSKILLS_BOOTSTRAP_TOKEN: token(),
  PSKILLS_WORKER_TOKEN: token(),
  PSKILLS_SESSION_SECRET: token(),
  PSKILLS_ALLOW_UNSCANNED: String(unscanned),
  PSKILLS_STATE_PROVIDER: 'file',
  PSKILLS_STATE_PATH: resolve(root, 'work/data/state'),
  PSKILLS_STORAGE_PROVIDER: 'filesystem',
  PSKILLS_STORAGE_ROOT: resolve(root, 'work/data/blobs'),
  PSKILLS_API_URL: 'http://localhost:5173',
};
try {
  const handle = await open(resolve(root, '.env'), 'wx', 0o600);
  try { await handle.writeFile(Object.entries(configuration).map(([key,value]) => `${key}=${value}`).join('\n')+'\n'); }
  finally { await handle.close(); }
  await mkdir(resolve(root, 'work/data'), { recursive: true, mode: 0o700 });
  console.log('Created private local .env. Use its PSKILLS_BOOTSTRAP_TOKEN to sign in.');
  console.log(unscanned ? 'Development unscanned distribution is explicitly enabled.' : 'Unscanned distribution is blocked; configure scanner policy and workers before installing skills.');
} catch(error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') console.log('.env already exists; no settings were changed.');
  else throw error;
}
