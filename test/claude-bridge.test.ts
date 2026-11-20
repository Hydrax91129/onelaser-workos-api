import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChatFetcher } from '../src/completions.js';
import { publicWikiOptionsFromEnv } from '../src/public-wiki.js';

// Owner, 2026-11-20: everything but AI超算 runs on Claude Haiku. The Wiki assistant and the evidence reviewer were written
// against an OpenAI-style chat endpoint; the bridge answers them with Claude in the same shape.
test('the chat bridge sends system + user to Claude and answers in the chat-completions shape', async () => {
  const seen: any[] = [];
  const client = { messages: { create: async (b: any) => { seen.push(b); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure: {"claims":[]} done' }] }; } } } as any;
  const f = claudeChatFetcher({ model: 'claude-haiku-5-5' }, client);
  const res = await f('https://api.x.ai/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'x', max_tokens: 1200, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: 'You are a doc assistant.' }, { role: 'user', content: '{"q":1}' }] }) });
  const j = await res.json();
  assert.deepEqual([j.choices[0].finish_reason, j.choices[0].message.content], ['stop', '{"claims":[]}'], 'JSON pulled out of the reply');
  assert.equal(seen[0].model, 'claude-haiku-5-5'); assert.match(seen[0].system, /doc assistant[\s\S]*JSON object only/);
  assert.deepEqual(seen[0].messages, [{ role: 'user', content: '{"q":1}' }]);
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  await f('x', { body: JSON.stringify({ response_format: { type: 'json_schema', json_schema: { schema } }, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.deepEqual(seen[1].output_config.format, { type: 'json_schema', schema });
});

test('Wiki assistant: Claude Haiku when ANTHROPIC_API_KEY is set; still off unless PUBLIC_WIKI_MODEL_ENABLED', () => {
  const on = publicWikiOptionsFromEnv({ PUBLIC_WIKI_MODEL_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'claude-haiku-5-5' } as any);
  assert.equal(on.model?.id, 'claude-haiku-5-5'); assert.equal(typeof on.fetcher, 'function');
  assert.equal(publicWikiOptionsFromEnv({ ANTHROPIC_API_KEY: 'test-key' } as any).model, undefined);
});
