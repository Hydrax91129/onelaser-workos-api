import { supportOptionsFromEnv } from './support.js';
import { caldockOptionsFromEnv } from './caldock.js';
import { dealerOptionsFromEnv } from './dealer.js';
import { publicWikiOptionsFromEnv } from './public-wiki.js';
import { shopifyOptionsFromEnv } from './shopify.js';
import { buildApp } from './app.js';
import { createDatabase, schema, seedDemo } from './db.js';
import { integrationOptionsFromEnv } from './integrations/routes.js';

const production=process.env.NODE_ENV==='production';
try {
  if(production&&process.env.ALLOW_DEV_LOGIN==='true') throw new Error('Development login cannot run in production');
  if(production&&process.env.SEED_DEMO==='true') throw new Error('Demo seeding cannot run in production');
  if(production&&!process.env.DATABASE_URL) throw new Error('A PostgreSQL DATABASE_URL is required in production');
  const db=await createDatabase({connectionString:process.env.DATABASE_URL||undefined,dataDir:process.env.PGLITE_DATA_DIR||'.runtime/pglite'});
  await db.exec(schema);
  if(process.env.SEED_DEMO==='true'&&!production) await seedDemo(db);
  const app=await buildApp({db,environment:process.env.NODE_ENV,allowDevLogin:process.env.ALLOW_DEV_LOGIN==='true',devLoginSecret:process.env.DEV_LOGIN_SECRET,support:supportOptionsFromEnv(process.env),publicWiki:publicWikiOptionsFromEnv(process.env),shopify:shopifyOptionsFromEnv(process.env),integrations:integrationOptionsFromEnv(process.env),caldock:caldockOptionsFromEnv(process.env),dealer:dealerOptionsFromEnv(process.env),studio:{connectionString:process.env.DATABASE_URL,ownerUserIds:(process.env.CALDOCK_STUDIO_OWNER_USER_IDS||'').split(',').filter(Boolean)}});
  const port=Number(process.env.PORT||3001);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid port');
  await app.listen({host:process.env.HOST||'127.0.0.1',port});
  console.log('OneLaser API started. Integration availability is reported by /capabilities.');
  const close=async()=>{await app.close();process.exit(0);};process.once('SIGINT',close);process.once('SIGTERM',close);
} catch {
  console.error('API startup failed. Check database, environment configuration and development-only flags.');
  process.exitCode=1;
}
