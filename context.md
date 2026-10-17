# Operational Work Management System — Project Context & Blueprint

## 1. Context & Problem Statement

A rapidly growing company (hundreds of employees across multiple teams) currently coordinates operational requests—customer issues, engineering bugs, payment holds, production incidents, compliance actions, and approvals—via fragmented channels (chat, spreadsheets, email).

### Core Pain Points to Solve

- **Loss of Context & Ownership:** Requests disappear in chat threads; no clear current owner, history, or next steps.
- **Race Conditions & Work Collisions:** Two people take the same issue simultaneously, or edit old versions without knowing someone else modified them.
- **Management Blindness:** No high-level dashboard to filter urgent items, detect forgotten work, or trace decision history.
- **Insecure / Unreliable Workflows:** Lack of server-enforced permissions and duplicate actions caused by network retries.

---

## 2. Minimal System Requirements

### Core Work Item Entity

A work item must explicitly represent:

1. **What & Why:** Title, detailed description, reporter, category/type.
2. **State & Priority:** Status (`open`, `in_progress`, `pending_approval`, `resolved`, `closed`), Priority (`low`, `medium`, `high`, `urgent`).
3. **Ownership:** Assigned team and assigned individual user.
4. **History & Evolution:** Append-only timeline of state changes, assignments, and notes.
5. **Version Tracking:** `version` integer field to prevent silent stale updates.

### Role-Based Access Control (RBAC)

- Users belong to one or more teams with defined roles (`admin`, `team_lead`, `member`, `viewer`).
- Permission checks are enforced directly in database queries and API handlers—never UI hiding alone.

---

## 3. The 3 Critical Non-CRUD Engineering Behaviors

To demonstrate system reliability beyond basic CRUD operations, the application solves these specific scenarios:

### 1. Simultaneous Actions & Stale Data Prevention (Optimistic Concurrency)

- **Mechanism:** Database updates require `WHERE id = :id AND version = :version`.
- **Behavior:** If User A updates an item, version increments to `N+1`. If User B submits an update targeting version `N`, the server aborts the transaction and returns `409 Conflict` along with the current server state so the client can reconcile differences.

### 2. Preventing Accidental Duplicate Operations (Idempotency Control)

- **Mechanism:** Clients send a unique `Idempotency-Key: <UUID>` header on state-changing requests (e.g., approvals, reassignments).
- **Behavior:** Server records the key in an `idempotency_keys` table inside a transaction. Retried requests hit the lookup and return the cached HTTP response instantly without re-executing logic.

### 3. Reliable Asynchronous Processing via Transactional Outbox

- **Mechanism:** Secondary work (Slack alerts, email notifications, activity webhooks) is written to an `outbox_events` table inside the _same_ database transaction as the work item update.
- **Behavior:** A background worker polls or listens for pending outbox entries, pushes them to an asynchronous queue with exponential backoff retries, ensuring 100% notification reliability without blocking main API responses.

---

## 4. Architecture & Stack Choices

- **Repository Structure:** Monorepo (`/apps/api`, `/apps/web`, `/packages/db`, `/packages/ui`) for unified TypeScript types between API and React UI.
- **Database:** PostgreSQL with Prisma ORM (Strict ACID transactions, relational integrity for teams/users, indexed outbox & activity logs).
- **Backend API:** Node.js / Express (Clean middleware stack for RBAC, Idempotency, and OCC).
- **Frontend:** Next.js / React (Optimistic state UI, conflict resolution modal on 409 responses, server-side filtering/pagination).
- **Async Workers:** Node.js background OutboxWorker with row-level claiming and exponential backoff retries.

---

## 5. Scope & Explicit Assumptions (1-Day Constraints)

### In-Scope

- Clean multi-team data model with DB-enforced authorization.
- Complete work item CRUD with versioned OCC and idempotency headers.
- Functional dashboard with status/team filtering and activity timeline.
- Automated integration tests covering 409 conflicts and duplicate request handling.
- Short `ENGINEERING_DECISIONS.md` explaining trade-offs.

### Out-of-Scope (Intentionally Skipped)

- Complex rich-text live collaborative document editing (CRDTs/OT).
- Fine-grained custom workflow builder UI (sticking to clear, reliable state transitions).
- Full OAuth/SSO enterprise setup (using lightweight JWT or header-based user switching for demo simplicity).

