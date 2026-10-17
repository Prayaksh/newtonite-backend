# Operational Work Management System

An enterprise-grade Operational Work Management System built as a TypeScript monorepo with Turborepo, Express, PostgreSQL, Prisma, and Next.js. It coordinates cross-functional requests (bugs, customer escalations, payment holds, compliance reviews, and approvals) with server-enforced guarantees for concurrency, idempotency, and asynchronous reliability.

---

## Architecture & Monorepo Structure

```
├── apps/
│   ├── api/                 # Node.js Express REST API (OCC, RBAC, Idempotency, Outbox)
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
  - An asynchronous `OutboxWorker` claims `PENDING` events using row locking, dispatches them with exponential backoff retry logic ($2^{\text{attempts}} \times 1\text{s}$), and flags terminal failures as `FAILED` after 5 attempts.

---

## API Specification

All endpoints are mounted on both `/api/v1/...` (spec standard) and `/api/...` (backwards compatibility).

Authentication in development is handled via the `X-User-Id: <user-id>` header.

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
| `GET` | `/api/v1/users/me` | Current user profile, roles, team scopes | Header: `X-User-Id` |
| `GET` | `/api/v1/teams` | List operational teams user belongs to | Header: `X-User-Id` |
| `GET` | `/api/v1/teams/:id/members` | List members and roles for a team | Header: `X-User-Id` |

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
- pnpm

### Environment Configuration
Configure `apps/api/.env`:
```env
NODE_ENV="development"
PORT=3000
DATABASE_URL="postgresql://user:password@localhost:5432/dashboard"
TEST_USER_ID="cmvbva00d0000d9tktpexpo4x"
TEST_TEAM_ID="cmvbva03c0001d9tkuixolcur"
```

### Database Setup & Seeding
```sh
# Generate Prisma Client & apply schema
pnpm --filter @repo/db db:push

# Seed development user and team
npx tsx apps/api/src/scripts/seed-dev.ts
```

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
```

---

## Example Usage

### 1. List Work Items
```sh
curl http://localhost:3000/api/v1/work-items \
  -H "X-User-Id: cmvbva00d0000d9tktpexpo4x"
```

### 2. Create a Work Item (Idempotent)
```sh
curl -X POST http://localhost:3000/api/v1/work-items \
  -H "Content-Type: application/json" \
  -H "X-User-Id: cmvbva00d0000d9tktpexpo4x" \
  -H "Idempotency-Key: 11111111-2222-3333-4444-555555555555" \
  -d '{
    "title": "Payment gateway timeout on checkout",
    "description": "Stripe webhook 504 gateway timeout under load",
    "category": "PAYMENT",
    "priority": "HIGH",
    "teamId": "cmvbva03c0001d9tkuixolcur"
  }'
```

### 3. Update with Optimistic Concurrency Control (OCC)
```sh
# Update using If-Match header matching current version
curl -X PATCH http://localhost:3000/api/v1/work-items/<ITEM_ID> \
  -H "Content-Type: application/json" \
  -H "X-User-Id: cmvbva00d0000d9tktpexpo4x" \
  -H "If-Match: \"1\"" \
  -d '{
    "priority": "URGENT"
  }'

# If someone else already updated to version 2, the server returns 409 Conflict:
# {"error":"Work item changed; refresh before retrying","current":{"id":"...","version":2,...}}
```

### 4. Transition State
```sh
curl -X POST http://localhost:3000/api/v1/work-items/<ITEM_ID>/transition \
  -H "Content-Type: application/json" \
  -H "X-User-Id: cmvbva00d0000d9tktpexpo4x" \
  -d '{
    "version": 2,
    "target_status": "IN_PROGRESS"
  }'
```

### 5. Add a Comment (Audit Timeline)
```sh
curl -X POST http://localhost:3000/api/v1/work-items/<ITEM_ID>/comments \
  -H "Content-Type: application/json" \
  -H "X-User-Id: cmvbva00d0000d9tktpexpo4x" \
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
