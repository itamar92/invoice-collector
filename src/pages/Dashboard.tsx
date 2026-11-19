import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { Stats } from '../api.js';
import { Card, Empty, ErrorText, fmtMoney, inputCls, Loading, PageTitle, rowCls, useApp, useLoad } from '../components/ui.js';
import { t } from '../i18n/he.js';

const SLOTS = 8;
const OTHER = '\u0000other';
const NONE = '\u0000none';

interface Series { key: string; label: string; color: string; link: string | null; count: number; total: number }

/**
 * One colour per category, tied to the category itself: its place in the settings list picks the slot, so a
 * category keeps its colour whichever year is shown. Categories beyond the eight slots fold into "other".
 */
function buildSeries(s: Stats, configured: string[]): { series: Series[]; keyOf: (category: string | null) => string } {
  const present = s.categories.filter((c) => c.category !== null).map((c) => c.category!);
  const slot = new Map<string, number>();
  for (const name of configured.slice(0, SLOTS)) if (present.includes(name)) slot.set(name, configured.indexOf(name) + 1);
  const free = Array.from({ length: SLOTS }, (_, i) => i + 1).filter((n) => ![...slot.values()].includes(n));
  const rest = present.filter((n) => !slot.has(n))
    .sort((a, b) => (configured.indexOf(a) + 1 || 999) - (configured.indexOf(b) + 1 || 999) || a.localeCompare(b));
  for (const name of rest) { const n = free.shift(); if (n) slot.set(name, n); }

  const keyOf = (category: string | null) => (category === null ? NONE : slot.has(category) ? category : OTHER);
  const byKey = new Map<string, Series>();
  for (const c of s.categories) {
    const key = keyOf(c.category);
    const cur = byKey.get(key) ?? {
      key, count: 0, total: 0,
      label: key === NONE ? t('dash.noCategory') : key === OTHER ? t('dash.other') : key,
      color: key === NONE ? 'var(--cat-none)' : key === OTHER ? 'var(--cat-other)' : `var(--cat-${slot.get(key)})`,
      link: key === NONE || key === OTHER ? null : `/invoices?q=${encodeURIComponent(key)}`,
    };
    cur.count += c.count; cur.total += c.total;
    byKey.set(key, cur);
  }
  const tail = (k: string) => (k === NONE ? 2 : k === OTHER ? 1 : 0);
  const series = [...byKey.values()].sort((a, b) => tail(a.key) - tail(b.key) || b.count - a.count || a.label.localeCompare(b.label));
  return { series, keyOf };
}

/** Slices by document count, clockwise from the top, with a thin white gap between neighbours. */
function Pie({ series, active, onActive, label }: { series: Series[]; active: string | null; onActive: (k: string | null) => void; label: string }) {
  const sum = series.reduce((n, x) => n + x.count, 0);
  const at = (frac: number, r: number) => {
    const a = frac * 2 * Math.PI - Math.PI / 2;
    return `${(50 + r * Math.cos(a)).toFixed(3)} ${(50 + r * Math.sin(a)).toFixed(3)}`;
  };
  let start = 0;
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={label} className="size-44 shrink-0">
      {series.map((x) => {
        const from = start;
        const to = (start += x.count / sum);
        const dim = active !== null && active !== x.key;
        const common = {
          fill: x.color, stroke: '#ffffff', strokeWidth: 1.2, strokeLinejoin: 'round' as const,
          opacity: dim ? 0.3 : 1, style: { transition: 'opacity 150ms' },
          onMouseEnter: () => onActive(x.key), onMouseLeave: () => onActive(null),
        };
        const tip = <title>{`${x.label}: ${t('dash.docs', { n: x.count })} (${Math.round((x.count / sum) * 100)}%)`}</title>;
        return to - from > 0.9999
          ? <circle key={x.key} cx="50" cy="50" r="48" {...common}>{tip}</circle>
          : <path key={x.key} d={`M50 50 L${at(from, 48)} A48 48 0 ${to - from > 0.5 ? 1 : 0} 1 ${at(to, 48)} Z`} {...common}>{tip}</path>;
      })}
    </svg>
  );
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-[4px]" style={{ background: color }} />;
}