---

# Operational Work Management Application - Backend API Specification

This document outlines the API endpoints designed to handle core workflow control, concurrency guards, authorization, idempotency, and audit history.

## 1. Work Items API (`/api/v1/work-items`)

| Method    | Endpoint                             | Description                                          | Headers / Parameters                                                         | Status |
| :-------- | :----------------------------------- | :--------------------------------------------------- | :--------------------------------------------------------------------------- | :----- |
| **GET**   | `/api/v1/work-items`                 | Search and list work items with pagination           | Params: `page`, `limit`, `team_id`, `status`, `priority`, `assignee_id`, `q` | Complete |
| **POST**  | `/api/v1/work-items`                 | Create a new work item                               | Header: `Idempotency-Key`                                                    | Complete |
| **GET**   | `/api/v1/work-items/{id}`            | Get detailed work item information                   | Returns: `ETag` / `version`                                                  | Complete |
| **PATCH** | `/api/v1/work-items/{id}`            | Update metadata / fields (Optimistic Locking)        | Header: `If-Match` (or body `version`)                                       | Complete |
| **POST**  | `/api/v1/work-items/{id}/assign`     | Claim or reassign work item                          | Header: `If-Match` / Body: `assignee_id`, `version`                          | Complete |
| **POST**  | `/api/v1/work-items/{id}/transition` | State machine transition (e.g., OPEN -> IN_PROGRESS) | Header: `If-Match` / Body: `target_status`, `version`                        | Complete |

---

## 2. Approvals & Actions API (`/api/v1/work-items/{id}/...`)

| Method   | Endpoint                          | Description                              | Headers / Parameters                                       | Status |
| :------- | :-------------------------------- | :--------------------------------------- | :--------------------------------------------------------- | :----- |
| **POST** | `/api/v1/work-items/{id}/approve` | Approve a work item                      | Body: `version`, `reason` (Roles: `ADMIN`, `TEAM_LEAD`)    | Complete |
| **POST** | `/api/v1/work-items/{id}/reject`  | Reject or request changes on a work item | Body: `version`, `reason` (Roles: `ADMIN`, `TEAM_LEAD`)    | Complete |

---

## 3. Collaboration & Audit History API (`/api/v1/work-items/{id}/...`)

| Method   | Endpoint                           | Description                               | Headers / Parameters                                    | Status |
| :------- | :--------------------------------- | :---------------------------------------- | :------------------------------------------------------ | :----- |
| **GET**  | `/api/v1/work-items/{id}/timeline` | Retrieve immutable activity & audit trail | Params: `limit`, `before_id`                            | Complete |
| **POST** | `/api/v1/work-items/{id}/comments` | Post a comment or internal note           | Header: `Idempotency-Key` / Body: `body`, `is_internal` | Complete |

---

## 4. Teams, Users & Identity API (`/api/v1/...`)

| Method  | Endpoint                     | Description                                      | Headers / Parameters | Status |
| :------ | :--------------------------- | :----------------------------------------------- | :------------------- | :----- |
| **GET** | `/api/v1/users/me`           | Fetch authenticated user, roles, and team scopes | Header: `X-User-Id`  | Complete |
| **GET** | `/api/v1/teams`              | List operational teams                           | Header: `X-User-Id`  | Complete |
| **GET** | `/api/v1/teams/{id}/members` | List members of a specific team                  | Header: `X-User-Id`  | Complete |

---

## 5. Critical Behaviors & Enforcement

1. **Optimistic Concurrency Control (OCC):**
   - Handled on `PATCH`, `/assign`, `/transition`, `/approve`, and `/reject`.
   - Requires matching current `version` integer (or `If-Match` header).
   - Mismatch returns `409 Conflict` alongside the `current` server state.

2. **Idempotency Guard:**
   - Handled on `POST` operations (`/work-items`, `/comments`).
   - Requires unique `Idempotency-Key` header to safely catch retries without duplicate executions.

