/* Automatic Chinese <-> English translation of what people write (OKR text first).
 * Translations are produced once per distinct text by the configured AI model and
 * cached in the database, so later views are instant and cost nothing. Without a
 * model the endpoint answers with no translations and the UI shows the original. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import type { User } from './auth.js';
import type { JsonModel } from './completions.js';
import { deny } from './errors.js';

export const translationSchema = `
CREATE TABLE IF NOT EXISTS text_translations(
  text_hash text NOT NULL, target text NOT NULL CHECK(target IN ('zh','en')), translated text NOT NULL,
  model text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(text_hash,target));
`;

const CJK = /[㐀-鿿豈-﫿]/g, LATIN = /[A-Za-z]/g;
/** Language a text is mainly written in, or null when it carries no words (numbers, codes). */
export function mainLanguage(text: string): 'zh' | 'en' | null {
  const cjk = (text.match(CJK) || []).length, latin = (text.match(LATIN) || []).length;
  if (!cjk && latin < 2) return null;
  // One Chinese character carries roughly as much meaning as a short English word.
  return cjk * 3 >= latin ? 'zh' : 'en';
}
const keyOf = (text: string) => createHash('sha256').update(text.normalize('NFC')).digest('hex');
const SCHEMA = { type: 'object', additionalProperties: false, required: ['translations'], properties: { translations: { type: 'array', items: { type: 'string' } } } };

export async function registerTranslateRoutes(app: FastifyInstance, db: Database, o: { model?: JsonModel | null }) {
  const rate = new Map<string, number[]>();
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const input = z.object({ target: z.enum(['zh', 'en']), texts: z.array(z.string().max(4000)).min(1).max(60) }).strict();

  app.post('/translate', async req => {
    const user = actorOf(req), v = input.parse(req.body);
    const texts = v.texts.map(t => t.trim());
    const items = texts.map(text => ({ text, sourceLang: mainLanguage(text), translated: null as string | null }));
    const need = items.filter(i => i.text && i.sourceLang && i.sourceLang !== v.target);
    if (!need.length) return { target: v.target, available: !!o.model, items };
    const hashes = [...new Set(need.map(i => keyOf(i.text)))];
    const cached = new Map<string, string>((await db.query('SELECT text_hash,translated FROM text_translations WHERE target=$1 AND text_hash=ANY($2::text[])', [v.target, hashes])).rows.map((r: any) => [r.text_hash, r.translated]));
    const missing = [...new Map(need.filter(i => !cached.has(keyOf(i.text))).map(i => [keyOf(i.text), i.text])).entries()];
    if (missing.length && o.model) {
      const recent = (rate.get(user.id) || []).filter(t => Date.now() - t < 3600_000);
      if (recent.length < 120) {
        rate.set(user.id, [...recent, Date.now()]);
        for (let start = 0; start < missing.length; start += 20) {
          const batch = missing.slice(start, start + 20);
          const lang = v.target === 'zh' ? 'Simplified Chinese' : 'English';
          try {
            const out = await o.model.json(
              `You translate workplace goals, key results and progress notes for OneLaser, a laser engraving and cutting machine company, into ${lang}. Translate each input string faithfully and concisely, keeping numbers, units, product names (Hydra, Cobra, XRF, VertiGo, Galvo Flex, LightBurn), people's names, SKUs and URLs unchanged. Use natural business wording. Return exactly one translation per input, in the same order. Never add commentary.`,
              JSON.stringify(batch.map(([, text]) => text)), SCHEMA, 'translations', Math.min(8000, 200 + batch.reduce((n, [, t]) => n + t.length * 3, 0)));
            const list = Array.isArray(out?.translations) ? out.translations : [];
            if (list.length !== batch.length) continue;
            for (let i = 0; i < batch.length; i++) {
              const t = typeof list[i] === 'string' ? list[i].trim().slice(0, 8000) : '';
              if (!t) continue;
              cached.set(batch[i][0], t);
              await db.query('INSERT INTO text_translations(text_hash,target,translated,model) VALUES($1,$2,$3,$4) ON CONFLICT(text_hash,target) DO NOTHING', [batch[i][0], v.target, t, o.model.model]);
            }
          } catch { /* the UI keeps the original text */ }
        }
      }
    }
    for (const i of need) i.translated = cached.get(keyOf(i.text)) ?? null;
    return { target: v.target, available: !!o.model, items };
  });
}
