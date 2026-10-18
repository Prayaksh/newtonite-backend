# Limitations, Trade-offs, and Future Scope

This document records the current boundaries of the Operational Work Management
System, why those boundaries exist, their practical impact, and ways the system
could be extended. It complements [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md),
which explains the architecture choices and their trade-offs in more detail.

This is an implementation snapshot as of 2026-10-18. It describes the repository
as it currently stands, not a claim that the system is unsuitable for every
deployment. Suitability depends on the organization’s security, availability,
scale, and compliance requirements.

## Current baseline

The system already provides a functional foundation: team-scoped work items,
fixed status and priority values, database-backed sessions and team roles,
optimistic concurrency checks, idempotent create/comment operations, an
activity timeline, persisted notification read receipts, dashboard summaries,
SSE updates, and an outbox/Redis queue pipeline. The API and web application
also have unit, integration, and browser test suites.

The limitations below describe where that foundation is intentionally narrow
or where infrastructure exists but the end-user capability is not complete.

## Known limitations and trade-offs

| Area | Current limitation | Why it is limited this way | Impact | Possible future scope |
| --- | --- | --- | --- | --- |
| Identity and account security | Sign-in uses local email/password credentials and database-backed sessions. There is no enterprise SSO, MFA, self-service password recovery, or identity-provider lifecycle integration. | A local session flow is simpler to run and demonstrate than a production identity platform. | Organizations that require centralized identity, stronger authentication policy, or automated account lifecycle management will need additional controls before rollout. | Integrate an OIDC/SAML identity provider; add MFA where needed, password recovery and rotation flows, session/device management, and documented security policy. |
| Authorization model | Access is team-scoped and based on a fixed set of team roles. Permissions are not a configurable policy system with custom roles or per-field rules. | A small, explicit role model is easier to reason about and enforce consistently in API queries and handlers. | Organizations with complex approval chains, delegated administration, or unusual data-segregation rules may not be able to express every policy. | Add centrally defined permission capabilities, configurable role-to-capability mappings, and policy tests; retain server-side enforcement and default-deny behavior. |
| Workflow customization | Statuses, priorities, categories, and valid transitions are defined in code. There is no workflow-builder UI, configurable state machine, or general work-item dependency model. | A fixed state machine limits accidental or invalid transitions and keeps a small initial implementation maintainable. | Different departments cannot independently configure lifecycle stages, required fields, or approval rules without engineering changes. | Add versioned workflow definitions, transition guards, required-field rules, and dependency relationships, with migration and audit behavior for existing items. |
| External notifications and integrations | The outbox and BullMQ pipeline are present, but the current queue processor publishes an internal event for SSE clients and marks the outbox event processed. It does not deliver email, Slack, or third-party webhooks. | The durable event pipeline is a foundation for integrations; connecting real providers also requires credentials, delivery policy, consent/configuration, and operational support. | Users who are offline or disconnected do not receive an external alert from this pipeline. “Processed” currently means the internal queue handler completed, not that an external recipient acknowledged delivery. | Implement provider-specific handlers; add per-team configuration, retry and dead-letter procedures, delivery receipts, secret management, and an administrative replay/inspection tool. |
| Real-time delivery | SSE provides live updates to connected clients, while activity records provide a persisted history. SSE itself is not a durable delivery channel for disconnected clients. | SSE is a lightweight way to update an operational dashboard without introducing a more complex bidirectional protocol. | A client that is offline or misses a connection may need to refresh or reload persisted data to catch up. | Add reconnection/backfill using event cursors, clear client resynchronization behavior, and load tests for long-lived connections across multiple API instances. |
| Collaboration and conflict handling | Version checks prevent silent stale writes, but they do not provide simultaneous editing or automatic field-level merge. Conflicts still require a user to review the latest record and choose how to proceed. | Optimistic concurrency is substantially simpler than maintaining collaborative document state and is appropriate for discrete work-item fields. | A user can lose time resolving conflicts manually; complex shared notes or documents are not supported as co-edited content. | Improve the conflict UI with per-field comparison and safe selective reapplication. Consider collaborative editing only for fields where real-time co-authoring is a demonstrated need. |
| Reporting and analytics | The dashboard provides operational counts and recent activity, with work-item listing and filters. It is not a configurable analytics or business-intelligence system; historical trends, custom reports, and data exports are not part of the current product surface. | The initial dashboard emphasizes current workload and actionability over a broad reporting subsystem. | Management cannot answer every historical, cross-team, or custom KPI question from the built-in dashboard alone. | Add date-bounded trend metrics and saved filters first; consider CSV export and a reporting API, with access checks and limits. Integrate a BI tool if reporting needs grow beyond operational dashboards. |
| Scale and resilience | PostgreSQL and Redis are runtime dependencies. The API process starts queue and polling workers as well as serving HTTP requests; no deployment topology or capacity target is defined here. | A compact local/development deployment keeps the system easy to start and avoids introducing orchestration before scale requirements are known. | Database/Redis availability affects core service startup and asynchronous processing. Larger deployments need deliberate worker sizing, connection management, and recovery procedures. | Separate API and worker deployment roles, define capacity and availability targets, add graceful dependency recovery, and validate behavior with load and failover tests before scaling out. |
| Operations and production readiness | The repository includes local setup, a basic health endpoint, and application logging, but does not define a complete production operations program such as service-level objectives, alerting, backups/restore drills, data-retention policy, or deployment runbooks. | These decisions depend on the actual hosting environment, data classification, and operational ownership, which are outside the current application implementation. | Operators may lack enough visibility or rehearsed recovery procedures to confidently manage production incidents and data loss. | Establish SLOs and alerting; add dependency-aware readiness checks and structured metrics; document deployment, rollback, backup/restore, retention, and incident-response procedures. |
| Verification coverage | Automated tests cover schema validation, API behavior including concurrency/idempotency, dashboard components, and browser flows. The checked-in suites do not establish performance limits, production security certification, or resilience under infrastructure failure. | Focused functional tests validate core product behavior without claiming production-scale or compliance assurance. | Passing the current tests is not evidence of a particular throughput, recovery time, or regulatory compliance level. | Add representative load/soak tests, security review and dependency scanning, failure-injection tests for database/Redis/queue outages, and CI gates tied to agreed targets. |

## Suggested order of future work

1. **Close the external-delivery gap:** define which notifications are required,
   implement and test at least one real provider, and make delivery state and
   failures visible to operators.
2. **Set production operating expectations:** document deployment, backups and
   restore, monitoring/alerting, retention, and recovery objectives for the
   chosen hosting environment.
3. **Confirm identity and authorization requirements:** select an identity
   provider and validate the fixed team-role model against actual organization
   policies before onboarding broader user groups.
4. **Improve user recovery and reporting:** add SSE resynchronization and
   conflict-resolution improvements, followed by the highest-value trend or
   export needs reported by users.
5. **Extend workflows only when justified:** gather real process requirements
   before investing in configurable workflows, custom roles, or collaborative
   editing; each adds product, migration, and testing complexity.

These priorities are a starting point, not a commitment or a substitute for
requirements gathering. In particular, authentication, compliance, and
availability work should be selected against the deployment’s risk profile.
