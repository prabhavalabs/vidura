// Centralized, validated environment access. Fail fast on missing required
// values so misconfiguration surfaces at boot rather than at first request.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  apiBaseUrl: optional("API_BASE_URL", "http://localhost:8787"),
  // Comma-separated list of frontend origins allowed to use this API,
  // e.g. "https://vidura.nipuntheekshana.com,https://vidura.prabhavalabs.com".
  webOrigins: optional("WEB_ORIGIN", "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  authSecret: required("BETTER_AUTH_SECRET"),
  googleClientId: optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
  openRouterApiKey: optional("OPENROUTER_API_KEY"),
  openRouterModel: optional("OPENROUTER_MODEL", "deepseek/deepseek-chat"),
  openRouterChatModel: optional("OPENROUTER_CHAT_MODEL"),
  // Single-shot streaming translation. Provider selects the model/endpoint;
  // the logic (one full-transcript call, streamed, with a completeness guard)
  // is identical either way:
  //   "openai"   → api.openai.com, OPENAI_MODEL, strict json_schema
  //   "deepseek" → OpenRouter, OPENROUTER_MODEL, json_object
  translationProvider: optional("TRANSLATION_PROVIDER", "openai"),
  openaiApiKey: optional("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_MODEL", "gpt-5.6-terra"),
  port: Number(optional("PORT", "8787")),
  // Residential proxy for YouTube. The VPS's datacenter IP is blocked, so
  // yt-dlp (which fetches YouTube's own frame-accurate caption track) only
  // runs when this points at a clean residential IP. Empty = Gemini only.
  youtubeProxyUrl: optional("YOUTUBE_PROXY_URL"),
  // Transcript + metadata via official Google APIs (Google fetches the public
  // YouTube URL on its own infrastructure, so the VPS IP block is irrelevant).
  // Gemini transcribes; the YouTube Data API serves exact metadata. One Cloud
  // Console API key can serve both when "Generative Language API" and "YouTube
  // Data API v3" are enabled on the project.
  geminiApiKey: optional("GEMINI_API_KEY"),
  // gemini-2.5-flash gives subtitle-grade timestamps (±~3s across a 10-min
  // video). flash-lite is cheaper but its timestamps drift badly on longer
  // videos (±100s+), and pro is both slower and less accurate here.
  geminiModel: optional("GEMINI_MODEL", "gemini-2.5-flash"),
  youtubeApiKey: optional("YOUTUBE_API_KEY"),
  // Web Push (VAPID). Notifies users when a video finishes processing.
  vapidPublicKey: optional("VAPID_PUBLIC_KEY"),
  vapidPrivateKey: optional("VAPID_PRIVATE_KEY"),
  vapidSubject: optional("VAPID_SUBJECT", "mailto:theekshana2@gmail.com"),
  // Email/password is a local-testing convenience; production uses Google only.
  emailPasswordAuth: optional("AUTH_EMAIL_PASSWORD", "false") === "true",
  get googleEnabled() {
    return Boolean(this.googleClientId && this.googleClientSecret);
  },
  get pushEnabled() {
    return Boolean(this.vapidPublicKey && this.vapidPrivateKey);
  },
};
