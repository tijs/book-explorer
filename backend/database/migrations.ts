// Database migrations for Book Explorer
import { rawDb } from "./db.ts";

export async function runMigrations() {
  try {
    // Create user_sessions table
    await rawDb.execute({
      sql: `
        CREATE TABLE IF NOT EXISTS user_sessions (
          did TEXT PRIMARY KEY,
          handle TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          pds_url TEXT,
          created_at INTEGER NOT NULL
        )
      `,
      args: [],
    });

    // Create iron_session_storage table (required by atproto-oauth-hono)
    await rawDb.execute({
      sql: `
        CREATE TABLE IF NOT EXISTS iron_session_storage (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
      args: [],
    });

    console.log("Database migrations completed successfully");
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}
