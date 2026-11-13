/* Pricing worksheet of the product library (产品资料库 · 定价（零售）/ 定价（批发）) and its 价格参数 settings.
 *
 * Formulas, exactly as the owner's spec writes them:
 *   delivered cost        = landed cost + last-mile freight
 *   retail cost           = delivered cost − retail shipping charge (what the customer pays for shipping; blank = free)
 *   selling-cost rate     = sum of the line items (DTC or wholesale), unless a manual rate overrides it
 *   suggested price       = cost ÷ (1 − selling-cost rate − target contribution margin)
 *   list price            = the nearest x99 (round to the nearest hundred, minus 1; never below 99)
 *   contribution margin   = price × (1 − selling-cost rate) − cost
 *   wholesale price       = floor(MSRP × (1 − tier discount)), unless the tier is overridden for this SKU
 *   wholesale cost        = landed cost when the dealer pays freight, delivered cost when we do
 *   Amazon / eBay price   = delivered ÷ (1 − DTC rate − marketplace extra − target CM)
 *
 * The settings are stored in pricing_rules.worksheet and ship EMPTY: the repository never holds the company's
 * real rates, tiers or targets (CLAUDE.md). An admin enters them once on 价格参数 (or imports them). */
import { z } from 'zod';

const pct = z.number().min(0).max(100);
const name = z.string().trim().min(1).max(60);
export const worksheetSchema = z.object({
  dtcItems: z.array(z.object({ name, pct }).strict()).max(20),
  whItems: z.array(z.object({ name, pct }).strict()).max(20),
  mktExtra: pct.nullable(),
  retailTiers: z.array(z.object({ name, cm: pct, use: z.string().trim().max(80).default('') }).strict()).max(12),
  /** floor: the lowest tier that needs the owner's approval; shown only to people with cost access. */
  whTiers: z.array(z.object({ name, discount: pct, floor: z.boolean().default(false) }).strict()).max(8),
  npcr: z.array(z.number().gt(0).lt(100)).max(16),
  dtcTarget: z.string().trim().max(20).default(''), dtcFloor: pct.nullable(),
  whTarget: z.string().trim().max(20).default(''), whFloor: pct.nullable(),
  dtcRateOverride: pct.nullable().default(null), whRateOverride: pct.nullable().default(null),
}).strict();
export type Worksheet = z.infer<typeof worksheetSchema>;
export const EMPTY_WORKSHEET: Worksheet = {
  dtcItems: [], whItems: [], mktExtra: null, retailTiers: [], whTiers: [], npcr: [], dtcTarget: '', dtcFloor: null, whTarget: '', whFloor: null,
  dtcRateOverride: null, whRateOverride: null,
};
export const normalizeWorksheet = (w: any): Worksheet => {
  const r = worksheetSchema.safeParse({ ...EMPTY_WORKSHEET, ...(w || {}) });
  return r.success ? r.data : EMPTY_WORKSHEET;
};
const sum = (a: { pct: number }[]) => a.reduce((s, x) => s + (Number(x.pct) || 0), 0);
/** Selling-cost rates as fractions; null until the settings have line items or a manual rate. */
export const dtcRate = (w: Worksheet) => w.dtcRateOverride != null ? w.dtcRateOverride / 100 : w.dtcItems.length ? sum(w.dtcItems) / 100 : null;
/** A SKU's own rate (percent, from the product library) when set, else the company rate. */
export const skuRate = (own: any, company: number | null) => { const x = own == null || own === '' ? NaN : Number(own); return isFinite(x) && x >= 0 && x < 100 ? x / 100 : company; };
export const whRate = (w: Worksheet) => w.whRateOverride != null ? w.whRateOverride / 100 : w.whItems.length ? sum(w.whItems) / 100 : null;
export const r99 = (x: number | null) => x == null || !isFinite(x) || x <= 0 ? null : Math.max(99, Math.round(x / 100) * 100 - 1);
const cmAt = (p: number | null, cost: number | null, rate: number | null) => p == null || cost == null || rate == null ? null : p * (1 - rate) - cost;
const priceFor = (cost: number | null, rate: number | null, cm: number) => { if (cost == null || rate == null) return null; const d = 1 - rate - cm; return d <= 0 ? null : cost / d; };
const ratio = (a: number | null, b: number | null) => a == null || b == null || !b ? null : a / b;
const n = (v: any) => v == null || v === '' || !isFinite(Number(v)) ? null : Number(v);
export type PriceInputs = { landed?: any; lastMile?: any; retailShip?: any; msrp?: any; map?: any; promoFloor?: any; whFreight?: any; [whOv: string]: any };
/** 'bad' below zero, 'low' below the floor, 'good' otherwise; null when unknown. */
export const tone = (cmp: number | null, floorPct: number | null) => cmp == null ? null : cmp < 0 ? 'bad' : floorPct != null && cmp < floorPct / 100 ? 'low' : 'good';

