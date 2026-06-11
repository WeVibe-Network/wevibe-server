'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import MemoryReview from '@/components/sessions/memory-review';
import Button from '@/components/ui/button';
import Modal from '@/components/ui/modal';
import { clearDrafts, deleteDraft, type ExtractionDraft, loadDrafts } from '@/lib/draft-store';
import { useExtractionQueue } from '@/lib/extraction-queue';
import { getIdentity } from '@/lib/wevibe-auth';

function sortDraftsByCreatedAtDesc(drafts: ExtractionDraft[]): ExtractionDraft[] {
  return [...drafts].sort((left, right) => right.createdAt - left.createdAt);
}

export default function ExtractedMemoriesPage() {
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ExtractionDraft[]>([]);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const queueSnapshot = useExtractionQueue();

  const totalExtractedMemories = drafts.reduce((total, draft) => total + draft.memories.length, 0);

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

  useEffect(() => {
    if (!pubkeyHex || drafts.length === 0) {
      setConfirmClearOpen(false);
    }
  }, [pubkeyHex, drafts.length]);

  const handleDiscardDraft = useCallback((draft: ExtractionDraft) => {
    if (!pubkeyHex) {
      return;
    }

    deleteDraft(pubkeyHex, draft.sessionId);
    reloadDrafts();

    const trimmedTitle = draft.sessionTitle?.trim() ?? '';
    toast.success(trimmedTitle.length > 0 ? `Discarded ${trimmedTitle}` : 'Discarded');
  }, [pubkeyHex, reloadDrafts]);

  const handleClearAll = useCallback(() => {
    if (!pubkeyHex) {
      return;
    }

    clearDrafts(pubkeyHex);
    setConfirmClearOpen(false);
    reloadDrafts();
    toast.success('Cleared all extracted memories');
  }, [pubkeyHex, reloadDrafts]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Extracted memories</h1>
          <p className="text-sm text-wv-dim">
            Review and submit the memories extracted from your sessions. Submitted memories move to
            {' '}
            My Submissions.
          </p>
        </div>
        {pubkeyHex && drafts.length > 0 ? (
          <Button type="button" variant="danger" onClick={() => setConfirmClearOpen(true)}>
            Clear all
          </Button>
        ) : null}
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
              <div className="mb-3 flex items-center justify-end">
                <Button
                  type="button"
                  variant="danger"
                  className="!rounded-lg !px-3 !py-1.5 text-xs"
                  onClick={() => handleDiscardDraft(draft)}
                >
                  Discard
                </Button>
              </div>
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

      <Modal
        open={confirmClearOpen}
        title="Clear all extracted memories?"
        onClose={() => setConfirmClearOpen(false)}
        footer={(
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirmClearOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={handleClearAll}>
              Clear all
            </Button>
          </div>
        )}
      >
        {`This permanently discards all ${totalExtractedMemories} unsubmitted extracted ${totalExtractedMemories === 1 ? 'memory' : 'memories'} across ${drafts.length} ${drafts.length === 1 ? 'session' : 'sessions'} from this browser. This cannot be undone.`}
      </Modal>
    </div>
  );
}
