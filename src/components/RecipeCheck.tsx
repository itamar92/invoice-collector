import type { RecipeCheck } from '../api.js';
import { fmtDate } from './ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

const show = (field: string, v: string | number | null): string =>
  v === null ? '—' : field === 'issueDate' ? fmtDate(String(v)) : String(v);

/**
 * What a recipe read from one document, field by field, next to the document's values: shows which field it
 * missed, and the text it ran on, so the owner can tell a bad recipe from a wrong value on the document.
 */
export function RecipeCheckView({ check, text }: { check: RecipeCheck; text?: string }) {
  const missed = check.fields.filter((f) => !f.ok);
  const notFound = missed.some((f) => f.got === null);
  return (
    <div className="space-y-1.5 text-xs">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-muted">
            <th className="px-2 py-1 text-start font-semibold">{t('recipeCheck.field')}</th>
            <th className="px-2 py-1 text-start font-semibold">{t('recipeCheck.expected')}</th>
            <th className="px-2 py-1 text-start font-semibold">{t('recipeCheck.got')}</th>
            <th className="w-6" />
          </tr>
        </thead>
        <tbody>
          {check.fields.map((f) => (
            <tr key={f.field} className="border-t border-line">
              <td className="px-2 py-1">{t(`field.${f.field}` as MessageKey)}{!f.required && <span className="text-muted"> {t('recipeCheck.optional')}</span>}</td>
              <td className="num px-2 py-1">{show(f.field, f.expected)}</td>
              <td className={`num px-2 py-1 ${f.ok ? '' : 'font-semibold text-alert-deep'}`}>{show(f.field, f.got)}</td>
              <td className="py-1 text-center" aria-label={f.ok ? t('recipeCheck.match') : t('recipeCheck.mismatch')}>{f.ok ? '✓' : '✗'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {missed.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5 text-muted">
          <li>{t('recipeCheck.tipExpected')}</li>
          {notFound && <li>{t('recipeCheck.tipNotFound')}</li>}
          <li>{t('recipeCheck.tipMirrored')}</li>
        </ul>
      )}
      {text !== undefined && (
        <details>
          <summary className="cursor-pointer font-semibold text-accent">{t('recipeCheck.text')}</summary>
          <p className="mt-1 text-muted">{t('recipeCheck.textHint')}</p>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-2 text-[11px]">{text}</pre>
        </details>
      )}
    </div>
  );
}
