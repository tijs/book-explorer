import { Hono } from "https://esm.sh/hono";
import { serveFile } from "https://esm.town/v/std/utils@85-main/index.ts";
import { sqlite } from "https://esm.town/v/stevekrouse/sqlite";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
} from "https://esm.sh/jose";
import type { BookStatus, OAuthSession } from "../shared/types.ts";
import { APP_CONFIG } from "../shared/config.ts";

const app = new Hono();

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

// Migrate to add DPoP key columns if they don't exist
try {
  await sqlite.execute(`
    ALTER TABLE ${SESSIONS_TABLE} 
    ADD COLUMN dpop_private_key TEXT
  `);
  console.log("Added dpop_private_key column");
} catch (_error) {
  // Column already exists, ignore
}

try {
  await sqlite.execute(`
    ALTER TABLE ${SESSIONS_TABLE} 
    ADD COLUMN dpop_public_key TEXT
  `);
  console.log("Added dpop_public_key column");
} catch (_error) {
  // Column already exists, ignore
}

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

// Generate DPoP proof JWT with provided keys (for session consistency)
async function generateDPoPProofWithKeys(
  method: string,
  url: string,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  accessToken?: string,
  nonce?: string,
) {
  // Export public key as JWK
  const jwk = await exportJWK(publicKey);

  // Create DPoP JWT payload
  const payload: any = {
    jti: crypto.randomUUID(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };

  // Add nonce if provided
  if (nonce) {
    payload.nonce = nonce;
  }

  // Add access token hash for authenticated requests
  if (accessToken) {
    const encoder = new TextEncoder();
    const data = encoder.encode(accessToken);
    const digest = await crypto.subtle.digest("SHA-256", data);
    payload.ath = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/[+/]/g, (match) => match === "+" ? "-" : "_")
      .replace(/=/g, "");
  }

  // Create and sign DPoP JWT
  const dpopProof = await new SignJWT(payload)
    .setProtectedHeader({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: jwk,
    })
    .sign(privateKey);

  return { dpopProof };
}

// Helper function to make DPoP authenticated request with nonce retry and token refresh
async function makeDPoPRequest(
  method: string,
  url: string,
  session: OAuthSession,
  body?: string,
  retryWithRefresh = true,
): Promise<{ response: Response; session: OAuthSession }> {
  // Import the stored DPoP keys
  const privateKeyJWK = JSON.parse(session.dpopPrivateKey);
  const publicKeyJWK = JSON.parse(session.dpopPublicKey);
  const privateKey = await importJWK(privateKeyJWK, "ES256") as CryptoKey;
  const publicKey = await importJWK(publicKeyJWK, "ES256") as CryptoKey;

  // First attempt - without nonce
  const { dpopProof } = await generateDPoPProofWithKeys(
    method,
    url,
    privateKey,
    publicKey,
    session.accessToken,
  );
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `DPoP ${session.accessToken}`,
    "DPoP": dpopProof,
  };

  let response = await fetch(url, {
    method,
    headers,
    body,
  });

  // Handle nonce requirement
  if (!response.ok && response.status === 401) {
    try {
      const errorData = await response.json();

      // Check if token is expired
      if (errorData.error === "invalid_token" && retryWithRefresh) {
        console.log("Token expired, attempting to refresh...");

        // Try to refresh the token
        const refreshedSession = await refreshOAuthToken(session);
        if (refreshedSession) {
          console.log("Token refreshed successfully, retrying request...");
          // Retry the request with the new token (but don't retry refresh again)
          return makeDPoPRequest(method, url, refreshedSession, body, false);
        } else {
          console.error("Failed to refresh token");
          // Return the original 401 response
          return { response, session };
        }
      }

      if (errorData.error === "use_dpop_nonce") {
        // Extract nonce from DPoP-Nonce header
        const nonce = response.headers.get("DPoP-Nonce");
        if (nonce) {
          console.log(`Retrying ${method} ${url} with DPoP nonce:`, nonce);

          // Second attempt - with nonce (using same session keys)
          const { dpopProof: dpopProofWithNonce } =
            await generateDPoPProofWithKeys(
              method,
              url,
              privateKey,
              publicKey,
              session.accessToken,
              nonce,
            );
          const retriedHeaders = {
            ...headers,
            "DPoP": dpopProofWithNonce,
          };
          response = await fetch(url, {
            method,
            headers: retriedHeaders,
            body,
          });

          // Check if the nonce retry also failed due to expired token
          if (!response.ok && response.status === 401 && retryWithRefresh) {
            try {
              const retryErrorData = await response.json();
              if (retryErrorData.error === "invalid_token") {
                console.log(
                  "Token expired after nonce retry, attempting to refresh...",
                );

                // Try to refresh the token
                const refreshedSession = await refreshOAuthToken(session);
                if (refreshedSession) {
                  console.log(
                    "Token refreshed successfully, retrying request with fresh token...",
                  );
                  // Retry the request with the new token (but don't retry refresh again)
                  return makeDPoPRequest(
                    method,
                    url,
                    refreshedSession,
                    body,
                    false,
                  );
                } else {
                  console.error("Failed to refresh token after nonce retry");
                }
              }
            } catch {
              // If parsing fails, continue to return response
            }
          }
        }
      }
    } catch {
      // If parsing fails, continue to return original response
    }
  }

  return { response, session };
}

