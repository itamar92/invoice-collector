import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AiSection, CategoriesSection, ConnectionsSection, GeneralSection, LabelSection, TelegramSection } from '../components/SettingsSections.js';
import { ButtonLink, Card, Notice, PageTitle, useApp } from '../components/ui.js';
import { t } from '../i18n/he.js';

/** Everything from setup, editable later (incl. switching AI off). */
export default function Settings() {
  const [params] = useSearchParams();
  const connected = params.get('connected');
  const { refreshSettings } = useApp();
  useEffect(() => { if (connected) void refreshSettings(); }, [connected, refreshSettings]);
  return (
    <div className="space-y-4">
      <PageTitle actions={<ButtonLink to="/setup" variant="ghost">{t('settings.setup')}</ButtonLink>}>{t('settings.title')}</PageTitle>
      {connected && <Notice tone="ok">{t('setup.connectedToast', { name: connected === 'google' ? t('conn.gmail') : t('conn.dropbox') })}</Notice>}
      <Card title={t('settings.connections')}><ConnectionsSection /></Card>
      <Card title={t('settings.ai')}><AiSection /></Card>
      <Card title={t('settings.label')}><LabelSection /></Card>
      <Card title={t('settings.telegram')}><TelegramSection /></Card>
      <Card title={t('settings.categories')}><CategoriesSection /></Card>
      <Card title={t('settings.general')}><GeneralSection /></Card>
    </div>
  );
}
