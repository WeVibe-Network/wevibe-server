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
        <p className="text-sm text-zinc-500">
          Manage your org&apos;s keyword vocabulary for memory classification and retrieval.
        </p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Add Keyword</h2>
        <form onSubmit={handleAdd} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            data-testid="keyword-add-input"
            type="text"
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            placeholder="Enter keyword"
            className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <button
            data-testid="keyword-add-button"
            type="submit"
            disabled={addLoading || !newKeyword.trim()}
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {addLoading ? 'Adding…' : 'Add'}
          </button>
        </form>
        {addError && (
          <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{addError}</div>
        )}
        {addSuccess && (
          <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{addSuccess}</div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Merge Keywords</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Select a source keyword to merge into a target keyword. All memory associations will be transferred.
        </p>
        <form onSubmit={handleMerge} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={mergeSource}
            onChange={e => setMergeSource(e.target.value)}
            placeholder="Source keyword"
            className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <span className="flex items-center text-sm text-zinc-500">→</span>
          <input
            type="text"
            value={mergeTarget}
            onChange={e => setMergeTarget(e.target.value)}
            placeholder="Target keyword"
            className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <button
            data-testid="keyword-merge-button"
            type="submit"
            disabled={mergeLoading || !mergeSource.trim() || !mergeTarget.trim()}
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {mergeLoading ? 'Merging…' : 'Merge'}
          </button>
        </form>
        {mergeError && (
          <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{mergeError}</div>
        )}
        {mergeSuccess && (
          <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{mergeSuccess}</div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Keyword List</h2>
        <p className="mt-1 text-sm text-zinc-500">
          All keywords in the org vocabulary. Deprecated keywords are no longer used for classification.
        </p>

        {loading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : error ? (
          <div className="mt-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        ) : keywords.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No keywords defined yet.</p>
        ) : (
          <div data-testid="keyword-list" className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Keyword</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Status</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Usage</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Created</th>
                  <th className="px-3 py-2 text-right font-semibold text-zinc-700">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {keywords.map(kw => (
                  <tr key={kw.keyword}>
                    <td className="px-3 py-2 font-medium text-zinc-900">{kw.keyword}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        kw.deprecated
                          ? 'bg-zinc-100 text-zinc-500'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {kw.deprecated ? 'Deprecated' : 'Active'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{kw.usage_count}</td>
                    <td className="px-3 py-2 text-zinc-500">{new Date(kw.created_at).toLocaleDateString()}</td>
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
                              className="w-32 rounded border border-zinc-200 bg-white px-2 py-1 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                            />
                            <button
                              onClick={() => void handleRename(kw.keyword)}
                              disabled={renameLoading}
                              className="rounded px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setRenameTarget(null)}
                              className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-50"
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
                              className="rounded px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
                            >
                              Rename
                            </button>
                            {!kw.deprecated && (
                              <button
                                data-testid="keyword-deprecate-button"
                                onClick={() => setDeprecateTarget(kw.keyword)}
                                className="rounded px-2 py-1 text-xs text-rose-600 hover:bg-rose-50"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-96 rounded-xl border border-zinc-200 bg-white p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-zinc-900">Deprecate Keyword</h3>
            <p className="mt-2 text-sm text-zinc-600">
              Are you sure you want to deprecate &ldquo;{deprecateTarget}&rdquo;? This keyword will no longer be used for classification.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeprecateTarget(null)}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                data-testid="keyword-deprecate-confirm-button"
                onClick={() => void handleDeprecate(deprecateTarget)}
                disabled={deprecateLoading}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-rose-300"
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