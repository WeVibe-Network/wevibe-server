'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  listKeywords,
  addKeyword,
  mergeKeywords,
  renameKeyword,
  deprecateKeyword,
  type KeywordRecord,
} from '@/lib/hub-client';
import ClientTime from '@/components/ui/client-time';

const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID ?? '';

export default function KeywordsPage() {
  const [keywords, setKeywords] = useState<KeywordRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [newKeyword, setNewKeyword] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');

  const [mergeSource, setMergeSource] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeSuccess, setMergeSuccess] = useState('');

  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameError, setRenameError] = useState('');

  const [deprecateTarget, setDeprecateTarget] = useState<string | null>(null);
  const [deprecateLoading, setDeprecateLoading] = useState(false);

  async function refreshKeywords() {
    setLoading(true);
    setError('');
    try {
      const data = await listKeywords(ORG_ID);
      setKeywords(data ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!ORG_ID) {
      setLoading(false);
      return;
    }
    refreshKeywords();
  }, []);

  const handleAdd = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyword.trim()) return;
    setAddLoading(true);
    setAddError('');
    setAddSuccess('');
    try {
      await addKeyword(ORG_ID, newKeyword.trim());
      setAddSuccess(`Keyword "${newKeyword.trim()}" added`);
      setNewKeyword('');
      await refreshKeywords();
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAddLoading(false);
    }
  }, [newKeyword]);

  const handleMerge = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mergeSource.trim() || !mergeTarget.trim()) return;
    setMergeLoading(true);
    setMergeError('');
    setMergeSuccess('');
    try {
      await mergeKeywords(ORG_ID, mergeSource.trim(), mergeTarget.trim());
      setMergeSuccess(`Merged "${mergeSource.trim()}" into "${mergeTarget.trim()}"`);
      setMergeSource('');
      setMergeTarget('');
      await refreshKeywords();
    } catch (err) {
      setMergeError((err as Error).message);
    } finally {
      setMergeLoading(false);
    }
  }, [mergeSource, mergeTarget]);

  const handleRename = useCallback(async (oldName: string) => {
    if (!renameValue.trim() || renameValue.trim() === oldName) {
      setRenameTarget(null);
      return;
    }
    setRenameLoading(true);
    setRenameError('');
    try {
      await renameKeyword(ORG_ID, oldName, renameValue.trim());
      setRenameTarget(null);
      setRenameValue('');
      await refreshKeywords();
    } catch (err) {
      setRenameError((err as Error).message);
    } finally {
      setRenameLoading(false);
    }
  }, [renameValue]);

  const handleDeprecate = useCallback(async (keyword: string) => {
    setDeprecateLoading(true);
    try {
      await deprecateKeyword(ORG_ID, keyword);
      setDeprecateTarget(null);
      await refreshKeywords();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeprecateLoading(false);
    }
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Keywords</h1>
        <p className="text-sm text-wv-dim">
          Manage your org&apos;s keyword vocabulary for memory classification and retrieval.
        </p>
      </header>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Add Keyword</h2>
        <form onSubmit={handleAdd} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            data-testid="keyword-add-input"
            type="text"
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            placeholder="Enter keyword"
            className="flex-1 rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm font-mono text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
          />
          <button
            data-testid="keyword-add-button"
            type="submit"
            disabled={addLoading || !newKeyword.trim()}
            className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:shadow-glow-v disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-faint"
          >
            {addLoading ? 'Adding…' : 'Add'}
          </button>
        </form>
        {addError && (
          <div className="mt-3 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{addError}</div>
        )}
        {addSuccess && (
          <div className="mt-3 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green">{addSuccess}</div>
        )}
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Merge Keywords</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Select a source keyword to merge into a target keyword. All memory associations will be transferred.
        </p>
        <form onSubmit={handleMerge} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={mergeSource}
            onChange={e => setMergeSource(e.target.value)}
            placeholder="Source keyword"
            className="flex-1 rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm font-mono text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
          />
          <span className="flex items-center text-sm font-mono text-wv-dim">→</span>
          <input
            type="text"
            value={mergeTarget}
            onChange={e => setMergeTarget(e.target.value)}
            placeholder="Target keyword"
            className="flex-1 rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm font-mono text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
          />
          <button
            data-testid="keyword-merge-button"
            type="submit"
            disabled={mergeLoading || !mergeSource.trim() || !mergeTarget.trim()}
            className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:shadow-glow-v disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-faint"
          >
            {mergeLoading ? 'Merging…' : 'Merge'}
          </button>
        </form>
        {mergeError && (
          <div className="mt-3 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{mergeError}</div>
        )}
        {mergeSuccess && (
          <div className="mt-3 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green">{mergeSuccess}</div>
        )}
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Keyword List</h2>
        <p className="mt-1 text-sm text-wv-dim">
          All keywords in the org vocabulary. Deprecated keywords are no longer used for classification.
        </p>

        {loading ? (
          <p className="mt-4 text-sm text-wv-dim">Loading…</p>
        ) : error ? (
          <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{error}</div>
        ) : keywords.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No keywords defined yet.</p>
        ) : (
          <div data-testid="keyword-list" className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-wv-line text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left font-mono font-semibold text-wv-dim">Keyword</th>
                  <th className="px-3 py-2 text-left font-mono font-semibold text-wv-dim">Status</th>
                  <th className="px-3 py-2 text-left font-mono font-semibold text-wv-dim">Usage</th>
                  <th className="px-3 py-2 text-left font-mono font-semibold text-wv-dim">Created</th>
                  <th className="px-3 py-2 text-right font-mono font-semibold text-wv-dim">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-wv-line">
                {keywords.map(kw => (
                  <tr key={kw.keyword}>
                    <td className="px-3 py-2 font-mono font-medium text-wv-text">{kw.keyword}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        kw.deprecated
                          ? 'bg-wv-panel-2 text-wv-dim'
                          : 'bg-[rgba(54,211,153,0.12)] text-wv-green'
                      }`}>
                        {kw.deprecated ? 'Deprecated' : 'Active'}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-wv-dim">{kw.usage_count}</td>
                    <td className="px-3 py-2 font-mono text-wv-dim"><ClientTime value={kw.created_at} mode="date" /></td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {renameTarget === kw.keyword ? (
                          <div className="flex items-center gap-1">
                            <input
                              data-testid="keyword-rename-input"
                              type="text"
                              defaultValue={kw.keyword}
                              onChange={e => setRenameValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') void handleRename(kw.keyword);
                                if (e.key === 'Escape') setRenameTarget(null);
                              }}
                              className="w-32 rounded border border-wv-line-2 bg-wv-panel-2 px-2 py-1 text-sm font-mono text-wv-text shadow-wv-sm focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]"
                            />
                            <button
                              onClick={() => void handleRename(kw.keyword)}
                              disabled={renameLoading}
                              className="rounded px-2 py-1 text-xs text-wv-violet hover:bg-[rgba(124,92,255,0.12)] disabled:cursor-not-allowed"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setRenameTarget(null)}
                              className="rounded px-2 py-1 text-xs text-wv-dim hover:bg-wv-line"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                setRenameTarget(kw.keyword);
                                setRenameValue(kw.keyword);
                              }}
                              className="rounded px-2 py-1 text-xs text-wv-violet hover:bg-[rgba(124,92,255,0.12)]"
                            >
                              Rename
                            </button>
                            {!kw.deprecated && (
                              <button
                                data-testid="keyword-deprecate-button"
                                onClick={() => setDeprecateTarget(kw.keyword)}
                                className="rounded px-2 py-1 text-xs text-wv-red hover:bg-[rgba(255,107,107,0.12)]"
                              >
                                Deprecate
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deprecateTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-wv-bg/70">
          <div className="w-96 rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-lg">
            <h3 className="text-lg font-semibold text-wv-text">Deprecate Keyword</h3>
            <p className="mt-2 text-sm text-wv-dim">
              Are you sure you want to deprecate &ldquo;{deprecateTarget}&rdquo;? This keyword will no longer be used for classification.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeprecateTarget(null)}
                className="rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-text hover:bg-wv-line"
              >
                Cancel
              </button>
              <button
                data-testid="keyword-deprecate-confirm-button"
                onClick={() => void handleDeprecate(deprecateTarget)}
                disabled={deprecateLoading}
                className="rounded-lg bg-wv-red px-4 py-2 text-sm font-medium text-white hover:shadow-wv-md disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-faint"
              >
                {deprecateLoading ? 'Deprecating…' : 'Deprecate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