// Generate PKCE code verifier and challenge
async function generatePKCE() {
  // Generate random code verifier (43-128 characters, URL-safe)
  const array = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = btoa(String.fromCharCode(...array))
    .replace(/[+/]/g, (match) => match === "+" ? "-" : "_")
    .replace(/=/g, "")
    .substring(0, 128);

  // Create SHA256 hash of code verifier for code challenge
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);

  // Convert to base64url
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/[+/]/g, (match) => match === "+" ? "-" : "_")
    .replace(/=/g, "");

  const codeChallengeMethod = "S256";

  return { codeVerifier, codeChallenge, codeChallengeMethod };
}

// Session management functions
async function getStoredSession(did: string): Promise<OAuthSession | null> {
  try {
    console.log(`Looking for stored session for DID: ${did}`);
    const result = await sqlite.execute(
      `SELECT handle, pds_url, access_token, refresh_token, dpop_private_key, dpop_public_key FROM ${SESSIONS_TABLE} WHERE did = ?`,
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
      const dpopPrivateKey = row[4] as string;
      const dpopPublicKey = row[5] as string;

      console.log(`Retrieved session for handle: ${handle}`);

      // Check if this session has DPoP keys (backward compatibility)
      if (!dpopPrivateKey || !dpopPublicKey) {
        console.log(`Session missing DPoP keys, user needs to re-authenticate`);
        return null;
      }

      return {
        did,
        handle,
        pdsUrl: pdsUrl || APP_CONFIG.ATPROTO_SERVICE, // Fallback for old sessions
        accessToken,
        refreshToken,
        dpopPrivateKey,
        dpopPublicKey,
      };
    }

    console.log(`No stored session found for DID: ${did}`);
    return null;
  } catch (error) {
    console.error("Failed to get stored session:", error);
    return null;
  }
}

