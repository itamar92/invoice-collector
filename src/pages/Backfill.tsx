import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { BackfillRow } from '../api.js';
import { VendorDecisions } from './Attention.js';
import {
  Button, Empty, ErrorText, Flag, fmtDate, fmtDateTime, fmtMoney, Loading, Notice, PageTitle, rowCls, StateBadge,
  useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';

/** First-run list (spec §4.5): approve → filed to Dropbox only. The UI offers no way to send these to Morning. */
export default function Backfill() {
  const { settings, summary, setSettings, refreshSummary, refreshSettings } = useApp();
  const polling = useRef(false);
  const list = useLoad(() => api.backfill(polling.current));
  const running = !!list.data?.running;
  const wasRunning = useRef(false);

  // The run is a background job on the server: poll while it lasts, then refresh settings/badge once it ends.
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      polling.current = true;
      const id = setInterval(() => { void list.reload(); }, 3000);
      return () => { clearInterval(id); polling.current = false; };
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      void refreshSettings(); void refreshSummary();
    }
  }, [running]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const act = useAction();
  const [finished, setFinished] = useState(false);
  const done = settings!.settings.backfillDone;

  const status = list.data;
  const rows = status?.rows ?? [];
  const approvable = useMemo(() => rows.filter((r) => r.state === 'awaiting_backfill_approval'), [rows]);
  const chosen = approvable.filter((r) => picked.has(r.id)).map((r) => r.id);
  const allPicked = approvable.length > 0 && chosen.length === approvable.length;

  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  const after = async () => { setPicked(new Set()); await list.reload(); await refreshSummary(); };
  const restart = () => act.run(async () => { await api.startBackfill(); await list.reload(); }, 'restart');
  const approve = () => act.run(async () => { await api.approveBackfill(chosen); await after(); }, 'approve');
  const skip = () => act.run(async () => { await api.skipBackfill(chosen); await after(); }, 'skip');
  const finish = () => {
    if (!window.confirm(t('backfill.finishConfirm'))) return;
    void act.run(async () => {
      await api.finishBackfill();
      setSettings(await api.settings());
      setFinished(true);
      await after();
    }, 'finish');
  };

  const notConnected = list.code === 'not_connected';

  const pickAll = () => setPicked(allPicked ? new Set() : new Set(approvable.map((r) => r.id)));

  return (
    <div className="space-y-4">
      <PageTitle actions={!done && <Button variant="secondary" loading={act.is('finish')} disabled={act.busy || running || status?.error === 'interrupted'} onClick={finish}>{t('backfill.finish')}</Button>}>
        {t('backfill.title')}
      </PageTitle>
      {finished && <Notice tone="ok">{t('backfill.finished')}</Notice>}
      {done && !finished && <Notice>{t('backfill.done')}</Notice>}
      <p className="text-sm text-muted">{t('backfill.intro')}</p>
      {running && (
        <Notice>
          <span className="me-2 inline-block size-3 animate-spin rounded-full border-2 border-info border-t-transparent align-middle" />
          {t('backfill.running')}{status?.startedAt && ` · ${t('backfill.startedAt', { when: fmtDateTime(status.startedAt) })}`}
        </Notice>
      )}
      {!running && status?.error && !done && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-warn-tint px-3 py-2 text-sm">
          <span>{status.error === 'interrupted' ? t('backfill.interrupted') : t('backfill.runError', { error: status.error })}</span>
          <Button variant="secondary" loading={act.is('restart')} disabled={act.busy} onClick={restart}>{t('backfill.restart')}</Button>
        </div>
      )}
      {!running && status?.result && !done && (
        <Notice tone="ok">{t('backfill.result', {
          emails: status.result.emails, items: status.result.items,
          failed: status.result.failed ? t('start.failed', { n: status.result.failed }) : '',
        })}</Notice>
      )}

      {!done && !notConnected && rows.length > 0 && (
        <NextSteps step={(summary?.awaitingVendor ?? 0) > 0 ? 1 : approvable.length > 0 ? 2 : 3} />
      )}

      <VendorDecisions onDecided={() => void list.reload()} />

      <section className="panel">
        {/* Bulk actions stay in reach while the list scrolls. */}
        <div className={`sticky top-14 z-10 flex flex-wrap items-center gap-2 bg-white md:top-0 ${approvable.length > 0 ? 'min-h-12 border-b border-line py-1.5' : ''}`}>
          {approvable.length > 0 && (
            <>
              <label className="flex min-h-10 items-center gap-2 text-sm font-semibold">
                <input type="checkbox" className="size-5" checked={allPicked} onChange={pickAll} />{t('backfill.selectAll')}
              </label>
              <Button className="ms-auto" loading={act.is('approve')} disabled={!chosen.length || act.busy} onClick={approve}>{t('backfill.approve', { n: chosen.length })}</Button>
              <Button variant="danger" className="ms-2" loading={act.is('skip')} disabled={!chosen.length || act.busy} onClick={skip}>{t('backfill.skip', { n: chosen.length })}</Button>
            </>
          )}
        </div>
        <ErrorText>{act.error}</ErrorText>
        {list.loading && !list.data ? <Loading rows={6} />
          : notConnected ? <div className="mt-2"><Notice tone="warn">{t('backfill.notConnected')}</Notice></div>
          : list.error ? <ErrorText>{list.error}</ErrorText>
          : rows.length === 0 ? <Empty>{t('backfill.empty')}</Empty>
          : <ul>{rows.map((r) => <Row key={r.id} r={r} checked={picked.has(r.id)} onToggle={() => toggle(r.id)} />)}</ul>}
      </section>
    </div>
  );
}

