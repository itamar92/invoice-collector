import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { BackfillRow } from '../api.js';
import { VendorDecisions } from './Attention.js';
import {
  Button, Card, Empty, ErrorText, fmtDate, fmtDateTime, fmtMoney, Loading, Notice, PageTitle, StateBadge, TableWrap, td, th,
  useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';

/** First-run list (spec §4.5): approve → filed to Dropbox only. The UI offers no way to send these to Morning. */
export default function Backfill() {
  const { settings, setSettings, refreshSummary, refreshSettings } = useApp();
  const list = useLoad(() => api.backfill());
  const running = !!list.data?.running;
  const wasRunning = useRef(false);

  // The run is a background job on the server: poll while it lasts, then refresh settings/badge once it ends.
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      const id = setInterval(() => { void list.reload(); }, 3000);
      return () => clearInterval(id);
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
  const restart = () => act.run(async () => { await api.startBackfill(); await list.reload(); });
  const approve = () => act.run(async () => { await api.approveBackfill(chosen); await after(); });
  const skip = () => act.run(async () => { await api.skipBackfill(chosen); await after(); });
  const finish = () => {
    if (!window.confirm(t('backfill.finishConfirm'))) return;
    void act.run(async () => {
      await api.finishBackfill();
      setSettings(await api.settings());
      setFinished(true);
      await after();
    });
  };

  const notConnected = list.code === 'not_connected';

  return (
    <div className="space-y-4">
      <PageTitle actions={!done && <Button variant="secondary" disabled={act.busy || running || status?.error === 'interrupted'} onClick={finish}>{t('backfill.finish')}</Button>}>
        {t('backfill.title')}
      </PageTitle>
      {finished && <Notice tone="ok">{t('backfill.finished')}</Notice>}
      {done && !finished && <Notice>{t('backfill.done')}</Notice>}
      <Notice>{t('backfill.intro')}</Notice>
      {running && (
        <Notice>
          <span className="me-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-700 border-t-transparent align-middle" />
          {t('backfill.running')}{status?.startedAt && ` · ${t('backfill.startedAt', { when: fmtDateTime(status.startedAt) })}`}
        </Notice>
      )}
      {!running && status?.error && !done && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>{status.error === 'interrupted' ? t('backfill.interrupted') : t('backfill.runError', { error: status.error })}</span>
          <Button variant="secondary" disabled={act.busy} onClick={restart}>{t('backfill.restart')}</Button>
        </div>
      )}
      {!running && status?.result && !done && (
        <Notice tone="ok">{t('backfill.result', {
          emails: status.result.emails, items: status.result.items,
          failed: status.result.failed ? t('start.failed', { n: status.result.failed }) : '',
        })}</Notice>
      )}

      <VendorDecisions onDecided={() => void list.reload()} />

      <Card actions={approvable.length > 0 && (
        <>
          <Button variant="secondary" onClick={() => setPicked(allPicked ? new Set() : new Set(approvable.map((r) => r.id)))}>{t('backfill.selectAll')}</Button>
          <Button disabled={!chosen.length || act.busy} onClick={approve}>{t('backfill.approve', { n: chosen.length })}</Button>
          <Button variant="danger" disabled={!chosen.length || act.busy} onClick={skip}>{t('backfill.skip', { n: chosen.length })}</Button>
        </>
      )}>
        <ErrorText>{act.error}</ErrorText>
        {list.loading && !list.data ? <Loading />
          : notConnected ? <Notice tone="warn">{t('backfill.notConnected')}</Notice>
          : list.error ? <ErrorText>{list.error}</ErrorText>
          : rows.length === 0 ? <Empty>{t('backfill.empty')}</Empty>
          : (
            <TableWrap>
              <thead><tr>
                <th className={th}><input type="checkbox" aria-label={t('backfill.selectAll')} checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(approvable.map((r) => r.id)))} /></th>
                <th className={th}>{t('common.vendor')}</th>
                <th className={th}>{t('common.date')}</th>
                <th className={th}>{t('common.total')}</th>
                <th className={th}>{t('backfill.filename')}</th>
                <th className={th}>{t('common.state')}</th>
              </tr></thead>
              <tbody>{rows.map((r) => <Row key={r.id} r={r} checked={picked.has(r.id)} onToggle={() => toggle(r.id)} />)}</tbody>
            </TableWrap>
          )}
      </Card>
    </div>
  );
}

function Row({ r, checked, onToggle }: { r: BackfillRow; checked: boolean; onToggle: () => void }) {
  const can = r.state === 'awaiting_backfill_approval';
  return (
    <tr className={checked ? 'bg-teal-50/50' : ''}>
      <td className={td}>
        <input type="checkbox" className="h-5 w-5" disabled={!can} checked={checked} onChange={onToggle}
          title={can ? undefined : t('backfill.notApprovable')} aria-label={r.vendor ?? r.id} />
      </td>
      <td className={td}><Link className="font-medium text-teal-800 hover:underline" to={`/items/${r.id}`}>{r.vendor ?? '—'}</Link></td>
      <td className={`${td} whitespace-nowrap`}>{fmtDate(r.issueDate)}</td>
      <td className={`${td} whitespace-nowrap`}>{fmtMoney(r.total, r.currency)}</td>
      <td className={td}>
        {r.filename ? <bdi className="ltr block break-all font-mono text-xs">{r.filename}</bdi> : '—'}
        {r.folder && <bdi className="ltr block break-all font-mono text-xs text-slate-500">{r.folder}</bdi>}
        {r.likelyDuplicate && <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">⚠ {t('backfill.duplicate')}</span>}
      </td>
      <td className={td}><StateBadge state={r.state} /></td>
    </tr>
  );
}
