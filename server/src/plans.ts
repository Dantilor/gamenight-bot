import { redact } from './log.js';

export const LIFETIME_DURATION_DAYS = 36500;

export type PublicPlan = {
  id: string;
  title: string;
  priceRub: number;
  durationDays: number;
};

export function premiumPageUrl(miniAppUrl: string): string | null {
  if (!miniAppUrl) return null;
  let url: URL;
  try {
    url = new URL(miniAppUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  url.pathname = '/premium';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function plansUrl(apiUrl: string): string | null {
  if (!apiUrl) return null;
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.pathname = '/api/plans';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function formatPlanPeriod(durationDays: number): string {
  if (durationDays >= LIFETIME_DURATION_DAYS) return 'Навсегда';
  if (durationDays === 30) return '1 месяц';
  if (durationDays === 90) return '3 месяца';
  const months = Math.max(1, Math.round(durationDays / 30));
  return `${months} мес.`;
}

export function formatTariffs(plans: PublicPlan[] | null): string {
  if (!plans || plans.length === 0) {
    return 'Актуальные тарифы Premium открываются в приложении GameNight Host.';
  }
  const lines = [...plans]
    .sort((a, b) => a.durationDays - b.durationDays || a.priceRub - b.priceRub)
    .map((plan) => `• ${formatPlanPeriod(plan.durationDays)} — ${plan.priceRub} ₽`);
  return ['Тарифы Premium', '', ...lines, '', 'Оплата проходит в приложении GameNight Host.'].join('\n');
}

export async function fetchPlans(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<PublicPlan[] | null> {
  const url = plansUrl(apiUrl);
  if (!url) return null;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      console.error('[plans] request failed', { status: response.status });
      return null;
    }
    const body = (await response.json()) as { plans?: unknown };
    if (!body || !Array.isArray(body.plans)) return null;
    const plans: PublicPlan[] = [];
    for (const item of body.plans) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      const title = typeof row.title === 'string' ? row.title : id;
      const priceRub = typeof row.priceRub === 'number' ? row.priceRub : Number.NaN;
      const durationDays = typeof row.durationDays === 'number' ? row.durationDays : Number.NaN;
      if (!id || !Number.isInteger(priceRub) || priceRub < 0 || !Number.isInteger(durationDays) || durationDays <= 0) {
        continue;
      }
      plans.push({ id, title, priceRub, durationDays });
    }
    plans.sort((a, b) => a.durationDays - b.durationDays || a.priceRub - b.priceRub);
    return plans;
  } catch (error) {
    console.error('[plans] fetch failed', redact(error));
    return null;
  }
}
