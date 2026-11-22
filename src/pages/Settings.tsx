import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { AiSection, CategoriesSection, ConnectionsSection, GeneralSection, LabelSection, ResetSection, TelegramSection } from '../components/SettingsSections.js';
import { ButtonLink, Card, Notice, PageTitle, useApp } from '../components/ui.js';
import { t } from '../i18n/he.js';
import { connectedName } from '../Layout.js';
import type { MessageKey } from '../i18n/he.js';

const SECTIONS: { id: string; key: MessageKey; body: () => ReactNode }[] = [
  { id: 'connections', key: 'settings.connections', body: () => <ConnectionsSection /> },
  { id: 'ai', key: 'settings.ai', body: () => <AiSection /> },
  { id: 'label', key: 'settings.label', body: () => <LabelSection /> },
  { id: 'telegram', key: 'settings.telegram', body: () => <TelegramSection /> },
  { id: 'categories', key: 'settings.categories', body: () => <CategoriesSection /> },
  { id: 'general', key: 'settings.general', body: () => <GeneralSection /> },
  { id: 'reset', key: 'settings.reset', body: () => <ResetSection /> },
];

/** Which section is on screen: the last one whose top has passed the menu. */
function useActiveSection(): string {
  const [active, setActive] = useState(SECTIONS[0]!.id);
  useEffect(() => {
    const onScroll = () => {
      const line = 140; // just under the sticky menu
      let cur = SECTIONS[0]!.id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) cur = s.id;
      }
      // At the very bottom the last (short) section can never reach the line: count it as reached.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1]!.id;
      setActive(cur);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return active;
}

/** Everything from setup, editable later (incl. switching AI off). */
export default function Settings() {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const connected = params.get('connected');
  const { refreshSettings } = useApp();
  const active = useActiveSection();
  useEffect(() => { if (connected) void refreshSettings(); }, [connected, refreshSettings]);
  // A link to /settings#categories lands on that section.
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView(); }, [hash]);

  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(window.history.state, '', `#${id}`);
  };

  return (
    <div className="space-y-4">
      <PageTitle actions={<ButtonLink to="/setup" variant="ghost">{t('settings.setup')}</ButtonLink>}>{t('settings.title')}</PageTitle>
      {connected && <Notice tone="ok">{t('setup.connectedToast', { name: connectedName(connected) })}</Notice>}

      {/* Section menu: stays under the phone header / at the top on desktop; scrolls sideways on a phone. */}
      <nav aria-label={t('settings.menu')} className="sticky top-14 z-10 -mx-4 bg-ground/95 px-4 py-2 backdrop-blur md:top-0 md:-mx-2 md:px-2">
        <ul className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {SECTIONS.map((s) => (
            <li key={s.id} className="shrink-0">
              <a href={`#${s.id}`} aria-current={active === s.id ? 'true' : undefined}
                onClick={(e) => { e.preventDefault(); go(s.id); }}
                className={`inline-flex min-h-9 items-center rounded-full px-3.5 text-sm transition-colors ${active === s.id ? 'bg-accent font-semibold text-white' : 'bg-white font-medium shadow-soft hover:bg-accent-tint'}`}>
                {t(s.key)}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {SECTIONS.map((s) => <Card key={s.id} id={s.id} className="scroll-mt-32 md:scroll-mt-16" title={t(s.key)}>{s.body()}</Card>)}
    </div>
  );
}
