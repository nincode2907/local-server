import { readFileSync } from 'node:fs';
interface Price { input_per_million: number | null; output_per_million: number | null; cached_input_per_million: number | null; source_id: string; scope: string }
interface Model { id: string; name: string; provider: string; default_effort: string; availability: { codex_plus: string; note: string }; reasoning: { codex: string[] }; specs: { api_price?: Price } }
const snapshot = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url), 'utf8')) as { checked_on: string; models: Model[]; sources: { id: string; url: string }[] };
export const catalog = { checked_on: snapshot.checked_on, models: snapshot.models.map(m => ({
  id: m.id, name: m.name, provider: m.provider, default_effort: m.default_effort,
  availability: m.availability.codex_plus, note: m.availability.note,
  reasoning: m.reasoning.codex.filter(e => ['minimal','low','medium','high','xhigh','max','ultra','persistent'].includes(e)),
  chat_supported: ['included','rollout'].includes(m.availability.codex_plus) && m.reasoning.codex.length > 0,
  price: m.specs.api_price ?? null,
  price_source: snapshot.sources.find(s => s.id === m.specs.api_price?.source_id)?.url ?? null,
})) };
export function estimateCost(model: string, input: number, output: number, cached: number) {
  const m = catalog.models.find(m => m.id === model), p = m?.price;
  if (!p || p.input_per_million === null || p.output_per_million === null) return null;
  const cache = Math.min(input, Math.max(0, cached));
  const cacheRate = p.cached_input_per_million ?? p.input_per_million;
  const inputCost = (input - cache) * p.input_per_million / 1e6;
  const cachedCost = cache * cacheRate / 1e6;
  const outputCost = output * p.output_per_million / 1e6;
  return { input_cost_usd: inputCost, cached_cost_usd: cachedCost, output_cost_usd: outputCost,
    cost_usd: inputCost + cachedCost + outputCost, input_rate: p.input_per_million,
    output_rate: p.output_per_million, cached_rate: cacheRate, price_checked_on: catalog.checked_on,
    price_source: m!.price_source ?? p.source_id };
}
export function periodKey(time: number, group: 'day' | 'week' | 'month') {
  const d = new Date(time + 7 * 3600000);
  if (group === 'week') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, group === 'month' ? 7 : 10);
}
