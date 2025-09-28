// Drizzle schema definitions for Book Explorer
import {
  integer,
  sqliteTable,
  text,
} from "https://esm.sh/drizzle-orm@0.44.5/sqlite-core";

// User sessions table for OAuth data
export const userSessionsTable = sqliteTable("user_sessions", {
  did: text("did").primaryKey(),
  handle: text("handle").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  pdsUrl: text("pds_url"),
  createdAt: integer("created_at").notNull(),
});

// Iron Session storage for encrypted session cookies (required by atproto-oauth-hono)
export const ironSessionStorageTable = sqliteTable("iron_session_storage", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Export types
export type UserSessionInsert = typeof userSessionsTable.$inferInsert;
export type UserSessionSelect = typeof userSessionsTable.$inferSelect;
export type IronSessionInsert = typeof ironSessionStorageTable.$inferInsert;
export type IronSessionSelect = typeof ironSessionStorageTable.$inferSelect;
