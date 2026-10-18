/**
 * Smoke + integration test suite for all API routes.
 *
 * Run against a live server:
 *   TEST_USER_ID=<id> TEST_TEAM_ID=<id> node --test src/tests/smoke.test.mjs
 *
 * Or export env vars first (see README.md § Running Tests).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSessionHeaders } from "./helpers/session.mjs";

const BASE = process.env.API_URL ?? "http://localhost:3000";
const UID = process.env.TEST_USER_ID;
const TID = process.env.TEST_TEAM_ID;

if (!UID || !TID) {
  throw new Error(
    "Set TEST_USER_ID and TEST_TEAM_ID env vars before running tests.\n" +
      "  Example: TEST_USER_ID=cmvbva... TEST_TEAM_ID=cmvbva... node --test src/tests/smoke.test.mjs",
  );
}

const H = await createSessionHeaders(BASE);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function reqWithHeaders(headers, method, path, body, extra = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const req = (method, path, body, extra) =>
  reqWithHeaders(H, method, path, body, extra);
const get = (path, extra) => req("GET", path, null, extra);
const post = (path, body, extra) => req("POST", path, body, extra);
const patch = (path, body, extra) => req("PATCH", path, body, extra);

async function createItem(override = {}) {
  const r = await post(
    "/api/work-items",
    {
      title: `test-${randomUUID()}`,
      description: "Integration test work item",
      category: "ENGINEERING",
      priority: "MEDIUM",
      teamId: TID,
      ...override,
    },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(r.status, 201, `createItem failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}

async function transition(item, toStatus) {
  const r = await post(`/api/work-items/${item.id}/transition`, {
    version: item.version,
    status: toStatus,
  });
  assert.equal(r.status, 200, `transition to ${toStatus} failed: ${JSON.stringify(r.body)}`);
  return r.body.item;
}

// ─── Health ───────────────────────────────────────────────────────────────────

test("GET /health returns 200", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "success");
});

test("GET /db confirms database connection", async () => {
  const r = await get("/db");
  assert.equal(r.status, 200);
  assert.ok(r.body.success);
});

// ─── Authentication guard ─────────────────────────────────────────────────────

test("requests without a session cookie are rejected", async () => {
  const r = await fetch(`${BASE}/api/work-items`);
  assert.equal(r.status, 401);
});

// ─── Users ────────────────────────────────────────────────────────────────────

test("GET /api/users/me returns current user", async () => {
  const r = await get("/api/users/me");
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, UID);
  assert.ok(r.body.user.name, "User should have a name");
});

// ─── Teams ────────────────────────────────────────────────────────────────────

test("GET /api/teams returns teams for user", async () => {
  const r = await get("/api/teams");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.teams), "Should return teams array");
  const ids = r.body.teams.map((t) => t.id);
  assert.ok(ids.includes(TID), `Expected team ${TID} in teams list`);
});

test("GET /api/teams/:id/members returns team members", async () => {
  const r = await get(`/api/teams/${TID}/members`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.members));
  const me = r.body.members.find((m) => m.userId === UID);
  assert.ok(me, "Calling user should be in team members");
});

test("GET /api/teams/:id/members for non-existent team returns 404", async () => {
  const r = await get("/api/teams/does-not-exist-xyz/members");
  assert.equal(r.status, 404);
});

// ─── Work Items — CRUD ────────────────────────────────────────────────────────

test("POST /api/work-items creates a work item", async () => {
  const title = `create-test-${randomUUID()}`;
  const r = await post(
    "/api/work-items",
    { title, description: "smoke test", category: "ENGINEERING", priority: "HIGH", teamId: TID },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.item.title, title);
  assert.equal(r.body.item.status, "OPEN");
  assert.equal(r.body.item.version, 1);
  assert.equal(r.body.item.teamId, TID);
});

test("POST /api/work-items without Idempotency-Key returns 400", async () => {
  const r = await post("/api/work-items", {
    title: "No key",
    description: "test",
    category: "ENGINEERING",
    priority: "MEDIUM",
    teamId: TID,
  });
  assert.equal(r.status, 400);
});

test("POST /api/work-items with missing required fields returns 400", async () => {
  const r = await post(
    "/api/work-items",
    { title: "No description or category", teamId: TID },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(r.status, 400);
  assert.ok(r.body.details || r.body.error, "Should include validation error details");
});

test("GET /api/work-items lists items for the user's teams", async () => {
  await createItem(); // ensure at least one exists
  const r = await get("/api/work-items");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  assert.ok(typeof r.body.total === "number");
  assert.ok(typeof r.body.page === "number");
});

test("GET /api/work-items supports search filter", async () => {
  const uniqueTitle = `searchable-${randomUUID()}`;
  await createItem({ title: uniqueTitle });
  const r = await get(`/api/work-items?search=${uniqueTitle}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].title, uniqueTitle);
});

test("GET /api/work-items supports status filter", async () => {
  const r = await get("/api/work-items?status=OPEN");
  assert.equal(r.status, 200);
  for (const item of r.body.items) {
    assert.equal(item.status, "OPEN");
  }
});

test("GET /api/work-items supports priority filter", async () => {
  await createItem({ priority: "URGENT" });
  const r = await get("/api/work-items?priority=URGENT");
  assert.equal(r.status, 200);
  for (const item of r.body.items) {
    assert.equal(item.priority, "URGENT");
  }
});

test("GET /api/work-items supports pagination", async () => {
  const r = await get("/api/work-items?page=1&limit=2");
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length <= 2);
});

test("GET /api/work-items/:id returns item with ETag header", async () => {
  const item = await createItem();
  const r = await get(`/api/work-items/${item.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.id, item.id);
  const etag = r.headers.get("etag");
  assert.ok(etag, "Should return ETag header");
  assert.equal(etag, `"${item.version}"`);
});

test("GET /api/work-items/:id for non-existent item returns 404", async () => {
  const r = await get("/api/work-items/does-not-exist-xyz");
  assert.equal(r.status, 404);
});

// ─── Work Items — PATCH (OCC) ─────────────────────────────────────────────────

test("PATCH /api/work-items/:id updates fields and bumps version", async () => {
  const item = await createItem();
  const r = await patch(`/api/work-items/${item.id}`, {
    version: item.version,
    title: "Updated by test",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.title, "Updated by test");
  assert.equal(r.body.item.version, item.version + 1);
});

test("PATCH with stale version returns 409 with current state", async () => {
  const item = await createItem();
  // First update succeeds
  await patch(`/api/work-items/${item.id}`, { version: item.version, title: "First" });
  // Second update uses old version — conflict
  const r = await patch(`/api/work-items/${item.id}`, {
    version: item.version, // stale
    title: "Second (conflict)",
  });
  assert.equal(r.status, 409);
  assert.ok(r.body.error);
  assert.equal(r.body.current.version, item.version + 1);
  assert.equal(r.body.current.title, "First");
});

test("PATCH using If-Match header instead of body version", async () => {
  const item = await createItem();
  const r = await patch(
    `/api/work-items/${item.id}`,
    { title: "Via If-Match" },
    { "If-Match": `"${item.version}"` },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.item.version, item.version + 1);
});

test("PATCH without version returns 400", async () => {
  const item = await createItem();
  const r = await patch(`/api/work-items/${item.id}`, { title: "No version" });
  assert.equal(r.status, 400);
});

test("PATCH with no updatable fields returns 400", async () => {
  const item = await createItem();
  const r = await patch(`/api/work-items/${item.id}`, { version: item.version });
  assert.equal(r.status, 400);
});

// ─── Work Items — Assign ──────────────────────────────────────────────────────

test("POST /api/work-items/:id/assign self-assigns a work item", async () => {
  const item = await createItem();
  const r = await post(`/api/work-items/${item.id}/assign`, {
    version: item.version,
    assigneeId: UID,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.assignee?.id, UID);
  assert.equal(r.body.item.version, item.version + 1);
});

test("POST /api/work-items/:id/assign unassigns when assigneeId is null", async () => {
  const item = await createItem();
  // Assign first
  const assigned = (
    await post(`/api/work-items/${item.id}/assign`, { version: item.version, assigneeId: UID })
  ).body.item;
  // Then unassign
  const r = await post(`/api/work-items/${item.id}/assign`, {
    version: assigned.version,
    assigneeId: null,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.assignee, null);
});

// ─── Work Items — State Machine ───────────────────────────────────────────────

test("POST /api/work-items/:id/transition: valid OPEN → IN_PROGRESS", async () => {
  const item = await createItem();
  const r = await post(`/api/work-items/${item.id}/transition`, {
    version: item.version,
    status: "IN_PROGRESS",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.status, "IN_PROGRESS");
  assert.equal(r.body.item.version, item.version + 1);
});

test("POST transition: invalid OPEN → RESOLVED returns 422", async () => {
  const item = await createItem();
  const r = await post(`/api/work-items/${item.id}/transition`, {
    version: item.version,
    status: "RESOLVED",
  });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.includes("Cannot transition"));
});

test("POST transition: full approval flow OPEN → IN_PROGRESS → PENDING_APPROVAL → RESOLVED", async () => {
  let item = await createItem();

  item = await transition(item, "IN_PROGRESS");
  assert.equal(item.status, "IN_PROGRESS");

  item = await transition(item, "PENDING_APPROVAL");
  assert.equal(item.status, "PENDING_APPROVAL");

  // Approve (TEAM_LEAD/ADMIN action) — test user has ADMIN role
  const r = await post(`/api/work-items/${item.id}/approve`, {
    version: item.version,
    reason: "Looks good",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.status, "RESOLVED");
});

test("POST transition: reject PENDING_APPROVAL → IN_PROGRESS", async () => {
  let item = await createItem();
  item = await transition(item, "IN_PROGRESS");
  item = await transition(item, "PENDING_APPROVAL");

  const r = await post(`/api/work-items/${item.id}/reject`, {
    version: item.version,
    reason: "Needs more work",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.status, "IN_PROGRESS");
});

test("POST approve on non-PENDING_APPROVAL item returns 422", async () => {
  const item = await createItem(); // status = OPEN
  const r = await post(`/api/work-items/${item.id}/approve`, { version: item.version });
  assert.equal(r.status, 422);
});

test("POST transition with stale version returns 409", async () => {
  const item = await createItem();
  // Do one update to advance version
  await patch(`/api/work-items/${item.id}`, { version: item.version, title: "bump" });
  // Now try transition with old version
  const r = await post(`/api/work-items/${item.id}/transition`, {
    version: item.version, // stale
    status: "IN_PROGRESS",
  });
  assert.equal(r.status, 409);
});

// ─── Work Items — Comments ────────────────────────────────────────────────────

test("POST /api/work-items/:id/comments adds a comment", async () => {
  const item = await createItem();
  const text = `test comment ${randomUUID()}`;
  const r = await post(
    `/api/work-items/${item.id}/comments`,
    { body: text, is_internal: false },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.activity.type, "COMMENT_ADDED");
  assert.equal(r.body.activity.message, text);
});

test("POST comment is idempotent with same key", async () => {
  const item = await createItem();
  const key = randomUUID();
  const text = `idem-comment-${randomUUID()}`;
  const body = { body: text };

  const first = await post(`/api/work-items/${item.id}/comments`, body, { "Idempotency-Key": key });
  const second = await post(`/api/work-items/${item.id}/comments`, body, { "Idempotency-Key": key });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  // Both responses should refer to the same activity record
  assert.equal(first.body.activity.id, second.body.activity.id);
});

// ─── Work Items — Timeline / Activity ────────────────────────────────────────

test("GET /api/work-items/:id/timeline returns audit trail", async () => {
  const item = await createItem();
  const r = await get(`/api/work-items/${item.id}/timeline`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.activities));
  // At minimum should have the CREATED entry
  const created = r.body.activities.find((a) => a.type === "CREATED");
  assert.ok(created, "Timeline should contain CREATED entry");
});

test("GET /api/work-items/:id/activities is an alias for /timeline", async () => {
  const item = await createItem();
  const r = await get(`/api/work-items/${item.id}/activities`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.activities));
});

test("Timeline shows status change after transition", async () => {
  const item = await createItem();
  await post(`/api/work-items/${item.id}/transition`, {
    version: item.version,
    status: "IN_PROGRESS",
  });
  const r = await get(`/api/work-items/${item.id}/timeline`);
  assert.equal(r.status, 200);
  const change = r.body.activities.find((a) => a.type === "STATUS_CHANGED");
  assert.ok(change, "Status change should appear in timeline");
  assert.equal(change.changes.after.status, "IN_PROGRESS");
});

test("Timeline shows comment after POST /comments", async () => {
  const item = await createItem();
  const msg = `timeline-comment-${randomUUID()}`;
  await post(
    `/api/work-items/${item.id}/comments`,
    { body: msg },
    { "Idempotency-Key": randomUUID() },
  );
  const r = await get(`/api/work-items/${item.id}/timeline`);
  const comment = r.body.activities.find((a) => a.message === msg);
  assert.ok(comment, "Comment should appear in timeline");
});

// ─── Activity Feed ────────────────────────────────────────────────────────────

test("GET /api/activity returns activity feed", async () => {
  await createItem(); // ensure some activity exists
  const r = await get("/api/activity");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.activities));
  assert.ok(typeof r.body.hasMore === "boolean");
});

test("GET /api/activity supports limit param", async () => {
  const r = await get("/api/activity?limit=3");
  assert.equal(r.status, 200);
  assert.ok(r.body.activities.length <= 3);
});

test("GET /api/activity supports team_id filter", async () => {
  const r = await get(`/api/activity?team_id=${TID}`);
  assert.equal(r.status, 200);
  for (const a of r.body.activities) {
    assert.equal(a.workItem?.team?.id, TID);
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

test("GET /api/dashboard/stats returns aggregated stats", async () => {
  const r = await get("/api/dashboard/stats");
  assert.equal(r.status, 200);
  const s = r.body.stats ?? r.body;
  assert.ok(typeof s.total === "number", "stats.total should be a number");
  assert.ok(typeof s.byStatus === "object", "stats.byStatus should be an object");
  assert.ok(typeof s.byPriority === "object", "stats.byPriority should be an object");
});

// ─── Notifications ────────────────────────────────────────────────────────────

test("GET /api/notifications returns notification list", async () => {
  const r = await get("/api/notifications");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.notifications));
  assert.ok(typeof r.body.total === "number");
});

test(
  "notifications support persisted unread filtering and read receipts",
  {
    skip:
      !process.env.TEST_NOTIFICATION_ACTOR_EMAIL ||
      !process.env.TEST_NOTIFICATION_ACTOR_PASSWORD ||
      process.env.TEST_NOTIFICATION_ACTOR_EMAIL.toLowerCase() ===
        (process.env.TEST_USER_EMAIL ?? "dev@example.com").toLowerCase(),
  },
  async () => {
    const actorHeaders = await createSessionHeaders(BASE, {
      email: process.env.TEST_NOTIFICATION_ACTOR_EMAIL,
      password: process.env.TEST_NOTIFICATION_ACTOR_PASSWORD,
    });
    const item = await createItem();

    const timeline = await reqWithHeaders(
      actorHeaders,
      "GET",
      `/api/work-items/${item.id}/timeline`,
    );
    assert.equal(timeline.status, 200);
    const createdActivity = timeline.body.activities.find(
      (activity) => activity.type === "CREATED",
    );
    assert.ok(createdActivity, "Created activity should appear in timeline");

    const unread = await reqWithHeaders(
      actorHeaders,
      "GET",
      "/api/notifications?unread_only=true&limit=100",
    );
    assert.equal(unread.status, 200);
    assert.ok(unread.body.notifications.some(({ id }) => id === createdActivity.id));

    const marked = await reqWithHeaders(
      actorHeaders,
      "POST",
      "/api/notifications/read",
      { activityIds: [createdActivity.id] },
    );
    assert.equal(marked.status, 200);
    assert.equal(marked.body.markedRead, 1);

    const afterMarking = await reqWithHeaders(
      actorHeaders,
      "GET",
      "/api/notifications?unread_only=true&limit=100",
    );
    assert.equal(afterMarking.status, 200);
    assert.ok(
      afterMarking.body.notifications.every(({ id }) => id !== createdActivity.id),
    );

    const all = await reqWithHeaders(
      actorHeaders,
      "GET",
      "/api/notifications?limit=100",
    );
    const notification = all.body.notifications.find(
      ({ id }) => id === createdActivity.id,
    );
    assert.ok(notification, "Read notification should remain in the full list");
    assert.equal(notification.isRead, true);
    assert.ok(notification.readAt);
  },
);

// ─── v1 prefix parity ────────────────────────────────────────────────────────

test("All routes accessible under /api/v1 prefix", async () => {
  const routes = [
    "/api/v1/work-items",
    `/api/v1/users/me`,
    `/api/v1/teams`,
    `/api/v1/dashboard/stats`,
    `/api/v1/notifications`,
    `/api/v1/activity`,
  ];
  for (const route of routes) {
    const r = await get(route);
    assert.notEqual(r.status, 404, `${route} returned 404 — not mounted?`);
  }
});

// ─── 404 for unknown routes ───────────────────────────────────────────────────

test("Unknown routes return 404 with JSON body", async () => {
  const r = await fetch(`${BASE}/api/this-does-not-exist`, { headers: H });
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.ok(body.message || body.error, "404 should return JSON error body");
});
