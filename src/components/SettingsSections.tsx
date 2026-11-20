import { useEffect, useMemo, useState } from 'react';
import { buildFilename, buildFolder } from '../../server/core/naming.js';
import { api, GMAIL_SEND_SCOPE, startOAuth } from '../api.js';
import { mergeMorningCategories } from '../morningCategories.js';
import { FolderPicker } from './FolderPicker.js';
import type { Category, ExtractedFields, MorningClassification, SecretKey, Settings } from '../api.js';
import { t, tDyn } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';
import { Button, Check, ErrorText, Field, hintCls, Icon, inputCls, Notice, rowCls, Saved, SecretInput, td, th, useAction, useApp, useLoad } from './ui.js';

/** Shared by Setup (one step each) and Settings (all of them, editable later). */

function useSettings() {
  const app = useApp();
  const s = app.settings!;
  const save = async (patch: Partial<Settings>) => { app.setSettings(await api.saveSettings(patch)); };
  const saveSecret = async (key: SecretKey, value: string) => { await api.setSecret(key, value); await app.refreshSettings(); };
  return { s, save, saveSecret, app };
}

// ---------- 1. connections ----------
type MorningMode = 'api_fields' | 'api_file' | 'email';
const MODES: MorningMode[] = ['api_fields', 'api_file', 'email'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ConnectRow({ name, hint, ok, onConnect }: { name: string; hint: string; ok: boolean; onConnect: () => Promise<void> }) {
  const a = useAction();
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 py-3 ${rowCls}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 text-base font-semibold">{name} <Check ok={ok} labels={[t('common.connected'), t('common.notConnected')]} /></div>
        <p className={hintCls}>{hint}</p>
        <ErrorText>{a.error}</ErrorText>
      </div>
      <Button variant={ok ? 'secondary' : 'primary'} disabled={a.busy} onClick={() => a.run(onConnect)}>
        {ok ? t('connect.reconnect') : t('connect.connect')}
      </Button>
    </div>
  );
}

