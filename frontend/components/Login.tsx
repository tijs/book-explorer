/** @jsxImportSource https://esm.sh/react */
import React, { useState } from "https://esm.sh/react";
export function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!handle.trim()) {
      setError("Please enter your Bluesky handle");
      setLoading(false);
      return;
    }

    try {
      const response = await fetch("/api/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim() }),
      });

      const data = await response.json();

      if (response.ok) {
        // Redirect to OAuth authorization URL
        globalThis.location.href = data.authUrl;
      } else {
        setError(data.error || "Failed to start OAuth flow");
      }
    } catch (_err) {
      setError("Network error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md w-full bg-white rounded-lg shadow-md p-8">
        <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">
          Login to Book Explorer
        </h2>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-3 bg-red-100 border border-red-400 text-red-700 rounded text-sm">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="handle"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Bluesky Handle
            </label>
            <input
              type="text"
              id="handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="your-handle.bsky.social"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={loading}
              required
            />
            <p className="mt-1 text-xs text-gray-500">
              Enter your Bluesky handle (with or without .bsky.social)
            </p>
          </div>

          <button
            type="submit"
            disabled={loading || !handle.trim()}
            className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Authenticating..." : "Login with Bluesky"}
          </button>
        </form>

        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-sm text-blue-800 mb-2">
            📚 Book Explorer - Manage your Bluesky book collection
          </p>
          <p className="text-xs text-blue-700">
            Uses OAuth for secure authentication. Only you can access and modify
            your book records.
          </p>
        </div>
      </div>
    </div>
  );
}
