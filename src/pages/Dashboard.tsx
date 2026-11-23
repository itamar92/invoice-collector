import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { Stats } from '../api.js';
import { ButtonLink, Card, Dot, Empty, ErrorText, fmtMoney, Icon, inputCls, Loading, PageTitle, rowCls, useApp, useLoad } from '../components/ui.js';
import type { MessageKey } from '../i18n/he.js';
import { t } from '../i18n/he.js';

const SLOTS = 8;
const OTHER = '\u0000other';
const NONE = '\u0000none';

interface Part { category: string; count: number; total: number; link: string }
/** `parts`: for the "other" slice, the categories folded into it, each with its own link. */
interface Series { key: string; label: string; color: string; link: string | null; count: number; total: number; parts: Part[] }

/** The filed documents of one category in one year, as counted here, on the invoices page. */
const docsLink = (year: number, category: string | null) =>
  `/invoices?${new URLSearchParams({ filed: '1', year: String(year), category: category ?? '-' })}`;

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
      link: key === OTHER ? null : docsLink(s.year, c.category),
      parts: [],
    };
    cur.count += c.count; cur.total += c.total;
    if (key === OTHER && c.category !== null) {
      cur.parts.push({ category: c.category, count: c.count, total: c.total, link: docsLink(s.year, c.category) });
    }
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

/**
 * The summary counts only what is already in Dropbox. Everything found but not filed yet is listed here with the
 * step it waits for, so an empty summary after the first scan says what to do next instead of looking broken.
 */
function NotFiledYet() {
  const { summary } = useApp();
  if (!summary) return null;
  const all: { n: number; key: MessageKey; to?: string; action?: MessageKey; tone: string }[] = [
    { n: summary.backfillWaiting, key: 'dash.pending.backfill', to: '/backfill', action: 'dash.pending.toBackfill', tone: 'bg-info' },
    { n: summary.awaitingVendor, key: 'dash.pending.vendor', to: '/attention', action: 'dash.pending.toVendors', tone: 'bg-warn' },
    { n: summary.needsAttention, key: 'dash.pending.attention', to: '/attention', action: 'dash.pending.toAttention', tone: 'bg-alert' },
    { n: summary.inProgress + summary.waitingAi, key: 'dash.pending.progress', tone: 'border-2 border-info' },
  ];
  const rows = all.filter((r) => r.n > 0);
  if (!rows.length) return null;
  return (
    <Card title={t('dash.pending.title')}>
      <p className="text-[13px] text-muted">{t('dash.pending.intro')}</p>
      <ul>
        {rows.map((r) => (
          <li key={r.key} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 ${rowCls}`}>
            <span className="flex items-center gap-2.5 text-sm"><Dot className={r.tone} /><span>{t(r.key, { n: r.n })}</span></span>
            {r.to && r.action && <ButtonLink to={r.to} variant={r === rows[0] ? 'primary' : 'secondary'}>{t(r.action)}</ButtonLink>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** How many filed documents went to each category this year, and how they spread over the months. */
export default function Dashboard() {
  const { settings, refreshSummary } = useApp();
  useEffect(() => { void refreshSummary(); }, [refreshSummary]);
  const [year, setYear] = useState<number | undefined>(undefined);
  const [active, setActive] = useState<string | null>(null);
  const [openOther, setOpenOther] = useState(false);
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
      <NotFiledYet />
      {load.loading && !s && <Loading rows={3} />}
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
                    const cls = `-mx-2 block w-full rounded-xl px-2 py-2 text-start transition-[opacity,background-color] ${dim(x.key)}`;
                    return (
                      <li key={x.key} className={rowCls} {...hover(x.key)}>
                        {x.link ? <Link to={x.link} className={`${cls} hover:bg-ground`}>{body}</Link> : x.parts.length ? (
                          <>
                            <button type="button" className={`${cls} hover:bg-ground`} aria-expanded={openOther} onClick={() => setOpenOther(!openOther)}>
                              {body}
                              <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-accent-deep">
                                {t(openOther ? 'dash.otherHide' : 'dash.otherShow', { n: x.parts.length })}
                                <Icon name={openOther ? 'up' : 'down'} className="size-3.5" />
                              </span>
                            </button>
                            {openOther && (
                              <ul className="mb-2 ms-5 border-s-2 border-line ps-3">
                                {x.parts.map((p) => (
                                  <li key={p.category}>
                                    <Link to={p.link} className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 text-sm hover:bg-ground">
                                      <span className="truncate">{p.category}</span>
                                      <span className="num text-[13px] text-muted">{t('dash.docs', { n: p.count })}</span>
                                      <span className="num font-medium">{fmtMoney(p.total, s.currency)}</span>
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        ) : <div className={cls}>{body}</div>}
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
