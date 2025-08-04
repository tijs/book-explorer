/** @jsxImportSource https://esm.sh/react */
import React, { useEffect, useState } from "https://esm.sh/react";
import type {
  AtProtoRecord,
  BookStatus,
  OAuthSession,
} from "../../shared/types.ts";
import { STATUS_LABELS } from "../../shared/types.ts";
import { APP_CONFIG as _APP_CONFIG } from "../../shared/config.ts";
import { Login } from "./Login.tsx";

interface Toast {
  id: string;
  type: "success" | "error" | "info";
  message: string;
  timestamp: number;
}

export function App() {
  const [books, setBooks] = useState<AtProtoRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<OAuthSession | null>(null);
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(0);
  const [showBulkActions, setShowBulkActions] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [statusFilter, setStatusFilter] = useState<BookStatus | null>(null);

  const BOOKS_PER_PAGE = 50;

  const showToast = (type: Toast["type"], message: string) => {
    const id = Date.now().toString();
    const toast: Toast = { id, type, message, timestamp: Date.now() };
    setToasts((prev) => [...prev, toast]);

    // Auto-remove after 5 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const logRequest = (method: string, url: string, data?: any) => {
    console.group(`🔄 API ${method} ${url}`);
    console.log("Timestamp:", new Date().toISOString());
    if (data) console.log("Request body:", data);
  };

  const logResponse = (
    _method: string,
    _url: string,
    response: Response,
    data?: any,
  ) => {
    console.log(`📥 Response: ${response.status} ${response.statusText}`);
    if (data) console.log("Response data:", data);
    console.groupEnd();
  };

  const logError = (method: string, url: string, error: any) => {
    console.error(`❌ Request failed: ${method} ${url}`, error);
    console.groupEnd();
  };

  // Load session from localStorage or URL on mount
  useEffect(() => {
    // Check for OAuth callback in URL
    const urlParams = new URLSearchParams(globalThis.location.search);
    const sessionParam = urlParams.get("session");

    if (sessionParam) {
      // OAuth callback with session data
      try {
        const sessionData = JSON.parse(atob(sessionParam));
        setSession(sessionData);
        // Clean up URL
        globalThis.history.replaceState(
          {},
          document.title,
          globalThis.location.pathname,
        );
      } catch {
        // Invalid session data
      }
    } else {
      // Check localStorage for existing session
      const storedSession = localStorage.getItem("oauthSession");
      if (storedSession) {
        const sessionData = JSON.parse(storedSession);
        setSession(sessionData);
      }
    }
  }, []);

  // Save session to localStorage when it changes
  useEffect(() => {
    if (session) {
      localStorage.setItem("oauthSession", JSON.stringify(session));
    } else {
      localStorage.removeItem("oauthSession");
    }
  }, [session]);

  const handleLogout = () => {
    setSession(null);
    setBooks([]);
    setError(null);
  };

  const fetchBooks = async () => {
    if (!session) return;

    setLoading(true);
    setError(null);

    const url = `/api/books`;
    logRequest("GET", url);

    try {
      const headers: HeadersInit = {};
      if (session) {
        headers["X-Session-Data"] = btoa(JSON.stringify(session));
      }

      const response = await fetch(url, { headers });
      const data = await response.json();

      logResponse("GET", url, response, data);

      if (response.ok) {
        setBooks(data.books);
        showToast(
          "success",
          `Found ${data.books.length} books in your collection`,
        );
      } else {
        const errorMsg = data.error || "Failed to fetch books";
        setError(errorMsg);
        showToast("error", errorMsg);
      }
    } catch (err) {
      const errorMsg = "Network error occurred";
      logError("GET", url, err);
      setError(errorMsg);
      showToast("error", errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const updateBookStatus = async (uri: string, newStatus: BookStatus) => {
    if (!session) {
      showToast("error", "Please login to update book status");
      return;
    }

    const url = `/api/books/${encodeURIComponent(uri)}/status`;
    const requestData = { status: newStatus };
    logRequest("PUT", url, requestData);

    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Data": btoa(JSON.stringify(session)),
        },
        body: JSON.stringify(requestData),
      });

      const result = await response.json();
      logResponse("PUT", url, response, result);

      if (response.ok) {
        // Update the local state
        setBooks((prevBooks) =>
          prevBooks.map((book) =>
            book.uri === uri
              ? { ...book, value: { ...book.value, status: newStatus } }
              : book
          )
        );

        // Find book title for better feedback
        const book = books.find((b) => b.uri === uri);
        const bookTitle = book?.value.title || "Book";
        showToast(
          "success",
          `Updated "${bookTitle}" to ${STATUS_LABELS[newStatus]}`,
        );
      } else {
        if (response.status === 401) {
          showToast("error", "Session expired. Please login again.");
          handleLogout();
        } else {
          showToast(
            "error",
            `Failed to update status: ${result.error || "Unknown error"}`,
          );
        }
      }
    } catch (err) {
      logError("PUT", url, err);
      showToast("error", "Failed to update book status - network error");
    }
  };

  const updateBulkStatus = async (newStatus: BookStatus) => {
    if (!session || selectedBooks.size === 0) return;

    const count = selectedBooks.size;
    showToast("info", `Updating ${count} book${count === 1 ? "" : "s"}...`);

    const uris = Array.from(selectedBooks);
    const results = await Promise.allSettled(
      uris.map((uri) => updateBookStatus(uri, newStatus)),
    );

    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    if (failed === 0) {
      showToast(
        "success",
        `Successfully updated ${successful} book${
          successful === 1 ? "" : "s"
        } to ${STATUS_LABELS[newStatus]}`,
      );
    } else if (successful === 0) {
      showToast(
        "error",
        `Failed to update all ${count} book${count === 1 ? "" : "s"}`,
      );
    } else {
      showToast(
        "error",
        `Updated ${successful} book${
          successful === 1 ? "" : "s"
        }, but ${failed} failed`,
      );
    }

    setSelectedBooks(new Set());
    setShowBulkActions(false);
  };

  const toggleBookSelection = (uri: string) => {
    const newSelected = new Set(selectedBooks);
    if (newSelected.has(uri)) {
      newSelected.delete(uri);
    } else {
      newSelected.add(uri);
    }
    setSelectedBooks(newSelected);
    setShowBulkActions(newSelected.size > 0);
  };

  const selectAllBooks = () => {
    const allUris = paginatedBooks.map((book) => book.uri);
    setSelectedBooks(new Set(allUris));
    setShowBulkActions(true);
  };

  const clearSelection = () => {
    setSelectedBooks(new Set());
    setShowBulkActions(false);
  };

  // Filter books based on status
  const filteredBooks = statusFilter
    ? books.filter((book) => book.value.status === statusFilter)
    : books;

  // Pagination logic
  const totalPages = Math.ceil(filteredBooks.length / BOOKS_PER_PAGE);
  const startIndex = currentPage * BOOKS_PER_PAGE;
  const paginatedBooks = filteredBooks.slice(
    startIndex,
    startIndex + BOOKS_PER_PAGE,
  );

  const goToPage = (page: number) => {
    setCurrentPage(Math.max(0, Math.min(page, totalPages - 1)));
    clearSelection(); // Clear selection when changing pages
  };

  const handleStatusFilterChange = (newStatusFilter: BookStatus | null) => {
    setStatusFilter(newStatusFilter);
    setCurrentPage(0); // Reset to first page when filter changes
    clearSelection(); // Clear selection when filter changes
  };

  // Auto-load books when session is available
  useEffect(() => {
    if (session) {
      fetchBooks();
    }
  }, [session]);

  // Show login screen if not authenticated
  if (!session) {
    return <Login />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 py-6 border-b border-gray-200 mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            📚 Book Explorer
          </h1>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <span className="text-sm text-gray-600">
              Logged in as: {session.handle}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 self-start sm:self-auto"
            >
              Logout
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg">
            {error}
          </div>
        )}

        {books.length > 0 && (
          <div>
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
              <h2 className="text-xl sm:text-2xl font-semibold text-gray-800">
                My Books ({statusFilter
                  ? `${filteredBooks.length} of ${books.length}`
                  : books.length})
              </h2>
              <div className="text-sm text-gray-600">
                Page {currentPage + 1} of {totalPages} • Showing{" "}
                {paginatedBooks.length} books
                {statusFilter &&
                  ` (filtered by ${STATUS_LABELS[statusFilter]})`}
              </div>
            </div>

            <BookFilter
              currentFilter={statusFilter}
              onFilterChange={handleStatusFilterChange}
            />

            {showBulkActions && (
              <BulkActions
                selectedCount={selectedBooks.size}
                onStatusUpdate={updateBulkStatus}
                onClearSelection={clearSelection}
              />
            )}

            <BooksTable
              books={paginatedBooks}
              selectedBooks={selectedBooks}
              onToggleSelection={toggleBookSelection}
              onSelectAll={selectAllBooks}
              onClearSelection={clearSelection}
              onStatusUpdate={updateBookStatus}
            />

            {totalPages > 1 && (
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={goToPage}
              />
            )}
          </div>
        )}

        {!loading && books.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <div className="text-6xl mb-4">📚</div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No books found
            </h3>
            <p>
              Your book collection will appear here once you add some books to
              your Bluesky profile.
            </p>
          </div>
        )}
      </div>

      {/* Toast Container */}
      <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
    </div>
  );
}