/** How many filed documents went to each category this year, and how they spread over the months. */
export default function Dashboard() {
  const { settings } = useApp();
  const [year, setYear] = useState<number | undefined>(undefined);
  const [active, setActive] = useState<string | null>(null);
  const load = useLoad(() => api.stats(year), [year]);
  const s = load.data;
  const configured = settings!.settings.categories.map((c) => c.name);
  const built = useMemo(() => (s ? buildSeries(s, configured) : null), [s, configured.join('\n')]);
  const series = built?.series ?? [];
  const topMonth = Math.max(1, ...(s?.months.map((m) => m.count) ?? []));
  const hover = (key: string) => ({ onMouseEnter: () => setActive(key), onMouseLeave: () => setActive(null) });
  const dim = (key: string) => (active !== null && active !== key ? 'opacity-30' : '');

  return (
    <div className="space-y-4">
      <PageTitle actions={s && (
        <select aria-label={t('dash.year')} className={`${inputCls} num w-28`} value={s.year} onChange={(e) => setYear(Number(e.target.value))}>
          {s.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      )}>
        {t('dash.title')}
      </PageTitle>
      <p className="text-sm text-muted">{t('dash.intro')}</p>
      {load.loading && !s && <Loading />}
      <ErrorText>{load.error}</ErrorText>

      {s && built && (
        <>
          <dl className="panel grid grid-cols-2 gap-4">
            <div>
              <dt className="text-[13px] text-muted">{t('dash.filed')}</dt>
              <dd className="display num text-3xl">{s.count}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-muted">{t('dash.total')}</dt>
              <dd className="display num text-3xl">{fmtMoney(s.total, s.currency)}</dd>
            </div>
            {s.otherCurrency > 0 && <p className="col-span-2 text-xs text-muted">{t('dash.otherCurrency', { n: s.otherCurrency })}</p>}
          </dl>

          <Card title={t('dash.byCategory')}>
            {series.length === 0 ? <Empty>{t('dash.empty')}</Empty> : (
              <div className="flex flex-col items-center gap-x-8 gap-y-3 md:flex-row md:items-start">
                <Pie series={series} active={active} onActive={setActive} label={t('dash.byCategory')} />
                {/* The list is the pie's legend and its table: colour, name, count, share and amount. */}
                <ul className="w-full min-w-0 flex-1">
                  {series.map((x) => {
                    const body = (
                      <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5">
                        <Swatch color={x.color} />
                        <span className="truncate font-medium">{x.label}</span>
                        <span className="num font-semibold">{fmtMoney(x.total, s.currency)}</span>
                        <span className="col-start-2 text-[13px] text-muted">{t('dash.docs', { n: x.count })}</span>
                        <span className="num text-[13px] text-muted">{Math.round((x.count / s.count) * 100)}%</span>
                      </span>
                    );
                    const cls = `-mx-2 block rounded-xl px-2 py-2 transition-[opacity,background-color] ${dim(x.key)}`;
                    return (
                      <li key={x.key} className={rowCls} {...hover(x.key)}>
                        {x.link ? <Link to={x.link} className={`${cls} hover:bg-ground`}>{body}</Link> : <div className={cls}>{body}</div>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>

          <Card title={t('dash.byMonth')}>
            {/* One column per month, stacked by category in the same colours; the number above is the month's count. */}
            <ol className="grid h-48 grid-cols-12 items-end gap-1.5 sm:gap-3" dir="ltr">
              {s.months.map((m) => {
                const parts = series
                  .map((x) => ({ x, count: m.parts.filter((p) => built.keyOf(p.category) === x.key).reduce((n, p) => n + p.count, 0) }))
                  .filter((p) => p.count > 0);
                return (
                  <li key={m.month} className="flex h-full flex-col items-center justify-end gap-1">
                    <span className={`text-xs font-semibold ${m.count ? '' : 'text-idle'}`}>{m.count}</span>
                    {m.count === 0
                      ? <span className="h-[3px] w-full max-w-10 rounded-full bg-ground-deep" />
                      : (
                        <span className="flex w-full max-w-10 flex-col-reverse gap-0.5 overflow-hidden rounded-t-md" style={{ height: `${Math.max(8, (m.count / topMonth) * 100)}%` }}>
                          {parts.map(({ x, count }) => (
                            <span key={x.key} {...hover(x.key)} className={`min-h-1 w-full transition-opacity ${dim(x.key)}`}
                              style={{ flexGrow: count, flexBasis: 0, background: x.color }}
                              title={`${String(m.month).padStart(2, '0')}/${s.year} · ${x.label}: ${t('dash.docs', { n: count })}`} />
                          ))}
                        </span>
                      )}
                    <span className="text-xs text-muted">{m.month}</span>
                  </li>
                );
              })}
            </ol>
            {series.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3">
                {series.map((x) => (
                  <li key={x.key} {...hover(x.key)} className={`flex items-center gap-1.5 text-[13px] transition-opacity ${dim(x.key)}`}>
                    <Swatch color={x.color} />{x.label}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