const STEPS = ['backfill.step1', 'backfill.step2', 'backfill.step3'] as const;

/** What to do with the list, in order, with the current step marked: the summary page fills only after step 2. */
function NextSteps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <section className="panel" aria-labelledby="backfill-steps">
      <h2 id="backfill-steps" className="display mb-2 text-lg">{t('backfill.stepsTitle')}</h2>
      <ol className="space-y-2">
        {STEPS.map((k, i) => {
          const n = i + 1;
          const state = n < step ? 'done' : n === step ? 'now' : 'later';
          return (
            <li key={k} aria-current={state === 'now' ? 'step' : undefined}
              className={`flex items-start gap-3 rounded-xl px-2 py-1.5 text-sm ${state === 'now' ? 'bg-accent-tint font-semibold' : state === 'done' ? 'text-muted' : ''}`}>
              <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${state === 'now' ? 'bg-accent text-white' : state === 'done' ? 'bg-ok-tint text-accent-deep' : 'bg-ground-deep'}`}>
                {state === 'done' ? '✓' : n}
              </span>
              <span className="pt-0.5">{t(k)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Row({ r, checked, onToggle }: { r: BackfillRow; checked: boolean; onToggle: () => void }) {
  const can = r.state === 'awaiting_backfill_approval';
  return (
    <li className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-3 ${rowCls} ${checked ? '-mx-2 rounded-xl bg-accent-tint px-2' : ''}`}>
      <input type="checkbox" className="mt-0.5 size-5" disabled={!can} checked={checked} onChange={onToggle}
        title={can ? undefined : t('backfill.notApprovable')} aria-label={r.vendor ?? r.id} />
      <div className="min-w-0 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <Link className="min-w-0 truncate font-semibold hover:underline" to={`/items/${r.id}`}>{r.vendor ?? '—'}</Link>
          <span className="num shrink-0 font-semibold">{fmtMoney(r.total, r.currency)}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge state={r.state} />
            {r.likelyDuplicate && <Flag>{t('backfill.duplicate')}</Flag>}
          </span>
          <span className="num text-[13px] text-muted">{fmtDate(r.issueDate)}</span>
        </div>
        {r.filename && <bdi className="ltr block break-all text-xs">{r.filename}</bdi>}
        {r.folder && <bdi className="ltr block break-all text-xs text-muted">{r.folder}</bdi>}
      </div>
    </li>
  );
}
