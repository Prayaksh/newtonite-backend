import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSessionHeaders } from "./helpers/session.mjs";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const USER_ID = process.env.TEST_USER_ID;
const TEAM_ID = process.env.TEST_TEAM_ID;

if (!USER_ID || !TEAM_ID) {
  throw new Error("Set TEST_USER_ID and TEST_TEAM_ID before running tests");
}

const headers = await createSessionHeaders(API_URL);

async function createItem(title) {
  const res = await fetch(`${API_URL}/api/v1/work-items`, {
    method: "POST",
    headers: {
      ...headers,
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      title,
      description: "Test work item for OCC tests",
      category: "ENGINEERING",
      priority: "HIGH",
      teamId: TEAM_ID,
    }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  return data.item;
}

test("GET returns work item with ETag matching item version", async () => {
  const item = await createItem(`occ-get-${randomUUID()}`);
  const res = await fetch(`${API_URL}/api/v1/work-items/${item.id}`, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("etag"), `"${item.version}"`);
  const body = await res.json();
  assert.equal(body.item.id, item.id);
});

test("PATCH updates item with correct version and increments version", async () => {
  const item = await createItem(`occ-patch-${randomUUID()}`);
  const res = await fetch(`${API_URL}/api/v1/work-items/${item.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      version: item.version,
      title: "Updated Title for OCC",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.item.version, item.version + 1);
  assert.equal(body.item.title, "Updated Title for OCC");
});

test("PATCH with stale version returns 409 Conflict with current server state", async () => {
  const item = await createItem(`occ-conflict-${randomUUID()}`);

  // User 1 updates successfully: version becomes 2
  const firstUpdate = await fetch(`${API_URL}/api/v1/work-items/${item.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      version: item.version,
      title: "User 1 Title",
    }),
  });
  assert.equal(firstUpdate.status, 200);

  // User 2 tries to update using stale version (version 1)
  const secondUpdate = await fetch(`${API_URL}/api/v1/work-items/${item.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      version: item.version, // stale!
      title: "User 2 Title (Stale)",
    }),
  });
  assert.equal(secondUpdate.status, 409);
  const conflictData = await secondUpdate.json();
  assert.ok(conflictData.error.includes("Work item changed"));
  assert.equal(conflictData.current.version, item.version + 1);
  assert.equal(conflictData.current.title, "User 1 Title");
});

test("PATCH supports If-Match header for optimistic concurrency", async () => {
  const item = await createItem(`occ-ifmatch-${randomUUID()}`);
  const res = await fetch(`${API_URL}/api/v1/work-items/${item.id}`, {
    method: "PATCH",
    headers: {
      ...headers,
      "If-Match": `"${item.version}"`,
    },
    body: JSON.stringify({
      title: "Updated using If-Match header",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.item.version, item.version + 1);
});

test("POST transition validates valid state machine transitions", async () => {
  const item = await createItem(`occ-trans-${randomUUID()}`);
  assert.equal(item.status, "OPEN");

  // Invalid transition: OPEN -> RESOLVED should return 422
  const invalidRes = await fetch(`${API_URL}/api/v1/work-items/${item.id}/transition`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: item.version,
      target_status: "RESOLVED",
    }),
  });
  assert.equal(invalidRes.status, 422);

  // Valid transition: OPEN -> IN_PROGRESS succeeds
  const validRes = await fetch(`${API_URL}/api/v1/work-items/${item.id}/transition`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: item.version,
      target_status: "IN_PROGRESS",
    }),
  });
  assert.equal(validRes.status, 200);
  const validBody = await validRes.json();
  assert.equal(validBody.item.status, "IN_PROGRESS");
  assert.equal(validBody.item.version, item.version + 1);
});

test("POST comments creates audit trail in /timeline", async () => {
  const item = await createItem(`occ-comment-${randomUUID()}`);
  const commentText = `Internal investigation note - ${randomUUID()}`;

  const commentRes = await fetch(`${API_URL}/api/v1/work-items/${item.id}/comments`, {
    method: "POST",
    headers: {
      ...headers,
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      body: commentText,
      is_internal: true,
    }),
  });
  assert.equal(commentRes.status, 201);

  const timelineRes = await fetch(`${API_URL}/api/v1/work-items/${item.id}/timeline`, {
    headers,
  });
  assert.equal(timelineRes.status, 200);
  const timelineData = await timelineRes.json();
  const found = timelineData.activities.find((a) => a.message === commentText);
  assert.ok(found, "Comment should appear in timeline");
  assert.equal(found.type, "COMMENT_ADDED");
});
