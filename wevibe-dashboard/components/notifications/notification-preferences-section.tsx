'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from '@/lib/hub-client';

export function NotificationPreferencesSection() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getNotificationPreferences();
      setPrefs(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => prefs?.supported_categories ?? [], [prefs]);

  const toggleCategory = (channel: 'email' | 'webhook', category: string) => {
    if (!prefs) return;
    const key = channel === 'email' ? 'email_categories' : 'webhook_categories';
    const current = new Set(prefs[key]);
    if (current.has(category)) current.delete(category);
    else current.add(category);
    setPrefs({ ...prefs, [key]: Array.from(current) });
  };

  const handleSave = async () => {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await updateNotificationPreferences({
        email_address: prefs.email_address,
        email_enabled: prefs.email_enabled,
        email_categories: prefs.email_categories,
        webhook_url: prefs.webhook_url,
        webhook_enabled: prefs.webhook_enabled,
        webhook_categories: prefs.webhook_categories,
      });
      setPrefs(response);
      setSuccess('Notification preferences saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!prefs) return;
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await updateNotificationPreferences({
        email_address: prefs.email_address,
        email_enabled: prefs.email_enabled,
        email_categories: prefs.email_categories,
        webhook_url: prefs.webhook_url,
        webhook_enabled: prefs.webhook_enabled,
        webhook_categories: prefs.webhook_categories,
        send_test: true,
      });
      setPrefs(response);
      if (response.test_sent) {
        setSuccess('Test notification sent. Check activity, email, and webhook receiver.');
      } else {
        setSuccess('Preferences saved, but test dispatch was skipped.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <div className="space-y-4">
          <header>
            <h2 className="text-lg font-semibold text-wv-text">Notification Preferences</h2>
            <p className="mt-1 text-sm text-wv-dim">Choose how you're notified about org activity.</p>
          </header>
          <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
            Loading notification preferences...
          </div>
        </div>
      </section>
    );
  }

  if (!prefs) {
    return (
      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <div className="space-y-4">
          <header>
            <h2 className="text-lg font-semibold text-wv-text">Notification Preferences</h2>
            <p className="mt-1 text-sm text-wv-dim">Choose how you're notified about org activity.</p>
          </header>
          <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
            Unable to load notification preferences.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
      <div className="space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-wv-text">Notification Preferences</h2>
          <p className="mt-1 text-sm text-wv-dim">Choose how you're notified about org activity.</p>
        </header>

        {error && <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">{error}</div>}
        {success && <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-3 text-sm text-wv-green">{success}</div>}

        <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-wv-text">Email</h2>
            <label className="inline-flex items-center gap-2 text-sm text-wv-text">
              <input
                type="checkbox"
                checked={prefs.email_enabled}
                onChange={(event) => setPrefs({ ...prefs, email_enabled: event.target.checked })}
                className="h-4 w-4 rounded border-wv-line-2 bg-wv-panel-2"
              />
              Enabled
            </label>
          </div>
          <input
            type="email"
            placeholder="you@example.com"
            value={prefs.email_address}
            onChange={(event) => setPrefs({ ...prefs, email_address: event.target.value })}
            className="w-full rounded-lg bg-wv-panel-2 border border-wv-line-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {categories.map((category) => (
              <label key={`email-${category}`} className="inline-flex items-center gap-2 text-sm font-mono text-wv-text">
                <input
                  type="checkbox"
                  checked={prefs.email_categories.includes(category)}
                  onChange={() => toggleCategory('email', category)}
                  className="h-4 w-4 rounded border-wv-line-2 bg-wv-panel-2"
                />
                {category}
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-wv-text">Webhook</h2>
            <label className="inline-flex items-center gap-2 text-sm text-wv-text">
              <input
                type="checkbox"
                checked={prefs.webhook_enabled}
                onChange={(event) => setPrefs({ ...prefs, webhook_enabled: event.target.checked })}
                className="h-4 w-4 rounded border-wv-line-2 bg-wv-panel-2"
              />
              Enabled
            </label>
          </div>
          <input
            type="url"
            placeholder="https://example.com/wevibe/webhook"
            value={prefs.webhook_url}
            onChange={(event) => setPrefs({ ...prefs, webhook_url: event.target.value })}
            className="w-full rounded-lg bg-wv-panel-2 border border-wv-line-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {categories.map((category) => (
              <label key={`webhook-${category}`} className="inline-flex items-center gap-2 text-sm font-mono text-wv-text">
                <input
                  type="checkbox"
                  checked={prefs.webhook_categories.includes(category)}
                  onChange={() => toggleCategory('webhook', category)}
                  className="h-4 w-4 rounded border-wv-line-2 bg-wv-panel-2"
                />
                {category}
              </label>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || testing}
            className="inline-flex items-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-dim shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={saving || testing}
            className="inline-flex items-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:shadow-glow-v disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testing ? 'Sending Test...' : 'Send Test Notification'}
          </button>
        </div>
      </div>
    </section>
  );
}
