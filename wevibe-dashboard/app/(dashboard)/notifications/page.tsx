'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from '@/lib/hub-client';

export default function NotificationsPage() {
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
      <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-16 text-center text-sm text-zinc-500">
        Loading notification preferences...
      </div>
    );
  }

  if (!prefs) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
        Unable to load notification preferences.
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Notification Preferences</h1>
        <p className="text-sm text-zinc-500">Choose where activity notifications are delivered.</p>
      </header>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
      {success && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div>}

      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-zinc-900">Email</h2>
          <label className="inline-flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={prefs.email_enabled}
              onChange={(event) => setPrefs({ ...prefs, email_enabled: event.target.checked })}
              className="h-4 w-4 rounded border-zinc-300"
            />
            Enabled
          </label>
        </div>
        <input
          type="email"
          placeholder="you@example.com"
          value={prefs.email_address}
          onChange={(event) => setPrefs({ ...prefs, email_address: event.target.value })}
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {categories.map((category) => (
            <label key={`email-${category}`} className="inline-flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={prefs.email_categories.includes(category)}
                onChange={() => toggleCategory('email', category)}
                className="h-4 w-4 rounded border-zinc-300"
              />
              {category}
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-zinc-900">Webhook</h2>
          <label className="inline-flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={prefs.webhook_enabled}
              onChange={(event) => setPrefs({ ...prefs, webhook_enabled: event.target.checked })}
              className="h-4 w-4 rounded border-zinc-300"
            />
            Enabled
          </label>
        </div>
        <input
          type="url"
          placeholder="https://example.com/wevibe/webhook"
          value={prefs.webhook_url}
          onChange={(event) => setPrefs({ ...prefs, webhook_url: event.target.value })}
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {categories.map((category) => (
            <label key={`webhook-${category}`} className="inline-flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={prefs.webhook_categories.includes(category)}
                onChange={() => toggleCategory('webhook', category)}
                className="h-4 w-4 rounded border-zinc-300"
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
          className="inline-flex items-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Saving...' : 'Save Preferences'}
        </button>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={saving || testing}
          className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {testing ? 'Sending Test...' : 'Send Test Notification'}
        </button>
      </div>
    </div>
  );
}
