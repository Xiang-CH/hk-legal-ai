// Single source of truth for the app's URL mount point.
// The app is physically mounted at src/app/clic-chat-hkulaw and proxied under
// this path on a shared domain. Next's `basePath` is NOT usable here (Azure SWA
// hybrid rejects it at deploy time), so pages/APIs come from the physical mount
// while only the `_next` asset URLs are prefixed (see assetPrefix in
// next.config.ts). Public assets therefore live under public/clic-chat-hkulaw.
export const APP_BASE_PATH = "/clic-chat-hkulaw";

export const routes = {
  home: APP_BASE_PATH,
  chat: `${APP_BASE_PATH}/c`,
  apiChat: `${APP_BASE_PATH}/api/chat`,
  apiClicSearch: `${APP_BASE_PATH}/api/clic/search`,
} as const;

// Prefix a mount-relative path (e.g. a public asset) with APP_BASE_PATH.
export const absolutePath = (path: string) => `${APP_BASE_PATH}${path}`;
