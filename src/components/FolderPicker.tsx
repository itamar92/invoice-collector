import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import type { StorageProvider } from '../api.js';
import { t } from '../i18n/he.js';
import { Button, ErrorText, hintCls, Icon, inputCls, Loading, Notice, rowCls, useAction } from './ui.js';

type Folder = { name: string; path: string };
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const clean = (p: string) => p.trim().replace(/\/{2,}/g, '/').replace(/\/$/, '');

/**
 * Browses the chosen cloud (Dropbox or Google Drive) one folder at a time and hands back the chosen path. Starts
 * where `value` points when that folder exists, else at the top.
 */
export function FolderPicker({ value, provider, onPick, onClose }:
  { value: string; provider: StorageProvider; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(clean(value));
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missingStart, setMissingStart] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const make = useAction();

  useEffect(() => {
    let live = true;
    setFolders(null); setError(null);
    api.storageFolders(path).then(
      (r) => { if (live) setFolders(r.folders); },
      (e: unknown) => {
        if (!live) return;
        // The saved root may not exist yet (it is created on the first filing): show the top instead.
        if (e instanceof ApiError && e.code === 'folder_not_found' && path !== '') { setMissingStart(path); setPath(''); return; }
        setError((e as Error).message);
      },
    );
    return () => { live = false; };
  }, [path]);

  const top = provider === 'gdrive' ? t('folders.top.gdrive') : t('folders.top');
  const crumbs = path.split('/').filter(Boolean);
  const newClean = newName.trim();
  const newBad = /[\\/:*?"<>|]/.test(newClean) || newClean === '.' || newClean === '..' || /[. ]$/.test(newClean);
  const pick = (p: string) => { onPick(p); onClose(); };
  /** Creates the folder in the cloud now and opens it, so it can be picked (or a subfolder made in it). */
  const create = () => make.run(async () => {
    const r = await api.createStorageFolder(path, newClean);
    setNewName(''); setCreated(r.folder.name); setMissingStart(null);
    setPath(r.folder.path);
  });
  useEffect(() => { if (!created) return; const id = setTimeout(() => setCreated(null), 5000); return () => clearTimeout(id); }, [created]);

  return (
    <div className="space-y-3 rounded-xl border border-line bg-white p-3">
      {created && <Notice tone="ok">{t('folders.created', { name: created })}</Notice>}
      {missingStart && <Notice tone="warn">{t('folders.missingStart', { path: missingStart })}</Notice>}

      {/* Where we are: every level is a step back up. */}
      <nav aria-label={t('folders.browse')} className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" onClick={() => setPath('')} className="min-h-8 rounded-lg px-1.5 font-semibold text-accent hover:bg-accent-tint">{top}</button>
        {crumbs.map((c, i) => {
          const to = `/${crumbs.slice(0, i + 1).join('/')}`;
          const last = i === crumbs.length - 1;
          return (
            <span key={to} className="flex items-center gap-1">
              <span className="text-muted">/</span>
              {last
                ? <bdi className="px-1.5 font-semibold" aria-current="location">{c}</bdi>
                : <button type="button" onClick={() => setPath(to)} className="min-h-8 rounded-lg px-1.5 font-semibold text-accent hover:bg-accent-tint"><bdi>{c}</bdi></button>}
            </span>
          );
        })}
      </nav>

      <div className="max-h-72 overflow-y-auto rounded-lg bg-ground px-2">
        {path !== '' && (
          <button type="button" onClick={() => setPath(parentOf(path))} className={`flex min-h-10 w-full items-center gap-2 text-start text-sm text-muted ${rowCls}`}>
            <Icon name="up" className="size-4" />{t('folders.up')}
          </button>
        )}
        {error ? <div className="py-2"><ErrorText>{error}</ErrorText></div>
          : folders === null ? <Loading label={t('folders.loading')} rows={3} />
          : folders.length === 0 ? <p className="py-3 text-sm text-muted">{t('folders.empty')}</p>
          : (
            <ul>
              {folders.map((f) => (
                <li key={f.path} className={rowCls}>
                  <button type="button" onClick={() => setPath(f.path)} aria-label={t('folders.open', { name: f.name })}
                    className="flex min-h-10 w-full items-center gap-2 rounded-lg text-start text-sm font-medium hover:bg-white">
                    <Icon name="folder" className="size-5 text-accent" /><bdi className="truncate">{f.name}</bdi>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>

      {path === '' && provider === 'dropbox' && <Notice>{t('folders.appFolderHint')}</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!!error && path !== ''} onClick={() => pick(path)}>
          {path ? t('folders.chooseNamed', { path }) : t('folders.choose')}
        </Button>
        <Button variant="ghost" className="ms-auto" onClick={onClose}>{t('folders.close')}</Button>
      </div>

      <div className="space-y-1 border-t border-line pt-3">
        <div className="text-[13px] font-medium text-muted">{t('folders.new')}</div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newClean && !newBad && !make.busy && !error) void create(); }}>
          <input aria-label={t('folders.new')} placeholder={t('folders.newPlaceholder')} className={inputCls} maxLength={255}
            value={newName} onChange={(e) => { setNewName(e.target.value); make.setError(null); }} />
          <Button type="submit" variant="secondary" loading={make.busy} disabled={!newClean || newBad || !!error}>
            <Icon name="folder" />{t('folders.create')}
          </Button>
        </form>
        <p className={hintCls}>{newBad ? t('folders.badName') : t('folders.newHint', { where: path || top })}</p>
        <ErrorText>{make.error}</ErrorText>
      </div>
    </div>
  );
}