export function ConnectionsSection() {
  const { s, save, saveSecret } = useSettings();
  const { settings, secrets, morningModes } = s;
  const hasSend = settings.gmailScopes.includes(GMAIL_SEND_SCOPE);
  const mode = settings.morning.mode;
  const [inbox, setInbox] = useState(settings.morning.inboxEmail ?? '');
  const detect = useAction();
  const saving = useAction();
  const [justDetected, setJustDetected] = useState(false);

  const available = (m: MorningMode) => m === 'email' || !!morningModes?.[m];
  const gmailUrl = (send: boolean) => `/api/oauth/google/start${send ? '?send=1' : ''}`;

  const runDetect = () => detect.run(async () => {
    const r = await api.detectMorning();
    const best: MorningMode = r.modes.api_fields ? 'api_fields' : r.modes.api_file ? 'api_file' : 'email';
    await save({ morning: { mode: best, inboxEmail: settings.morning.inboxEmail } });
    setJustDetected(true);
  });
  const choose = (m: MorningMode) => saving.run(() => save({ morning: { mode: m, inboxEmail: settings.morning.inboxEmail } }));
  const saveInbox = () => saving.run(() => save({ morning: { mode: 'email', inboxEmail: inbox.trim() } }));
  const onlyEmail = morningModes != null && !morningModes.api_fields && !morningModes.api_file;

  return (
    <div>
      <ConnectRow name={t('conn.gmail')} hint={t('connect.gmailHint')} ok={secrets.gmail_refresh}
        onConnect={() => startOAuth(gmailUrl(mode === 'email'))} />
      <ConnectRow name={t('conn.dropbox')} hint={t('connect.dropboxHint')} ok={secrets.dropbox_refresh}
        onConnect={() => startOAuth('/api/oauth/dropbox/start')} />

      <div className="space-y-3 py-3">
        <div className="text-base font-semibold">{t('conn.morning')}</div>
        <p className={hintCls}>{t('connect.morningHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SecretInput label={t('connect.morningId')} configured={secrets.morning_id} onSave={(v) => saveSecret('morning_id', v)} />
          <SecretInput label={t('connect.morningSecret')} configured={secrets.morning_secret} onSave={(v) => saveSecret('morning_secret', v)} />
        </div>
        <Button variant="secondary" disabled={detect.busy || !secrets.morning_id || !secrets.morning_secret} onClick={runDetect}>
          {detect.busy ? t('connect.detecting') : t('connect.detect')}
        </Button>
        <ErrorText>{detect.error}</ErrorText>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-semibold">{t('connect.modes')}</legend>
          {MODES.map((m) => (
            <label key={m} className={`flex min-h-8 items-start gap-2 text-sm ${available(m) ? '' : 'text-idle'}`}>
              <input type="radio" name="morning-mode" className="mt-0.5 size-4" checked={mode === m} disabled={!available(m) || saving.busy}
                onChange={() => choose(m)} />
              <span>{t(`connect.mode.${m}` as MessageKey)}{!available(m) && ` — ${t('connect.modeUnavailable')}`}</span>
            </label>
          ))}
        </fieldset>

        {mode && <p className="text-sm font-semibold">{t('connect.chosen', { mode: t(`connect.mode.${mode}` as MessageKey) })}</p>}
        {(mode === 'api_fields' || mode === 'api_file') && <Notice tone="warn">{t('connect.detectedNote')}</Notice>}
        {justDetected && onlyEmail && <Notice tone="warn">{t('connect.onlyEmail')}</Notice>}

        {mode === 'email' && (
          <div className="space-y-2 rounded-xl bg-ground p-3">
            <Field label={t('connect.inboxEmail')}>
              <div className="flex gap-2">
                <input type="email" className={`${inputCls} ltr`} value={inbox} onChange={(e) => setInbox(e.target.value)} />
                <Button variant="secondary" disabled={!EMAIL_RE.test(inbox.trim()) || saving.busy} onClick={saveInbox}>{t('common.save')}</Button>
              </div>
            </Field>
            {hasSend
              ? <p className="flex items-center gap-1 text-sm font-medium"><Icon name="check" className="size-4 text-accent-deep" />{t('connect.hasSend')}</p>
              : (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{t('connect.needsSend')}</span>
                  <Button variant="secondary" onClick={() => saving.run(() => startOAuth(gmailUrl(true)))}>{t('connect.grantSend')}</Button>
                </div>
              )}
          </div>
        )}
        <ErrorText>{saving.error}</ErrorText>
        <p className={hintCls}>{t('connect.neverApproved')}</p>
      </div>
    </div>
  );
}

// ---------- 2. AI ----------
type AiMode = Settings['ai']['mode'];
const AI_MODES: AiMode[] = ['anthropic', 'openai', 'gemini', 'ssh', 'none'];
const KEY_OF: Partial<Record<AiMode, SecretKey>> = { anthropic: 'ai_key_anthropic', openai: 'ai_key_openai', gemini: 'ai_key_gemini' };

export function AiSection() {
  const { s, save, saveSecret } = useSettings();
  const ai = s.settings.ai;
  const [mode, setMode] = useState<AiMode>(ai.mode);
  const [model, setModel] = useState(ai.model ?? '');
  const [ssh, setSsh] = useState({ host: ai.ssh?.host ?? '', port: String(ai.ssh?.port ?? 22), user: ai.ssh?.user ?? '', hostKeySha256: ai.ssh?.hostKeySha256 ?? '' });
  const saving = useAction();
  const test = useAction();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const sshValid = ssh.host.trim() && ssh.user.trim() && ssh.hostKeySha256.trim() && Number(ssh.port) >= 1 && Number(ssh.port) <= 65535;
  const dirty = mode !== ai.mode || model !== (ai.model ?? '') || (mode === 'ssh' && (
    ssh.host !== (ai.ssh?.host ?? '') || ssh.user !== (ai.ssh?.user ?? '') || ssh.hostKeySha256 !== (ai.ssh?.hostKeySha256 ?? '') || Number(ssh.port) !== (ai.ssh?.port ?? 22)));

  const doSave = () => saving.run(async () => {
    const next: Settings['ai'] = { mode };
    if (mode !== 'none' && model.trim()) next.model = model.trim();
    if (mode === 'ssh') next.ssh = { host: ssh.host.trim(), port: Number(ssh.port), user: ssh.user.trim(), hostKeySha256: ssh.hostKeySha256.trim() };
    await save({ ai: next });
    setSaved(true); setResult(null);
  });
  const doTest = () => test.run(async () => {
    const r = await api.testAi();
    setResult(r.ok ? { ok: true, text: t('ai.testOk', { provider: r.provider }) } : { ok: false, text: t('ai.testFail', { error: r.error ?? '' }) });
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('ai.intro')}</p>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-[13px] font-semibold">{t('ai.mode')}</legend>
        {AI_MODES.map((m) => (
          <label key={m} className={`flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm ${mode === m ? 'border-accent bg-accent-tint font-semibold' : 'border-line-strong'}`}>
            <input type="radio" name="ai-mode" className="size-4" checked={mode === m} onChange={() => { setMode(m); setSaved(false); }} />
            {t(`ai.mode.${m}` as MessageKey)}
          </label>
        ))}
      </fieldset>

      {mode === 'none' && <Notice>{t('ai.noneHint')}</Notice>}
      {KEY_OF[mode] && (
        <SecretInput label={t('ai.key')} configured={s.secrets[KEY_OF[mode]!]} onSave={(v) => saveSecret(KEY_OF[mode]!, v)} />
      )}
      {mode === 'ssh' && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('ai.sshHost')}><input className={`${inputCls} ltr`} value={ssh.host} onChange={(e) => setSsh({ ...ssh, host: e.target.value })} /></Field>
            <Field label={t('ai.sshPort')}><input inputMode="numeric" className={`${inputCls} ltr`} value={ssh.port} onChange={(e) => setSsh({ ...ssh, port: e.target.value })} /></Field>
            <Field label={t('ai.sshUser')}><input className={`${inputCls} ltr`} value={ssh.user} onChange={(e) => setSsh({ ...ssh, user: e.target.value })} /></Field>
          </div>
          <Field label={t('ai.sshHostKey')}><input className={`${inputCls} ltr font-mono`} value={ssh.hostKeySha256} onChange={(e) => setSsh({ ...ssh, hostKeySha256: e.target.value })} placeholder="SHA256:…" /></Field>
          <SecretInput label={t('ai.sshKey')} configured={s.secrets.ssh_private_key} onSave={(v) => saveSecret('ssh_private_key', v)} multiline />
          <p className={hintCls}>{t('ai.sshHint')}</p>
        </div>
      )}
      {mode !== 'none' && (
        <Field label={t('ai.model')} hint={t('ai.modelHint')}>
          <input className={`${inputCls} ltr`} value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!dirty || saving.busy || (mode === 'ssh' && !sshValid)} onClick={doSave}>{saving.busy ? t('common.saving') : t('common.save')}</Button>
        {mode !== 'none' && <Button variant="secondary" disabled={dirty || test.busy} onClick={doTest}>{test.busy ? t('ai.testing') : t('ai.test')}</Button>}
        <Saved show={saved && !dirty} />
      </div>
      {result && <Notice tone={result.ok ? 'ok' : 'warn'}>{result.text}</Notice>}
      <ErrorText>{saving.error ?? test.error}</ErrorText>
    </div>
  );
}

// ---------- 3. Gmail label ----------
const FILTERS_URL = 'https://mail.google.com/mail/u/0/#settings/filters';
const HOW: MessageKey[] = ['label.how1', 'label.how2', 'label.how3', 'label.how4', 'label.how5', 'label.how6'];

export function LabelSection() {
  const { s, save } = useSettings();
  const current = s.settings.gmailLabel;
  const [useLabel, setUseLabel] = useState(current !== null || !s.settings.setupComplete) // label is the recommended default;
  const [label, setLabel] = useState(current ?? '');
  const [labels, setLabels] = useState<string[] | null>(null);
  const [listError, setListError] = useState(false);
  const saving = useAction();

  const load = async () => {
    try { setLabels((await api.gmailLabels()).labels); setListError(false); } catch { setLabels(null); setListError(true); }
  };
  useEffect(() => { void load(); }, [s.secrets.gmail_refresh]);

  const doSave = () => saving.run(() => save({ gmailLabel: useLabel ? label.trim() : null }));
  const canSave = useLabel ? !!label.trim() && label.trim() !== current : current !== null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('label.why')}</p>
      <div>
        <p className="mb-1 text-[13px] font-semibold">{t('label.howTitle')}</p>
        <ol className="list-decimal space-y-0.5 ps-6 text-sm marker:font-semibold marker:text-accent">
          {HOW.map((k) => <li key={k}>{t(k)}</li>)}
        </ol>
        <a href={FILTERS_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-9 items-center gap-1 text-sm font-semibold text-accent underline">
          {t('label.link')}<Icon name="out" className="size-4" />
        </a>
      </div>

      <fieldset className="space-y-2">
        <label className="flex min-h-8 items-center gap-2 text-sm font-semibold">
          <input type="radio" name="label-mode" className="size-4" checked={useLabel} onChange={() => setUseLabel(true)} /> {t('label.useLabel')}
        </label>
        {useLabel && (
          <div className="space-y-2 ps-6">
            {labels && labels.length > 0 && (
              <Field label={t('label.pick')}>
                <select className={inputCls} value={labels.includes(label) ? label : ''} onChange={(e) => setLabel(e.target.value)}>
                  <option value="">{t('label.choose')}</option>
                  {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </Field>
            )}
            {listError && <p className="rounded-lg bg-warn-tint px-2 py-1 text-xs">{t('label.listUnavailable')}</p>}
            <Field label={t('label.typeIt')}>
              <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Button variant="ghost" onClick={() => void load()}>{t('label.refresh')}</Button>
            <p className={hintCls}>{t('label.missedNote')}</p>
          </div>
        )}
        <label className="flex min-h-8 items-center gap-2 text-sm font-semibold">
          <input type="radio" name="label-mode" className="size-4" checked={!useLabel} onChange={() => setUseLabel(false)} /> {t('label.scanAll')}
        </label>
        {!useLabel && <p className="ms-6 rounded-lg bg-warn-tint px-2 py-1 text-xs">{t('label.scanAllHint')}</p>}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!canSave || saving.busy} onClick={doSave}>{saving.busy ? t('common.saving') : t('common.save')}</Button>
        <span className="text-sm text-muted">{current ? t('label.current', { label: current }) : t('label.currentAll')}</span>
      </div>
      <ErrorText>{saving.error}</ErrorText>
    </div>
  );
}

