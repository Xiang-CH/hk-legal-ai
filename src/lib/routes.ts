// Single source of truth for the app's URL mount point.
// APP_BASE_PATH is wired into next.config.ts as `basePath`, so Next prefixes
// pages, next/link, next/router and static assets (`_next/static` + `public/`)
// automatically. Route values are therefore RELATIVE to the mount point.
// Anything that escapes Next's URL handling (raw fetch, <img src>) must be
// prefixed with absolutePath().
export const APP_BASE_PATH = "/clic-chat-hkulaw";

export const routes = {
  home: "/",
  chat: "/c",
  apiChat: "/api/chat",
  apiClicSearch: "/api/clic/search",
} as const;

// Prefix a mount-relative path with APP_BASE_PATH.
export const absolutePath = (path: string) => `${APP_BASE_PATH}${path}`;
