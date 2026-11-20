import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { t } from '../i18n/he.js';
import { Button, ErrorText, hintCls, Icon, inputCls, Loading, Notice, rowCls } from './ui.js';

type Folder = { name: string; path: string };
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const clean = (p: string) => p.trim().replace(/\/{2,}/g, '/').replace(/\/$/, '');

/**
 * Browses the Dropbox one folder at a time and hands back the chosen path. Starts where `value` points when that
 * folder exists, else at the top. A new folder name only extends the path: Dropbox creates it on the first filing.
 */
export function FolderPicker({ value, onPick, onClose }: { value: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(clean(value));
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missingStart, setMissingStart] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    let live = true;
    setFolders(null); setError(null);
    api.dropboxFolders(path).then(
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

  const crumbs = path.split('/').filter(Boolean);
  const newClean = newName.trim().replace(/[/\\]/g, '');
  const pick = (p: string) => { onPick(p); onClose(); };

  return (
    <div className="space-y-3 rounded-xl border border-line bg-white p-3">
      {missingStart && <Notice tone="warn">{t('folders.missingStart', { path: missingStart })}</Notice>}

      {/* Where we are: every level is a step back up. */}
      <nav aria-label={t('folders.browse')} className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" onClick={() => setPath('')} className="min-h-8 rounded-lg px-1.5 font-semibold text-accent hover:bg-accent-tint">{t('folders.top')}</button>
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
          : folders === null ? <Loading />
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

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!!error && path !== ''} onClick={() => pick(path)}>
          {path ? t('folders.chooseNamed', { path }) : t('folders.choose')}
        </Button>
        <Button variant="ghost" className="ms-auto" onClick={onClose}>{t('folders.close')}</Button>
      </div>

      <div className="space-y-1 border-t border-line pt-3">
        <div className="flex gap-2">
          <input aria-label={t('folders.new')} placeholder={t('folders.newPlaceholder')} className={inputCls}
            value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button variant="secondary" disabled={!newClean} onClick={() => pick(`${path}/${newClean}`)}>{t('folders.useNew')}</Button>
        </div>
        <p className={hintCls}>{t('folders.newHint')}</p>
      </div>
    </div>
  );
}
