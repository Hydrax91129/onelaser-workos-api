/* Weight rules for simple OKRs.
 * - One person's objectives in one monthly cycle add up to 100 points.
 * - The key results under one objective add up to exactly 100%.
 * A change that would push either total above 100 is refused. Totals below 100
 * are allowed while an OKR is still being written, but key results can only be
 * scored once their weights add up to exactly 100%. Totals that were already
 * above 100 (older data) may still be lowered. */
import type { Queryable } from './db.js';
import { deny } from './errors.js';

const EPS = 0.001;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Sum of the other key results' weights under an objective. */
async function otherKrWeights(db: Queryable, objectiveId: string, excludeKrId?: string) {
  const rows = (await db.query('SELECT id,planning FROM key_results WHERE objective_id=$1 AND archived_at IS NULL', [objectiveId])).rows;
  return rows.filter((r: any) => r.id !== excludeKrId).reduce((s: number, r: any) => s + num(r.planning?.weight), 0);
}

export async function assertKrWeight(db: Queryable, objectiveId: string, weight: number | undefined, current?: { id: string; weight?: unknown }) {
  if (weight === undefined) return;
  const others = await otherKrWeights(db, objectiveId, current?.id);
  const lowering = current && weight <= num(current.weight);
  if (others + weight > 100 + EPS && !lowering)
    deny(400, 'KR_WEIGHT_OVER_100', `KR weights under one objective must add up to exactly 100%. ${fmt(Math.min(others, 100))}% is already used, so at most ${fmt(Math.max(0, 100 - others))}% is left.`,
      `同一个目标下所有 KR 的权重合计必须正好是 100%。其他 KR 已用 ${fmt(Math.min(others, 100))}%，这条最多只能填 ${fmt(Math.max(0, 100 - others))}%。`);
}

/** Points of the other objectives of the same owner (or the company) in the same cycle. */
async function otherObjectivePoints(db: Queryable, o: { id?: string; org_id: string; owner_id: string | null; level: string; period: string }) {
  const rows = (await db.query(`SELECT id,planning FROM objectives WHERE org_id=$1 AND archived_at IS NULL AND COALESCE(planning->>'period','')=$2
    AND ${o.level === 'company' ? "level='company'" : "level<>'company' AND owner_id IS NOT DISTINCT FROM $3"}`, o.level === 'company' ? [o.org_id, o.period] : [o.org_id, o.period, o.owner_id])).rows;
  return rows.filter((r: any) => r.id !== o.id).reduce((s: number, r: any) => s + num(r.planning?.weight), 0);
}

export async function assertObjectivePoints(db: Queryable, o: { id?: string; org_id: string; owner_id: string | null; level: string; period?: string }, weight: number | undefined, currentWeight?: unknown) {
  if (weight === undefined || !o.period) return;
  const others = await otherObjectivePoints(db, { ...o, period: o.period });
  const lowering = o.id !== undefined && weight <= num(currentWeight);
  if (others + weight > 100 + EPS && !lowering)
    deny(400, 'OBJECTIVE_POINTS_OVER_100', `Objectives in one cycle must add up to exactly 100 points. ${fmt(Math.min(others, 100))} points are already used, so at most ${fmt(Math.max(0, 100 - others))} are left.`,
      `本周期所有目标的分值合计必须正好是 100 分。其他目标已用 ${fmt(Math.min(others, 100))} 分，这个目标最多只能填 ${fmt(Math.max(0, 100 - others))} 分。`);
}

/** Key results can be scored only when every KR under the objective has a weight and they add up to exactly 100%. */
export async function assertKrWeightsComplete(db: Queryable, objectiveId: string) {
  const rows = (await db.query('SELECT planning FROM key_results WHERE objective_id=$1 AND archived_at IS NULL', [objectiveId])).rows;
  const missing = rows.filter((r: any) => !num(r.planning?.weight)).length, total = rows.reduce((s: number, r: any) => s + num(r.planning?.weight), 0);
  if (missing || Math.abs(total - 100) > EPS)
    deny(409, 'KR_WEIGHTS_INCOMPLETE', `Set every KR weight so they add up to exactly 100% before scoring (now ${fmt(total)}%${missing ? `, ${missing} without a weight` : ''}).`,
      `评分前，请先把这个目标下每条 KR 的权重填好，合计正好 100%（现在是 ${fmt(total)}%${missing ? `，有 ${missing} 条没填权重` : ''}）。`);
}
