# Engineering Decisions & Trade-Offs

This document explains important engineering choices implemented in the
Operational Work Management System. Each entry describes the problem, the
chosen approach, why it fits this system, and the trade-offs that should be
understood when operating or extending it. It describes current behavior, not a
future plan.

## 1. Concurrency Control: Optimistic Concurrency Control

### Problem
More than one operator can view or edit the same work item. A save must not
silently overwrite a change made by another operator after the first operator
loaded the item.

### Decision
Each work item has an incrementing `version`. Reads expose that version through
an HTTP `ETag`, and updates can provide the expected version in `If-Match` (or
the request body). The database update is conditional on both the item ID and
the version that the client read.

### Why this fits
- Editing is intermittent human activity, so it would be wasteful to hold a
  database lock while someone reviews a form.
- Most edits are expected not to conflict. In that common case, the client can
  save without a lock acquisition and waiting period.
- A stale edit is reported as `409 Conflict` with the latest server state. The
  dashboard can show both versions and let the operator decide whether to
  discard or reapply their changes.

### Trade-offs and implications
- A conflicting user must resolve the conflict and retry; the server does not
  merge changes automatically.
- Every write path that can change a work item must advance and check the
  version. A new mutation that skips this rule could reintroduce lost updates.
- The client must retain the version it read and handle conflicts as a normal
  outcome, not as an unexpected server error.

## 2. Duplicate Prevention: Database-Backed Idempotency

### Problem
Browsers and clients may retry requests when a response is delayed or the
connection is interrupted. A retry must not create a second work item or
repeat another side effect.

### Decision
Protected operations accept an `Idempotency-Key`. The key is scoped to the
authenticated user and stored in PostgreSQL with a hash of the request and the
original response. Work-item creation requires a key; comment creation uses
idempotency when a key is supplied.

### Why this fits
- A caller can safely retry after a network failure without needing to know
  whether the first request completed.
- Storing the operation and its response in the same transaction makes replay
  available from the same durable store as the operation.
- Per-user scoping prevents unrelated users from colliding on a key.
- A repeated key with the same request replays the original status and response;
  using the same key for a different request returns `409 Conflict`.

### Trade-offs and implications
- The caller must reuse the same key for retries of one logical action and use a
  new key for a new action.
- PostgreSQL storage and transaction handling add work to protected requests.
- Keys are assigned a 24-hour expiry timestamp, but expired rows are not
  periodically cleaned up and the current lookup path does not ignore an
  expired row. In practice, a key can remain effective until that row is
  removed; the timestamp alone does not guarantee expiry behavior.
- Idempotency protects only the routes and operations that use the middleware.
  New side-effecting routes must explicitly adopt it if they need retry safety.

## 3. Asynchronous Handoff: PostgreSQL Outbox and BullMQ

### Problem
A work-item change can require follow-up processing. Publishing a queue job
separately from the database commit can lose the notification if the database
write succeeds but queue publication fails, or publish a job for a transaction
that later rolls back.

### Decision
The work-item change, activity record, and `OutboxEvent` are written together
in a PostgreSQL transaction. A poller claims pending outbox rows and enqueues
them in BullMQ, which uses Redis.

### Why this fits
- The outbox row commits or rolls back with the work-item mutation, so a
  successful change leaves a durable record of work that still needs delivery.
- Queue processing is kept outside the request transaction and can be retried
  independently.
- Using the outbox ID as the BullMQ job ID helps avoid creating duplicate jobs
  when the poller retries enqueueing.
- A reconciler can recover stale claims when an outbox row was claimed but its
  queue job is missing.

### Trade-offs and implications
- Delivery is **at least once**, not exactly once. A worker may see an event
  again after a retry, so side-effecting handlers must be idempotent or detect
  duplicates.
- The poller adds up to its polling interval (currently three seconds) before
  queue work begins. It claims batches of up to 20 rows.
