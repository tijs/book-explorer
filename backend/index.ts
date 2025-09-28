import { Hono } from "https://esm.sh/hono";
import { serveFile } from "https://esm.town/v/std/utils@85-main/index.ts";
import { createATProtoOAuth } from "jsr:@tijs/atproto-oauth-hono@^0.2.6";
import type { BookStatus } from "../shared/types.ts";
import { APP_CONFIG } from "../shared/config.ts";
import { initializeTables } from "./database/db.ts";
import { storage } from "./oauth/storage-adapter.ts";

const app = new Hono();

// Initialize database on startup
await initializeTables();

// Create OAuth instance using the package
const oauth = createATProtoOAuth({
  baseUrl: APP_CONFIG.BASE_URL,
  cookieSecret: APP_CONFIG.COOKIE_SECRET || "book-explorer-secret",
  appName: APP_CONFIG.APP_NAME,
  sessionTtl: 60 * 60 * 24, // 24 hours for session validity
  storage,
});

// OAuth client metadata endpoint
app.get("/client-metadata.json", (c) => {
  const metadata = {
    "client_id": APP_CONFIG.CLIENT_ID,
    "client_name": APP_CONFIG.APP_NAME,
    "client_uri": APP_CONFIG.BASE_URL,
    "redirect_uris": [APP_CONFIG.REDIRECT_URI],
    "scope": "atproto transition:generic",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "application_type": "web",
    "token_endpoint_auth_method": "none",
    "dpop_bound_access_tokens": true,
  };
  return c.json(metadata);
});

// Mount OAuth routes - workaround for type instantiation issue
try {
  // @ts-ignore - Type instantiation too deep but works at runtime
  app.route("/", oauth.routes);
  console.log("✅ OAuth routes mounted successfully");
} catch (error) {
  console.error("❌ Failed to mount OAuth routes:", error);
  console.error("Error details:", error.message, error.stack);
  throw error; // Re-throw so we know about OAuth setup issues
}

// Serve frontend files
app.get("/frontend/*", (c) => serveFile(c.req.path, import.meta.url));
app.get("/shared/*", (c) => serveFile(c.req.path, import.meta.url));

// Test endpoint to verify server is working
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    oauth: !!oauth,
    routes: !!oauth.routes,
  });
});

// Serve the main HTML file for the root path
app.get("/", async (_c) => {
  const html = await serveFile("/frontend/index.html", import.meta.url);
  return html;
});

// Helper function to get authenticated user DID from session
async function getAuthenticatedUserDid(
  c: any,
): Promise<{ did: string; oauthSession: any } | null> {
  try {
    const { getIronSession, unsealData } = await import(
      "npm:iron-session@8.0.4"
    );

    const COOKIE_SECRET = APP_CONFIG.COOKIE_SECRET;
    let userDid: string | null = null;

    // Try Bearer token first (mobile)
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const sealedToken = authHeader.slice(7);
        const sessionData = await unsealData(sealedToken, {
          password: COOKIE_SECRET,
        }) as { did: string };
        userDid = sessionData.did;
      } catch (err) {
        console.log("Bearer token authentication failed:", err);
      }
    }

    // Fallback to cookie authentication (web)
    if (!userDid) {
      try {
        interface Session {
          did: string;
        }
        const session = await getIronSession<Session>(c.req.raw, c.res, {
          cookieName: "sid",
          password: COOKIE_SECRET,
        });
        userDid = session.did;

        // Extend session TTL if valid (sliding expiration)
        if (userDid) {
          await session.save();
        }
      } catch (err) {
        console.log("Cookie authentication failed:", err);
      }
    }

    if (!userDid) {
      return null;
    }

    // Get OAuth session data using the sessions API
    const oauthSession = await oauth.sessions.getOAuthSession(userDid);
    if (!oauthSession) {
      return null;
    }

    return { did: userDid, oauthSession };
  } catch (error) {
    console.error("Failed to get authenticated user:", error);
    return null;
  }
}

// API endpoint to fetch book records for the authorized user
app.get("/api/books", async (c) => {
  try {
    // Get the authenticated user's DID and OAuth session
    const authResult = await getAuthenticatedUserDid(c);

    if (!authResult) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const { did: userDid, oauthSession } = authResult;

    // Fetch all book records using cursor pagination
    const allRecords = [];
    let cursor = undefined;

    do {
      const url = new URL(
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords`,
      );
      url.searchParams.set("repo", userDid);
      url.searchParams.set("collection", "buzz.bookhive.book");
      url.searchParams.set("limit", "100");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      // Use the OAuth session to make authenticated requests
      const response = await oauthSession.makeRequest("GET", url.toString());

      if (!response.ok) {
        console.error("Failed to fetch book records:", {
          status: response.status,
          statusText: response.statusText,
          url: url.toString(),
        });
        const errorText = await response.text();
        console.error("Error response body:", errorText);
        break;
      }

      const data = await response.json();
      console.log("Fetched records batch:", {
        count: data.records?.length || 0,
        cursor: data.cursor,
      });
      allRecords.push(...(data.records || []));
      cursor = data.cursor;

      if (!cursor || (data.records?.length || 0) === 0) {
        break;
      }
    } while (cursor);

    console.log("Total records found:", allRecords.length);
    return c.json({ books: allRecords });
  } catch (error) {
    console.error("Failed to fetch books:", error);
    return c.json({ error: "Failed to fetch books" }, 500);
  }
});

// API endpoint to update book status using OAuth authentication
app.put("/api/books/:uri/status", async (c) => {
  const uri = decodeURIComponent(c.req.param("uri"));
  const { status }: { status: BookStatus } = await c.req.json();

  try {
    // Get the authenticated user's DID and OAuth session
    const authResult = await getAuthenticatedUserDid(c);

    if (!authResult) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const { did: userDid, oauthSession } = authResult;

    // Parse the AT URI to get repo, collection, and rkey
    const uriMatch = uri.match(/at:\/\/([^\/]+)\/([^\/]+)\/(.+)/);
    if (!uriMatch) {
      return c.json({ error: "Invalid AT URI format" }, 400);
    }

    const [, repo, collection, rkey] = uriMatch;

    // Verify that the repo matches the authenticated user's DID
    if (repo !== userDid) {
      return c.json({
        error: "Access denied",
        message: "You can only modify your own records",
      }, 403);
    }

    console.log(
      `Updating record ${rkey} in collection ${collection} for ${repo}`,
    );

    try {
      // Get the current record
      const getUrl =
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`;

      const getResponse = await oauthSession.makeRequest("GET", getUrl);

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

      // Update the record using authenticated fetch
      const updateResponse = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
        {
          headers: { "Content-Type": "application/json" },
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
