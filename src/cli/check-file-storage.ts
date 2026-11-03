/* Checks object storage settings before FILE_STORAGE=s3 is switched on in production.
 *
 *   S3_ENDPOINT=... S3_BUCKET=... S3_REGION=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *     npx tsx src/cli/check-file-storage.ts            (or: node build/src/cli/check-file-storage.js in the image)
 *
 * It writes one small test object under _healthcheck/, reads it back, confirms that an unsigned request
 * cannot read it (the bucket must be private), and deletes it. Secrets are never printed. */
import { randomUUID } from 'node:crypto';
import { s3ConfigFromEnv, s3Store } from '../files.js';

async function main() {
  if (process.argv.includes('--help')) { console.log('Usage: S3_* settings in the environment, then run check-file-storage. See src/files.ts.'); return 0; }
  const config = s3ConfigFromEnv(process.env);
  if (!config) { console.error('No object storage settings found (S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).'); return 2; }
  const store = s3Store(config), key = `_healthcheck/${randomUUID()}`, body = Buffer.from(`onelaser file storage check ${new Date().toISOString()}`);
  console.log(`Bucket ${config.bucket} at ${config.endpoint} (${config.pathStyle ? 'path' : 'virtual-hosted'} style, region ${config.region}${config.prefix ? ', prefix ' + config.prefix : ''})`);
  const step = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ok   ${label}`); return true; }
    catch (e: any) { console.log(`  FAIL ${label}: ${e?.message || e}`); return false; }
  };
  let ok = await step('write a test object', () => store.put(key, body, 'text/plain'));
  if (ok) ok = await step('read it back', async () => { if (!(await store.get(key)).equals(body)) throw new Error('content differs'); });
  if (ok) ok = await step('bucket is private (unsigned read refused)', async () => {
    const res = await fetch(store.urlFor(key), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (res.ok) throw new Error(`anyone with the URL can read files (HTTP ${res.status}); set the bucket ACL to private`);
  });
  const cleaned = await step('delete the test object', () => store.delete(key));
  console.log(ok && cleaned ? 'All checks passed. FILE_STORAGE=s3 can be enabled.' : 'Checks failed. Keep FILE_STORAGE=db until this passes.');
  return ok && cleaned ? 0 : 1;
}
main().then(code => { process.exitCode = code; }, e => { console.error('Check failed: ' + (e?.message || e)); process.exitCode = 1; });