// ---------- 4. categories + templates ----------
type ClassList = { state: 'off' } | { state: 'loading' } | { state: 'error' } | { state: 'ok'; items: MorningClassification[] };

const classLabel = (c: MorningClassification) => (c.irsCode != null ? `${c.title} (${c.irsCode})` : c.title);

/** Morning's expense categories for the picker; 'off' until Morning credentials are saved. */
function useMorningClassifications(configured: boolean) {
  const [list, setList] = useState<ClassList>({ state: configured ? 'loading' : 'off' });
  const load = async () => {
    if (!configured) { setList({ state: 'off' }); return; }
    setList({ state: 'loading' });
    try { setList({ state: 'ok', items: (await api.morningClassifications()).classifications }); } catch { setList({ state: 'error' }); }
  };
  useEffect(() => { void load(); }, [configured]);
  return { list, reload: load };
}

/** A dropdown of Morning's categories when the list loaded; otherwise the free-text id field it replaces. */
function ClassificationPicker({ value, list, onChange }: { value: string; list: ClassList; onChange: (v: string) => void }) {
  if (list.state !== 'ok' || list.items.length === 0) {
    return <input aria-label={t('cat.classification')} className={`${inputCls} ltr`} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  const known = !value || list.items.some((c) => c.id === value);
  return (
    <select aria-label={t('cat.classification')} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('cat.classificationNone')}</option>
      {!known && <option value={value}>{t('cat.classificationUnknown', { id: value })}</option>}
      {list.items.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
    </select>
  );
}

export function CategoriesSection() {
  const { s, save } = useSettings();
  const st = s.settings;
  const [cats, setCats] = useState<Category[]>(st.categories);
  const [root, setRoot] = useState(st.storageRoot);
  const [folderT, setFolderT] = useState(st.folderTemplate);
  const [fileT, setFileT] = useState(st.filenameTemplate);
  const [newName, setNewName] = useState('');
  const saving = useAction();
  const [saved, setSaved] = useState(false);
  const morning = useMorningClassifications(s.secrets.morning_id && s.secrets.morning_secret);

  const draft: Settings = { ...st, categories: cats, storageRoot: root, folderTemplate: folderT, filenameTemplate: fileT };
  const example = useMemo(() => {
    const year = new Date().getFullYear();
    const sample: ExtractedFields = {
      vendorName: t('cat.sampleVendor'), vendorTaxId: null, docType: 'tax_invoice', docNumber: '1001',
      issueDate: `${year}-03-15`, total: 118, vat: 18, net: 100, currency: st.currency, allocationNumber: null,
      description: t('cat.sampleDescription'), category: cats[0]?.name ?? null,
    };
    try { return `${buildFolder(sample, draft)}/${buildFilename(sample, draft)}`; } catch { return null; }
  }, [cats, root, folderT, fileT]);

  const names = cats.map((c) => c.name.trim());
  const valid = names.every(Boolean) && new Set(names).size === names.length && folderT.trim() && fileT.trim();
  const setCat = (i: number, patch: Partial<Category>) => { setCats(cats.map((c, j) => (j === i ? { ...c, ...patch } : c))); setSaved(false); };
  const [fromMorning, setFromMorning] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const useMorning = () => {
    if (morning.list.state !== 'ok') return;
    const r = mergeMorningCategories(cats, morning.list.items);
    setCats(r.cats); setFromMorning(r.added); setSaved(false);
  };
  const add = () => { if (!newName.trim() || names.includes(newName.trim())) return; setCats([...cats, { name: newName.trim(), sendToAccounting: true }]); setNewName(''); setSaved(false); };

  const doSave = () => saving.run(async () => {
    const categories = cats.map((c) => {
      const out: Category = { name: c.name.trim(), sendToAccounting: c.sendToAccounting };
      if (c.accountingClassification?.trim()) out.accountingClassification = c.accountingClassification.trim();
      return out;
    });
    await save({ categories, storageRoot: root.trim(), folderTemplate: folderT.trim(), filenameTemplate: fileT.trim() });
    setSaved(true);
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('cat.intro')}</p>
      {morning.list.state === 'ok' && morning.list.items.length > 0 && (
        <div className="space-y-2 rounded-xl bg-ground p-3">
          <div className="text-sm font-semibold">{t('cat.fromMorning.title')}</div>
          <p className={hintCls}>{t('cat.fromMorning.hint', { n: morning.list.items.length })}</p>
          <Button variant="secondary" className="bg-white" onClick={useMorning}>{t('cat.fromMorning.button')}</Button>
          {fromMorning !== null && (
            <Notice tone={fromMorning > 0 ? 'ok' : 'info'}>
              {fromMorning > 0 ? t('cat.fromMorning.added', { n: fromMorning }) : t('cat.fromMorning.none')}
            </Notice>
          )}
        </div>
      )}
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[32rem] text-sm">
          <thead><tr>
            <th className={th}>{t('cat.name')}</th>
            <th className={`${th} text-center`}>{t('cat.send')}</th>
            <th className={th}>{t('cat.classification')}</th>
            <th className={th} />
          </tr></thead>
          <tbody>
            {cats.map((c, i) => (
              <tr key={i}>
                <td className={td}><input aria-label={t('cat.name')} className={inputCls} value={c.name} onChange={(e) => setCat(i, { name: e.target.value })} /></td>
                <td className={`${td} text-center`}><input type="checkbox" className="size-5" checked={c.sendToAccounting} onChange={(e) => setCat(i, { sendToAccounting: e.target.checked })} aria-label={t('cat.send')} /></td>
                <td className={td}><ClassificationPicker value={c.accountingClassification ?? ''} list={morning.list} onChange={(v) => setCat(i, { accountingClassification: v })} /></td>
                <td className={td}><Button variant="ghost" onClick={() => { setCats(cats.filter((_, j) => j !== i)); setSaved(false); }}>{t('cat.remove')}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {morning.list.state === 'off' && <span>{t('cat.classificationsNeedMorning')}</span>}
        {morning.list.state === 'loading' && <span>{t('cat.classificationsLoading')}</span>}
        {morning.list.state === 'error' && <span className="rounded-lg bg-warn-tint px-2 py-1 text-ink">{t('cat.classificationsUnavailable')}</span>}
        {morning.list.state !== 'off' && (
          <Button variant="ghost" disabled={morning.list.state === 'loading'} onClick={() => void morning.reload()}>{t('cat.classificationsRefresh')}</Button>
        )}
      </div>
      <div className="flex gap-2">
        <input aria-label={t('cat.newName')} className={inputCls} placeholder={t('cat.newName')} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button variant="secondary" disabled={!newName.trim()} onClick={add}>{t('cat.add')}</Button>
      </div>

      <div className="grid gap-3">
        <div>
          <Field label={t('cat.root')} hint={t('cat.rootHint')}>
            <input className={`${inputCls} ltr`} value={root} onChange={(e) => { setRoot(e.target.value); setSaved(false); }} />
          </Field>
          {/* Outside the label: its buttons must not focus the input. */}
          <div className="mt-2">
            {browsing
              ? <FolderPicker value={root} onPick={(p) => { setRoot(p); setSaved(false); }} onClose={() => setBrowsing(false)} />
              : (
                <Button variant="secondary" disabled={!s.secrets.dropbox_refresh} onClick={() => setBrowsing(true)}>
                  <Icon name="folder" />{t('folders.browse')}
                </Button>
              )}
          </div>
        </div>
        <Field label={t('cat.folderTemplate')}>
          <input className={`${inputCls} ltr font-mono`} value={folderT} onChange={(e) => { setFolderT(e.target.value); setSaved(false); }} />
        </Field>
        <Field label={t('cat.filenameTemplate')} hint={t('cat.placeholders')}>
          <input className={`${inputCls} ltr font-mono`} value={fileT} onChange={(e) => { setFileT(e.target.value); setSaved(false); }} />
        </Field>
        <div className="rounded-xl bg-ok-tint p-3 text-sm">
          <span className="font-semibold">{t('cat.example')}</span>{' '}
          {example ? <bdi className="ltr inline-block break-all font-mono text-xs">{example}</bdi> : <span className="font-semibold text-alert-deep">{t('cat.exampleError')}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={!valid || saving.busy} onClick={doSave}>{saving.busy ? t('common.saving') : t('common.save')}</Button>
        <Saved show={saved} />
      </div>
      <ErrorText>{saving.error}</ErrorText>
    </div>
  );
}

// ---------- general (settings page only) ----------
export function GeneralSection() {
  const { s, save } = useSettings();
  const st = s.settings;
  const [f, setF] = useState({ vatRate: String(st.vatRate), currency: st.currency, currencyLabel: st.currencyLabel, pollMinutes: String(st.pollMinutes), timezone: st.timezone });
  const saving = useAction();
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setSaved(false); };
  const doSave = () => saving.run(async () => {
    await save({ vatRate: Number(f.vatRate), currency: f.currency.trim(), currencyLabel: f.currencyLabel.trim(), pollMinutes: Number(f.pollMinutes), timezone: f.timezone.trim() });
    setSaved(true);
  });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('settings.vatRate')}><input inputMode="decimal" className={`${inputCls} ltr`} value={f.vatRate} onChange={set('vatRate')} /></Field>
        <Field label={t('settings.pollMinutes')}><input inputMode="numeric" className={`${inputCls} ltr`} value={f.pollMinutes} onChange={set('pollMinutes')} /></Field>
        <Field label={t('settings.currency')}><input className={`${inputCls} ltr`} value={f.currency} onChange={set('currency')} /></Field>
        <Field label={t('settings.currencyLabel')}><input className={inputCls} value={f.currencyLabel} onChange={set('currencyLabel')} /></Field>
        <Field label={t('settings.timezone')}><input className={`${inputCls} ltr`} value={f.timezone} onChange={set('timezone')} /></Field>
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={saving.busy} onClick={doSave}>{saving.busy ? t('common.saving') : t('common.save')}</Button>
        <Saved show={saved} />
      </div>
      <ErrorText>{saving.error}</ErrorText>
    </div>
  );
}


// ---------- telegram bot (settings page only) ----------
/** The shared bot: one tap makes a pairing link; pressing Start in that chat connects it. */
function SharedBot() {
  const { s, save, app } = useSettings();
  const url = s.settings.telegramRelayUrl;
  const status = useLoad(() => api.relayStatus(), [url, s.secrets.telegram_relay_auth]);
  const [link, setLink] = useState<string | null>(null);
  const [before, setBefore] = useState(0);
  const [invite, setInvite] = useState('');
  const [addr, setAddr] = useState(url);
  const connect = useAction();
  const saving = useAction();
  const [saved, setSaved] = useState(false);
  const st = status.data;
  const chats = st?.chats ?? [];

  // While the link is out, watch for the chat to appear; then the link has done its job.
  useEffect(() => {
    if (!link) return;
    const id = setInterval(() => { void status.reload(); }, 3000);
    return () => clearInterval(id);
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (link && chats.length > before) setLink(null); }, [link, chats.length, before]);

  const start = () => connect.run(async () => {
    setBefore(chats.length);
    const r = await api.relayConnect(invite.trim() || undefined);
    setLink(r.url);
    await app.refreshSettings();
  });
  const unlink = (id: string) => connect.run(async () => { await api.relayUnlink(id); await status.reload(); });
  const saveAddr = () => saving.run(async () => { await save({ telegramRelayUrl: addr.trim() }); setLink(null); setSaved(true); });

  return (
    <div className="space-y-3">
      {!url && <Notice>{t('telegram.relayNone')}</Notice>}
      {url && (
        <div className="space-y-2">
          {st?.botUsername && <p className="text-sm">{t('telegram.bot')} <bdi className="ltr font-medium">@{st.botUsername}</bdi></p>}
          {st?.error && <ErrorText>{tDyn(`error.${st.error}`, 'error.relay_rejected')}</ErrorText>}
          <div className="text-base font-semibold">{t('telegram.linked')}</div>
          {chats.length === 0 && <p className={hintCls}>{t('telegram.linkedNone')}</p>}
          <ul>
            {chats.map((c) => (
              <li key={c.id} className={`flex items-center justify-between gap-2 py-1.5 ${rowCls}`}>
                <span className="flex min-w-0 items-center gap-2 text-sm"><Check ok labels={[t('common.connected'), t('common.notConnected')]} /><bdi className="truncate font-medium">{c.name || t('telegram.chatNoName')}</bdi></span>
                <Button variant="ghost" disabled={connect.busy} onClick={() => unlink(c.id)}>{t('telegram.remove')}</Button>
              </li>
            ))}
          </ul>
          {!s.secrets.telegram_relay_auth && (
            <input aria-label={t('telegram.invite')} placeholder={t('telegram.invite')} className={`${inputCls} ltr max-w-72`} autoComplete="off"
              value={invite} onChange={(e) => setInvite(e.target.value)} />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {link
              ? <a href={link} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-deep"><Icon name="out" />{t('telegram.open')}</a>
              : <Button disabled={connect.busy} onClick={start}>{connect.busy ? t('telegram.connecting') : t('telegram.connect')}</Button>}
          </div>
          {link && <p className={hintCls}>{t('telegram.openHint')}</p>}
          <ErrorText>{connect.error}</ErrorText>
        </div>
      )}
      <Field label={t('telegram.relayUrl')} hint={t('telegram.relayUrlHint')}>
        <div className="flex gap-2">
          <input className={`${inputCls} ltr`} inputMode="url" placeholder="https://" value={addr} onChange={(e) => { setAddr(e.target.value); setSaved(false); }} />
          <Button variant="secondary" disabled={saving.busy || addr.trim() === url} onClick={saveAddr}>{saving.busy ? t('common.saving') : t('common.save')}</Button>
        </div>
      </Field>
      <Saved show={saved} />
      <ErrorText>{saving.error}</ErrorText>
    </div>
  );
}

export function TelegramSection() {
  const { s, save, saveSecret } = useSettings();
  const ids = s.settings.telegramChatIds;
  const [id, setId] = useState('');
  const [bot, setBot] = useState<string | null>(null);
  const saving = useAction();
  const test = useAction();
  const clean = id.trim();
  const valid = /^-?\d{1,20}$/.test(clean) && !ids.includes(clean);
  const add = () => saving.run(async () => { await save({ telegramChatIds: [...ids, clean] }); setId(''); });
  const remove = (x: string) => saving.run(() => save({ telegramChatIds: ids.filter((i) => i !== x) }));
  const runTest = () => test.run(async () => {
    setBot(null);
    const r = await api.testTelegram();
    if (!r.ok) throw new Error(r.error || t('error.generic'));
    setBot(r.username ? `@${r.username}` : '');
  });
  const own = s.secrets.telegram_bot_token || ids.length > 0;
  return (
    <div className="space-y-4">
      <p className={hintCls}>{t('telegram.hint')}</p>
      <SharedBot />

      <div className="space-y-3 rounded-xl bg-ground p-3">
        <div className="text-base font-semibold">{t('telegram.own')}</div>
        <p className={hintCls}>{t('telegram.ownHint')}</p>
        <SecretInput label={t('telegram.token')} configured={s.secrets.telegram_bot_token} onSave={(v) => saveSecret('telegram_bot_token', v)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" className="bg-white" disabled={test.busy || !s.secrets.telegram_bot_token} onClick={runTest}>
            {test.busy ? t('telegram.testing') : t('telegram.test')}
          </Button>
          {bot !== null && <span className="text-sm font-medium text-accent-deep">{t('telegram.testOk')} <bdi className="ltr">{bot}</bdi></span>}
        </div>
        <ErrorText>{test.error}</ErrorText>

        <div className="space-y-2 pt-1">
          <div className="text-sm font-semibold">{t('telegram.chats')}</div>
          <p className={hintCls}>{t('telegram.chatsHint')}</p>
          {own && ids.length === 0 && <Notice tone="warn">{t('telegram.none')}</Notice>}
          <ul>
            {ids.map((x) => (
              <li key={x} className={`flex items-center justify-between gap-2 py-1.5 ${rowCls}`}>
                <bdi className="ltr num font-mono text-sm">{x}</bdi>
                <Button variant="ghost" disabled={saving.busy} onClick={() => remove(x)}>{t('telegram.remove')}</Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input aria-label={t('telegram.chatId')} placeholder={t('telegram.chatId')} inputMode="numeric" className={`${inputCls} ltr max-w-56`}
              value={id} onChange={(e) => setId(e.target.value)} />
            <Button variant="secondary" className="bg-white" disabled={!valid || saving.busy} onClick={add}>{t('telegram.add')}</Button>
          </div>
          <ErrorText>{saving.error}</ErrorText>
        </div>
      </div>
    </div>
  );
}