- BullMQ retries failed jobs up to five times with exponential backoff.
  Exhausted retries leave the outbox row failed and available for inspection;
  this needs operational monitoring and a recovery procedure.
- Redis and PostgreSQL are both required for the complete handoff path. The
  outbox preserves pending work during queue interruptions, but it does not
  remove the need to restore the queue service.

## 4. Authorization: Team-Scoped, Data-Backed RBAC

### Problem
Users can belong to multiple teams and have different responsibilities. Hiding
buttons in the UI is not sufficient to protect data or operations from a
modified client request.

### Decision
The API checks the caller's PostgreSQL team memberships and roles
(`ADMIN`, `TEAM_LEAD`, `MEMBER`, and `VIEWER`) in protected handlers and scopes
queries to teams the caller belongs to.

### Why this fits
- Authorization uses persisted membership data rather than trusting a role or
  team ID supplied by the browser.
- The API remains the enforcement point, so the same rules apply to the web UI
  and other clients.
- Approval and rejection are restricted to `ADMIN` and `TEAM_LEAD`, while
  read queries are scoped to the caller's teams.
- The membership relationship supports users who work across more than one
  team without duplicating their account.

### Trade-offs and implications
- Membership and permission checks are application responsibilities and need to
  be included in new routes and queries.
- PostgreSQL row-level security is not configured. A missing scope or role
  check in application code would not be automatically blocked by the
  database.
- Permission changes take effect through the membership data read by the API;
  access is not carried as a long-lived client-side role claim.
- Authorization tests should exercise both allowed and denied roles, including
  access to items outside a caller's teams.

## 5. API Routing: Resource Route Compatibility

### Problem
The project has clients using resource endpoints with and without an explicit
API version. Changing every existing caller at once risks breaking working
integrations.

### Decision
Work-item, user, team, dashboard, notification, and activity routers are
mounted under both `/api/...` and `/api/v1/...`. Authentication routes are
mounted under `/api/v1/auth`.

### Why this fits
- Existing unversioned resource callers can continue to work while the
  dashboard uses versioned routes.
- The versioned prefix gives future API evolution an explicit place to start.
- Both prefixes share the same route handlers, avoiding two implementations
  that could drift in validation or authorization behavior.

### Trade-offs and implications
- Supporting aliases increases the number of public paths that should be
  covered by route tests and documented for clients.
- The aliases do not provide different behavior or independent versions; they
  currently reach the same implementation.
- There is no `/api/auth` alias. New clients should use `/api/v1/auth`, and a
  future alias or removal should be treated as a compatibility change.

## 6. Session Security: Opaque Tokens with Server-Side Validation

### Problem
The API needs to identify callers on every request and revoke their access when
their session expires or their account becomes inactive.

### Decision
Login creates a random opaque `sid` token and returns it in an HTTP-only cookie.
PostgreSQL stores the SHA-256 token hash, owning user, and expiry. Authentication
middleware hashes the presented cookie and validates the corresponding session
and active user.

### Why this fits
- The browser does not need to read or store a bearer token in JavaScript.
- A random opaque value reveals no identity or role claims to the client.
- The server can invalidate a session or respond to account deactivation using
  current database state instead of waiting for a self-contained token to
  expire.
- Invitation tokens are also stored as hashes and expire, so the raw token is
  not the database lookup value.
- Login uses bcrypt and performs a dummy-hash comparison for unknown users to
  reduce the timing difference between unknown accounts and incorrect
  passwords.

### Trade-offs and implications
- Authenticated requests depend on PostgreSQL to validate the session; this
  improves revocation control but adds a database lookup and makes database
  availability part of the authentication path.
- Session data must be expired and managed server-side. The current session
  lifetime is seven days.
- Cookie security settings vary with deployment mode: the cookie is HTTP-only,
  uses `SameSite=Lax`, and is marked `Secure` in production.
- Browser/API deployments must configure allowed origins and credentials
  correctly for cookie-based cross-origin requests.

