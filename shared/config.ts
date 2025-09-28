export const APP_CONFIG = {
  // Base URL for the application
  BASE_URL: "https://book-browser.val.run",

  // OAuth configuration
  CLIENT_ID: "https://book-browser.val.run/client-metadata.json",
  REDIRECT_URI: "https://book-browser.val.run/oauth/callback",
  COOKIE_SECRET: Deno.env.get("COOKIE_SECRET") ||
    "book-explorer-default-secret",

  // App metadata
  APP_NAME: "Book Explorer",
  APP_DESCRIPTION: "Browse and manage your Bluesky book collection",

  // ATProto configuration
  ATPROTO_SERVICE: "https://bsky.social", // Default fallback for handle resolution
  PLC_DIRECTORY: "https://plc.directory",
} as const;
