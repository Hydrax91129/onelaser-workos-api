/* Pricing worksheet of the 产品资料 page (KC's spec, groups 4 定价（零售） and 5 定价（批发）).
 *
 *   delivered cost      = landed + last mile
 *   selling-cost rate   = sum of the line items (or a manual override), DTC and wholesale separately
 *   contribution (CM)   = price × (1 − rate) − cost
 *   price for a target  = cost ÷ (1 − rate − target CM), shown at the nearest x99 (6,036 → 5,999)
 *   retail tiers        target CM per tier; MSRP / MAP / promotion floor with CM and floor warnings
 *   wholesale tiers     MSRP × (1 − discount), floored to whole dollars, or a per-SKU manual override; the last tier is the floor
 *                       (approval needed). CM with dealer paying freight uses landed cost, with us paying uses delivered cost.
 *   NPCR ladder         for each target CM: retail, wholesale (both freight options) and Amazon/eBay (DTC rate + extra) prices
 *
 * The settings (价格参数) live in pricing_rules.rules.worksheet and are entered by an executive in the app.
 * This repository ships them EMPTY: no real rates, tiers or targets belong in code, seeds or tests. */
import { z } from 'zod';

const pct = z.number().min(0).max(100);
const name = z.string().trim().max(60);
export const worksheetSchema = z.object({
  dtcItems: z.array(z.object({ name: name.min(1), pct }).strict()).max(20),
  whItems: z.array(z.object({ name: name.min(1), pct }).strict()).max(20),
  mktExtra: pct.nullable(),
  dtcRateOverride: pct.nullable(), whRateOverride: pct.nullable(),
  retailTiers: z.array(z.object({ name: name.min(1), cm: z.number().min(0).max(99), use: z.string().trim().max(80) }).strict()).max(10),
  whTiers: z.array(z.object({ name: name.min(1), discount: pct }).strict()).max(6),
  npcr: z.array(z.number().gt(0).lt(100)).max(12),
  dtcTarget: z.string().trim().max(20), dtcFloor: pct.nullable(),
  whTarget: z.string().trim().max(20), whFloor: pct.nullable(),
}).strict();
export type Worksheet = z.infer<typeof worksheetSchema>;
export const EMPTY_WORKSHEET: Worksheet = {
  dtcItems: [], whItems: [], mktExtra: null, dtcRateOverride: null, whRateOverride: null,
  retailTiers: [], whTiers: [], npcr: [], dtcTarget: '', dtcFloor: null, whTarget: '', whFloor: null,
};
export const MAX_WH_TIERS = 6;
export const worksheetOf = (rules: any): Worksheet => {
  const p = worksheetSchema.safeParse(rules?.worksheet);
  return p.success ? p.data : EMPTY_WORKSHEET;
};
export const configured = (w: Worksheet) => w.dtcItems.length > 0 || w.dtcRateOverride != null;

const sum = (a: { pct: number }[]) => a.reduce((s, x) => s + (Number(x.pct) || 0), 0);
export const dtcRate = (w: Worksheet) => (w.dtcRateOverride ?? sum(w.dtcItems)) / 100;
export const whRate = (w: Worksheet) => (w.whRateOverride ?? sum(w.whItems)) / 100;
export const r99 = (x: number | null) => x == null || !isFinite(x) || x <= 0 ? null : Math.max(99, Math.round(x / 100) * 100 - 1);
const cmAt = (p: number | null, cost: number | null, rate: number) => p == null || cost == null ? null : p * (1 - rate) - cost;
const priceFor = (cost: number | null, rate: number, c: number) => { const d = 1 - rate - c; return cost == null || d <= 0 ? null : cost / d; };
const ratio = (a: number | null, b: number | null) => a == null || !b ? null : a / b;
const cents = (x: number | null) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const share = (x: number | null) => x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000;

export type PriceInputs = { landed?: number | null; lastMile?: number | null; msrp?: number | null; map?: number | null; promoFloor?: number | null;
  whOv?: (number | null | undefined)[]; whFreight?: string | null };

