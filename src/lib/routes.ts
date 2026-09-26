// Single source of truth for the app's URL mount point.
// To re-mount the whole app under a different path, change APP_BASE_PATH
// below (and rename the src/app/<base> folders to match — Next.js resolves
// physical route folders, so those can't be dynamic).
export const APP_BASE_PATH = "/clic-chat-hkulaw";

export const routes = {
  home: APP_BASE_PATH,
  chat: `${APP_BASE_PATH}/c`,
  apiChat: `${APP_BASE_PATH}/api/chat`,
  apiClicSearch: `${APP_BASE_PATH}/api/clic/search`,
} as const;
