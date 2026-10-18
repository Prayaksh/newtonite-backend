import { expect, test, type Page, type Route } from "@playwright/test";

type Item = {
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
const currentUser = {
  id: "user-1",
  name: "Taylor Tester",
  email: "taylor@example.com",
  memberships: [{ teamId: team.id, team, role: "ADMIN" }],
};

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    title: "Investigate API latency",
    description: "Review recent latency increase.",
    category: "ENGINEERING",
    status: "OPEN",
    priority: "HIGH",
    teamId: team.id,
    reporterId: currentUser.id,
    assigneeId: null,
    version: 1,
    dueAt: null,
    createdAt: "2026-10-18T09:00:00.000Z",
    updatedAt: "2026-10-18T09:30:00.000Z",
    team,
    reporter: { id: currentUser.id, name: currentUser.name },
    assignee: null,
    ...overrides,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockApi(
  page: Page,
  {
    initialItems = [item()],
    conflictOnFirstEdit = false,
  }: { initialItems?: Item[]; conflictOnFirstEdit?: boolean } = {},
) {
  let loggedIn = false;
  let items = [...initialItems];
  let activities: Array<Record<string, unknown>> = [];
  let conflictPending = conflictOnFirstEdit;

  await page.addInitScript(() => {
    class TestEventSource {
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: TestEventSource });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | undefined;

    if (path.endsWith("/auth/me")) {
      return loggedIn
        ? json(route, { user: currentUser })
        : json(route, { message: "Unauthorized" }, 401);
    }

    if (path.endsWith("/auth/login") && method === "POST") {
      loggedIn = body?.password === "correct-password";
      return loggedIn
        ? json(route, { success: true })
        : json(route, { message: "Invalid email or password" }, 401);
    }

    if (path.endsWith("/auth/logout") && method === "POST") {
      loggedIn = false;
      return json(route, { success: true });
    }

    if (path.endsWith("/work-items/events")) {
      return json(route, {});
    }

    if (path.endsWith("/teams") && method === "GET") {
      return json(route, { teams: [team] });
    }

    if (/\/teams\/[^/]+\/members$/.test(path)) {
      return json(route, {
        members: [
          { id: "membership-1", role: "ADMIN", user: { id: currentUser.id, name: currentUser.name } },
          { id: "membership-2", role: "MEMBER", user: { id: "user-2", name: "Morgan Member" } },
        ],
      });
    }

    if (path.endsWith("/dashboard/stats")) {
      return json(route, {
        total: items.length,
        byStatus: { OPEN: 1, IN_PROGRESS: 1, PENDING_APPROVAL: 0 },
        byPriority: { HIGH: 1 },
        urgentCount: 1,
        overdueCount: 0,
        pendingApprovalCount: 0,
      });
    }

    if (path.endsWith("/work-items") && method === "GET") {
      const filtered = items.filter((entry) => {
        const query = url.searchParams.get("q")?.toLowerCase();
        return (
          (!query || `${entry.title} ${entry.description}`.toLowerCase().includes(query)) &&
          (!url.searchParams.get("team_id") || entry.teamId === url.searchParams.get("team_id")) &&
          (!url.searchParams.get("status") || entry.status === url.searchParams.get("status")) &&
          (!url.searchParams.get("priority") || entry.priority === url.searchParams.get("priority"))
        );
      });
      return json(route, { items: filtered });
    }

    if (path.endsWith("/work-items") && method === "POST") {
      const created = item({
        ...body,
        id: `item-${items.length + 1}`,
        title: String(body?.title),
        description: String(body?.description),
        category: String(body?.category),
        priority: body?.priority as Item["priority"],
        status: "OPEN",
      });
      items = [...items, created];
      return json(route, { item: created }, 201);
    }

    const match = path.match(/\/work-items\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const [, id, action] = match;
      const selected = items.find((entry) => entry.id === id);
      if (!selected) return json(route, { error: "Work item not found" }, 404);

      if (action === "timeline" && method === "GET") {
        return json(route, { activities });
      }

      if (action === "members" && method === "GET") {
        return json(route, {
          members: [
            { id: "membership-1", role: "ADMIN", user: { id: currentUser.id, name: currentUser.name } },
            { id: "membership-2", role: "MEMBER", user: { id: "user-2", name: "Morgan Member" } },
          ],
        });
      }

      if (action === "transition" && method === "POST") {
        const updated = { ...selected, status: body?.target_status as Item["status"], version: selected.version + 1 };
        items = items.map((entry) => entry.id === id ? updated : entry);
        return json(route, { item: updated });
      }

      if (action === "assign" && method === "POST") {
        const assigneeId = (body?.assignee_id as string | null) ?? null;
        const assignee = assigneeId === "user-2"
          ? { id: "user-2", name: "Morgan Member" }
          : assigneeId === currentUser.id
            ? { id: currentUser.id, name: currentUser.name }
            : null;
        const updated = { ...selected, assigneeId, assignee, version: selected.version + 1 };
        items = items.map((entry) => entry.id === id ? updated : entry);
        return json(route, { item: updated });
      }

      if (action === "comments" && method === "POST") {
        const activity = {
          id: `activity-${activities.length + 1}`,
          type: "COMMENT_ADDED",
          message: body?.body,
          createdAt: new Date().toISOString(),
          actor: { id: currentUser.id, name: currentUser.name },
        };
        activities = [...activities, activity];
        return json(route, { activity }, 201);
      }

      if ((action === "approve" || action === "reject") && method === "POST") {
        const updated = {
          ...selected,
          status: action === "approve" ? "RESOLVED" as const : "IN_PROGRESS" as const,
          version: selected.version + 1,
        };
        items = items.map((entry) => entry.id === id ? updated : entry);
        return json(route, { item: updated });
      }

      if (!action && method === "PATCH") {
        if (conflictPending) {
          conflictPending = false;
          const current = { ...selected, title: "Updated by another teammate", version: selected.version + 1 };
          items = items.map((entry) => entry.id === id ? current : entry);
          return json(route, { error: "Work item changed while editing", current }, 409);
        }
        const updated = { ...selected, ...body, version: selected.version + 1 };
        items = items.map((entry) => entry.id === id ? updated : entry);
        return json(route, { item: updated });
      }
    }

    return json(route, { error: `Unhandled request: ${method} ${path}` }, 404);
  });
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(currentUser.email);
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Concurrency & Workflow Engine")).toBeVisible();
}

