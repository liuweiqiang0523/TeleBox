export type CachedIdentity = {
  senderId: string;
  names: string[];
  usernames: string[];
  firstSeen: number;
  lastSeen: number;
  count: number;
};

export type IdentityCache = {
  users: Record<string, CachedIdentity>;
};

export type ChatMessageRecord = {
  id: number;
  timestamp: number;
  sender: string;
  senderId: string;
  username: string;
  firstName: string;
  lastName: string;
  content: string;
};

export type MessageFetchResult = {
  records: ChatMessageRecord[];
  fetchedPages: number;
  reachedFetchLimit: boolean;
  reachedTimeBoundary: boolean;
};

export type PreparedInput = {
  lines: string[];
  note: string;
};

export type SummaryDensity = {
  label: string;
  targetLength: string;
  topicLimit: number;
  pointLimit: number;
  highlightLimit: number;
  quoteLimit: number;
  todoLimit: number;
  maxOutputLength: number;
};

export type SumMode =
  | "summary"
  | "person"
  | "hot"
  | "rank"
  | "links"
  | "todo"
  | "catchup"
  | "vibe"
  | "about"
  | "meme"
  | "relation"
  | "story"
  | "compare"
  | "track"
  | "quotes"
  | "melon"
  | "roast"
  | "cp"
  | "abstract"
  | "award"
  | "mood"
  | "npc";
