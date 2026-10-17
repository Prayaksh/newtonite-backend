import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const USER_ID = process.env.TEST_USER_ID;
const TEAM_ID = process.env.TEST_TEAM_ID;

if (!USER_ID || !TEAM_ID) {
  throw new Error("Set TEST_USER_ID and TEST_TEAM_ID before running tests");
}

const headers = {
  "Content-Type": "application/json",
  "X-User-Id": USER_ID,
};

function createPayload(title) {
  return {
    title,
    description: "Created by the idempotency integration test",
    category: "ENGINEERING",
    priority: "MEDIUM",
    teamId: TEAM_ID,
  };
}

async function createWorkItem(key, payload) {
  const response = await fetch(`${API_URL}/api/work-items`, {
    method: "POST",
    headers: {
      ...headers,
      "Idempotency-Key": key,
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function countItemsWithTitle(title) {
  const url = new URL(`${API_URL}/api/work-items`);
  url.searchParams.set("search", title);
  url.searchParams.set("page", "1");
  url.searchParams.set("limit", "100");

  const response = await fetch(url, {
    headers: { ...headers },
  });

  assert.equal(response.status, 200, "Could not fetch work items");

  const body = await response.json();

  return body.items.filter((item) => item.title === title).length;
}

test("first request creates a work item", async () => {
  const title = `idem-first-${randomUUID()}`;
  const result = await createWorkItem(randomUUID(), createPayload(title));

  assert.equal(result.status, 201);
  assert.ok(result.body.item?.id, "Response should contain the created item");
  assert.equal(result.body.item.title, title);
});

test("retry with the same key and body replays the original response", async () => {
  const key = randomUUID();
  const payload = createPayload(`idem-replay-${randomUUID()}`);

  const first = await createWorkItem(key, payload);
  const second = await createWorkItem(key, payload);

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.item.id, first.body.item.id);
  assert.equal(await countItemsWithTitle(payload.title), 1);
});

test("reusing a key with a different body returns 409", async () => {
  const key = randomUUID();
  const firstPayload = createPayload(`idem-original-${randomUUID()}`);
  const changedPayload = {
    ...firstPayload,
    title: `idem-changed-${randomUUID()}`,
  };

  const first = await createWorkItem(key, firstPayload);
  const second = await createWorkItem(key, changedPayload);

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(await countItemsWithTitle(firstPayload.title), 1);
  assert.equal(await countItemsWithTitle(changedPayload.title), 0);
});

test("simultaneous requests with the same key create only one item", async () => {
  const key = randomUUID();
  const payload = createPayload(`idem-concurrent-${randomUUID()}`);

  const [first, second] = await Promise.all([
    createWorkItem(key, payload),
    createWorkItem(key, payload),
  ]);

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.item.id, second.body.item.id);
  assert.equal(await countItemsWithTitle(payload.title), 1);
});
