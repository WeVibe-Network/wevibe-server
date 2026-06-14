export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  agent: string;
  directory: string;
  time_created: string;
  time_updated: string;
  message_count: number;
}

export interface SessionDetail {
  session_id: string;
  title: string;
  model: string;
  directory: string;
  message_count: number;
  transcript: string;
}

export interface ClassifiedKeyword {
  keyword: string;
  weight: number;
  base_weight?: number;
}

export interface SuggestedKeyword extends ClassifiedKeyword {
  rationale: string;
}

export interface MemoryCandidateKeywords {
  classified: ClassifiedKeyword[];
  suggestions: SuggestedKeyword[];
}

export interface MemoryCandidate {
  implement: string;
  context: string;
  dnd: string | null;
  stack: string[];
  memory_type: 'memory';
  preference_confidence: number;
  extraction_hash: string;
  keywords?: MemoryCandidateKeywords;
}