## 7. Workflows: Explicit State Machine and Role-Gated Approval

### Problem
An arbitrary status update can skip required work or approval steps. Clients
should not be able to invent lifecycle transitions by sending a status field.

### Decision
Work items use the finite status set `OPEN`, `IN_PROGRESS`,
`PENDING_APPROVAL`, `RESOLVED`, and `CLOSED`. The API validates transitions
against an explicit transition map. Approval and rejection are distinct,
role-gated operations.

### Why this fits
- The workflow rules are centralized at the API boundary and apply regardless
  of which client initiates a change.
- Invalid transitions can be rejected with a clear client error instead of
  leaving an item in a state the product does not expect.
- Approval and rejection can enforce stricter permissions than ordinary
  transitions.
- Transition requests also use optimistic concurrency, so an operator cannot
  act on an outdated status/version without receiving a conflict.

### Trade-offs and implications
- Adding a status or transition requires coordinated changes to the API's
  transition rules, validation, dashboard actions, and relevant tests.
- The database stores the status but does not independently enforce the
  transition graph with a trigger or policy. The API remains the lifecycle
  enforcement point.
- Clients must present only actions that make sense for the current status,
  while still treating API validation as authoritative.

## 8. Auditability: Activity Records Commit with Mutations

### Problem
Operators and reviewers need to understand who changed an item and what
happened over its lifecycle. A mutation without a corresponding activity entry
would leave the timeline incomplete.

### Decision
Work-item creation, edits, assignments, comments, and lifecycle changes write
activity records in the same database transaction as the related mutation.
Timeline and activity-feed reads are team-scoped and paginated.

### Why this fits
- Committing the change and activity together prevents one from succeeding
  without the other in the covered transactions.
- A common activity stream gives the dashboard a single source for item
  timelines and team activity.
- Actor, event type, timestamp, and change data support review and
  troubleshooting.
- Bounded pagination avoids returning an unbounded history response.

### Trade-offs and implications
- Activity data is coupled to the transactional work-item path; a failure to
  write the activity should fail the covered mutation as well.
- Change payloads should contain useful context without including secrets or
  unnecessary personal data.
- Handlers treat records as append-oriented, but immutability is not enforced
  through database permissions or triggers. Database access and retention
  policies still matter.
- New mutations should add an activity record in the same transaction when
  their outcome needs to be auditable.

## 9. Real-Time Delivery: Redis Pub/Sub with Authenticated SSE

### Problem
Operators should see work-item updates made by other users without repeatedly
refreshing the page, including when API requests are served by different
instances.

### Decision
Redis Pub/Sub distributes event messages between API instances. Each instance
forwards relevant events to its local Server-Sent Events connections. The
`/events` endpoint requires an authenticated session and filters events by the
caller's team memberships.

### Why this fits
- SSE provides a straightforward one-way stream for server-to-browser
  notifications; the browser already sends commands through normal HTTP
  requests.
- Redis Pub/Sub allows instances to share live updates without requiring a
  browser connection to stay attached to the instance that produced the
  change.
- Team filtering limits delivery to teams the authenticated user belongs to.
- On reconnection, the dashboard reloads items and stats to recover updates
  missed while disconnected.

### Trade-offs and implications
- Pub/Sub is transient: a disconnected subscriber does not receive event
  history or replay. The dashboard refresh on reconnect is a state-recovery
  mechanism, not replay of every event.
- The event stream complements durable database state and the outbox; it is
  not the source of truth.
- SSE is one-way and is suitable for notifications, not client-to-server
  commands or binary streaming.
- Redis availability affects live delivery, and connections need cleanup
  during shutdown.

## 10. Notifications: Activity-Derived with Per-User Read Receipts

### Problem
Users need a personal unread/read view of relevant team activity, without
storing a second copy of every activity message for each recipient.