// Refresh OAuth token when expired
async function refreshOAuthToken(
  session: OAuthSession,
): Promise<OAuthSession | null> {
  try {
    console.log(`Refreshing OAuth token for ${session.handle}`);

    // Get the user's token endpoint from their PDS
    const didDocResponse = await fetch(
      `${APP_CONFIG.PLC_DIRECTORY}/${session.did}`,
    );
    if (!didDocResponse.ok) {
      console.error("Failed to get DID document for token refresh");
      return null;
    }

    const didDoc = await didDocResponse.json();
    const pdsEndpoint = didDoc.service?.find((s: any) =>
      s.id === "#atproto_pds"
    )?.serviceEndpoint;

    if (!pdsEndpoint) {
      console.error("Could not find PDS endpoint for token refresh");
      return null;
    }

    // Discover OAuth protected resource metadata
    const resourceMetadataResponse = await fetch(
      `${pdsEndpoint}/.well-known/oauth-protected-resource`,
    );

    if (!resourceMetadataResponse.ok) {
      console.error("Failed to get OAuth metadata for token refresh");
      return null;
    }

    const resourceMetadata = await resourceMetadataResponse.json();
    const authServerUrl = resourceMetadata.authorization_servers?.[0];

    if (!authServerUrl) {
      console.error("No authorization server found for token refresh");
      return null;
    }

    // Get token endpoint
    const authServerMetadataResponse = await fetch(
      `${authServerUrl}/.well-known/oauth-authorization-server`,
    );

    if (!authServerMetadataResponse.ok) {
      console.error("Failed to get auth server metadata for token refresh");
      return null;
    }

    const authServerMetadata = await authServerMetadataResponse.json();
    const tokenEndpoint = authServerMetadata.token_endpoint;

    if (!tokenEndpoint) {
      console.error("No token endpoint found for refresh");
      return null;
    }

    // Import the stored DPoP keys
    const privateKeyJWK = JSON.parse(session.dpopPrivateKey);
    const publicKeyJWK = JSON.parse(session.dpopPublicKey);
    const privateKey = await importJWK(privateKeyJWK, "ES256") as CryptoKey;
    const publicKey = await importJWK(publicKeyJWK, "ES256") as CryptoKey;

    // Prepare refresh token request
    const requestBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: APP_CONFIG.CLIENT_ID,
    });

    // First attempt - without nonce
    const { dpopProof } = await generateDPoPProofWithKeys(
      "POST",
      tokenEndpoint,
      privateKey,
      publicKey,
    );

    let tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "DPoP": dpopProof,
      },
      body: requestBody,
    });

    // Handle nonce requirement
    if (!tokenResponse.ok && tokenResponse.status === 400) {
      try {
        const errorData = await tokenResponse.json();
        if (errorData.error === "use_dpop_nonce") {
          const nonce = tokenResponse.headers.get("DPoP-Nonce");
          if (nonce) {
            console.log("Retrying token refresh with DPoP nonce");

            const { dpopProof: dpopProofWithNonce } =
              await generateDPoPProofWithKeys(
                "POST",
                tokenEndpoint,
                privateKey,
                publicKey,
                undefined,
                nonce,
              );
            tokenResponse = await fetch(tokenEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "DPoP": dpopProofWithNonce,
              },
              body: requestBody,
            });
          }
        }
      } catch {
        // Continue to general error handling
      }
    }

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Token refresh failed:", {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        body: errorText,
      });
      return null;
    }

    const tokens = await tokenResponse.json();
    console.log("Successfully refreshed OAuth token");

    // Update session with new tokens
    const updatedSession: OAuthSession = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || session.refreshToken, // Keep old refresh token if not provided
    };

    // Store updated session in database
    const now = Date.now();
    await sqlite.execute(
      `
      UPDATE ${SESSIONS_TABLE}
      SET access_token = ?, refresh_token = ?, updated_at = ?
      WHERE did = ?
    `,
      [
        updatedSession.accessToken,
        updatedSession.refreshToken,
        now,
        session.did,
      ],
    );

    console.log(`Updated session in database for ${session.handle}`);

    return updatedSession;
  } catch (error) {
    console.error("Token refresh error:", error);
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
    // Try to resolve handle using multiple methods
    let did: string | null = null;

    // First, try to resolve at the domain specified in the handle
    const handleParts = handle.split(".");
    const potentialPDS = handleParts.length >= 2
      ? `https://${handleParts.slice(-2).join(".")}`
      : null;

    // List of services to try for handle resolution
    const resolutionServices = [
      potentialPDS, // User's potential PDS based on their handle
      APP_CONFIG.ATPROTO_SERVICE, // Fallback to bsky.social
      "https://api.bsky.app", // Another common endpoint
    ].filter(Boolean);

    for (const service of resolutionServices) {
      try {
        const resolveResponse = await fetch(
          `${service}/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`,
        );

        if (resolveResponse.ok) {
          const data = await resolveResponse.json();
          did = data.did;
          break;
        }
      } catch {
        // Try next service
      }
    }

    if (!did) {
      return c.json({ error: "Handle not found on any known service" }, 404);
    }

    // Get the user's DID document to find PDS
    const didDocResponse = await fetch(`${APP_CONFIG.PLC_DIRECTORY}/${did}`);
    if (!didDocResponse.ok) {
      return c.json({ error: "Could not resolve DID" }, 404);
    }

    const didDoc = await didDocResponse.json();
    const pdsEndpoint = didDoc.service?.find((s: any) =>
      s.id === "#atproto_pds"
    )?.serviceEndpoint;

    if (!pdsEndpoint) {
      return c.json({ error: "Could not find PDS endpoint" }, 404);
    }

    // Discover OAuth protected resource metadata
    const resourceMetadataResponse = await fetch(
      `${pdsEndpoint}/.well-known/oauth-protected-resource`,
    );

    if (!resourceMetadataResponse.ok) {
      return c.json({ error: "PDS does not support OAuth" }, 400);
    }

    const resourceMetadata = await resourceMetadataResponse.json();
    const authServerUrl = resourceMetadata.authorization_servers?.[0];

    if (!authServerUrl) {
      return c.json({ error: "No authorization server found" }, 400);
    }

    // Discover OAuth authorization server metadata
    const authServerMetadataResponse = await fetch(
      `${authServerUrl}/.well-known/oauth-authorization-server`,
    );

    if (!authServerMetadataResponse.ok) {
      return c.json(
        { error: "Could not get authorization server metadata" },
        400,
      );
    }

    const authServerMetadata = await authServerMetadataResponse.json();
    const authorizationEndpoint = authServerMetadata.authorization_endpoint;
    const tokenEndpoint = authServerMetadata.token_endpoint;

    if (!authorizationEndpoint || !tokenEndpoint) {
      return c.json({ error: "Invalid authorization server metadata" }, 400);
    }

    // Generate OAuth parameters
    const { codeVerifier, codeChallenge, codeChallengeMethod } =
      await generatePKCE();

    // Encode state data directly in the state parameter (Val Town serverless issue)
    const stateData = {
      codeVerifier,
      handle,
      did,
      pdsEndpoint,
      authorizationEndpoint,
      tokenEndpoint,
      timestamp: Date.now(), // For expiry checking
    };

    const state = btoa(JSON.stringify(stateData));
    console.log("Generated encoded state with data:", {
      stateLength: state.length,
    });

    // Build OAuth authorization URL
    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", APP_CONFIG.CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", APP_CONFIG.REDIRECT_URI);
    authUrl.searchParams.set("scope", "atproto transition:generic");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", codeChallengeMethod);

    return c.json({ authUrl: authUrl.toString() });
  } catch (_error) {
    console.error("OAuth start error:", _error);
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
    // Decode state data from the state parameter
    let stateData: any;
    try {
      stateData = JSON.parse(atob(state));
      console.log("Decoded state data:", {
        handle: stateData.handle,
        timestamp: stateData.timestamp,
      });
    } catch (parseError) {
      console.error("Failed to parse state:", parseError);
      return c.json({ error: "Invalid state format" }, 400);
    }

    // Check if state is expired (5 minutes)
    const stateAge = Date.now() - stateData.timestamp;
    if (stateAge > 5 * 60 * 1000) {
      return c.json({ error: "State expired" }, 400);
    }

    const { codeVerifier, handle, did, pdsEndpoint, tokenEndpoint } = stateData;

    console.log("Token exchange details:", {
      handle,
      did,
      tokenEndpoint,
      clientId: APP_CONFIG.CLIENT_ID,
    });

    // Generate DPoP key pair for this session (with extractable: true for storage)
    const { privateKey: sessionPrivateKey, publicKey: sessionPublicKey } =
      await generateKeyPair("ES256", { extractable: true });

    // Prepare the request body
    const requestBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: APP_CONFIG.REDIRECT_URI,
      client_id: APP_CONFIG.CLIENT_ID,
      code_verifier: codeVerifier,
    });

    // First attempt - without nonce (using session keys)
    const { dpopProof } = await generateDPoPProofWithKeys(
      "POST",
      tokenEndpoint,
      sessionPrivateKey,
      sessionPublicKey,
    );
    let tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "DPoP": dpopProof,
      },
      body: requestBody,
    });

    // Handle nonce requirement
    if (!tokenResponse.ok && tokenResponse.status === 400) {
      try {
        const errorData = await tokenResponse.json();
        if (errorData.error === "use_dpop_nonce") {
          // Extract nonce from DPoP-Nonce header
          const nonce = tokenResponse.headers.get("DPoP-Nonce");
          if (nonce) {
            console.log("Retrying with DPoP nonce:", nonce);

            // Second attempt - with nonce (using same session keys)
            const { dpopProof: dpopProofWithNonce } =
              await generateDPoPProofWithKeys(
                "POST",
                tokenEndpoint,
                sessionPrivateKey,
                sessionPublicKey,
                undefined,
                nonce,
              );
            tokenResponse = await fetch(tokenEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "DPoP": dpopProofWithNonce,
              },
              body: requestBody,
            });
          }
        }
      } catch {
        // If parsing fails, continue to general error handling
      }
    }

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Token exchange failed:", {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        body: errorText,
        tokenEndpoint,
      });
      return c.json({
        error: "Failed to exchange code for tokens",
        details: errorText,
        status: tokenResponse.status,
      }, 400);
    }

    const tokens = await tokenResponse.json();

    console.log("Received tokens:", {
      access_token_length: tokens.access_token?.length,
      refresh_token_length: tokens.refresh_token?.length,
      token_type: tokens.token_type,
      scope: tokens.scope,
    });

    // Export keys to JWK format for storage
    console.log("Exporting DPoP keys to JWK format...");
    const privateKeyJWK = JSON.stringify(await exportJWK(sessionPrivateKey));
    const publicKeyJWK = JSON.stringify(await exportJWK(sessionPublicKey));
    console.log("DPoP keys exported successfully");

    // Store session data
    const sessionData: OAuthSession = {
      did,
      handle,
      pdsUrl: pdsEndpoint,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      dpopPrivateKey: privateKeyJWK,
      dpopPublicKey: publicKeyJWK,
    };

    // Store the session in SQLite
    const now = Date.now();
    console.log(`Storing session for DID: ${did}, handle: ${handle}`);

    await sqlite.execute(
      `
      INSERT OR REPLACE INTO ${SESSIONS_TABLE} 
      (did, handle, pds_url, access_token, refresh_token, dpop_private_key, dpop_public_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        did,
        handle,
        pdsEndpoint,
        sessionData.accessToken,
        sessionData.refreshToken,
        sessionData.dpopPrivateKey,
        sessionData.dpopPublicKey,
        now,
        now,
      ],
    );

    console.log(`Session stored successfully for DID: ${did}`);

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

      // Get the current record using DPoP authenticated request
      const getUrl =
        `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`;
      const getResult = await makeDPoPRequest(
        "GET",
        getUrl,
        storedSession,
      );
      const getResponse = getResult.response;
      let currentSession = getResult.session;

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

      // Update the record using DPoP authenticated request
      const updateResult = await makeDPoPRequest(
        "POST",
        `${pdsEndpoint}/xrpc/com.atproto.repo.putRecord`,
        currentSession,
        JSON.stringify({
          repo,
          collection,
          rkey,
          record: updatedValue,
          swapRecord: currentRecord.cid,
        }),
      );
      const updateResponse = updateResult.response;
      currentSession = updateResult.session;

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
