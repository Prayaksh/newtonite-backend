# Operational Work Management System

An enterprise-grade Operational Work Management System built as a TypeScript monorepo with Turborepo, Express, PostgreSQL, Prisma, and Next.js. It coordinates cross-functional requests (bugs, customer escalations, payment holds, compliance reviews, and approvals) with server-enforced guarantees for concurrency, idempotency, and asynchronous reliability.

---

## Architecture & Monorepo Structure

```
├── apps/
│   ├── api/                 # Node.js Express REST API (OCC, RBAC, Idempotency, Redis)
│   └── web/                 # Next.js / React operational dashboard
├── packages/
│   ├── db/                  # Prisma client, schema, migrations, connection pool
│   ├── ui/                  # Shared UI components
│   ├── eslint-config/       # ESLint shared configs
│   └── typescript-config/   # Shared tsconfig bases
├── ENGINEERING_DECISIONS.md # Detailed architecture and trade-off rationale
└── context.md               # Project blueprint, specification & progress tracker
```

---

## The 3 Critical Non-CRUD Engineering Behaviors

### 1. Optimistic Concurrency Control (OCC)
- **Problem:** Two operators viewing the same work item try to modify or reassign it simultaneously, causing silent overwrites.
- **Implementation:**
  - Every `WorkItem` record contains an integer `version` incremented on every mutation.
  - The API returns an `ETag: "<version>"` header on `GET /api/v1/work-items/:id`.
  - Mutations (`PATCH`, `/assign`, `/transition`, `/approve`, `/reject`) accept the target version via `If-Match: "<version>"` header or `version` in the JSON body.
  - Atomic conditional updates: `UPDATE "WorkItem" ... WHERE id = :id AND version = :version`.
  - **Conflict Response:** If a race condition occurs, 0 rows are updated and the server returns **`409 Conflict`** with the current server record (`{ error: "Work item changed; refresh before retrying", current: latest }`), allowing clients to resolve diffs cleanly.

### 2. Idempotency Control (Network Retry Safety)
- **Problem:** Network blips or duplicate form submissions produce duplicate work items or re-executed approvals.
- **Implementation:**
  - Clients pass an `Idempotency-Key: <UUID>` header on state-changing requests (`POST /api/v1/work-items`, `POST /api/v1/work-items/:id/comments`).
  - Recorded atomically in the database inside the same ACID transaction using an `IdempotencyKey` table with unique constraint on `(userId, key)`.
  - Retried requests with matching keys return the cached status code and response payload immediately without side effects.
  - Reusing a key with a *different* request payload returns **`409 Conflict`**.

### 3. Reliable Asynchronous Processing via Transactional Outbox
- **Problem:** Dual writes (committing to DB and calling external services like Slack/Email/Webhooks) fail when one succeeds and the other fails.
- **Implementation:**
  - Events are written to `OutboxEvent` within the **same database transaction** as the work item update.
  - The API poller claims `PENDING` rows and enqueues them into BullMQ using the outbox ID as a deduplication key. PostgreSQL remains the durable source of truth.
  - BullMQ retries failed jobs up to five times with exponential backoff. Completed queue jobs are retained temporarily; failed jobs remain available for inspection.

### 4. Distributed Real-Time Updates
- API instances publish work-item events through Redis Pub/Sub, and each instance forwards received events to its connected authenticated SSE clients.
- Redis is required when starting the API. Set `REDIS_URL` to the reachable Redis instance (the local default is `redis://localhost:6379`).

---

## API Specification

All endpoints are mounted on both `/api/v1/...` (spec standard) and `/api/...` (backwards compatibility).

Protected API routes use database-backed sessions. Sign in through `/api/v1/auth/login`; the API sets an HTTP-only `sid` cookie that must be sent on subsequent requests. The dashboard includes credentials automatically.

### Work Items (`/api/v1/work-items`)

| Method | Endpoint | Description | Key Headers / Body |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/work-items` | List & filter items (pagination, status, priority, search) | Params: `page`, `limit`, `team_id`, `status`, `priority`, `assignee_id`, `q` |
| `POST` | `/api/v1/work-items` | Create new work item | Header: `Idempotency-Key` |
| `GET` | `/api/v1/work-items/:id` | Get item details | Returns: `ETag: "<version>"` |
| `PATCH` | `/api/v1/work-items/:id` | Update metadata with OCC | Header: `If-Match` or Body: `version` |
| `POST` | `/api/v1/work-items/:id/assign` | Claim or reassign item | Header: `If-Match` / Body: `assignee_id`, `version` |
| `POST` | `/api/v1/work-items/:id/transition` | State machine transition | Header: `If-Match` / Body: `target_status`, `version` |
| `POST` | `/api/v1/work-items/:id/approve` | Approve item (`PENDING_APPROVAL` $\rightarrow$ `RESOLVED`) | Body: `version`, `reason` (Role: Admin / Team Lead) |
| `POST` | `/api/v1/work-items/:id/reject` | Reject item (`PENDING_APPROVAL` $\rightarrow$ `IN_PROGRESS`) | Body: `version`, `reason` (Role: Admin / Team Lead) |
| `POST` | `/api/v1/work-items/:id/comments` | Post comment / internal note | Header: `Idempotency-Key` / Body: `body`, `is_internal` |
| `GET` | `/api/v1/work-items/:id/timeline` | Immutable activity & audit trail | Params: `limit`, `before_id` |

### Teams & Identity (`/api/v1/...`)

| Method | Endpoint | Description | Key Headers / Body |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/login` | Create a session | Body: `email`, `password`; sets `sid` cookie |
| `GET` | `/api/v1/auth/me` | Verify the current session | Cookie: `sid` |
| `POST` | `/api/v1/auth/logout` | End the current session | Cookie: `sid` |
| `GET` | `/api/v1/users/me` | Current user profile, roles, team scopes | Cookie: `sid` |
| `GET` | `/api/v1/teams` | List operational teams user belongs to | Cookie: `sid` |
| `GET` | `/api/v1/teams/:id/members` | List members and roles for a team | Cookie: `sid` |
| `GET` | `/api/v1/notifications` | List team activity notifications; supports `unread_only=true` | Cookie: `sid` |
| `POST` | `/api/v1/notifications/read` | Mark up to 100 notification activity IDs as read | Cookie: `sid`; Body: `activityIds` |

