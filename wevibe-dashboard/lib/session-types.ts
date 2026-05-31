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

export interface MemoryCandidate {
  insight: string;
  context: string;
  avoid: string | null;
  stack: string[];
  memory_type: 'memory';
}

export type ExtractionStatus =
  | 'idle'
  | 'loading-transcript'
  | 'extracting'
  | 'done'
  | 'error';