### Decision
Notifications are derived from team activity, exclude the caller's own
actions, and store read state as `NotificationRead` rows keyed by user and
activity. The API returns `isRead` and `readAt`; the read endpoint accepts up
to 100 accessible activity IDs per request.

### Why this fits
- Activity remains the canonical record of what happened; notification
  responses are a filtered view over that record.
- A separate per-user receipt records only the state that differs between
  users, rather than duplicating activity content.
- The unique user/activity key makes repeated read receipts safe.
- Excluding the caller's own actions avoids presenting self-generated work as
  a new notification.

### Trade-offs and implications
- Notification content and availability depend on activity records and their
  access scope.
- Read state grows with the number of users who mark activities read and must
  be retained or cleaned up under an explicit data-retention policy.
- The API caps each read batch, so clients need to split larger sets into
  bounded requests.
- New activity types should be evaluated for whether they belong in the
  notification view.

## 11. Relational Integrity: Team Membership as the Tenant Boundary

### Problem
Users can share the system while work and activity remain isolated by team.
Relationships must also stay valid when users, teams, or work items change.

### Decision
Team membership is a many-to-many relationship with a unique
`(userId, teamId)` pair. Work items, activities, invitations, and assignments
use relational foreign keys. Team-scoped queries derive access from the
caller's memberships.

### Why this fits
- A user can participate in multiple teams without creating a separate account
  for each team.
- A unique membership pair prevents duplicate role assignments for the same
  user/team relationship.
- Foreign keys protect references from pointing to records that do not exist.
- Composite indexes support common team/status/priority, assignee/status,
  reporter, activity, and outbox query patterns.

### Trade-offs and implications
- Access depends on correct membership-scoped queries and route checks; the
  relational model alone does not authorize a read.
- PostgreSQL row-level security is not enabled, so a new data-access path must
  explicitly apply team scope.
- Indexes improve common reads at the cost of additional storage and write
  work. Index changes should follow actual query needs.
- Data-model changes to membership and foreign keys should be coordinated
  with migrations and application code.

## 12. Abuse Protection: Shared Redis Login Rate Limit

### Problem
An attacker can repeatedly guess passwords, and an in-memory counter on one
API instance would not constrain attempts routed to another instance.

### Decision
Login attempts use a Redis-backed per-IP limit shared across API instances:
ten failed attempts in a 15-minute window. Successful login requests do not
count toward the failure limit.

### Why this fits
- Redis provides a shared counter rather than independent limits per process.
- Counting failures allows a successful login to proceed without consuming
  more of the user's remaining attempt budget.
- Requiring Redis at startup avoids silently switching to a weaker,
  process-local fallback.

### Trade-offs and implications
- Multiple users behind the same public IP share the per-IP limit and can
  affect one another.
- The service depends on Redis for this configured rate-limit store; Redis
  health and capacity are operational requirements.
- The limit is a layer of abuse protection, not a replacement for strong
  passwords, monitoring, or account-level security controls.
- General API rate limits use their configured Express rate-limit store and
  should be reviewed separately from the login-specific rule.

## 13. Input Validation: Shared Zod Schemas at the API Boundary

### Problem
Requests come from clients that can be outdated, buggy, or deliberately
malformed. Route handlers should not each interpret input differently.

### Decision
Reusable Zod schemas define accepted request shapes and rules for work-item
creation and updates, filters, transitions, assignments, comments, login,
invitations, approvals, and timeline queries.

### Why this fits
- Validation happens at the API boundary, before values are used by business
  logic or database operations.
- Shared schemas provide a single definition for allowed enums, required
  fields, length limits, and query bounds.
- Transformations can normalize values such as email case and supported
  request aliases, while defaults keep omitted optional values consistent.
- Strict schemas for selected inputs reject unknown keys instead of silently
  accepting misspelled or unsupported fields.

### Trade-offs and implications
- Validation rules are part of the public API contract; changing a limit,
  field, or enum can affect existing clients.
