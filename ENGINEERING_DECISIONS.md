# Engineering Decisions & Trade-Offs

This document records architectural decisions embodied in the Operational Work Management System. It describes implemented behavior, not a project plan.

## 1. Concurrency Control: Optimistic Concurrency Control

### Choice
Work items use an incrementing `version` together with HTTP `ETag` and `If-Match` headers.

### Rationale
- Operators may view and edit the same work item concurrently. Holding database locks across a human editing session would increase contention and hold connections unnecessarily.
- Mutations use conditional updates against both the work-item ID and expected version. If the version is stale, the API returns `409 Conflict` with the latest item rather than silently overwriting another user's change.
- The UI can refresh or present the conflict state without blocking other work.

## 2. Duplicate Prevention: Database-Backed Idempotency

### Choice
Idempotency is keyed by the authenticated user and client-provided `Idempotency-Key`, with records stored in PostgreSQL.

### Rationale
- The server records the request hash and response inside the same transaction as the protected operation.
- A retry with the same key and payload replays the stored status and response without repeating side effects. Reusing a key with a different payload returns `409 Conflict`.
- Keys receive a 24-hour expiry timestamp. Expired records are not currently cleaned up on a schedule or ignored during lookup, so a key may remain effective beyond that window. Work-item creation requires a key; comment creation uses idempotency when a key is supplied.
- Scoping keys to the user prevents one user's retry key from colliding with another's.

## 3. Asynchronous Handoff: PostgreSQL Outbox and BullMQ

### Choice
Work-item changes write an `OutboxEvent` row in the same PostgreSQL transaction as the primary mutation and its activity record. A poller hands pending rows to BullMQ in Redis.

### Rationale
- Persisting the event alongside the mutation prevents a successful database change from committing without a corresponding outbox record.
- The poller checks every three seconds, claims rows in batches of up to 20, and enqueues jobs using the outbox ID as the BullMQ job ID.
- BullMQ retries failed jobs up to five times with exponential backoff. Completed jobs are retained temporarily; failed jobs remain available for inspection.
- The outbox row remains `PROCESSING` until the queue worker completes the job; exhausted BullMQ retries mark it `FAILED`. A periodic reconciler checks stale claims against BullMQ and requeues claims with no corresponding job. Processing remains at-least-once, so handlers must tolerate duplicate delivery.

## 4. Authorization: Team-Scoped, Data-Backed RBAC

### Choice
Role-Based Access Control (`ADMIN`, `TEAM_LEAD`, `MEMBER`, `VIEWER`) is checked against PostgreSQL team memberships in route handlers and scoped data queries.

### Rationale
- Permissions are not enforced solely in the UI. Mutations verify membership and role for the work item's team.
- Approval and rejection require `ADMIN` or `TEAM_LEAD`; read queries scope results to teams the caller belongs to.
- PostgreSQL foreign keys and uniqueness constraints protect relational integrity, but row-level security is not configured. Tenant isolation relies on application query and handler checks.

## 5. API Routing: Resource Route Compatibility

### Choice
Work-item, user, team, dashboard, notification, and activity routes are mounted under both `/api/...` and `/api/v1/...` prefixes.

### Rationale
- The aliases preserve compatibility for existing callers while providing the versioned API prefix.
- Authentication routes are mounted under `/api/v1/auth`; they do not currently have a `/api/auth` alias.

## 6. Session Security: Opaque Tokens with Server-Side Validation

### Choice
Authenticated requests use a random, opaque `sid` session token backed by an `AuthSession` record, rather than trusting an identity header or embedding authorization claims in a client token.

### Rationale
- The raw token is returned only in an HTTP-only cookie; PostgreSQL stores its SHA-256 hash, expiry, and owning user.
- Middleware hashes the presented cookie and checks that the session is unexpired and the user remains active before setting the request identity.
- Login verifies bcrypt password hashes, including a dummy-hash comparison for unknown users. Invitation tokens are also stored as hashes and expire.
- Server-side sessions keep identity and account status revocable. They require a database lookup on authenticated requests and make PostgreSQL availability part of the authentication path.

## 7. Workflows: Explicit State Machine and Role-Gated Approval

### Choice
Work-item statuses follow a finite workflow (`OPEN`, `IN_PROGRESS`, `PENDING_APPROVAL`, `RESOLVED`, `CLOSED`) with an explicit transition map. Approval and rejection are separate privileged actions.

### Rationale
- Invalid transitions are rejected instead of allowing arbitrary status updates.
- Transitions require the current work-item version; approval actions additionally verify the caller's team role.
- Keeping lifecycle rules in the API gives clients one server-enforced workflow. The rules are not independently enforced by a database trigger or PostgreSQL policy.

## 8. Auditability: Activity Records Commit with Mutations

### Choice
User-visible activity records are written in the same database transaction as the corresponding work-item mutation.

### Rationale
- Creation, edits, assignments, comments, and lifecycle changes record the actor, event type, timestamp, and relevant change data.
- Timeline and activity-feed queries apply team-membership scope and bounded pagination.
- The transaction makes a successful mutation and its corresponding history atomic from the application's perspective. Records are append-oriented in handlers, but immutability is not enforced by database permissions or triggers.

## 9. Real-Time Delivery: Redis Pub/Sub with Authenticated SSE

### Choice
Redis Pub/Sub distributes work-item events between API instances. Each instance forwards received messages to its local Server-Sent Events connections; `/events` requires a valid session.

### Rationale
- Pub/Sub avoids coupling connected clients to a single API process, while SSE provides a simple one-way browser update stream.
- API startup waits for Redis connections, and graceful shutdown closes Pub/Sub, BullMQ, and database clients.
- Pub/Sub is transient: disconnected subscribers do not receive history or replay. Durable work-item/activity data and the PostgreSQL outbox are separate from this live notification channel.
- At connection time, the SSE route loads the caller's team memberships and only forwards events carrying one of those team IDs. Reconnected browsers refresh dashboard data to recover changes missed during disconnects.

## 10. Notifications: Activity-Derived with Per-User Read Receipts

### Choice
Notifications are derived from team activity, exclude the caller's own actions, and store read state as per-user `NotificationRead` rows keyed by user and activity.

### Rationale
- `unread_only=true` filters out activities with a read receipt. The response includes `isRead` and `readAt`.
- `POST /api/v1/notifications/read` marks up to 100 accessible notification activity IDs as read; duplicate requests are safe because the receipt key is unique.
- This avoids duplicating activity content into a separate notification table. Read state is durable, while notifications themselves remain a view over the activity stream.

## 11. Relational Integrity: Team Membership as the Tenant Boundary

### Choice
Users can participate in multiple teams through a unique `(userId, teamId)` membership. Work items, activities, invitations, and assignments are connected through relational foreign keys.

### Rationale
- Team-scoped queries derive accessible team IDs from the authenticated user's memberships; route handlers validate roles before protected mutations.
- Composite indexes support common team/status/priority, assignee/status, reporter, activity, and outbox access patterns.
- PostgreSQL constraints protect referential integrity, while authorization remains application-enforced rather than using row-level security.

## 12. Abuse Protection: Shared Redis Login Rate Limit

### Choice
Login attempts use a Redis-backed per-IP limit shared across API instances: ten failed attempts per 15-minute window. Successful login requests are excluded from the failure count.

### Rationale
- Redis avoids per-process memory counters that would reset on restart and diverge across horizontally scaled API instances.
- The API requires Redis at startup, so this control does not silently fall back to an unshared in-memory store.
- Other general API limits continue to use their configured Express rate-limit store.
