# Engineering Decisions & Trade-Offs

This document outlines the core architectural and engineering choices made across the Operational Work Management System, as specified in `context.md`.

---

## 1. Concurrency Control: Optimistic Concurrency Control (OCC) vs. Pessimistic Locking

### Choice
We implemented **Optimistic Concurrency Control (OCC)** using an incremental `version` integer column on the `WorkItem` entity, paired with HTTP `ETag` and `If-Match` headers.

### Trade-Offs & Rationale
- **Why Not Pessimistic Locking (`SELECT FOR UPDATE`):**
  - In a multi-user collaborative environment with human decision makers, users open edit dialogs or view items for minutes. Holding database locks across network interactions leads to connection pool exhaustion, contention, and cascading deadlocks.
- **Why OCC:**
  - OCC uses conditional atomic updates (`UPDATE "WorkItem" ... WHERE id = :id AND version = :version`).
  - If a race condition occurs (e.g. User B attempts to edit version `N` after User A committed version `N+1`), the update affects 0 rows.
  - The server immediately rolls back and returns **`409 Conflict`** alongside the `current` server state, empowering the client UI to perform automated diff resolution or offer a 3-way merge modal without blocking others.

---

## 2. Accidental Duplicate Prevention: Idempotency Key Pattern

### Choice
Transactional idempotency tracking using an `IdempotencyKey` table queried and recorded atomically within the database transaction.

### Trade-Offs & Rationale
- **The Problem:** Network timeouts and client retries during slow database writes or network drops often cause duplicate items, duplicate approvals, or multiple credit card charges.
- **Mechanism:**
  - Clients provide a unique `Idempotency-Key: <UUID>` header.
  - The server records `(userId, key, requestHash)` within the transaction.
  - Retried requests with the same key and same payload return the cached response immediately (`201 Created` or `200 OK`) without re-running business logic or generating duplicate outbox events.
  - If the client reuses an idempotency key with a *different* request payload, the server detects the hash mismatch and rejects it with `409 Conflict`.

---

## 3. Reliable Asynchronous Processing: Transactional Outbox Pattern

### Choice
Secondary events (notifications, audit hooks, external queue dispatching) are written into an `outbox_events` table inside the *exact same ACID database transaction* as the work item mutation.

### Trade-Offs & Rationale
- **Why Not Direct Message Publishing (Dual Writes):**
  - Emitting directly to Redis/BullMQ or Slack during the HTTP request is vulnerable to split-brain states:
    - If the message queue publish succeeds but the database transaction rolls back, external systems react to phantom data.
    - If the database commit succeeds but the queue publish fails, notifications are permanently lost.
- **Transactional Outbox Solution:**
  - By writing the event to `outbox_events` atomically with the primary record, either both commit or neither does.
  - A dedicated `OutboxWorker` polls `PENDING` events with database claiming (`lockedAt`), exponential backoff (`Math.pow(2, attempts) * 1000ms`), and a dead-letter state (`FAILED` after 5 attempts).
  - Guarantees **at-least-once delivery** while isolating primary API latency from downstream service outages.

---

## 4. Authorization & Security: Database-Level RBAC

### Choice
Role-Based Access Control (`ADMIN`, `TEAM_LEAD`, `MEMBER`, `VIEWER`) verified directly against the database in middleware and route handlers, scoped to team boundaries.

### Trade-Offs & Rationale
- **Database & Query Enforcement:**
  - Permissions are never checked solely in the UI.
  - Every mutation checks the user's role on the target item's team.
  - Sensitive state transitions (e.g., `/approve`, `/reject`) strictly require `ADMIN` or `TEAM_LEAD` status.
  - Read queries filter at the database level (`teamId: { in: accessibleTeamIds }`), preventing unauthorized multi-tenant leakage even if IDs are guessed.

---

## 5. API Routing Strategy: Dual Version Compatibility

### Choice
Both `/api/...` and `/api/v1/...` route prefixes are mounted simultaneously in `app.ts`.

### Trade-Offs & Rationale
- Ensures backwards compatibility with pre-existing integration tests and legacy callers while strictly complying with the `/api/v1/...` specification outlined in `context.md`.