---

## State Machine Transition Rules

```mermaid
stateDiagram-v2
    [*] --> OPEN: Created
    OPEN --> IN_PROGRESS: Work Started
    OPEN --> CLOSED: Canceled / Discarded
    IN_PROGRESS --> PENDING_APPROVAL: Sent for Review
    IN_PROGRESS --> RESOLVED: Direct Resolution
    IN_PROGRESS --> OPEN: Reopened
    IN_PROGRESS --> CLOSED: Closed
    PENDING_APPROVAL --> RESOLVED: /approve (Lead/Admin)
    PENDING_APPROVAL --> IN_PROGRESS: /reject (Changes Requested)
    RESOLVED --> CLOSED: Verified
    RESOLVED --> OPEN: Reopened
    CLOSED --> OPEN: Reopened
```

---

## Getting Started

### Prerequisites
- Node.js >= 24
- PostgreSQL running locally or in Docker
- Redis running locally or in Docker
- pnpm

### Environment Configuration
Configure `apps/api/.env`:
```env
NODE_ENV="development"
PORT=3000
REDIS_URL="redis://localhost:6379"
DATABASE_URL="postgresql://user:password@localhost:5432/dashboard"
TEST_USER_ID="cmvbva00d0000d9tktpexpo4x"
TEST_TEAM_ID="cmvbva03c0001d9tkuixolcur"
DEV_USER_PASSWORD="choose-a-local-development-password"
```

### Database Setup & Seeding
```sh
# Start local backing services, including Redis
docker compose up -d postgres redis

# Generate Prisma Client & apply schema
pnpm --filter @repo/db db:push

# Seed the development user and team (also sets the login password)
pnpm --filter @repo/api exec node --env-file=.env --import tsx src/scripts/seed-dev.ts
```

The compose file reads `DB_USER` and `DB_PASSWORD` from the repository-root `.env`; configure those values before starting PostgreSQL. Keep credentials out of source control.

The seed script requires `DEV_USER_PASSWORD`. Integration tests log in as `dev@example.com` using that password and send the returned session cookie; set `TEST_USER_EMAIL` and/or `TEST_USER_PASSWORD` to test a different account.
The notification read-receipt integration test also runs when `TEST_NOTIFICATION_ACTOR_EMAIL` and `TEST_NOTIFICATION_ACTOR_PASSWORD` are set to a second user who belongs to `TEST_TEAM_ID`.

### Running the API
```sh
# Start development server with hot-reload
pnpm --filter @repo/api dev

# Build TypeScript
pnpm --filter @repo/api build
```

### Running Integration Tests
```sh
# Run idempotency and OCC concurrency test suites
node --env-file=apps/api/.env --test apps/api/src/tests/idempotency.test.mjs
node --env-file=apps/api/.env --test apps/api/src/tests/occ-concurrency.test.mjs
node --env-file=apps/api/.env --test apps/api/src/tests/smoke.test.mjs
```

---

## Example Usage

### 1. Sign In
```sh
curl -c /tmp/dashboard.cookies -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"<DEV_USER_PASSWORD>"}'
```

### 2. List Work Items
```sh
curl -b /tmp/dashboard.cookies http://localhost:3000/api/v1/work-items
```

### 3. Create a Work Item (Idempotent)
```sh
curl -X POST http://localhost:3000/api/v1/work-items \
  -b /tmp/dashboard.cookies \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 11111111-2222-3333-4444-555555555555" \
  -d '{
    "title": "Payment gateway timeout on checkout",
    "description": "Stripe webhook 504 gateway timeout under load",
    "category": "PAYMENT",
    "priority": "HIGH",
    "teamId": "cmvbva03c0001d9tkuixolcur"
  }'
```

### 4. Update with Optimistic Concurrency Control (OCC)
```sh
# Update using If-Match header matching current version
curl -X PATCH http://localhost:3000/api/v1/work-items/<ITEM_ID> \
  -b /tmp/dashboard.cookies \
  -H "Content-Type: application/json" \
  -H "If-Match: \"1\"" \
  -d '{
    "priority": "URGENT"
  }'

# If someone else already updated to version 2, the server returns 409 Conflict:
# {"error":"Work item changed; refresh before retrying","current":{"id":"...","version":2,...}}
```

### 5. Transition State
```sh
curl -X POST http://localhost:3000/api/v1/work-items/<ITEM_ID>/transition \
  -b /tmp/dashboard.cookies \
  -H "Content-Type: application/json" \
  -d '{
    "version": 2,
    "target_status": "IN_PROGRESS"
  }'
```

### 6. Add a Comment (Audit Timeline)
```sh
curl -X POST http://localhost:3000/api/v1/work-items/<ITEM_ID>/comments \
  -b /tmp/dashboard.cookies \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" \
  -d '{
    "body": "Root cause identified: connection pool saturation.",
    "is_internal": true
  }'
```

---

## Documentation
- Detailed architectural trade-offs: [`ENGINEERING_DECISIONS.md`](file:///home/lumas/projects/dashboard/ENGINEERING_DECISIONS.md)
- System blueprint and progress tracking: [`context.md`](file:///home/lumas/projects/dashboard/context.md)