- A schema only protects a route when that route actually applies it. New
  handlers must wire the relevant schema into validation middleware.
- Validation is not authorization. A structurally valid team or user ID must
  still be checked against the caller's permissions.
- Database constraints remain necessary for relational integrity and
  concurrent writes; request validation cannot replace them.

## 14. Test Strategy: Layered Tests with Explicit Service Boundaries

### Problem
One test style cannot efficiently verify pure validation rules, interactive UI
behavior, real browser layout, and persistence-backed API behavior. Tests also
need clear boundaries so failures identify which part of the system is broken.

### Decision
The project uses Node's built-in test runner for API schema unit tests, Vitest
with React Testing Library for web component tests, Playwright for browser
end-to-end tests, and separate live API integration tests.

### Why this fits
- API schema tests run without PostgreSQL or Redis and cover parsing,
  defaults, normalization, and invalid input.
- Component tests render the actual dashboard and simulate user actions while
  mocking API responses. They check visible states and requests sent by the
  client.
- Playwright tests exercise the app in Chromium with a mocked API. They cover
  complete browser flows, including authentication, work-item actions, conflict
  recovery, and a phone-sized viewport.
- Live API integration tests remain responsible for persistence-backed routes,
  idempotency, concurrency, and interactions across handlers.

### Trade-offs and implications
- Mocked tests are isolated and repeatable, but cannot prove that the API,
  database, and queue work correctly together.
- Live integration tests provide that coverage but require running services,
  configured credentials, and a test team; they create work-item records and
  should not run against production data.
- Browser tests require Playwright's Chromium installation and take longer
  than unit tests.
- A green result in one layer should not be reported as proof that all other
  layers passed.

### Commands
- API schema unit tests: `pnpm --filter @repo/api test:unit`
- Live API integration tests: `pnpm --filter @repo/api test:integration`
- Web component tests: `pnpm --filter @repo/web test`
- Browser E2E tests: `pnpm --filter @repo/web test:e2e`
- Playwright browser setup: `pnpm --filter @repo/web exec playwright install chromium`

## 15. User Interface: Shared Dark Palette and Responsive Work Surfaces

### Problem
The dashboard presents operational information that needs to remain readable
across the overview, work-item list, detail panel, and forms. Dense tabular
content also needs to remain usable on narrow screens.

### Decision
The web app defines a shared palette using pop violet (`#7c3aed`), hyper cyan
(`#06b6d4`), hot fuchsia (`#ec4899`), acid green (`#84cc16`), sunburst orange
(`#f97316`), plum (`#0d0b18`), card plum (`#1a162b`), and bright text
(`#fafafa`). The dashboard, dialogs, and forms use coordinated dark plum
surfaces. The work-item table scrolls horizontally on narrow screens instead
of shrinking its columns until content becomes unreadable.

### Why this fits
- Shared CSS variables keep key colors consistent and allow the palette to be
  adjusted in one place.
- Violet is the primary action color and cyan remains a limited secondary
  accent. Fuchsia, green, and orange distinguish urgent/danger, success, and
  warning/priority states without making the overall interface predominantly
  blue.
- Stat cards, filters, tables, and modals use distinct surfaces and borders to
  separate information without hiding it in a dense layout.
- Responsive layouts reflow controls and summaries on phones while preserving
  a usable minimum width for table data.
- Visible keyboard focus styles and reduced-motion handling support keyboard
  users and users who prefer less animation.

### Trade-offs and implications
- A dark base palette requires sufficient contrast for muted text, borders,
  badges, and disabled controls; new UI states should use the shared tokens
  rather than introducing arbitrary colors.
- The table may require horizontal scrolling on phones. This preserves
  readable columns but does not make every column visible at once.
- Dialogs use dark plum surfaces to keep the interface visually consistent;
  text and controls need sufficient contrast against those surfaces.
- Visual consistency depends on applying the same tokens and responsive
  patterns to newly added components.