export function worksheet(p: PriceInputs, w: Worksheet) {
  const landed = n(p.landed), lastMile = n(p.lastMile) ?? 0, delivered = landed == null ? null : landed + lastMile;
  // Retail margins use the cost after what the customer pays for shipping (never below zero).
  const retailShip = n(p.retailShip) ?? 0, retailCost = delivered == null ? null : Math.max(0, delivered - retailShip);
  const dr = skuRate(p.dtcRate, dtcRate(w)), wr = skuRate(p.whRate, whRate(w)), msrp = n(p.msrp);
  const retail = w.retailTiers.map(t => {
    const theory = priceFor(retailCost, dr, t.cm / 100), list = r99(theory), cm = cmAt(list, retailCost, dr);
    return { name: t.name, cmTarget: t.cm, use: t.use, theory, list, offMsrp: msrp && list ? 1 - list / msrp : null, cm, cmPct: ratio(cm, list) };
  });
  const fixed = (['msrp', 'map', 'promoFloor'] as const).map(k => {
    const price = k === 'map' ? n(p.map) ?? msrp : n(p[k]), cm = cmAt(price, retailCost, dr), cmPct = ratio(cm, price);
    return { key: k, price, cm, cmPct, belowFloor: cmPct != null && w.dtcFloor != null && cmPct < w.dtcFloor / 100 };
  });
  const npcr = w.npcr.map(c => {
    const theory = priceFor(retailCost, dr, c / 100), list = r99(theory);
    return { cm: c, theory, list, sellingCost: list != null && dr != null ? list * dr : null, gross: list != null && retailCost != null ? list - retailCost : null,
      contribution: cmAt(list, retailCost, dr), whDealerFreight: priceFor(landed, wr, c / 100), whOurFreight: priceFor(delivered, wr, c / 100),
      marketplace: dr == null || w.mktExtra == null ? null : priceFor(delivered, dr + w.mktExtra / 100, c / 100) };
  });
  const freight = p.whFreight === 'us' ? 'us' : 'dealer';
  const wholesale = w.whTiers.map((t, i) => {
    const ov = n(p['whOv' + i]), price = ov != null ? ov : msrp ? Math.floor(msrp * (1 - t.discount / 100)) : null;
    const cmDealer = cmAt(price, landed, wr), cmUs = cmAt(price, delivered, wr);
    const main = freight === 'us' ? cmUs : cmDealer;
    return { name: t.name, discount: ov != null && msrp ? (1 - ov / msrp) * 100 : t.discount, floor: t.floor, override: ov != null, price,
      dealerMargin: msrp && price != null ? msrp - price : null, dealerMarginPct: msrp && price != null ? (msrp - price) / msrp : null,
      cmDealerFreight: cmDealer, cmDealerFreightPct: ratio(cmDealer, price), cmOurFreight: cmUs, cmOurFreightPct: ratio(cmUs, price),
      cm: main, cmPct: ratio(main, price), belowFloor: !t.floor && ratio(main, price) != null && w.whFloor != null && ratio(main, price)! < w.whFloor / 100 };
  });
  return { landed, lastMile, delivered, retailShip, retailCost, dtcRate: dr, whRate: wr, freight, retail, fixed, npcr, wholesale };
}

/** What a viewer without cost access may see: the selling prices everyone sees. */
export const publicPrices = (ws: ReturnType<typeof worksheet>) => ({
  msrp: ws.fixed[0].price, map: ws.fixed[1].price, promoFloor: ws.fixed[2].price, freight: ws.freight,
  wholesale: ws.wholesale.filter(t => !t.floor).map(t => ({ name: t.name, discount: t.discount, price: t.price, override: t.override })),
});
