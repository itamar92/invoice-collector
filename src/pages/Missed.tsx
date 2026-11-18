import { useState } from 'react';
import { api } from '../api.js';
import type { MissedRow } from '../api.js';
import {
  Button, Card, Empty, ErrorText, fmtDateTime, Loading, Notice, PageTitle, useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

export default function Missed() {
  const { settings, refreshSummary } = useApp();
  const list = useLoad(() => api.missed());
  const [showAll, setShowAll] = useState(false);
  const act = useAction();
  const rows = (list.data ?? []).filter((r) => showAll || r.status === 'open');

  const doIt = (r: MissedRow, what: 'queue' | 'hide') => act.run(async () => {
    if (what === 'queue') await api.queueMissed(r.messageId); else await api.hideMissed(r.messageId);
    await list.reload(); await refreshSummary();
  });

  return (
    <div className="space-y-4">
      <PageTitle>{t('missed.title')}</PageTitle>
      <Notice>{t('missed.intro')}</Notice>
      {!settings!.settings.gmailLabel && <Notice tone="warn">{t('missed.noLabel')}</Notice>}
      <Card actions={
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {t('missed.showAll')}
        </label>
      }>
        <ErrorText>{act.error}</ErrorText>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorText>{list.error}</ErrorText> : rows.length === 0 ? <Empty /> : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.messageId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <div className="font-medium"><bdi>{r.subject || '—'}</bdi></div>
                  <div className="text-xs text-slate-500">
                    <bdi className="ltr">{r.sender ?? '—'}</bdi> · {fmtDateTime(r.receivedAt)}
                    {r.status !== 'open' && <> · {t(`missed.status.${r.status}` as MessageKey)}</>}
                  </div>
                </div>
                {r.status === 'open' && (
                  <div className="flex gap-2">
                    <Button disabled={act.busy} onClick={() => doIt(r, 'queue')}>{t('missed.queue')}</Button>
                    <Button variant="secondary" disabled={act.busy} onClick={() => doIt(r, 'hide')}>{t('missed.hide')}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
