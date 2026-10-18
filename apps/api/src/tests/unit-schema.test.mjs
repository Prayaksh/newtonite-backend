import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptInviteSchema,
  approveRejectSchema,
  assignSchema,
  commentSchema,
  createInvitationSchema,
  createWorkItemSchema,
  listWorkItemsSchema,
  loginSchema,
  timelineQuerySchema,
  transitionSchema,
  updateWorkItemSchema,
} from "../lib/schema.ts";

const validWorkItem = {
  title: "  API latency  ",
  description: "  Investigate recent latency  ",
  category: "ENGINEERING",
  teamId: "team-123",
};

test("create work item trims input and defaults priority", () => {
  assert.deepEqual(createWorkItemSchema.parse(validWorkItem), {
    title: "API latency",
    description: "Investigate recent latency",
    category: "ENGINEERING",
    priority: "MEDIUM",
    teamId: "team-123",
  });
});

test("create work item rejects blank fields, unknown keys, and invalid enums", () => {
  assert.equal(createWorkItemSchema.safeParse({ ...validWorkItem, title: " " }).success, false);
  assert.equal(createWorkItemSchema.safeParse({ ...validWorkItem, category: "UNKNOWN" }).success, false);
  assert.equal(createWorkItemSchema.safeParse({ ...validWorkItem, extra: true }).success, false);
});

test("update work item requires a changed field and accepts nullable due date", () => {
  assert.deepEqual(
    updateWorkItemSchema.parse({ version: 2, title: "  Revised title  ", dueAt: null }),
    { version: 2, title: "Revised title", dueAt: null },
  );
  assert.equal(updateWorkItemSchema.safeParse({ version: 2 }).success, false);
  assert.equal(updateWorkItemSchema.safeParse({ title: "ab" }).success, false);
});

test("list work item query applies defaults and canonicalizes supported aliases", () => {
  assert.deepEqual(listWorkItemsSchema.parse({}), {
    page: 1,
    limit: 20,
    teamId: undefined,
    assigneeId: undefined,
    status: undefined,
    priority: undefined,
    search: undefined,
  });
  assert.deepEqual(
    listWorkItemsSchema.parse({
      page: "3",
      limit: "25",
      team_id: "team-123",
      assignee_id: "user-456",
      q: "  latency  ",
      status: "IN_PROGRESS",
      priority: "HIGH",
    }),
    {
      page: 3,
      limit: 25,
      teamId: "team-123",
      assigneeId: "user-456",
      status: "IN_PROGRESS",
      priority: "HIGH",
      search: "latency",
    },
  );
  assert.equal(listWorkItemsSchema.safeParse({ page: "0" }).success, false);
  assert.equal(listWorkItemsSchema.safeParse({ limit: "101" }).success, false);
});

test("transition schema accepts both status field names and normalizes them", () => {
  assert.deepEqual(
    transitionSchema.parse({ version: 4, target_status: "IN_PROGRESS" }),
    { version: 4, status: "IN_PROGRESS" },
  );
  assert.deepEqual(
    transitionSchema.parse({ status: "CLOSED" }),
    { version: undefined, status: "CLOSED" },
  );
  assert.equal(transitionSchema.safeParse({ version: 1 }).success, false);
});

test("assignment schema normalizes snake-case and explicit unassignment", () => {
  assert.deepEqual(
    assignSchema.parse({ version: 3, assignee_id: "user-123" }),
    { version: 3, assigneeId: "user-123" },
  );
  assert.deepEqual(assignSchema.parse({ assigneeId: null }), {
    version: undefined,
    assigneeId: null,
  });
  assert.equal(assignSchema.safeParse({ assigneeId: "" }).success, false);
});

test("comment schema normalizes legacy fields and defaults internal visibility", () => {
  assert.deepEqual(commentSchema.parse({ body: "  Note  " }), {
    body: "Note",
    isInternal: false,
  });
  assert.deepEqual(commentSchema.parse({ message: "Note", is_internal: true }), {
    body: "Note",
    isInternal: true,
  });
  assert.deepEqual(commentSchema.parse({ body: "Note", isInternal: true }), {
    body: "Note",
    isInternal: true,
  });
  assert.equal(commentSchema.safeParse({ body: " " }).success, false);
  assert.equal(commentSchema.safeParse({}).success, false);
});

test("login schema trims and lowercases email and rejects invalid addresses", () => {
  assert.deepEqual(
    loginSchema.parse({ email: "  USER@Example.com ", password: "pass" }),
    { email: "user@example.com", password: "pass" },
  );
  assert.equal(loginSchema.safeParse({ email: "not-an-email", password: "pass" }).success, false);
  assert.equal(loginSchema.safeParse({ email: "user@example.com", password: "" }).success, false);
});

test("invitation acceptance enforces token and password requirements", () => {
  assert.deepEqual(
    acceptInviteSchema.parse({ token: " invite-token ", password: "password-123" }),
    { token: "invite-token", password: "password-123" },
  );
  assert.equal(acceptInviteSchema.safeParse({ token: "token", password: "short" }).success, false);
  assert.equal(acceptInviteSchema.safeParse({ token: "", password: "password-123" }).success, false);
});

test("invitation creation normalizes email and defaults role", () => {
  assert.deepEqual(
    createInvitationSchema.parse({
      email: "  NEW@Example.com ",
      teamId: "team-123",
    }),
    { email: "new@example.com", teamId: "team-123", role: "MEMBER" },
  );
  assert.equal(
    createInvitationSchema.safeParse({
      email: "new@example.com",
      teamId: "team-123",
      role: "OWNER",
    }).success,
    false,
  );
});

test("approval/rejection reason is optional, trimmed, and length-limited", () => {
  assert.deepEqual(approveRejectSchema.parse({ version: 2, reason: "  Looks good  " }), {
    version: 2,
    reason: "Looks good",
  });
  assert.equal(approveRejectSchema.safeParse({ reason: "x".repeat(1001) }).success, false);
});

test("timeline query defaults and bounds its page size", () => {
  assert.deepEqual(timelineQuerySchema.parse({}), { limit: 50 });
  assert.deepEqual(timelineQuerySchema.parse({ limit: "10", before_id: "activity-1" }), {
    limit: 10,
    before_id: "activity-1",
  });
  assert.equal(timelineQuerySchema.safeParse({ limit: 101 }).success, false);
});