const statusOptions: BookStatus[] = [
  "buzz.bookhive.defs#wantToRead",
  "buzz.bookhive.defs#reading",
  "buzz.bookhive.defs#finished",
  "buzz.bookhive.defs#abandoned",
  "buzz.bookhive.defs#owned",
];

const getStatusColor = (status: BookStatus) => {
  switch (status) {
    case "buzz.bookhive.defs#finished":
      return "bg-green-100 text-green-800";
    case "buzz.bookhive.defs#reading":
      return "bg-blue-100 text-blue-800";
    case "buzz.bookhive.defs#wantToRead":
      return "bg-yellow-100 text-yellow-800";
    case "buzz.bookhive.defs#abandoned":
      return "bg-red-100 text-red-800";
    case "buzz.bookhive.defs#owned":
      return "bg-gray-100 text-gray-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
};

interface BooksTableProps {
  books: AtProtoRecord[];
  selectedBooks: Set<string>;
  onToggleSelection: (uri: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onStatusUpdate: (uri: string, status: BookStatus) => void;
}

function BooksTable({
  books,
  selectedBooks,
  onToggleSelection,
  onSelectAll,
  onClearSelection,
  onStatusUpdate,
}: BooksTableProps) {
  const allSelected = books.length > 0 &&
    books.every((book) => selectedBooks.has(book.uri));
  const someSelected = selectedBooks.size > 0 && !allSelected;

  const handleSelectAll = () => {
    if (allSelected) {
      onClearSelection();
    } else {
      onSelectAll();
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = someSelected;
                  }}
                  onChange={handleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Title
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Author
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Added
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Technical
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {books.map((record) => (
              <BookRow
                key={record.uri}
                record={record}
                isSelected={selectedBooks.has(record.uri)}
                onToggleSelection={onToggleSelection}
                onStatusUpdate={onStatusUpdate}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface BookRowProps {
  record: AtProtoRecord;
  isSelected: boolean;
  onToggleSelection: (uri: string) => void;
  onStatusUpdate: (uri: string, status: BookStatus) => void;
}

function BookRow({
  record,
  isSelected,
  onToggleSelection,
  onStatusUpdate,
}: BookRowProps) {
  const book = record.value;
  const currentStatus = book.status as BookStatus;
  const [showTechnical, setShowTechnical] = useState(false);

  return (
    <tr className={`hover:bg-gray-50 ${isSelected ? "bg-blue-50" : ""}`}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelection(record.uri)}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
      </td>
      <td className="px-3 py-2">
        <div
          className="text-sm font-medium text-gray-900 truncate max-w-xs"
          title={book.title}
        >
          {book.title}
        </div>
        {book.stars && (
          <div className="text-xs text-yellow-500">
            {"★".repeat(book.stars)} ({book.stars}/10)
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <div
          className="text-sm text-gray-900 truncate max-w-xs"
          title={book.authors}
        >
          {book.authors}
        </div>
      </td>
      <td className="px-3 py-2">
        <span
          className={`px-2 py-1 rounded-full text-xs font-medium ${
            getStatusColor(currentStatus)
          }`}
        >
          {STATUS_LABELS[currentStatus] || currentStatus}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="text-xs text-gray-500">
          {new Date(book.createdAt).toLocaleDateString()}
        </div>
        {book.startedAt && (
          <div className="text-xs text-gray-400">
            Started: {new Date(book.startedAt).toLocaleDateString()}
          </div>
        )}
        {book.finishedAt && (
          <div className="text-xs text-gray-400">
            Finished: {new Date(book.finishedAt).toLocaleDateString()}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => setShowTechnical(!showTechnical)}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          {showTechnical ? "Hide" : "Show"}
        </button>
        {showTechnical && (
          <div className="mt-1 space-y-1 text-xs text-gray-400">
            <div title={record.uri}>URI: {record.uri.slice(-20)}...</div>
            <div title={record.cid}>CID: {record.cid.slice(-20)}...</div>
            <div>Hive: {book.hiveId}</div>
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <select
            value={currentStatus}
            onChange={(e) =>
              onStatusUpdate(record.uri, e.target.value as BookStatus)}
            className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <a
            href={`https://bookhive.buzz/books/${book.hiveId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-blue-600 transition-colors"
            title="View on BookHive"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </a>
        </div>
      </td>
    </tr>
  );
}

interface BulkActionsProps {
  selectedCount: number;
  onStatusUpdate: (status: BookStatus) => void;
  onClearSelection: () => void;
}

function BulkActions(
  { selectedCount, onStatusUpdate, onClearSelection }: BulkActionsProps,
) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-center justify-between">
      <div className="text-sm text-blue-800">
        {selectedCount} book{selectedCount === 1 ? "" : "s"} selected
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-blue-800">Change status to:</span>
        {statusOptions.map((status) => (
          <button
            type="button"
            key={status}
            onClick={() => onStatusUpdate(status)}
            className={`px-2 py-1 rounded text-xs ${
              getStatusColor(status)
            } hover:opacity-80`}
          >
            {STATUS_LABELS[status]}
          </button>
        ))}
        <button
          type="button"
          onClick={onClearSelection}
          className="ml-2 px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs hover:bg-gray-300"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

function Pagination(
  { currentPage, totalPages, onPageChange }: PaginationProps,
) {
  const pages = [];
  const showPages = 5;
  let startPage = Math.max(0, currentPage - Math.floor(showPages / 2));
  const endPage = Math.min(totalPages - 1, startPage + showPages - 1);

  if (endPage - startPage < showPages - 1) {
    startPage = Math.max(0, endPage - showPages + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    pages.push(i);
  }

  return (
    <div className="flex items-center justify-center gap-2 mt-6">
      <button
        type="button"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 0}
        className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
      >
        ← Prev
      </button>

      {startPage > 0 && (
        <>
          <button
            type="button"
            onClick={() => onPageChange(0)}
            className="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50"
          >
            1
          </button>
          {startPage > 1 && <span className="text-gray-500">...</span>}
        </>
      )}

      {pages.map((page) => (
        <button
          type="button"
          key={page}
          onClick={() => onPageChange(page)}
          className={`px-3 py-1 border rounded ${
            page === currentPage
              ? "bg-blue-600 text-white border-blue-600"
              : "border-gray-300 hover:bg-gray-50"
          }`}
        >
          {page + 1}
        </button>
      ))}

      {endPage < totalPages - 1 && (
        <>
          {endPage < totalPages - 2 && (
            <span className="text-gray-500">...</span>
          )}
          <button
            type="button"
            onClick={() => onPageChange(totalPages - 1)}
            className="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50"
          >
            {totalPages}
          </button>
        </>
      )}

      <button
        type="button"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages - 1}
        className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
      >
        Next →
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: Toast[];
  onRemoveToast: (id: string) => void;
}

function ToastContainer({ toasts, onRemoveToast }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastMessage key={toast.id} toast={toast} onRemove={onRemoveToast} />
      ))}
    </div>
  );
}

interface ToastMessageProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

function ToastMessage({ toast, onRemove }: ToastMessageProps) {
  const getToastStyles = (type: Toast["type"]) => {
    switch (type) {
      case "success":
        return "bg-green-500 text-white";
      case "error":
        return "bg-red-500 text-white";
      case "info":
        return "bg-blue-500 text-white";
      default:
        return "bg-gray-500 text-white";
    }
  };

  const getIcon = (type: Toast["type"]) => {
    switch (type) {
      case "success":
        return "✅";
      case "error":
        return "❌";
      case "info":
        return "ℹ️";
      default:
        return "📝";
    }
  };

  return (
    <div
      className={`${
        getToastStyles(toast.type)
      } rounded-lg shadow-lg p-4 flex items-start justify-between min-w-0 animate-in slide-in-from-right-full duration-300`}
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-sm shrink-0">{getIcon(toast.type)}</span>
        <p className="text-sm break-words">{toast.message}</p>
      </div>
      <button
        type="button"
        onClick={() => onRemove(toast.id)}
        className="text-white/80 hover:text-white ml-2 shrink-0"
      >
        ✕
      </button>
    </div>
  );
}

interface BookFilterProps {
  currentFilter: BookStatus | null;
  onFilterChange: (filter: BookStatus | null) => void;
}

function BookFilter({ currentFilter, onFilterChange }: BookFilterProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-2">
          <label
            htmlFor="status-filter"
            className="text-sm font-medium text-gray-700"
          >
            Filter by status:
          </label>
          <select
            id="status-filter"
            value={currentFilter || ""}
            onChange={(e) =>
              onFilterChange(e.target.value as BookStatus || null)}
            className="border border-gray-300 rounded-md px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Books</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>

        {currentFilter && (
          <button
            type="button"
            onClick={() => onFilterChange(null)}
            className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 self-start sm:self-auto"
          >
            Clear Filter
          </button>
        )}

        {currentFilter && (
          <div className="text-sm text-gray-600">
            Showing books with status:{" "}
            <span
              className={`px-2 py-1 rounded-full text-xs font-medium ${
                getStatusColor(currentFilter)
              }`}
            >
              {STATUS_LABELS[currentFilter]}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
