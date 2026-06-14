'use client';

import { LeaderPipelinePanel } from '@/components/moderation/leader-pipeline-panel';
import { ModeratorReviewPanel } from '@/components/moderation/moderator-review-panel';
import { useDashboardState } from '@/lib/use-dashboard-state';

export default function ModerationNewPage() {
  const { isLeader, canModerate } = useDashboardState();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {canModerate ? <ModeratorReviewPanel /> : null}
      {isLeader ? <LeaderPipelinePanel /> : null}
    </div>
  );
}
