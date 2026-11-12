import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';

// Fictional accounts and passwords only.
test('a DingTalk account adds its own sign-in email and password, then signs in with them; emails stay unique; changing needs the current password', async () => {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0 });
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST', url: string, payload?: any) => { tokens[who] ??= (await issueSession(db, who)).accessToken; return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': 'zh-CN' } }); };
  const signIn = (email: string, password: string) => app.inject({ method: 'POST', url: '/auth/password', payload: { email, password } });
  try {
    await db.query(`UPDATE users SET login_email='', password_hash=NULL WHERE id IN ('m1','m2')`);
    assert.deepEqual((await call('m1', 'GET', '/me/login')).json(), { loginEmail: '', hasPassword: false }, 'signs in with DingTalk only');
    assert.equal((await call('m1', 'POST', '/me/login', { email: 'owner@example.com', newPassword: 'short' })).statusCode, 400, 'passwords have at least 10 characters');
    const set = await call('m1', 'POST', '/me/login', { email: ' Owner@Example.com ', newPassword: 'Example-Pass-2027' });
    assert.equal(set.statusCode, 200, set.body); assert.deepEqual(set.json(), { loginEmail: 'owner@example.com', hasPassword: true });
    assert.equal((await signIn('owner@example.com', 'Example-Pass-2027')).statusCode, 200, 'email + password now works');
    assert.equal((await signIn('owner@example.com', 'wrong-password-1')).statusCode, 401);
    // Someone else cannot take the same sign-in email
    const taken = await call('m2', 'POST', '/me/login', { email: 'owner@example.com', newPassword: 'Another-Pass-2027' });
    assert.equal(taken.statusCode, 409); assert.match(taken.json().error.message, /已经被别的账号/);
    // Changing it again needs the current password
    assert.equal((await call('m1', 'POST', '/me/login', { email: 'kc@example.com', newPassword: 'Newer-Pass-2028' })).statusCode, 401);
    assert.equal((await call('m1', 'POST', '/me/login', { email: 'kc@example.com', newPassword: 'Newer-Pass-2028', currentPassword: 'Example-Pass-2027' })).statusCode, 200);
    assert.equal((await signIn('owner@example.com', 'Example-Pass-2027')).statusCode, 401, 'the old email no longer signs in');
    assert.equal((await signIn('kc@example.com', 'Newer-Pass-2028')).statusCode, 200);
  } finally { await app.close(); }
});
