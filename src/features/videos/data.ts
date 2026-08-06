import type { LucideIcon } from "lucide-react";
import { LanguagesIcon } from "lucide-react";

export type VideoStatus = "ready" | "processing" | "queued" | "failed";

export type Video = {
  id: string;
  youtubeVideoId?: string;
  youtubeUrl?: string;
  thumbnailUrl?: string;
  title: string;
  channel: string;
  category: string;
  duration: string;
  progress: string;
  status: VideoStatus;
  accent: string;
  Icon: LucideIcon;
};

export type TranscriptSegment = {
  id: string;
  time: string;
  startMs?: number;
  endMs?: number;
  original: string;
  sinhala: string | null;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citation?: string;
};

export const languageOptions = [
  { value: "si", label: "Sinhala" },
  { value: "bi", label: "Bilingual" },
  { value: "en", label: "English" },
];

export const quickPrompts = [
  "Summarize this section",
  "Explain the term simply",
  "Give me an example",
  "Quiz me from this video",
];

export const emptyImportIcon = LanguagesIcon;
