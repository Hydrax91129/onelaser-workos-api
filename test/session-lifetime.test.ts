import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { issueSession, resolveSession, cookie, hash, SESSION_IDLE_HOURS, SESSION_MAX_DAYS } from '../src/auth.js';

// Owner, 2026-11-14: people were signed out a fixed hour after signing in, even while working.
// A session now stays alive while used (24 hours idle), up to 7 days after sign-in. Fictional users only.
test('sessions slide while used: 24 hours idle, at most 7 days after sign-in; the cookie covers the longest session', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const s = await issueSession(db, 'm1'), h = hash(s.accessToken), hours = (iso: any) => (new Date(iso).getTime() - Date.now()) / 3600_000;
  assert.ok(Math.abs(hours(s.expiresAt) - SESSION_IDLE_HOURS) < 0.1, 'a new session lasts 24 idle hours');
  const end = async () => hours((await db.query('SELECT expires_at FROM sessions WHERE token_hash=$1', [h])).rows[0].expires_at);
  // Close to the end: using it pushes the end out again.
  await db.query("UPDATE sessions SET expires_at=now()+interval '20 minutes' WHERE token_hash=$1", [h]);
  assert.equal((await resolveSession(db, 'Bearer ' + s.accessToken))?.id, 'm1');
  assert.ok(Math.abs(await end() - SESSION_IDLE_HOURS) < 0.1, 'used → 24 hours from now');
  // Near the absolute limit the end stops at sign-in + 7 days.
  await db.query(`UPDATE sessions SET created_at=now()-interval '${SESSION_MAX_DAYS} days'+interval '2 hours', expires_at=now()+interval '10 minutes' WHERE token_hash=$1`, [h]);
  await resolveSession(db, 'Bearer ' + s.accessToken);
  assert.ok(Math.abs(await end() - 2) < 0.1, 'capped at 7 days after sign-in');
  // Past the end it is gone; a disabled account is refused at once.
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1", [h]);
  assert.equal(await resolveSession(db, 'Bearer ' + s.accessToken), null);
  const s2 = await issueSession(db, 'm2'); await db.query("UPDATE users SET active=false WHERE id='m2'");
  assert.equal(await resolveSession(db, 'Bearer ' + s2.accessToken), null, 'disabled accounts are signed out');
  assert.match(cookie('workos_session', 'x', true), /Max-Age=604800; Secure$/);
  assert.match(cookie('workos_session', '', true, 0), /Max-Age=0/);
  const user: any = await resolveSession(db, 'Bearer ' + (await issueSession(db, 'm1')).accessToken);
  assert.equal('s_expires' in user || 's_created' in user, false, 'session columns are not part of the user');
  await db.close?.();
});
