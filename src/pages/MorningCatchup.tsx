import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { CatchupCheck, CatchupRow, CatchupSent } from '../api.js';
import {
  Button, ButtonLink, Empty, ErrorText, Flag, fmtDate, fmtMoney, Loading, Notice, PageTitle, rowCls, useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

const CHECK_BATCH = 20;
const SEND_BATCH = 10;
type Filter = 'all' | 'not_found' | 'maybe' | 'found' | 'unknown' | 'unchecked';

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Filed documents that never went to Morning: the first import (the app books only new mail) or anything filed
 * before Morning was connected. The page checks Morning for each one, then sends only what the owner picks;
 * the server looks each one up again right before sending.
 */
export default function MorningCatchup() {
  const { refreshSummary } = useApp();
  const list = useLoad(() => api.catchup());
  const rows = list.data?.rows ?? [];
  const [checks, setChecks] = useState<Map<string, CatchupCheck>>(new Map());
  const [sent, setSent] = useState<Map<string, CatchupSent>>(new Map());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ label: MessageKey; done: number; total: number } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const act = useAction();

  const statusOf = (id: string): Filter => checks.get(id)?.status ?? 'unchecked';
  const open = rows.filter((r) => !sent.has(r.id) || sent.get(r.id)!.outcome === 'failed');
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: open.length, not_found: 0, maybe: 0, found: 0, unknown: 0, unchecked: 0 };
    for (const r of open) c[statusOf(r.id)]++;
    return c;
  }, [open, checks]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = filter === 'all' ? open : open.filter((r) => statusOf(r.id) === filter);
  const chosen = open.filter((r) => picked.has(r.id)).map((r) => r.id);
  const checkedAll = open.length > 0 && counts.unchecked === 0;

  const check = () => act.run(async () => {
    setNote(null);
    const ids = open.map((r) => r.id);
    const next = new Map(checks);
    setProgress({ label: 'catchup.checking', done: 0, total: ids.length });
    for (const part of chunks(ids, CHECK_BATCH)) {
      const r = await api.catchupCheck(part);
      for (const x of r.results) next.set(x.id, x);
      setChecks(new Map(next));
      setProgress((p) => p && { ...p, done: p.done + part.length });
    }
    setProgress(null);
    // Only what Morning surely does not hold is picked by default; a "maybe" needs a look first.
    setPicked(new Set(ids.filter((id) => next.get(id)?.status === 'not_found')));
  }, 'check');

  const sendPicked = () => {
    if (!window.confirm(t('catchup.sendConfirm', { n: chosen.length }))) return;
    void act.run(async () => {
      setNote(null);
      const next = new Map(sent);
      setProgress({ label: 'catchup.sending', done: 0, total: chosen.length });
      try {
        for (const part of chunks(chosen, SEND_BATCH)) {
          const r = await api.catchupSend(part);
          for (const x of r.results) next.set(x.id, x);
          setSent(new Map(next));
          setProgress((p) => p && { ...p, done: p.done + part.length });
        }
      } finally {
        setProgress(null);
        setPicked(new Set());
        await refreshSummary();
      }
      const results = chosen.map((id) => next.get(id)).filter((x): x is CatchupSent => !!x);
      const failed = results.filter((x) => x.outcome === 'failed').length;
      setNote({
        tone: failed ? 'warn' : 'ok',
        text: t('catchup.sentResult', {
          sent: results.filter((x) => x.outcome === 'sent').length, found: results.filter((x) => x.outcome === 'in_morning').length, failed,
        }),
      });
    }, 'send');
  };

  const mark = (as: 'in_morning' | 'skipped', ids: string[]) => {
    if (as === 'skipped' && !window.confirm(t('catchup.skipConfirm', { n: ids.length }))) return;
    void act.run(async () => {
      const refs: Record<string, { where: 'expense' | 'draft'; morningId: string }> = {};
      for (const id of ids) {
        const c = checks.get(id);
        if (c?.morningId && c.where && (c.status === 'found' || c.status === 'maybe')) refs[id] = { where: c.where, morningId: c.morningId };
      }
      const r = await api.catchupMark(ids, as, refs);
      setNote({ tone: 'ok', text: t(as === 'in_morning' ? 'catchup.markedInMorning' : 'catchup.markedSkipped', { n: r.changed }) });
      setPicked(new Set());
      await list.reload();
    }, as);
  };

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const pickShown = () => setPicked((p) => {
    const n = new Set(p);
    for (const r of shown) { if (allShownPicked) n.delete(r.id); else n.add(r.id); }
    return n;
  });
  const foundIds = open.filter((r) => statusOf(r.id) === 'found').map((r) => r.id);

  const mode = list.data?.mode ?? null;
  const canCheck = !!list.data?.canCheck;
  const FILTERS: Filter[] = checkedAll ? ['all', 'not_found', 'maybe', 'found', 'unknown'] : ['all'];

  return (
    <div className="space-y-4">
      <PageTitle>{t('catchup.title')}</PageTitle>
      <p className="text-sm text-muted">{t('catchup.intro')}</p>

      {list.data && !mode && (
        <Notice tone="warn">
          {t('catchup.notConfigured')} <Link to="/settings" className="font-semibold underline">{t('catchup.toSettings')}</Link>
        </Notice>
      )}
      {list.data && mode && !canCheck && <Notice tone="warn">{t('catchup.cannotCheck')}</Notice>}
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <ErrorText>{act.error}</ErrorText>

      {list.data && mode && open.length > 0 && (canCheck || progress) && (
        <section className="panel space-y-3">
          {canCheck && (
            <ol className="list-decimal space-y-1 ps-5 text-sm">
              <li className={checkedAll ? 'text-muted' : 'font-semibold'}>{t('catchup.step1')}</li>
              <li className={checkedAll ? 'font-semibold' : ''}>{t('catchup.step2')}</li>
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {canCheck && (
              <Button variant={checkedAll ? 'secondary' : 'primary'} loading={act.is('check')} disabled={act.busy} onClick={check}>
                {checkedAll ? t('catchup.recheck') : t('catchup.check', { n: open.length })}
              </Button>
            )}
            {foundIds.length > 0 && (
              <Button variant="secondary" loading={act.is('in_morning')} disabled={act.busy} onClick={() => mark('in_morning', foundIds)}>
                {t('catchup.markAllFound', { n: foundIds.length })}
              </Button>
            )}
          </div>
          {progress && (
            <div className="space-y-1" role="status">
              <div className="text-sm">{t(progress.label, { done: progress.done, total: progress.total })}</div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ground-deep">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        {FILTERS.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label={t('catchup.filter')}>
            {FILTERS.map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                className={`min-h-9 rounded-full border px-3 text-sm transition-colors ${filter === f ? 'border-accent bg-accent text-white' : 'border-line-strong bg-white hover:bg-ground'}`}>
                {t(`catchup.filter.${f}` as MessageKey)} <span className={`num text-xs ${filter === f ? 'text-white/80' : 'text-muted'}`}>{counts[f]}</span>
              </button>
            ))}
          </div>
        )}
        {mode && open.length > 0 && (
          <div className="sticky top-14 z-10 flex min-h-12 flex-wrap items-center gap-2 border-b border-line bg-white py-1.5 md:top-0">
            <label className="flex min-h-10 items-center gap-2 text-sm font-semibold">
              <input type="checkbox" className="size-5" checked={allShownPicked} onChange={pickShown} />{t('backfill.selectAll')}
            </label>
            <Button className="ms-auto" loading={act.is('send')} disabled={!chosen.length || act.busy || (canCheck && !checkedAll)}
              title={canCheck && !checkedAll ? t('catchup.checkFirst') : undefined} onClick={sendPicked}>
              {t('catchup.send', { n: chosen.length })}
            </Button>
            <Button variant="secondary" loading={act.is('in_morning')} disabled={!chosen.length || act.busy} onClick={() => mark('in_morning', chosen)}>
              {t('catchup.markInMorning')}
            </Button>
            <Button variant="ghost" loading={act.is('skipped')} disabled={!chosen.length || act.busy} onClick={() => mark('skipped', chosen)}>
              {t('catchup.skip')}
            </Button>
          </div>
        )}
        {list.loading && !list.data ? <Loading rows={6} />
          : list.error ? <ErrorText>{list.error}</ErrorText>
          : rows.length === 0 ? <Empty>{t('catchup.empty')}</Empty>
          : (
            <ul>
              {shown.map((r) => (
                <Row key={r.id} r={r} check={checks.get(r.id)} sent={sent.get(r.id)} checked={picked.has(r.id)} disabled={!mode} onToggle={() => toggle(r.id)} />
              ))}
              {sent.size > 0 && open.length === 0 && <Empty>{t('catchup.allDone')}</Empty>}
            </ul>
          )}
      </section>
      {sent.size > 0 && <ButtonLink to="/invoices">{t('catchup.toInvoices')}</ButtonLink>}
    </div>
  );
}

const TONE: Record<CatchupCheck['status'], string> = {
  found: 'bg-ok-tint text-accent-deep', maybe: 'bg-warn-tint', not_found: 'bg-info-tint', unknown: 'bg-ground-deep',
};

function Row({ r, check, sent, checked, disabled, onToggle }: {
  r: CatchupRow; check?: CatchupCheck; sent?: CatchupSent; checked: boolean; disabled: boolean; onToggle: () => void;
}) {
  const seen = check?.seen;
  return (
    <li className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-3 ${rowCls} ${checked ? '-mx-2 rounded-xl bg-accent-tint px-2' : ''}`}>
      <input type="checkbox" className="mt-0.5 size-5" disabled={disabled} checked={checked} onChange={onToggle} aria-label={r.vendor ?? r.id} />
      <div className="min-w-0 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <Link className="min-w-0 truncate font-semibold hover:underline" to={`/items/${r.id}`}>{r.vendor ?? '—'}</Link>
          <span className="num shrink-0 font-semibold">{fmtMoney(r.total, r.currency)}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
          <span className="flex flex-wrap items-center gap-2">
            {check && (
              <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${TONE[check.status]}`}>
                {t(`catchup.status.${check.status}` as MessageKey)}
                {check.where && (check.status === 'found' || check.status === 'maybe') && ` · ${t(`catchup.where.${check.where}` as MessageKey)}`}
              </span>
            )}
            {sent && <Flag>{t(`catchup.outcome.${sent.outcome}` as MessageKey)}</Flag>}
            {r.docNumber && <span className="text-muted">{t('catchup.number', { n: r.docNumber })}</span>}
            {r.category && <span className="rounded-md bg-ground-deep px-1.5 py-0.5 text-xs">{r.category}</span>}
          </span>
          <span className="num text-muted">{fmtDate(r.issueDate)}</span>
        </div>
        {seen && check?.status === 'maybe' && (
          <p className="text-xs text-muted">
            {t('catchup.seen', {
              number: seen.number ?? '—', amount: fmtMoney(seen.amount, r.currency), supplier: seen.supplier ?? '—', date: fmtDate(seen.date),
            })}
          </p>
        )}
        {(check?.error || sent?.error) && <p className="text-xs text-alert">{sent?.error ?? check?.error}</p>}
        {r.why === 'not_configured' && <p className="text-xs text-muted">{t('catchup.why.not_configured')}</p>}
      </div>
    </li>
  );
}