/** The whole worksheet for one product. Shares (cmPct, off…) are fractions, money is rounded to cents. */
export function calc(w: Worksheet, p: PriceInputs) {
  const landed = p.landed ?? null, lm = p.lastMile ?? 0, delivered = landed == null ? null : landed + lm;
  const dr = dtcRate(w), wr = whRate(w), msrp = p.msrp ?? null;
  const retail = w.retailTiers.map(t => {
    const f = priceFor(delivered, dr, t.cm / 100), l = r99(f), cm = cmAt(l, delivered, dr);
    return { name: t.name, cm: t.cm, use: t.use, theoretical: cents(f), list: l, offMsrp: share(msrp && l ? 1 - l / msrp : null), contribution: cents(cm), cmPct: share(ratio(cm, l)) };
  });
  const fixed = (['msrp', 'map', 'promoFloor'] as const).map(k => {
    const price = p[k] ?? null, cm = cmAt(price, delivered, dr), cmPct = ratio(cm, price);
    return { key: k, price, contribution: cents(cm), cmPct: share(cmPct), belowFloor: cmPct != null && w.dtcFloor != null && cmPct < w.dtcFloor / 100 };
  });
  const npcr = w.npcr.map(c => {
    const f = priceFor(delivered, dr, c / 100), l = r99(f);
    return { cm: c, retailTheoretical: cents(f), retailList: l, sellingCost: cents(l ? l * dr : null), gross: cents(l != null && delivered != null ? l - delivered : null),
      contribution: cents(cmAt(l, delivered, dr)), wholesaleDealerFreight: cents(priceFor(landed, wr, c / 100)), wholesaleOurFreight: cents(priceFor(delivered, wr, c / 100)),
      marketplace: cents(priceFor(delivered, dr + (w.mktExtra ?? 0) / 100, c / 100)) };
  });
  const freight = p.whFreight === 'us' ? 'us' : 'dealer';
  const wholesale = w.whTiers.map((t, i) => {
    const ov = p.whOv?.[i] ?? null, price = ov != null ? ov : (msrp ? Math.floor(msrp * (1 - t.discount / 100)) : null);
    const cD = cmAt(price, landed, wr), cU = cmAt(price, delivered, wr), main = freight === 'dealer' ? ratio(cD, price) : ratio(cU, price);
    return { name: t.name, discount: t.discount, effectiveDiscount: share(msrp && price != null ? 1 - price / msrp : null), price, override: ov != null, floorTier: i === w.whTiers.length - 1,
      dealerMargin: cents(msrp && price != null ? msrp - price : null), dealerMarginPct: share(msrp && price != null ? (msrp - price) / msrp : null),
      cmDealerFreight: cents(cD), cmDealerFreightPct: share(ratio(cD, price)), cmOurFreight: cents(cU), cmOurFreightPct: share(ratio(cU, price)),
      belowFloor: main != null && w.whFloor != null && main < w.whFloor / 100 };
  });
  return { configured: configured(w), landed, lastMile: p.lastMile ?? null, delivered: cents(delivered), dtcRate: share(dr), whRate: share(wr), freight, retail, fixed, npcr, wholesale };
}

/** What someone without cost access may see: the selling prices (MAP defaults to MSRP) and the public wholesale tiers. */
export function publicPrices(w: Worksheet, p: PriceInputs) {
  const c = calc(w, { msrp: p.msrp, whOv: p.whOv });
  return { msrp: p.msrp ?? null, map: p.map ?? p.msrp ?? null, promoFloor: p.promoFloor ?? null,
    wholesale: c.wholesale.filter(t => !t.floorTier).map(t => ({ name: t.name, discount: t.effectiveDiscount ?? t.discount / 100, price: t.price })) };
}

/** Contribution margin of MSRP and whether the product sits below the DTC or wholesale floor (used by the import analysis). */
export function marginSummary(w: Worksheet, p: PriceInputs) {
  const c = calc(w, p), m = c.fixed[0];
  return { msrpCmPct: m.cmPct, belowDtcFloor: m.belowFloor, belowWholesaleFloor: c.wholesale.some(t => !t.floorTier && t.belowFloor) };
}