3. **Resource-Level Authorization (RBAC/ABAC):**
   - Enforced in backend database queries and route handlers prior to mutation.
   - Restricted roles cannot modify items (`VIEWER`); approvals/rejections require `ADMIN` or `TEAM_LEAD`.
   - Invalid state transition returns `422 Unprocessable Entity`; missing permissions returns `403 Forbidden`.

---

## 6. Implementation Status & Progress Tracker

### Resolved Issues & Changes Made

1. **Route Resolution (`app.ts` & `work-items.routes.ts`):**
   - **Root Cause:** A prior edit accidentally pasted a duplicate `router.post("/", ...)` handler over `router.get("/", ...)`. When clients requested `GET /api/work-items`, Express failed to find a matching route inside `workItemRouter` and fell through to the catch-all `Route not found` 404 handler in `app.ts`.
   - **Fix:** Restored `router.get("/", ...)` with pagination/filtering, cleanly kept the idempotent `router.post("/", ...)` create handler, and mounted routes under both `/api` and `/api/v1` in `app.ts`.

2. **Full API Endpoint Suite Implemented:**
   - [`work-items.routes.ts`](file:///home/lumas/projects/dashboard/apps/api/src/routes/work-items.routes.ts): All 10 endpoints complete with `If-Match` / `ETag` OCC, state machine validations, approvals, rejections, comments, and audit timeline.
   - [`users.routes.ts`](file:///home/lumas/projects/dashboard/apps/api/src/routes/users.routes.ts): Implemented `GET /api/v1/users/me` returning user, roles, and team scopes.
   - [`teams.routes.ts`](file:///home/lumas/projects/dashboard/apps/api/src/routes/teams.routes.ts): Implemented `GET /api/v1/teams` and `GET /api/v1/teams/:id/members`.
   - [`schema.ts`](file:///home/lumas/projects/dashboard/apps/api/src/lib/schema.ts): Added comprehensive Zod validation schemas with snake_case and camelCase query/body aliases.

3. **Transactional Outbox Worker:**
   - [`outbox.service.ts`](file:///home/lumas/projects/dashboard/apps/api/src/services/outbox.service.ts) and [`outbox.worker.ts`](file:///home/lumas/projects/dashboard/apps/api/src/workers/outbox.worker.ts): Implemented row claiming, status tracking (`PENDING` $\rightarrow$ `PROCESSING` $\rightarrow$ `PROCESSED` / `FAILED`), and exponential backoff retry.

4. **Integration Test Suites:**
   - [`idempotency.test.mjs`](file:///home/lumas/projects/dashboard/apps/api/src/tests/idempotency.test.mjs): Covers initial creation, identical replay, key conflict (409), and concurrent creation.
   - [`occ-concurrency.test.mjs`](file:///home/lumas/projects/dashboard/apps/api/src/tests/occ-concurrency.test.mjs): Covers `ETag`, version increments, stale version 409 conflicts with server state, `If-Match` headers, state transition restrictions, and audit timeline.

5. **Architecture Documentation:**
   - [`ENGINEERING_DECISIONS.md`](file:///home/lumas/projects/dashboard/ENGINEERING_DECISIONS.md): Thorough write-up of design decisions, alternatives considered, and trade-offs for OCC, Idempotency, Transactional Outbox, and RBAC.

### Next Steps (Frontend UI — `apps/web`)

1. **Dashboard View (`apps/web/app/page.tsx`):**
   - Connect to `/api/v1/work-items` with search, status filtering, and team selector.
   - Visual badges for priority (`URGENT`, `HIGH`, `MEDIUM`, `LOW`) and status.
2. **Work Item Detail & Conflict Resolution Modal:**
   - Display item metadata with current `version` / `ETag`.
   - On `409 Conflict`, render a 3-way reconciliation modal showing conflicting fields (e.g., local edit vs server's latest state).
3. **State Machine Action Controls:**
   - Context-aware action buttons based on status:
     - `Start Work` (`OPEN` $\rightarrow$ `IN_PROGRESS`)
     - `Submit for Approval` (`IN_PROGRESS` $\rightarrow$ `PENDING_APPROVAL`)
     - `Approve` / `Request Changes` (rendered only for `ADMIN` / `TEAM_LEAD` roles)
     - `Resolve` / `Close`
4. **Audit Activity Timeline Sidebar:**
   - Embedded component fetching `/api/v1/work-items/:id/timeline`.
   - Comment submission form with automatic client-side `Idempotency-Key` generation.

---

## 6. Implementation Status & Progress Tracker

### Resolved Issues & Changes Made

1. **Route Resolution (`app.ts` & `work-items.routes.ts`):**
   - **Root Cause:** A prior edit accidentally pasted a duplicate `router.post("/", ...)` handler over `router.get("/", ...)`. When clients requested `GET /api/work-items`, Express failed to find a matching route inside `workItemRouter` and fell through to the catch-all `Route not found` 404 handler in `app.ts`.
   - **Fix:** Restored `router.get("/", ...)` with pagination/filtering, cleanly kept the idempotent `router.post("/", ...)` create handler, and mounted routes under both `/api` and `/api/v1` in `app.ts`.

2. **Full API Endpoint Suite Implemented:**
   - [`work-items.routes.ts`](file:///home/lumas/projects/dashboard/apps/api/src/routes/work-items.routes.ts): All 10 endpoints complete with `If-Match` / `ETag` OCC, state machine validations, approvals, rejections, comments, and audit timeline.
   - [`users.routes.ts`](file:///home/lumas/projects/dashboard/apps/api/src/routes/users.routes.ts): Implemented `GET /api/v1/users/me` returning user, roles, and team scopes.
   - [`teams.routes.ts`](file:///home/lumas/projects/dashboard/apps/api/src/routes/teams.routes.ts): Implemented `GET /api/v1/teams` and `GET /api/v1/teams/:id/members`.
   - [`schema.ts`](file:///home/lumas/projects/dashboard/apps/api/src/lib/schema.ts): Added comprehensive Zod validation schemas with snake_case and camelCase query/body aliases.

3. **Transactional Outbox Worker:**
   - [`outbox.service.ts`](file:///home/lumas/projects/dashboard/apps/api/src/services/outbox.service.ts) and [`outbox.worker.ts`](file:///home/lumas/projects/dashboard/apps/api/src/workers/outbox.worker.ts): Implemented row claiming, status tracking (`PENDING` $\rightarrow$ `PROCESSING` $\rightarrow$ `PROCESSED` / `FAILED`), and exponential backoff retry.

4. **Integration Test Suites:**
   - [`idempotency.test.mjs`](file:///home/lumas/projects/dashboard/apps/api/src/tests/idempotency.test.mjs): Covers initial creation, identical replay, key conflict (409), and concurrent creation.
   - [`occ-concurrency.test.mjs`](file:///home/lumas/projects/dashboard/apps/api/src/tests/occ-concurrency.test.mjs): Covers `ETag`, version increments, stale version 409 conflicts with server state, `If-Match` headers, state transition restrictions, and audit timeline.

5. **Architecture Documentation:**
   - [`ENGINEERING_DECISIONS.md`](file:///home/lumas/projects/dashboard/ENGINEERING_DECISIONS.md): Thorough write-up of design decisions, alternatives considered, and trade-offs for OCC, Idempotency, Transactional Outbox, and RBAC.

### Next Steps (Frontend UI — `apps/web`)

1. **Dashboard View (`apps/web/app/page.tsx`):**
   - Connect to `/api/v1/work-items` with search, status filtering, and team selector.
   - Visual badges for priority (`URGENT`, `HIGH`, `MEDIUM`, `LOW`) and status.
2. **Work Item Detail & Conflict Resolution Modal:**
   - Display item metadata with current `version` / `ETag`.
   - On `409 Conflict`, render a 3-way reconciliation modal showing conflicting fields (e.g., local edit vs server's latest state).
3. **State Machine Action Controls:**
   - Context-aware action buttons based on status:
     - `Start Work` (`OPEN` $\rightarrow$ `IN_PROGRESS`)
     - `Submit for Approval` (`IN_PROGRESS` $\rightarrow$ `PENDING_APPROVAL`)
     - `Approve` / `Request Changes` (rendered only for `ADMIN` / `TEAM_LEAD` roles)
     - `Resolve` / `Close`
4. **Audit Activity Timeline Sidebar:**
   - Embedded component fetching `/api/v1/work-items/:id/timeline`.
   - Comment submission form with automatic client-side `Idempotency-Key` generation.

