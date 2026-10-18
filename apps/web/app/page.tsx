"use client";

import React, { useState, useEffect, useCallback } from "react";
import styles from "./dashboard.module.css";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(input, {
    ...init,
    headers,
    credentials: "include",
  });
}

type WorkItem = {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "OPEN" | "IN_PROGRESS" | "PENDING_APPROVAL" | "RESOLVED" | "CLOSED";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  teamId: string;
  reporterId: string;
  assigneeId: string | null;
  version: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  team?: { id: string; name: string };
  reporter?: { id: string; name: string };
  assignee?: { id: string; name: string } | null;
};

type UserProfile = {
  id: string;
  name: string;
  email: string;
  memberships: {
    teamId: string;
    team: { id: string; name: string };
    role: "ADMIN" | "TEAM_LEAD" | "MEMBER" | "VIEWER";
  }[];
};

type Team = {
  id: string;
  name: string;
  slug: string;
  myRole?: string;
};

type Activity = {
  id: string;
  type: string;
  message: string | null;
  changes: any;
  createdAt: string;
  actor: { id: string; name: string };
};

type DashboardStats = {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  urgentCount: number;
  overdueCount: number;
  pendingApprovalCount: number;
};

export default function DashboardPage() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loginLoading, setLoginLoading] = useState<boolean>(false);

  // Filters
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [selectedPriority, setSelectedPriority] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  // Selected Item Drawer / Detail
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [timeline, setTimeline] = useState<Activity[]>([]);
  const [teamMembers, setTeamMembers] = useState<
    { id: string; role: string; user: { id: string; name: string } }[]
  >([]);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [showEditModal, setShowEditModal] = useState<boolean>(false);
  const [conflictData, setConflictData] = useState<{
    error: string;
    current: WorkItem;
    attempted: Partial<WorkItem>;
  } | null>(null);

  // Forms
  const [createForm, setCreateForm] = useState({
    title: "",
    description: "",
    category: "ENGINEERING",
    priority: "MEDIUM",
    teamId: "",
    assigneeId: "",
  });

  const [editForm, setEditForm] = useState<{
    title: string;
    description: string;
    priority: WorkItem["priority"];
  }>({
    title: "",
    description: "",
    priority: "MEDIUM",
  });

  const [commentText, setCommentText] = useState("");
  const [isInternalComment, setIsInternalComment] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const [showReasonInput, setShowReasonInput] = useState<
    "approve" | "reject" | null
  >(null);

  const getHeaders = useCallback(
    () => ({ "Content-Type": "application/json" }),
    [],
  );

  // Load User, Teams, and Stats
  const loadInitialData = useCallback(async () => {
    try {
      const headers = getHeaders();

      const sessionRes = await apiFetch(`${API_BASE}/api/v1/auth/me`, {
        headers,
      });
      if (sessionRes.status === 401) {
        setUser(null);
        return;
      }
      if (!sessionRes.ok) throw new Error("Failed to verify session");

      const session = await sessionRes.json();
      setUser(session.user);

      // Fetch teams
      const teamsRes = await apiFetch(`${API_BASE}/api/v1/teams`, { headers });
      if (teamsRes.ok) {
        const t = await teamsRes.json();
        setTeams(t.teams);
        if (t.teams.length > 0) {
          setCreateForm((prev) =>
            prev.teamId ? prev : { ...prev, teamId: t.teams[0].id },
          );
        }
      }

      // Fetch dashboard stats
      const statsRes = await apiFetch(`${API_BASE}/api/v1/dashboard/stats`, {
        headers,
      });
      if (statsRes.ok) {
        const s = await statsRes.json();
        setStats(s);
      }
    } catch (err) {
      console.error("Failed to load initial data:", err);
      setAuthError("Unable to connect to the server. Please try again.");
    } finally {
      setAuthLoading(false);
    }
  }, [getHeaders]);

  // Load Work Items with Filters
  const loadWorkItems = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const url = new URL(`${API_BASE}/api/v1/work-items`);
      if (selectedTeam) url.searchParams.set("team_id", selectedTeam);
      if (selectedStatus) url.searchParams.set("status", selectedStatus);
      if (selectedPriority) url.searchParams.set("priority", selectedPriority);
      if (searchQuery) url.searchParams.set("q", searchQuery);

      const res = await apiFetch(url.toString(), { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setWorkItems(data.items);
      }
    } catch (err) {
      console.error("Failed to fetch work items:", err);
    } finally {
      setLoading(false);
    }
  }, [
    getHeaders,
    selectedTeam,
    selectedStatus,
    selectedPriority,
    searchQuery,
    user,
  ]);

  // Load Timeline & Members for selected item
  const loadItemDetails = useCallback(
    async (item: WorkItem) => {
      setSelectedItem(item);
      setEditForm({
        title: item.title,
        description: item.description,
        priority: item.priority,
      });
      setShowReasonInput(null);

      try {
        const headers = getHeaders();
        // Load timeline
        const timelineRes = await apiFetch(
          `${API_BASE}/api/v1/work-items/${item.id}/timeline`,
          { headers },
        );
        if (timelineRes.ok) {
          const data = await timelineRes.json();
          setTimeline(data.activities);
        }

        // Load team members
        const membersRes = await apiFetch(
          `${API_BASE}/api/v1/teams/${item.teamId}/members`,
          { headers },
        );
        if (membersRes.ok) {
          const data = await membersRes.json();
          setTeamMembers(data.members);
        }
      } catch (err) {
        console.error("Failed to load item timeline:", err);
      }
    },
    [getHeaders],
  );

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  useEffect(() => {
    loadWorkItems();
  }, [loadWorkItems]);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginLoading(true);
    setAuthError("");

    try {
      const response = await apiFetch(`${API_BASE}/api/v1/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setAuthError(data.message || "Unable to sign in");
        return;
      }

      setPassword("");
      await loadInitialData();
    } catch (error) {
      console.error("Login failed:", error);
      setAuthError("Unable to connect to the server. Please try again.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      const response = await apiFetch(`${API_BASE}/api/v1/auth/logout`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Logout failed");
      setUser(null);
      setTeams([]);
      setStats(null);
      setWorkItems([]);
    } catch (error) {
      console.error("Logout failed:", error);
      setAuthError("Unable to sign out. Please try again.");
    }
  };

  // Connect Server-Sent Events (SSE) for Real-Time Updates
  useEffect(() => {
    if (!user) return;
    const sse = new EventSource(`${API_BASE}/api/v1/work-items/events`, {
      withCredentials: true,
    });
    let connectedBefore = false;

    sse.onopen = () => {
      if (connectedBefore) {
        loadWorkItems();
        loadInitialData();
      }
      connectedBefore = true;
    };

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type !== "CONNECTED") {
          // Live reload work items and stats
          loadWorkItems();
          loadInitialData();
        }
      } catch (e) {
        // Heartbeat or ignore
      }
    };

    return () => {
      sse.close();
    };
  }, [loadWorkItems, loadInitialData, user]);

  // Handle Create Work Item (with Idempotency-Key)
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await apiFetch(`${API_BASE}/api/v1/work-items`, {
        method: "POST",
        headers: {
          ...getHeaders(),
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          ...createForm,
          assigneeId: createForm.assigneeId || undefined,
        }),
      });

      if (res.ok) {
        setShowCreateModal(false);
        setCreateForm({
          title: "",
          description: "",
          category: "ENGINEERING",
          priority: "MEDIUM",
          teamId: teams[0]?.id || "",
          assigneeId: "",
        });
        loadWorkItems();
        loadInitialData();
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create work item");
      }
    } catch (err) {
      console.error("Create error:", err);
    }
  };

  // Handle Edit with Optimistic Concurrency Control (OCC)
  const handleEditSubmit = async (overrideVersion?: number) => {
    if (!selectedItem) return;
    const targetVersion = overrideVersion ?? selectedItem.version;

    try {
      const res = await apiFetch(
        `${API_BASE}/api/v1/work-items/${selectedItem.id}`,
        {
          method: "PATCH",
          headers: {
            ...getHeaders(),
            "If-Match": `"${targetVersion}"`,
          },
          body: JSON.stringify(editForm),
        },
      );

      if (res.status === 409) {
        // OCC 409 Conflict detected!
        const conflict = await res.json();
        setConflictData({
          error: conflict.error,
          current: conflict.current,
          attempted: editForm,
        });
      } else if (res.ok) {
        const updated = await res.json();
        setShowEditModal(false);
        setConflictData(null);
        loadItemDetails(updated.item);
        loadWorkItems();
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update item");
      }
    } catch (err) {
      console.error("Edit error:", err);
    }
  };

  // State Transition Actions
  const handleTransition = async (targetStatus: string) => {
    if (!selectedItem) return;

    try {
      const res = await apiFetch(
        `${API_BASE}/api/v1/work-items/${selectedItem.id}/transition`,
        {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            version: selectedItem.version,
            target_status: targetStatus,
          }),
        },
      );

      if (res.status === 409) {
        const conflict = await res.json();
        alert(
          `Concurrency Conflict: Another user modified this item to version ${conflict.current?.version}. Refreshing.`,
        );
        loadItemDetails(conflict.current);
      } else if (res.ok) {
        const data = await res.json();
        loadItemDetails(data.item);
        loadWorkItems();
      } else {
        const err = await res.json();
        alert(err.error || "Transition failed");
      }
    } catch (err) {
      console.error("Transition error:", err);
    }
  };

  // Handle Approval / Rejection
  const handleApprovalAction = async (action: "approve" | "reject") => {
    if (!selectedItem) return;

    try {
      const res = await apiFetch(
        `${API_BASE}/api/v1/work-items/${selectedItem.id}/${action}`,
        {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            version: selectedItem.version,
            reason: reasonText || undefined,
          }),
        },
      );

      if (res.status === 409) {
        const conflict = await res.json();
        alert(
          `Concurrency Conflict: Version changed to ${conflict.current?.version}. Refreshing.`,
        );
        loadItemDetails(conflict.current);
      } else if (res.ok) {
        const data = await res.json();
        setShowReasonInput(null);
        setReasonText("");
        loadItemDetails(data.item);
        loadWorkItems();
      } else {
        const err = await res.json();
        alert(err.error || `Failed to ${action} item`);
      }
    } catch (err) {
      console.error(`${action} error:`, err);
    }
  };

  // Handle Reassignment
  const handleAssign = async (assigneeId: string) => {
    if (!selectedItem) return;

    try {
      const res = await apiFetch(
        `${API_BASE}/api/v1/work-items/${selectedItem.id}/assign`,
        {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            version: selectedItem.version,
            assignee_id: assigneeId || null,
          }),
        },
      );

      if (res.status === 409) {
        const conflict = await res.json();
        alert(
          `Concurrency Conflict: Version changed to ${conflict.current?.version}. Refreshing.`,
        );
        loadItemDetails(conflict.current);
      } else if (res.ok) {
        const data = await res.json();
        loadItemDetails(data.item);
        loadWorkItems();
      }
    } catch (err) {
      console.error("Assign error:", err);
    }
  };

  // Add Comment with Idempotency Key
  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedItem || !commentText.trim()) return;

    try {
      const res = await apiFetch(
        `${API_BASE}/api/v1/work-items/${selectedItem.id}/comments`,
        {
          method: "POST",
          headers: {
            ...getHeaders(),
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            body: commentText.trim(),
            is_internal: isInternalComment,
          }),
        },
      );

      if (res.ok) {
        setCommentText("");
        loadItemDetails(selectedItem);
      }
    } catch (err) {
      console.error("Comment error:", err);
    }
  };

  // Priority and Status Badge styling helper
  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case "OPEN":
        return `${styles.badge} ${styles.badgeOpen}`;
      case "IN_PROGRESS":
        return `${styles.badge} ${styles.badgeInProgress}`;
      case "PENDING_APPROVAL":
        return `${styles.badge} ${styles.badgePendingApproval}`;
      case "RESOLVED":
        return `${styles.badge} ${styles.badgeResolved}`;
      case "CLOSED":
        return `${styles.badge} ${styles.badgeClosed}`;
      default:
        return styles.badge;
    }
  };

  const getPriorityBadgeClass = (priority: string) => {
    switch (priority) {
      case "URGENT":
        return `${styles.badge} ${styles.badgeUrgent}`;
      case "HIGH":
        return `${styles.badge} ${styles.badgeHigh}`;
      case "MEDIUM":
        return `${styles.badge} ${styles.badgeMedium}`;
      case "LOW":
        return `${styles.badge} ${styles.badgeLow}`;
      default:
        return styles.badge;
    }
  };

  if (authLoading) {
    return <main className={styles.authLoading}>Checking your session...</main>;
  }

  if (!user) {
    return (
      <main className={styles.authScreen}>
        <form className={styles.authCard} onSubmit={handleLogin}>
          <div className={styles.brand}>
            <div className={styles.brandIcon}>OM</div>
            <div>
              <div className={styles.brandTitle}>Operational Work System</div>
              <div className={styles.brandSubtitle}>
                Sign in to your account
              </div>
            </div>
          </div>
          {authError && (
            <p className={styles.authError} role="alert">
              {authError}
            </p>
          )}
          <label className={styles.formGroup}>
            <span className={styles.formLabel}>Email</span>
            <input
              className={styles.formInput}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className={styles.formGroup}>
            <span className={styles.formLabel}>Password</span>
            <input
              className={styles.formInput}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            className={styles.btnPrimary}
            type="submit"
            disabled={loginLoading}
          >
            {loginLoading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className={styles.container}>
      {/* Top Header */}
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.brandIcon}>OM</div>
          <div>
            <div className={styles.brandTitle}>Operational Work System</div>
            <div className={styles.brandSubtitle}>
              Concurrency & Workflow Engine
            </div>
          </div>
        </div>

        <div className={styles.userScope}>
          <div className={styles.liveBadge}>
            <span className={styles.liveDot}></span>
            <span>Real-time SSE Active</span>
          </div>

          <div className={styles.userCard}>
            <span>{user.name}</span>
            {user.memberships[0] && (
              <span className={styles.userRole}>
                {user.memberships[0].role}
              </span>
            )}
          </div>
          <button
            className={styles.btnSecondary}
            type="button"
            onClick={handleLogout}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className={styles.main}>
        {/* Metric Cards */}
        <section className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Total Work Items</div>
            <div className={styles.statValue}>{stats?.total ?? 0}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>In Progress</div>
            <div className={`${styles.statValue} ${styles.statWarning}`}>
              {stats?.byStatus?.IN_PROGRESS ?? 0}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Pending Approval</div>
            <div className={styles.statValue}>
              {stats?.byStatus?.PENDING_APPROVAL ?? 0}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Urgent Priority</div>
            <div className={`${styles.statValue} ${styles.statUrgent}`}>
              {stats?.urgentCount ?? 0}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Overdue Items</div>
            <div className={`${styles.statValue} ${styles.statUrgent}`}>
              {stats?.overdueCount ?? 0}
            </div>
          </div>
        </section>

        {/* Toolbar & Filter Bar */}
        <div className={styles.toolbar}>
          <div className={styles.filters}>
            <input
              type="text"
              placeholder="Search title & description..."
              className={styles.searchInput}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <select
              className={styles.selectInput}
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value)}
            >
              <option value="">All Teams</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <select
              className={styles.selectInput}
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="OPEN">Open</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="PENDING_APPROVAL">Pending Approval</option>
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED">Closed</option>
            </select>

            <select
              className={styles.selectInput}
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
            >
              <option value="">All Priorities</option>
              <option value="URGENT">Urgent</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
          </div>

          <button
            className={styles.btnPrimary}
            onClick={() => setShowCreateModal(true)}
          >
            + Create Work Item
          </button>
        </div>

        {/* Work Items Table */}
        <div className={styles.tableContainer}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Title & Category</th>
                <th className={styles.th}>Status</th>
                <th className={styles.th}>Priority</th>
                <th className={styles.th}>Team</th>
                <th className={styles.th}>Assignee</th>
                <th className={styles.th}>Version</th>
                <th className={styles.th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className={styles.td}
                    style={{ textAlign: "center", padding: "2rem" }}
                  >
                    Loading work items...
                  </td>
                </tr>
              ) : workItems.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className={styles.td}
                    style={{
                      textAlign: "center",
                      padding: "2rem",
                      color: "#64748b",
                    }}
                  >
                    No work items found matching the selected filters.
                  </td>
                </tr>
              ) : (
                workItems.map((item) => (
                  <tr
                    key={item.id}
                    className={styles.tr}
                    onClick={() => loadItemDetails(item)}
                  >
                    <td className={styles.td}>
                      <div className={styles.itemTitle}>{item.title}</div>
                      <div className={styles.itemCategory}>{item.category}</div>
                    </td>
                    <td className={styles.td}>
                      <span className={getStatusBadgeClass(item.status)}>
                        {item.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className={styles.td}>
                      <span className={getPriorityBadgeClass(item.priority)}>
                        {item.priority}
                      </span>
                    </td>
                    <td className={styles.td}>
                      {item.team?.name || "Unassigned"}
                    </td>
                    <td className={styles.td}>
                      {item.assignee?.name || "Unclaimed"}
                    </td>
                    <td className={styles.td}>
                      <span
                        className={`${styles.badge} ${styles.badgeVersion}`}
                      >
                        v{item.version}
                      </span>
                    </td>
                    <td className={styles.td}>
                      {new Date(item.updatedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {/* Work Item Detail & Actions Drawer Modal */}
      {selectedItem && (
        <div
          className={styles.modalOverlay}
          onClick={() => setSelectedItem(null)}
        >
          <div
            className={styles.drawerContent}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <span className={getPriorityBadgeClass(selectedItem.priority)}>
                  {selectedItem.priority}
                </span>{" "}
                <span className={getStatusBadgeClass(selectedItem.status)}>
                  {selectedItem.status.replace("_", " ")}
                </span>{" "}
                <span className={`${styles.badge} ${styles.badgeVersion}`}>
                  v{selectedItem.version}
                </span>
                <h2
                  className={styles.modalTitle}
                  style={{ marginTop: "0.5rem" }}
                >
                  {selectedItem.title}
                </h2>
              </div>
              <button
                className={styles.btnSecondary}
                onClick={() => setSelectedItem(null)}
              >
                ✕ Close
              </button>
            </div>

            <div className={styles.modalBody}>
              {/* Description */}
              <div style={{ marginBottom: "1.5rem" }}>
                <div className={styles.formLabel}>Description</div>
                <div
                  style={{
                    background: "#f8fafc",
                    padding: "1rem",
                    borderRadius: "0.375rem",
                    border: "1px solid #e2e8f0",
                  }}
                >
                  {selectedItem.description}
                </div>
              </div>

              {/* Action Toolbar */}
              <div
                style={{
                  background: "#f1f5f9",
                  padding: "1rem",
                  borderRadius: "0.5rem",
                  marginBottom: "1.5rem",
                }}
              >
                <div
                  className={styles.formLabel}
                  style={{ marginBottom: "0.75rem" }}
                >
                  Workflow State Transitions (Optimistic Concurrency Guarded)
                </div>
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
                >
                  {selectedItem.status === "OPEN" && (
                    <>
                      <button
                        className={styles.btnPrimary}
                        onClick={() => handleTransition("IN_PROGRESS")}
                      >
                        Start Work →
                      </button>
                      <button
                        className={styles.btnSecondary}
                        onClick={() => handleTransition("CLOSED")}
                      >
                        Discard / Close
                      </button>
                    </>
                  )}

                  {selectedItem.status === "IN_PROGRESS" && (
                    <>
                      <button
                        className={styles.btnPrimary}
                        onClick={() => handleTransition("PENDING_APPROVAL")}
                      >
                        Submit for Review →
                      </button>
                      <button
                        className={styles.btnSuccess}
                        onClick={() => handleTransition("RESOLVED")}
                      >
                        Direct Resolve
                      </button>
                      <button
                        className={styles.btnSecondary}
                        onClick={() => handleTransition("CLOSED")}
                      >
                        Close
                      </button>
                    </>
                  )}

                  {selectedItem.status === "PENDING_APPROVAL" && (
                    <>
                      <button
                        className={styles.btnSuccess}
                        onClick={() => setShowReasonInput("approve")}
                      >
                        ✓ Approve Item
                      </button>
                      <button
                        className={styles.btnDanger}
                        onClick={() => setShowReasonInput("reject")}
                      >
                        ✕ Request Changes
                      </button>
                    </>
                  )}

                  {selectedItem.status === "RESOLVED" && (
                    <>
                      <button
                        className={styles.btnSecondary}
                        onClick={() => handleTransition("CLOSED")}
                      >
                        Verify & Close
                      </button>
                      <button
                        className={styles.btnSecondary}
                        onClick={() => handleTransition("OPEN")}
                      >
                        Reopen Item
                      </button>
                    </>
                  )}

                  {selectedItem.status === "CLOSED" && (
                    <button
                      className={styles.btnSecondary}
                      onClick={() => handleTransition("OPEN")}
                    >
                      Reopen Item
                    </button>
                  )}

                  <button
                    className={styles.btnSecondary}
                    onClick={() => setShowEditModal(true)}
                  >
                    ✎ Edit Fields (OCC)
                  </button>
                </div>

                {/* Approve/Reject Reason Input */}
                {showReasonInput && (
                  <div
                    style={{
                      marginTop: "1rem",
                      padding: "0.75rem",
                      background: "#ffffff",
                      borderRadius: "0.375rem",
                    }}
                  >
                    <div className={styles.formLabel}>
                      {showReasonInput === "approve"
                        ? "Approval Notes (Optional):"
                        : "Reason for Rejection / Changes:"}
                    </div>
                    <input
                      type="text"
                      className={styles.formInput}
                      placeholder="Enter rationale..."
                      value={reasonText}
                      onChange={(e) => setReasonText(e.target.value)}
                      style={{ marginBottom: "0.5rem" }}
                    />
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        className={
                          showReasonInput === "approve"
                            ? styles.btnSuccess
                            : styles.btnDanger
                        }
                        onClick={() => handleApprovalAction(showReasonInput)}
                      >
                        Confirm{" "}
                        {showReasonInput === "approve"
                          ? "Approval"
                          : "Rejection"}
                      </button>
                      <button
                        className={styles.btnSecondary}
                        onClick={() => setShowReasonInput(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Ownership & Assignment */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                  marginBottom: "1.5rem",
                }}
              >
                <div>
                  <div className={styles.formLabel}>Team Assignment</div>
                  <div style={{ fontWeight: 600 }}>
                    {selectedItem.team?.name}
                  </div>
                </div>
                <div>
                  <div className={styles.formLabel}>
                    Assignee (Click to Reassign)
                  </div>
                  <select
                    className={styles.formSelect}
                    value={selectedItem.assigneeId || ""}
                    onChange={(e) => handleAssign(e.target.value)}
                  >
                    <option value="">Unassigned / Claim</option>
                    {teamMembers.map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {m.user.name} ({m.role})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Activity Timeline & Comment Box */}
              <div>
                <h3
                  className={styles.modalTitle}
                  style={{ fontSize: "1rem", marginBottom: "0.5rem" }}
                >
                  Activity & Audit Timeline
                </h3>

                <form
                  onSubmit={handleAddComment}
                  style={{ marginBottom: "1rem" }}
                >
                  <textarea
                    className={styles.formTextarea}
                    placeholder="Add an internal note or update (Idempotent)..."
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    style={{ minHeight: "70px" }}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: "0.5rem",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "0.8125rem",
                        color: "#64748b",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isInternalComment}
                        onChange={(e) => setIsInternalComment(e.target.checked)}
                        style={{ marginRight: "0.375rem" }}
                      />
                      Internal note only
                    </label>
                    <button type="submit" className={styles.btnPrimary}>
                      Post Comment
                    </button>
                  </div>
                </form>

                <div className={styles.timeline}>
                  {timeline.map((act) => (
                    <div key={act.id} className={styles.timelineItem}>
                      <div className={styles.timelineAvatar}>
                        {act.actor?.name?.charAt(0) || "U"}
                      </div>
                      <div className={styles.timelineContent}>
                        <div className={styles.timelineHeader}>
                          <span className={styles.timelineActor}>
                            {act.actor?.name}
                          </span>
                          <span className={styles.timelineTime}>
                            {new Date(act.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div
                          style={{
                            fontWeight: 600,
                            color: "#475569",
                            fontSize: "0.75rem",
                          }}
                        >
                          {act.type.replace("_", " ")}
                        </div>
                        {act.message && (
                          <div className={styles.timelineMessage}>
                            {act.message}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Work Item Modal */}
      {showCreateModal && (
        <div
          className={styles.modalOverlay}
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>Create New Work Item</h2>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateSubmit}>
              <div className={styles.modalBody}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Title *</label>
                  <input
                    type="text"
                    required
                    className={styles.formInput}
                    placeholder="Short summary of request..."
                    value={createForm.title}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, title: e.target.value })
                    }
                  />
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Description *</label>
                  <textarea
                    required
                    className={styles.formTextarea}
                    placeholder="Detailed steps, context, or reproduction notes..."
                    value={createForm.description}
                    onChange={(e) =>
                      setCreateForm({
                        ...createForm,
                        description: e.target.value,
                      })
                    }
                  />
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "1rem",
                  }}
                >
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Category</label>
                    <select
                      className={styles.formSelect}
                      value={createForm.category}
                      onChange={(e) =>
                        setCreateForm({
                          ...createForm,
                          category: e.target.value,
                        })
                      }
                    >
                      <option value="CUSTOMER_ISSUE">Customer Issue</option>
                      <option value="ENGINEERING">Engineering Bug</option>
                      <option value="PAYMENT">Payment Hold</option>
                      <option value="INCIDENT">Production Incident</option>
                      <option value="COMPLIANCE">Compliance</option>
                      <option value="OPERATIONS">Operations</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Priority</label>
                    <select
                      className={styles.formSelect}
                      value={createForm.priority}
                      onChange={(e) =>
                        setCreateForm({
                          ...createForm,
                          priority: e.target.value,
                        })
                      }
                    >
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                      <option value="URGENT">Urgent</option>
                    </select>
                  </div>
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Team Assignment *</label>
                  <select
                    required
                    className={styles.formSelect}
                    value={createForm.teamId}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, teamId: e.target.value })
                    }
                  >
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className={styles.btnPrimary}>
                  Submit Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Fields Modal (Optimistic Concurrency Control) */}
      {showEditModal && selectedItem && (
        <div
          className={styles.modalOverlay}
          onClick={() => setShowEditModal(false)}
        >
          <div
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>
                Edit Work Item (Targeting Version {selectedItem.version})
              </h2>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowEditModal(false)}
              >
                ✕
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Title</label>
                <input
                  type="text"
                  className={styles.formInput}
                  value={editForm.title}
                  onChange={(e) =>
                    setEditForm({ ...editForm, title: e.target.value })
                  }
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Priority</label>
                <select
                  className={styles.formSelect}
                  value={editForm.priority}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      priority: e.target.value as WorkItem["priority"],
                    })
                  }
                >
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Description</label>
                <textarea
                  className={styles.formTextarea}
                  value={editForm.description}
                  onChange={(e) =>
                    setEditForm({ ...editForm, description: e.target.value })
                  }
                />
              </div>
            </div>

            <div className={styles.modalFooter}>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowEditModal(false)}
              >
                Cancel
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => handleEditSubmit()}
              >
                Save Changes (OCC Guarded)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OCC 409 Conflict Resolution Dialog */}
      {conflictData && (
        <div className={styles.modalOverlay}>
          <div className={styles.modalContent} style={{ maxWidth: "700px" }}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle} style={{ color: "#b91c1c" }}>
                ⚠️ 409 Conflict Detected
              </h2>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.conflictBanner}>
                Another user modified this work item while you were editing! The
                server state has advanced to{" "}
                <strong>Version {conflictData.current.version}</strong>.
              </div>

              <div className={styles.diffContainer}>
                {/* Your attempted changes */}
                <div className={styles.diffColumn}>
                  <div className={styles.diffColumnTitle}>
                    Your Local Changes
                  </div>
                  <div className={styles.diffField}>
                    <div className={styles.diffFieldLabel}>Title:</div>
                    <div className={styles.diffFieldValue}>
                      {conflictData.attempted.title}
                    </div>
                  </div>
                  <div className={styles.diffField}>
                    <div className={styles.diffFieldLabel}>Priority:</div>
                    <div className={styles.diffFieldValue}>
                      {conflictData.attempted.priority}
                    </div>
                  </div>
                  <div className={styles.diffField}>
                    <div className={styles.diffFieldLabel}>Target Version:</div>
                    <div className={styles.diffFieldValue}>
                      v{selectedItem?.version}
                    </div>
                  </div>
                </div>

                {/* Current Server State */}
                <div
                  className={styles.diffColumn}
                  style={{ borderColor: "#10b981", background: "#f0fdf4" }}
                >
                  <div
                    className={styles.diffColumnTitle}
                    style={{ color: "#065f46" }}
                  >
                    Current Server State (Latest)
                  </div>
                  <div className={styles.diffField}>
                    <div className={styles.diffFieldLabel}>Title:</div>
                    <div className={styles.diffFieldValue}>
                      {conflictData.current.title}
                    </div>
                  </div>
                  <div className={styles.diffField}>
                    <div className={styles.diffFieldLabel}>Priority:</div>
                    <div className={styles.diffFieldValue}>
                      {conflictData.current.priority}
                    </div>
                  </div>
                  <div className={styles.diffField}>
                    <div className={styles.diffFieldLabel}>
                      Current Version:
                    </div>
                    <div className={styles.diffFieldValue}>
                      v{conflictData.current.version}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.modalFooter}>
              <button
                className={styles.btnSecondary}
                onClick={() => {
                  loadItemDetails(conflictData.current);
                  setConflictData(null);
                  setShowEditModal(false);
                }}
              >
                Discard My Edits & Load Server Version
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => {
                  // Re-apply local changes on top of new version
                  handleEditSubmit(conflictData.current.version);
                }}
              >
                Overwrite with My Changes (on v{conflictData.current.version})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
