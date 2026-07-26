'use client';

import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InfoTooltip from '@/components/ui/tooltip';
import { addKeyword, listKeywords, type KeywordRecord } from '@/lib/hub-client';
import { useOrgContext } from '@/lib/org-context';

export function KeywordsSection(): JSX.Element | null {
  const { activeOrg } = useOrgContext();
  const orgId = activeOrg?.org_id;
  const sectionRef = useRef<HTMLElement>(null);

  const [keywords, setKeywords] = useState<KeywordRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);

  const loadCurrentKeywords = useCallback(async (targetOrgId: string) => {
    const result = await listKeywords(targetOrgId);
    setKeywords(result);
    setLoadError(null);
  }, []);

  useEffect(() => {
    if (window.location.hash === '#keywords') {
      sectionRef.current?.scrollIntoView({ block: 'start' });
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (!orgId) {
      return () => {
        active = false;
      };
    }

    setKeywords(null);
    setLoadError(null);

    void listKeywords(orgId)
      .then((result) => {
        if (!active) {
          return;
        }
        setKeywords(result);
        setLoadError(null);
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setKeywords([]);
        setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      active = false;
    };
  }, [orgId]);

  const sortedKeywords = useMemo(() => {
    if (!keywords) {
      return [];
    }
    return [...keywords].sort((left, right) => {
      if (left.deprecated !== right.deprecated) {
        return left.deprecated ? 1 : -1;
      }
      return left.keyword.localeCompare(right.keyword);
    });
  }, [keywords]);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!orgId || !draft.trim()) {
      return;
    }

    setSaving(true);
    setAddError(null);
    setAddSuccess(null);

    let added: Awaited<ReturnType<typeof addKeyword>>;
    try {
      added = await addKeyword(orgId, draft);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
      setSaving(false);
      return;
    }

    setDraft('');
    setAddSuccess(`Added "${added.keyword}".`);

    try {
      await loadCurrentKeywords(orgId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }

    setSaving(false);
  }, [draft, loadCurrentKeywords, orgId]);

  if (!orgId) {
    return null;
  }

  return (
    <section id="keywords" ref={sectionRef} className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm scroll-mt-6" data-testid="keywords-section">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-wv-text">Keywords</h2>
        <InfoTooltip label="Org taxonomy for extraction and recall conformity.">
          Org taxonomy used for memory extraction and recall conformity across your organization.
        </InfoTooltip>
      </div>
      <p className="mt-1 text-sm text-wv-dim">Leader-only. Keywords seed memory extraction and recall conformity for your org. Without them, extraction is degraded.</p>

      {keywords === null ? (
        <p className="mt-4 text-xs text-wv-dim">Loading keywords…</p>
      ) : sortedKeywords.length === 0 ? (
        <p className="mt-4 text-sm text-wv-dim">No keywords seeded yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2" data-testid="keywords-list">
          {sortedKeywords.map((k) => (
            <li key={k.keyword} className="flex items-center gap-3 rounded-lg border border-wv-line bg-wv-panel-2 px-3 py-2">
              <span className="font-mono text-sm text-wv-text">{k.keyword}</span>
              <span className="text-xs text-wv-dim">{k.usage_count} uses</span>
              {k.deprecated ? (
                <span className="rounded-full border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] px-2 py-0.5 text-xs font-medium text-wv-amber">Deprecated</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label htmlFor="keywords-add-input" className="block text-sm font-medium text-wv-text">New keyword</label>
            <input
              id="keywords-add-input"
              data-testid="keywords-add-input"
              type="text"
              placeholder="add keyword…"
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              className="mt-2 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
            />
            <p className="mt-2 text-xs text-wv-dim">Lowercase letters, digits, and underscores; must start with a letter; 2–40 characters.</p>
          </div>
          <button
            type="submit"
            data-testid="keywords-add-button"
            disabled={saving || draft.trim().length === 0}
            className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {saving ? 'Adding…' : 'Add keyword'}
          </button>
        </form>
      </div>

      {loadError ? (
        <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{loadError}</div>
      ) : null}
      {addError ? (
        <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{addError}</div>
      ) : null}
      {addSuccess ? (
        <div className="mt-4 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green break-all">{addSuccess}</div>
      ) : null}
    </section>
  );
}
