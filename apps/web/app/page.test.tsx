import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DashboardPage from "./page";

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
  team: { id: string; name: string };
  reporter: { id: string; name: string };
  assignee: { id: string; name: string } | null;
};

const team = { id: "team-1", name: "Engineering" };
const userProfile = {
  id: "user-1",
  name: "Taylor Tester",
  email: "taylor@example.com",
  memberships: [{ teamId: team.id, team, role: "ADMIN" as const }],
};

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1",
    title: "Investigate API latency",
    description: "Review recent latency increase.",
    category: "ENGINEERING",
    status: "OPEN",
    priority: "HIGH",
    teamId: team.id,
    reporterId: userProfile.id,
    assigneeId: null,
    version: 1,
    dueAt: null,
    createdAt: "2026-10-18T09:00:00.000Z",
    updatedAt: "2026-10-18T09:30:00.000Z",
    team,
    reporter: { id: userProfile.id, name: userProfile.name },
    assignee: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

function installApiMock({
  initialItems = [makeItem()],
  initialStatus = 401,
  conflictOnFirstEdit = false,
}: {
  initialItems?: WorkItem[];
  initialStatus?: number;
  conflictOnFirstEdit?: boolean;
} = {}) {
  let loggedIn = initialStatus === 200;
  let items = [...initialItems];
  let activities: Array<Record<string, unknown>> = [];
  let shouldConflict = conflictOnFirstEdit;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown>; headers: Headers }> = [];
  const members = [
    { id: "membership-1", role: "ADMIN", user: { id: userProfile.id, name: userProfile.name } },
    { id: "membership-2", role: "MEMBER", user: { id: "user-2", name: "Morgan Member" } },
  ];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url: url.toString(), method, body, headers });
    const path = url.pathname;

    if (path.endsWith("/auth/me")) {
      return loggedIn
        ? jsonResponse({ user: userProfile })
        : jsonResponse({ message: "Unauthorized" }, 401);
    }

    if (path.endsWith("/auth/login") && method === "POST") {
      loggedIn = body?.password === "correct-password";
      return loggedIn
        ? jsonResponse({ success: true })
        : jsonResponse({ message: "Invalid email or password" }, 401);
    }

    if (path.endsWith("/auth/logout") && method === "POST") {
      loggedIn = false;
      return jsonResponse({ success: true });
    }

    if (path.endsWith("/teams") && method === "GET") {
      return jsonResponse({ teams: [team] });
    }

    if (/\/teams\/[^/]+\/members$/.test(path)) {
      return jsonResponse({
        members: [
          { id: "membership-1", role: "ADMIN", user: { id: userProfile.id, name: userProfile.name } },
          { id: "membership-2", role: "MEMBER", user: { id: "user-2", name: "Morgan Member" } },
        ],
      });
    }

    if (path.endsWith("/dashboard/stats")) {
      return jsonResponse({
        total: items.length,
        byStatus: { OPEN: 1, IN_PROGRESS: 1, PENDING_APPROVAL: 0 },
        byPriority: { HIGH: 1 },
        urgentCount: 1,
        overdueCount: 0,
        pendingApprovalCount: 0,
      });
    }

    if (path.endsWith("/work-items/events")) {
      return jsonResponse({});
    }

    if (path.endsWith("/work-items") && method === "GET") {
      const filteredItems = items.filter((item) => {
        const query = url.searchParams.get("q")?.toLowerCase();
        return (
          (!query || `${item.title} ${item.description}`.toLowerCase().includes(query)) &&
          (!url.searchParams.get("team_id") || item.teamId === url.searchParams.get("team_id")) &&
          (!url.searchParams.get("status") || item.status === url.searchParams.get("status")) &&
          (!url.searchParams.get("priority") || item.priority === url.searchParams.get("priority"))
        );
      });
      return jsonResponse({ items: filteredItems });
    }

    if (path.endsWith("/work-items") && method === "POST") {
      const item = makeItem({
        ...body,
        id: `item-${items.length + 1}`,
        title: String(body?.title),
        description: String(body?.description),
        category: String(body?.category),
        priority: body?.priority as WorkItem["priority"],
        status: "OPEN",
      });
      items = [...items, item];
      return jsonResponse({ item }, 201);
    }

    const itemMatch = path.match(/\/work-items\/([^/]+)(?:\/(.*))?$/);
    if (itemMatch) {
      const [, id, action] = itemMatch;
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return jsonResponse({ error: "Work item not found" }, 404);

      if (action === "timeline" && method === "GET") {
        return jsonResponse({ activities });
      }

      if (action === "members" && method === "GET") {
        return jsonResponse({ members });
      }

      if (action === "transition" && method === "POST") {
        const updated = { ...item, status: body?.target_status as WorkItem["status"], version: item.version + 1 };
        items = items.map((candidate) => candidate.id === id ? updated : candidate);
        return jsonResponse({ item: updated });
      }

      if (action === "assign" && method === "POST") {
        const selectedMember = members.find((member) => member.user.id === body?.assignee_id);
        const updated = {
          ...item,
          assigneeId: (body?.assignee_id as string | null) ?? null,
          assignee: selectedMember?.user ?? null,
          version: item.version + 1,
        };
        items = items.map((candidate) => candidate.id === id ? updated : candidate);
        return jsonResponse({ item: updated });
      }

      if (action === "comments" && method === "POST") {
        const activity = {
          id: `activity-${activities.length + 1}`,
          type: "COMMENT_ADDED",
          message: body?.body,
          createdAt: new Date().toISOString(),
          actor: { id: userProfile.id, name: userProfile.name },
        };
        activities = [...activities, activity];
        return jsonResponse({ activity }, 201);
      }

      if ((action === "approve" || action === "reject") && method === "POST") {
        const updated = {
          ...item,
          status: action === "approve" ? "RESOLVED" as const : "IN_PROGRESS" as const,
          version: item.version + 1,
        };
        items = items.map((candidate) => candidate.id === id ? updated : candidate);
        return jsonResponse({ item: updated });
      }

      if (!action && method === "PATCH") {
        if (shouldConflict) {
          shouldConflict = false;
          const current = { ...item, title: "Updated by another teammate", version: item.version + 1 };
          items = items.map((candidate) => candidate.id === id ? current : candidate);
          return jsonResponse({
            error: "Work item changed while editing",
            current,
          }, 409);
        }

        const updated = { ...item, ...body, version: item.version + 1 };
        items = items.map((candidate) => candidate.id === id ? updated : candidate);
        return jsonResponse({ item: updated });
      }
    }

    return jsonResponse({ error: `Unhandled request: ${method} ${path}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    close = vi.fn();
    constructor(_url: string, _options?: EventSourceInit) {}
  });

  return { calls, fetchMock };
}

async function renderLoggedInDashboard() {
  const user = userEvent.setup();
  render(<DashboardPage />);
  await screen.findByText("Sign in to your account");
  await user.type(screen.getByLabelText("Email"), userProfile.email);
  await user.type(screen.getByLabelText("Password"), "correct-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Concurrency & Workflow Engine");
  return user;
}

describe("dashboard authentication", () => {
  beforeEach(() => {
    installApiMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the sign-in form and reports invalid credentials", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByText("Sign in to your account");
    await user.type(screen.getByLabelText("Email"), userProfile.email);
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid email or password",
    );
  });

  it("signs in, loads the dashboard, and signs out", async () => {
    const { calls } = installApiMock();
    const user = await renderLoggedInDashboard();

    expect(await screen.findByText("Taylor Tester")).toBeInTheDocument();
    expect(screen.getByText("Total Work Items")).toBeInTheDocument();
    expect(screen.getByText("Investigate API latency")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Sign in to your account")).toBeInTheDocument();
    expect(calls.some((call) => call.url.endsWith("/auth/logout"))).toBe(true);
  });
});

describe("dashboard work-item workflows", () => {
  beforeEach(() => {
    installApiMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies search, team, status, and priority filters to the list request", async () => {
    const { calls } = installApiMock({
      initialItems: [
        makeItem(),
        makeItem({
          id: "item-2",
          title: "Improve release pipeline",
          description: "Maintain release automation.",
          status: "IN_PROGRESS",
          priority: "MEDIUM",
        }),
      ],
      initialStatus: 200,
    });
    render(<DashboardPage />);
    expect(await screen.findByText("Improve release pipeline")).toBeInTheDocument();
    const search = screen.getByPlaceholderText("Search title & description...");
    fireEvent.change(search, { target: { value: "latency" } });
    await waitFor(() => {
      expect(calls.some((call) => new URL(call.url).searchParams.get("q") === "latency")).toBe(true);
    });
    const selects = screen.getAllByRole("combobox");
    const [teamSelect, statusSelect, prioritySelect] = selects;
    if (!teamSelect || !statusSelect || !prioritySelect) {
      throw new Error("Expected team, status, and priority filters");
    }
    fireEvent.change(teamSelect, { target: { value: team.id } });
    fireEvent.change(statusSelect, { target: { value: "OPEN" } });
    fireEvent.change(prioritySelect, { target: { value: "HIGH" } });

    await waitFor(() => {
      expect(screen.queryByText("Improve release pipeline")).not.toBeInTheDocument();
      expect(screen.getByText("Investigate API latency")).toBeInTheDocument();
    });

    await waitFor(() => {
      const request = calls.filter((call) => call.url.includes("/work-items?")).at(-1);
      expect(request && new URL(request.url).searchParams.get("team_id")).toBe(team.id);
      expect(request && new URL(request.url).searchParams.get("status")).toBe("OPEN");
      expect(request && new URL(request.url).searchParams.get("priority")).toBe("HIGH");
    });
  });

  it("creates a work item from the modal and refreshes the table", async () => {
    const { calls } = installApiMock();
    const user = await renderLoggedInDashboard();
    await user.click(screen.getByRole("button", { name: "+ Create Work Item" }));
    await user.type(screen.getByPlaceholderText("Short summary of request..."), "Add integration coverage");
    await user.type(
      screen.getByPlaceholderText("Detailed steps, context, or reproduction notes..."),
      "Cover the main dashboard workflows.",
    );
    await user.click(screen.getByRole("button", { name: "Submit Request" }));

    expect(await screen.findByText("Add integration coverage")).toBeInTheDocument();
    const createCall = calls.find((call) =>
      call.url.endsWith("/work-items") && call.method === "POST",
    );
    expect(createCall?.body).toMatchObject({
      title: "Add integration coverage",
      category: "ENGINEERING",
      priority: "MEDIUM",
      teamId: team.id,
    });
    expect(createCall?.headers.has("Idempotency-Key")).toBe(true);
  });

  it("opens an item, transitions its status, assigns it, and posts a comment", async () => {
    const { calls } = installApiMock();
    const user = await renderLoggedInDashboard();
    await user.click(await screen.findByText("Investigate API latency"));
    expect(await screen.findByText("Workflow State Transitions (Optimistic Concurrency Guarded)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Start Work/ }));
    expect((await screen.findAllByText("IN PROGRESS")).length).toBeGreaterThan(0);

    const assigneeSelect = screen.getByDisplayValue("Unassigned / Claim");
    await user.selectOptions(assigneeSelect, "user-2");
    expect(await screen.findByDisplayValue("Morgan Member (MEMBER)")).toBeInTheDocument();

    const comment = screen.getByPlaceholderText("Add an internal note or update (Idempotent)...");
    await user.type(comment, "Verified the latency regression.");
    await user.click(screen.getByRole("button", { name: "Post Comment" }));
    expect(await screen.findByText("Verified the latency regression.")).toBeInTheDocument();

    expect(calls.some((call) => call.url.endsWith("/transition"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/assign"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/comments"))).toBe(true);
  });

  it("handles stale edits by displaying the conflict and retrying against the latest version", async () => {
    const { calls } = installApiMock({ conflictOnFirstEdit: true });
    const user = await renderLoggedInDashboard();
    await user.click(await screen.findByText("Investigate API latency"));
    await user.click(await screen.findByRole("button", { name: "✎ Edit Fields (OCC)" }));
    const titleInput = screen.getByDisplayValue("Investigate API latency");
    await user.clear(titleInput);
    await user.type(titleInput, "Local title update");
    await user.click(screen.getByRole("button", { name: /Save Changes/ }));

    expect(await screen.findByText(/409 Conflict Detected/)).toBeInTheDocument();
    expect(screen.getByText("Updated by another teammate")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Overwrite with My Changes/ }));

    await waitFor(() => {
      expect(screen.queryByText(/409 Conflict Detected/)).not.toBeInTheDocument();
    });
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "PATCH").at(-1)?.headers.get("If-Match")).toBe('"2"');
    expect((await screen.findAllByText("Local title update")).length).toBeGreaterThan(0);
  });

  it("approves an item after entering an optional reason", async () => {
    const pendingItem = makeItem({ status: "PENDING_APPROVAL" });
    const { calls } = installApiMock({
      initialItems: [pendingItem],
      initialStatus: 200,
    });
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByText("Investigate API latency");
    await user.click(screen.getByText("Investigate API latency"));
    await user.click(await screen.findByRole("button", { name: "✓ Approve Item" }));
    await user.type(screen.getByPlaceholderText("Enter rationale..."), "Reviewed and verified.");
    await user.click(screen.getByRole("button", { name: "Confirm Approval" }));

    expect((await screen.findAllByText("RESOLVED")).length).toBeGreaterThan(0);
    const approvalCall = calls.find((call) => call.url.endsWith("/approve"));
    expect(approvalCall?.body).toMatchObject({
      version: 1,
      reason: "Reviewed and verified.",
    });
  });
});
