import { Hono } from "https://esm.sh/hono";
import { serveFile } from "https://esm.town/v/std/utils@85-main/index.ts";
import { sqlite } from "https://esm.town/v/stevekrouse/sqlite";
import { OAuthClient } from "jsr:@tijs/oauth-client-deno";
import type { BookStatus, OAuthSession } from "../shared/types.ts";
import { APP_CONFIG } from "../shared/config.ts";

const app = new Hono();

// SQLite storage for OAuth client
class SQLiteOAuthStorage {
  private tableName = "oauth_client_storage";
  private initialized = false;

  private async init() {
    if (this.initialized) return;

    await sqlite.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.initialized = true;
  }

  async get<T = string>(key: string): Promise<T | null> {
    await this.init();

    const now = Date.now();
    const result = await sqlite.execute(
      `SELECT value, expires_at FROM ${this.tableName} WHERE key = ?`,
      [key],
    );

    if (!result.rows || result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const value = row[0] as string;
    const expiresAt = row[1] as number | null;

    // Check if expired
    if (expiresAt && now > expiresAt) {
      await this.delete(key);
      return null;
    }

    // Try to parse JSON, fallback to string
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set<T>(
    key: string,
    value: T,
    options?: { ttl?: number },
  ): Promise<void> {
    await this.init();

    const now = Date.now();
    const expiresAt = options?.ttl ? now + (options.ttl * 1000) : null;
    const serializedValue = typeof value === "string"
      ? value
      : JSON.stringify(value);

    await sqlite.execute(
      `INSERT OR REPLACE INTO ${this.tableName} (key, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [key, serializedValue, expiresAt, now, now],
    );
  }

  async delete(key: string): Promise<void> {
    await this.init();
    await sqlite.execute(`DELETE FROM ${this.tableName} WHERE key = ?`, [key]);
  }

  async clear(): Promise<void> {
    await this.init();
    await sqlite.execute(`DELETE FROM ${this.tableName}`);
  }
}

// Initialize OAuth client with SQLite storage
const oauthClient = new OAuthClient({
  clientId: APP_CONFIG.CLIENT_ID,
  redirectUri: APP_CONFIG.REDIRECT_URI,
  storage: new SQLiteOAuthStorage(),
});

// Initialize SQLite tables
const SESSIONS_TABLE = "oauth_sessions";

// Create table with initial schema
await sqlite.execute(`
  CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
    did TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// Add pds_url column
try {
  await sqlite.execute(`
    ALTER TABLE ${SESSIONS_TABLE} 
    ADD COLUMN pds_url TEXT
  `);
  console.log("Added pds_url column");
} catch (_error) {
  // Column already exists, ignore
}

// Helper to convert OAuth client session to our OAuthSession type
function convertToOAuthSession(clientSession: any): OAuthSession {
  console.log(
    "Debug - client session structure:",
    JSON.stringify(clientSession, null, 2),
  );

  // Handle different possible session structures
  const accessToken = clientSession.tokenSet?.access_token ||
    clientSession.access_token ||
    clientSession.accessToken;
  const refreshToken = clientSession.tokenSet?.refresh_token ||
    clientSession.refresh_token ||
    clientSession.refreshToken;

  if (!accessToken) {
    throw new Error("No access token found in client session");
  }

  return {
    did: clientSession.sub || clientSession.did,
    handle: clientSession.handle || "",
    pdsUrl: clientSession.pdsUrl || APP_CONFIG.ATPROTO_SERVICE,
    accessToken,
    refreshToken,
  };
}

// Session management functions
async function getStoredSession(did: string): Promise<OAuthSession | null> {
  try {
    console.log(`Looking for stored session for DID: ${did}`);
    const result = await sqlite.execute(
      `SELECT handle, pds_url, access_token, refresh_token FROM ${SESSIONS_TABLE} WHERE did = ?`,
      [did],
    );

    console.log(`Session query result:`, {
      rowCount: result.rows?.length || 0,
      hasRows: !!result.rows,
    });

    if (result.rows && result.rows.length > 0) {
      const row = result.rows[0];
      console.log(`Raw row data:`, row);

      // Val Town SQLite returns rows as arrays with indexed access
      const handle = row[0] as string;
      const pdsUrl = row[1] as string;
      const accessToken = row[2] as string;
      const refreshToken = row[3] as string;

      console.log(`Retrieved session for handle: ${handle}`);

      return {
        did,
        handle,
        pdsUrl: pdsUrl || APP_CONFIG.ATPROTO_SERVICE, // Fallback for old sessions
        accessToken,
        refreshToken,
      };
    }

    console.log(`No stored session found for DID: ${did}`);
    return null;
  } catch (error) {
    console.error("Failed to get stored session:", error);
    return null;
  }
}

// Note: Agent-based authentication removed in favor of direct OAuth API calls

// Serve frontend files
app.get("/frontend/*", (c) => serveFile(c.req.path, import.meta.url));
app.get("/shared/*", (c) => serveFile(c.req.path, import.meta.url));

// Serve the main HTML file for the root path
app.get("/", async (_c) => {
  const html = await serveFile("/frontend/index.html", import.meta.url);
  return html;
});

// OAuth client metadata endpoint
app.get("/client-metadata.json", (c) => {
  const metadata = {
    "client_id": APP_CONFIG.CLIENT_ID,
    "client_name": APP_CONFIG.APP_NAME,
    "client_uri": APP_CONFIG.BASE_URL,
    "logo_uri": `${APP_CONFIG.BASE_URL}/favicon.ico`,
    "tos_uri": `${APP_CONFIG.BASE_URL}/tos`,
    "policy_uri": `${APP_CONFIG.BASE_URL}/privacy`,
    "redirect_uris": [APP_CONFIG.REDIRECT_URI],
    "scope": "atproto transition:generic",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "application_type": "web",
    "token_endpoint_auth_method": "none",
    "dpop_bound_access_tokens": true,
  };

  return c.json(metadata, 200, {
    "Content-Type": "application/json",
  });
});

// Start OAuth flow
app.post("/api/auth/start", async (c) => {
  // Get handle from request body
  const { handle } = await c.req.json();

  if (!handle) {
    return c.json({ error: "Handle is required" }, 400);
  }

  try {
    // Use the OAuth client to start authorization
    const authUrl = await oauthClient.authorize(handle);
    return c.json({ authUrl });
  } catch (error) {
    console.error("OAuth start error:", error);
    return c.json({ error: "Failed to start OAuth flow" }, 500);
  }
});

// OAuth callback endpoint
app.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  console.log("OAuth callback received:", {
    code: !!code,
    stateLength: state?.length,
    error,
    errorDescription,
  });

  // Handle OAuth errors
  if (error) {
    console.error("OAuth error:", error, errorDescription);
    return c.json({
      error: `OAuth failed: ${error}`,
      description: errorDescription || "Unknown OAuth error",
    }, 400);
  }

  if (!code || !state) {
    return c.json({ error: "Missing authorization code or state" }, 400);
  }

  try {
    // Use the OAuth client to handle the callback
    const { session: clientSession } = await oauthClient.callback({
      code,
      state,
    });

    // Convert to our session format
    const sessionData = convertToOAuthSession(clientSession);

    // Store the session in SQLite
    const now = Date.now();
    console.log(
      `Storing session for DID: ${sessionData.did}, handle: ${sessionData.handle}`,
    );

    await sqlite.execute(
      `
      INSERT OR REPLACE INTO ${SESSIONS_TABLE} 
      (did, handle, pds_url, access_token, refresh_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        sessionData.did,
        sessionData.handle,
        sessionData.pdsUrl,
        sessionData.accessToken,
        sessionData.refreshToken,
        now,
        now,
      ],
    );

    console.log(`Session stored successfully for DID: ${sessionData.did}`);

    // Redirect back to app with session
    const redirectUrl = new URL("/", c.req.url);
    redirectUrl.searchParams.set("session", btoa(JSON.stringify(sessionData)));

    return c.redirect(redirectUrl.toString());
  } catch (error) {
    console.error("OAuth callback error:", error);
    return c.json({
      error: "OAuth callback failed",
      details: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

// API endpoint to fetch book records for the authorized handle
app.get("/api/books", async (c) => {
  const sessionData = c.req.header("X-Session-Data");

  if (!sessionData) {
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    // Parse session data to get user info
    const session = JSON.parse(atob(sessionData));
    const { did, pdsUrl } = session;

    // Use the user's PDS URL from session
    const userPDS = pdsUrl || APP_CONFIG.ATPROTO_SERVICE;

    // Prepare headers for authenticated request
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (sessionData) {
      try {
        const storedSession = await sqlite.execute(
          `
          SELECT access_token FROM ${SESSIONS_TABLE} WHERE did = ?
        `,
          [did],
        );

        if (storedSession.rows && storedSession.rows.length > 0) {
          headers["Authorization"] = `Bearer ${storedSession.rows[0][0]}`;
        }
      } catch {
        // Continue without authentication
      }
    }

    // Fetch all book records using cursor pagination
    try {
      const allRecords = [];
      let cursor = undefined;

      do {
        const url = new URL(
          `${userPDS}/xrpc/com.atproto.repo.listRecords`,
        );
        url.searchParams.set("repo", did);
        url.searchParams.set("collection", "buzz.bookhive.book");
        url.searchParams.set("limit", "100");
        if (cursor) {
          url.searchParams.set("cursor", cursor);
        }

        const response = await fetch(url.toString(), { headers });

        if (!response.ok) {
          // Collection doesn't exist or no access
          break;
        }

        const data = await response.json();
        allRecords.push(...data.records);
        cursor = data.cursor;

        // Break if no more records
        if (!cursor || data.records.length === 0) {
          break;
        }
      } while (cursor);

      return c.json({ books: allRecords });
    } catch {
      // Collection doesn't exist or no access
      return c.json({ books: [] });
    }
  } catch (_error) {
    return c.json({ error: "Failed to fetch books" }, 500);
  }
});

// API endpoint to update book status using OAuth authentication
app.put("/api/books/:uri/status", async (c) => {
  const uri = decodeURIComponent(c.req.param("uri"));
  const { status }: { status: BookStatus } = await c.req.json();
  const sessionData = c.req.header("X-Session-Data");

  if (!sessionData) {
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    // Parse session data to get DID
    const session = JSON.parse(atob(sessionData));

    const did = session.did;

    // Parse the AT URI to get repo, collection, and rkey
    const uriMatch = uri.match(/at:\/\/([^\/]+)\/([^\/]+)\/(.+)/);
    if (!uriMatch) {
      return c.json({ error: "Invalid AT URI format" }, 400);
    }

    const [, repo, collection, rkey] = uriMatch;

    // Verify that the repo matches the authenticated user's DID
    if (repo !== did) {
      return c.json({
        error: "Access denied",
        message: "You can only modify your own records",
      }, 403);
    }

    console.log(
      `Updating record ${rkey} in collection ${collection} for ${repo}`,
    );

    try {
      // Get the user's PDS endpoint from their DID (we need this for direct API calls)
      const didDoc = await fetch(`${APP_CONFIG.PLC_DIRECTORY}/${did}`);
      if (!didDoc.ok) {
        return c.json({ error: "Failed to resolve user's DID document" }, 500);
      }

      const didData = await didDoc.json();
      const pdsEndpoint = didData.service?.find((s: any) =>
        s.id === "#atproto_pds"
      )?.serviceEndpoint;

      if (!pdsEndpoint) {
        return c.json({ error: "Could not find user's PDS endpoint" }, 500);
      }

      // Get stored session for the OAuth tokens
      const storedSession = await getStoredSession(did);
      if (!storedSession) {
        return c.json({
          error: "Authentication failed",
          message: "No valid OAuth session found. Please login again.",
        }, 401);
      }

      console.log(`Using PDS endpoint: ${pdsEndpoint}`);
      console.log(
        `Using auth header with token prefix: ${
          storedSession.accessToken.substring(0, 20)
        }...`,
      );

      const getUrl =
        `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`;

      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${storedSession.accessToken}`,
      };

      const getResponse = await fetch(getUrl, {
        method: "GET",
        headers,
      });

      if (!getResponse.ok) {
        const errorText = await getResponse.text();
        console.error("Failed to get current record:", {
          status: getResponse.status,
          statusText: getResponse.statusText,
          error: errorText,
        });
        return c.json(
          { error: "Failed to fetch current record" },
          getResponse.status as 400 | 401 | 403 | 404 | 500,
        );
      }

      const currentRecord = await getResponse.json();

      // Update the record with new status
      const updatedValue = {
        ...currentRecord.value,
        status: status,
      };

      // Update the record using Bearer token
      const updateResponse = await fetch(
        `${pdsEndpoint}/xrpc/com.atproto.repo.putRecord`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${storedSession.accessToken}`,
          },
          body: JSON.stringify({
            repo,
            collection,
            rkey,
            record: updatedValue,
            swapRecord: currentRecord.cid,
          }),
        },
      );

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        console.error("Update failed:", {
          status: updateResponse.status,
          statusText: updateResponse.statusText,
          error: errorText,
        });

        // Handle specific OAuth errors
        if (updateResponse.status === 401) {
          return c.json({
            error: "Authentication failed",
            message: "OAuth session expired. Please login again.",
          }, 401);
        }

        return c.json({
          error: "Failed to update record",
          message: errorText,
        }, updateResponse.status as 400 | 401 | 403 | 404 | 500);
      }

      const result = await updateResponse.json();
      console.log(`Successfully updated record ${rkey} to status ${status}`);

      return c.json({
        success: true,
        message: `Status updated to ${status}`,
        uri: result.uri,
        cid: result.cid,
        newStatus: status,
      });
    } catch (repoError: any) {
      console.error("Repository operation failed:", {
        error: repoError,
        repo,
        collection,
        rkey,
      });

      // Handle specific ATProto errors
      if (repoError.message?.includes("RecordNotFound")) {
        return c.json({ error: "Record not found" }, 404);
      }

      if (repoError.message?.includes("InvalidSwap")) {
        return c.json({
          error: "Record was modified by another process",
          message: "Please refresh and try again",
        }, 409);
      }

      // Check if it's an authentication error
      if (
        repoError.status === 401 || repoError.message?.includes("Unauthorized")
      ) {
        return c.json({
          error: "Authentication failed",
          message: "OAuth session expired. Please login again.",
        }, 401);
      }

      return c.json({
        error: "Failed to update record",
        message: repoError.message || "Unknown repository error",
      }, 500);
    }
  } catch (error) {
    console.error("Update error:", error);

    if (error instanceof Error) {
      return c.json({
        error: "Failed to update book status",
        message: error.message,
      }, 500);
    }

    return c.json({ error: "Failed to update book status" }, 500);
  }
});

app.onError((err, _c) => {
  console.error("Error:", err);
  throw err;
});

export default app.fetch;