test.describe("dashboard browser workflows", () => {
  test("authenticates, displays summary and items, and signs out", async ({ page }) => {
    await mockApi(page);
    await signIn(page);

    await expect(page.getByText("Taylor Tester")).toBeVisible();
    await expect(page.getByText("Total Work Items")).toBeVisible();
    await expect(page.getByText("Investigate API latency")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Sign in to your account")).toBeVisible();
  });

  test("filters work items and creates a new item", async ({ page }) => {
    await mockApi(page, {
      initialItems: [
        item(),
        item({
          id: "item-2",
          title: "Improve release pipeline",
          description: "Maintain release automation.",
          status: "IN_PROGRESS",
          priority: "MEDIUM",
        }),
      ],
    });
    await signIn(page);
    await expect(page.getByText("Improve release pipeline")).toBeVisible();

    const search = page.getByPlaceholder("Search title & description...");
    const filteredResponse = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.get("q") === "latency",
    );
    await search.fill("latency");
    const response = await filteredResponse;
    expect((await response.json()).items).toHaveLength(1);
    await expect(
      page.locator("tbody tr").filter({ hasText: "Improve release pipeline" }),
    ).toHaveCount(0);
    await expect(page.getByText("Investigate API latency")).toBeVisible();

    await search.clear();
    await expect(page.getByText("Improve release pipeline")).toBeVisible();
    await page.getByRole("button", { name: "+ Create Work Item" }).click();
    await page.getByPlaceholder("Short summary of request...").fill("Add browser test coverage");
    await page.getByPlaceholder("Detailed steps, context, or reproduction notes...")
      .fill("Exercise create, list, and refresh.");
    await page.getByRole("button", { name: "Submit Request" }).click();
    await expect(page.getByText("Add browser test coverage")).toBeVisible();
  });

  test("transitions, assigns, comments, and edits with conflict recovery", async ({ page }) => {
    await mockApi(page, { conflictOnFirstEdit: true });
    await signIn(page);
    await page.getByText("Investigate API latency").click();

    await page.getByRole("button", { name: /Start Work/ }).click();
    await expect(page.getByText("IN PROGRESS", { exact: true }).last()).toBeVisible();

    const assigneeSelect = page.locator("select").filter({
      has: page.locator('option[value="user-2"]'),
    });
    await assigneeSelect.selectOption("user-2");
    await expect(assigneeSelect).toHaveValue("user-2");

    await page.getByPlaceholder("Add an internal note or update (Idempotent)...")
      .fill("Browser workflow confirmed.");
    await page.getByRole("button", { name: "Post Comment" }).click();
    await expect(page.getByText("Browser workflow confirmed.")).toBeVisible();

    await page.getByRole("button", { name: "✎ Edit Fields (OCC)" }).click();
    await page.locator('input[value="Investigate API latency"]').fill("Updated from browser");
    await page.getByRole("button", { name: /Save Changes/ }).click();
    await expect(page.getByText(/409 Conflict Detected/)).toBeVisible();
    await expect(page.getByText("Updated by another teammate")).toBeVisible();
    await page.getByRole("button", { name: /Overwrite with My Changes/ }).click();
    await expect(page.getByText(/409 Conflict Detected/)).toHaveCount(0);
    await expect(page.getByText("Updated from browser", { exact: true }).first()).toBeVisible();
  });

  test("approves a pending item with a reason", async ({ page }) => {
    await mockApi(page, {
      initialItems: [item({ status: "PENDING_APPROVAL" })],
    });
    await signIn(page);
    await page.getByText("Investigate API latency").click();
    await page.getByRole("button", { name: "✓ Approve Item" }).click();
    await page.getByPlaceholder("Enter rationale...").fill("Acceptance criteria verified.");
    await page.getByRole("button", { name: "Confirm Approval" }).click();
    await expect(page.getByText("RESOLVED", { exact: true }).first()).toBeVisible();
  });

  test("shows invalid credential feedback", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.getByLabel("Email").fill(currentUser.email);
    await page.getByLabel("Password").fill("incorrect-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("p[role='alert']")).toHaveText("Invalid email or password");
  });

  test("keeps the dashboard and work-item table usable on a phone viewport", async ({ page }) => {
    await mockApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    await expect(page.getByRole("button", { name: "+ Create Work Item" })).toBeVisible();
    const tableWidths = await page.locator("table").evaluate((table) => ({
      content: table.scrollWidth,
      viewport: table.parentElement?.clientWidth ?? 0,
    }));
    expect(tableWidths.content).toBeGreaterThan(tableWidths.viewport);

    await page.getByRole("button", { name: "+ Create Work Item" }).click();
    await expect(page.getByRole("heading", { name: "Create New Work Item" })).toBeVisible();
    await expect(page.getByPlaceholder("Short summary of request...")).toBeVisible();
  });
});
