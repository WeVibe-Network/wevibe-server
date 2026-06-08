'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import MemoryReview from '@/components/sessions/memory-review';
import { type ExtractionDraft, loadDrafts } from '@/lib/draft-store';
import { useExtractionQueue } from '@/lib/extraction-queue';
import { getIdentity } from '@/lib/wevibe-auth';

function sortDraftsByCreatedAtDesc(drafts: ExtractionDraft[]): ExtractionDraft[] {
  return [...drafts].sort((left, right) => right.createdAt - left.createdAt);
}

export default function ExtractedMemoriesPage() {
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ExtractionDraft[]>([]);
  const queueSnapshot = useExtractionQueue();

  useEffect(() => {
    let cancelled = false;

    void getIdentity().then((nextIdentity) => {
      if (cancelled) {
        return;
      }

      const normalizedPubkey = nextIdentity?.pubkeyHex?.trim() ?? '';
      setPubkeyHex(normalizedPubkey.length > 0 ? normalizedPubkey : null);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const reloadDrafts = useCallback(() => {
    if (!pubkeyHex) {
      setDrafts([]);
      return;
    }

    const nextDrafts = sortDraftsByCreatedAtDesc(Object.values(loadDrafts(pubkeyHex)));
    setDrafts(nextDrafts);
  }, [pubkeyHex]);

  useEffect(() => {
    reloadDrafts();
  }, [reloadDrafts, queueSnapshot.activeCount, queueSnapshot.jobs]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Extracted memories</h1>
        <p className="text-sm text-wv-dim">
          Review and submit the memories extracted from your sessions. Submitted memories move to
          {' '}
          My Submissions.
        </p>
      </header>

      {!pubkeyHex ? (
        <div className="flex items-center gap-3 rounded-lg border border-wv-line bg-wv-panel px-4 py-2 text-xs text-wv-dim">
          <span className="font-mono font-medium text-wv-amber">No identity:</span>
          <Link href="/login" className="text-wv-violet underline hover:text-wv-text">
            Set Up Identity
          </Link>
        </div>
      ) : drafts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
          No extracted memories yet. Go to
          {' '}
          <Link href="/sessions" className="text-wv-violet underline hover:text-wv-text">
            Sessions → Extract
          </Link>
          {' '}
          to queue a session.
        </div>
      ) : (
        <div className="space-y-4">
          {drafts.map((draft) => (
            <section key={draft.sessionId} className="rounded-2xl border border-wv-line bg-wv-panel p-4">
              <MemoryReview
                sessionId={draft.sessionId}
                sessionTitle={draft.sessionTitle}
                sessionDirectory={draft.sessionDirectory}
                memories={draft.memories}
                extractionMeta={draft.extractionMeta}
                pubkeyHex={pubkeyHex}
                onSubmitted={reloadDrafts}
              />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
