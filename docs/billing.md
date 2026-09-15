# Billing contract

`packages/billing` is a provider-neutral billing boundary for organization
subscriptions. It owns customer and subscription mappings, verified webhook
state, bounded plan entitlements, and transactional usage enforcement. It has
no identity-provider, web-framework, or payment-SDK dependency. The Stripe
adapter is an explicit infrastructure seam; the local adapter is test-only
and never creates a remote customer, product, or charge.

## Configuration boundary

The catalog contains finite provisional defaults so local tests can exercise
enforcement. They are fixtures for engineering work and do not establish
public pricing or launch entitlements. A deployment must supply a distinct
provider recurring Price identifier for each paid plan it enables. The
catalog rejects duplicate plan IDs and duplicate Price IDs. Price IDs are
server configuration; webhook metadata, query parameters, and checkout URLs
cannot select an entitlement.

`PlanCatalog.publicMetadata()` is the browser-safe projection for product
surfaces. It carries the protocol version, public plan identity and copy,
finite limits, and boolean price/checkout readiness without exposing a Price
ID or provider credential. The separate marketing app derives its preview
cards from this projection rather than maintaining a second plan list. A
marketing build can receive a custom catalog through the bounded
`PUBLIC_PLAN_METADATA_JSON` public-only input; malformed or server-only fields
fail the build. Without that input, the page intentionally labels the
checked-in defaults and asks the operator to rebuild when the application uses
custom plan metadata. The authenticated billing console and runtime catalog
remain authoritative for live entitlements and checkout.

Until a provider and at least one paid Price ID are configured, hosted
checkout, customer-portal sessions, and webhook verification remain
unavailable. An explicitly enabled deployment can still enforce finite limits
from verified subscription state while provider setup is deferred; the
`BillingStatus.providerReady` and `usageEnforcement` fields keep those two
boundaries visible. Missing Stripe credentials do not activate a local paid
mode. This package makes no external Stripe calls during tests and does not
contain production account credentials.

The free plan still has finite Eve limits, and
`createBillingEveCostReservation` requires the billing service's enabled
admission status before reserving them. A no-Stripe launch demo can use the
explicit providerless metered evaluation profile by setting
`PSKILLS_BILLING_ENABLED=true` and
`PSKILLS_BILLING_METERED_EVALUATION=true` with a durable PostgreSQL billing
repository. This mode is valid in hosted production when PostgreSQL is
explicitly configured; the service reports `provider: null`, keeps checkout,
portal, invoice-provider reads, and webhook routes unavailable, and still
enforces the free-plan limits. Production profiles without that durable
boundary refuse the mode; flipping the status gate would permit unmetered Eve
work.

## Company-admin console

The bounded route factory is `createBillingRoutes()` in
`apps/web/server/routes/billing.ts`. It exposes the company snapshot at
`GET /v1/billing`, the most recent 100 invoice records at
`GET /v1/billing/invoices`, and POST checkout, portal, and raw-body webhook
paths. The route factory authenticates the request, requires an `owner` or
`admin` role, derives the organization from the server principal, and never
accepts a browser organization, customer, or subscription selector. Hosted
actions are closed unless the service reports a provider, a configured
recurring Price ID, trusted return URLs, and verified webhook signing.

Seat-hold inspection and recovery are platform operations, not company billing
actions. `createBillingSeatRecoveryRoutes()` is a separate route factory whose
operator authenticator returns the target organization from a server-owned
credential; an owner/admin session or company API token cannot reach it. The
request includes the subject kind/id and an operator `writer-terminated` proof,
while `PostgresIdentityBillingAdmission.recoverFailedSeat()` derives the opaque
operation key and rejects a mismatch. It acquires the same PostgreSQL advisory
lock that wraps every Better Auth organization mutation, rechecks the exact
member or invitation row, and releases the hold only when no row exists. A
committed row therefore wins over recovery even when its after hook was lost;
a failed request can be retried with the same proof after its writer lock has
ended. There is no automatic age-based expiry and no tenant self-attestation.
The Node mount is enabled only when `PSKILLS_BILLING_RECOVERY_TOKEN` or its
SHA-256 `PSKILLS_BILLING_RECOVERY_TOKEN_HASH` is supplied together with
`PSKILLS_BILLING_RECOVERY_ORGANIZATION_ID`. It accepts exactly one of the two
credential forms, forces the `billing:seat-recovery` capability in code, and
uses a bearer-only worker authenticator. This credential must be provisioned
separately from `PSKILLS_WORKER_TOKEN`; ordinary scanner, Eve, and queue worker
credentials are rejected even when they carry the worker role.

The Node runtime now constructs this service from the environment, using the
separate PostgreSQL billing repository whenever a PostgreSQL pool is present.
It mounts the tenant routes before registry dispatch and handles the webhook at
the top-level raw-body boundary, so webhook delivery does not need browser
authentication. An explicit non-production local-test profile may use the
memory repository and local adapter; a live provider request without a durable
PostgreSQL boundary is disabled. The edge runtime exposes a disabled billing
service because it has no server-only provider adapter or durable billing
repository.

`apps/web/src/views/BillingView.tsx` renders the current plan and status,
enforced usage and limits, invoice history, and checkout/subscription controls.
Disabled, unconfigured, and local test-mode states are explicit in the view;
test mode is labeled as fixtures or test transactions and does not imply a
live charge. The view sends only a selected server-known plan ID for checkout
and an empty body for portal creation.

Invoice history is a server-side read-model callback supplied to
`createBillingRoutes()`. The Node runtime delegates to the server-only Stripe
invoice adapter after `BillingService` has checked the durable organization to
customer mapping. The route validates provider, tenant, customer, amounts,
timestamps, statuses, and document URLs before projecting rows to the browser
without provider or customer IDs. The read model is bounded to the most recent
100 provider records. A provider response containing a different
customer is rejected before the organization is attached to the row. If the
runtime has no verified provider invoice adapter, the console reports invoice
history as unavailable. This package does not persist provider invoice rows.

The company-admin navigation still selects `BillingView` through the host UI;
the runtime route and server-only invoice adapter are mounted in the Node
composition described above.

## PostgreSQL state

`PostgresBillingRepository` owns a separate migration generated by
`billingPostgresSchemaSql()`. It creates tables for organization customers,
subscriptions, webhook event IDs, monthly/current usage, and idempotent usage
operations. The migration does not alter identity or registry tables.

Each mutation runs in a database transaction. The usage row is created if
needed and locked with `FOR UPDATE`; the bounded organization billing state
is read, synchronously updated, validated, and committed or rolled back as one
unit. Metered transactions additionally lock only the exact requested usage
operation keys, so a replay of an aged key remains atomic without scanning an
unbounded operation ledger. Customer and subscription provider identifiers have
database-wide unique constraints, and webhook `(provider, event_id)` claims are unique. A
losing concurrent event claim aborts before any entitlement mutation and is
reported as a duplicate after the durable row is re-read.

The same PostgreSQL usage-operation table is the recovery source for Eve
reservations. The web adapter keeps only a bounded in-process cache for
latency; after a restart or cache eviction it resolves the reservation by its
durable operation key, validates the organization and positive Eve estimate,
and then applies an idempotent correction. Missing, ambiguous, or malformed
records fail closed and require reconciliation rather than reopening Eve work.

`packages/billing/test/postgres.integration.test.ts` is skipped unless
`PSKILLS_BILLING_POSTGRES_URL` is supplied. With a disposable PostgreSQL
instance it runs two independent repository/service instances concurrently to
prove one usage reservation wins a finite limit, retries and released-key
re-admission are idempotent, seat admission survives stale identity snapshots
and lifecycle expiry/removal/missed hooks, recovery waits behind an active
Better Auth mutation and rejects a committed row while releasing a failed
writer's absent row, one signed webhook delivery is durably claimed, and an
older out-of-order event cannot replace newer subscription state. The normal
unit suite uses the provider-neutral fake repository and is not presented as
this database proof.

## Webhooks

`createBillingWebhookHandler()` consumes a bounded raw request body once. It
rejects oversized or malformed UTF-8 input before parsing and verifies the
Stripe-style `t=...,v1=...` header over the exact body with
`crypto.subtle.verify`. The timestamp replay window is checked before event
processing. The handler accepts only `POST` and can enforce an exact path and
deployment-specific body limit.

Only verified provider events can create or update mappings. Subscription
events use the server Price-ID catalog and record unknown prices as
unconfigured. Status changes are applied by event creation time, so retries
are idempotent and older deliveries cannot replace newer subscription state;
the provider event ID deterministically breaks same-second ties.
Cancellation and payment failure events can close access; refund events are
recorded for reconciliation but do not by themselves cancel a subscription,
because a charge may be partial while the provider subscription remains
active. Customer and subscription IDs cannot move between organizations.
Unsupported, stale, and unbound events do not grant paid access.

## Usage enforcement

`reserveUsage()` and `setSeatCount()` enforce finite seats, retained bytes,
monthly scans, and monthly Eve cents limits against the current entitlement.
Operation keys make retries idempotent and reject a reused key with a
different delta. `reconcileUsage()` supports measured post-operation
corrections; omitted metrics retain their reservation, while an explicit zero
releases it. A fully released reservation can be admitted again with the same
operation key after the ledger reopens its lifecycle. UTC month rollover resets
scans and Eve spend while retaining current seats and storage.

Storage recovery has a separate `restoreUsage()` compensation seam. It accepts
only the exact positive `storageBytes` quantity from a released, storage-only
reservation and the caller's source generation. The inverse bypasses the
current quota check so a concurrent refill cannot strand retained accounting,
then advances the reservation to the next generation and records the source
key, source generation, destination generation, and delta in a durable
compensation operation. It returns the new generation as well as the source
generation; a later cleanup must reconcile with that new generation. A retry
of the same compensation key with the original source generation returns the
same result without changing usage, including after restart or operation-window
eviction. Old zero callbacks remain fenced and future admissions still observe
the over-cap usage.

The core registry reserves scan work before native publish, rescan, source
import, and OpenClaw queue admission. It reserves retained bytes before a
publish blob write and before import completion stores an acquired bundle.
Authoring reserves draft bytes before create/upload/revision writes and scan
units before draft publication. The worker repeats the scan reservation with
the same job key before source acquisition, download, materialization, or
scanner execution, so queue admission and retries charge one operation. The
worker reports whether a scanner adapter was entered, but never performs a
client-side release. The core records a terminal `unused` or `executed` intent
atomically with job completion; a bounded server maintenance pass may apply
an explicit-zero reconciliation only for a definite pre-scanner failure,
fenced to that job and the exact billing reservation generation. A newer queued/running job reusing the
canonical key keeps its charge. After a provider or blob write may have
succeeded, the charged reservation remains held for durable object
reconciliation. Release corrections are fenced by a durable per-generation
token and use a token-specific billing operation key. The billing ledger also
assigns each usage reservation a finite numeric `reservationGeneration`,
starting at `1` and increasing when a released operation key is admitted again.
New reconciliation callers pass the generation returned by admission; a stale
generation, or an omitted generation after reopening, returns a no-write `409`.
Rows written before generation fencing are interpreted as generation `1`, so
the four-argument reconciliation path remains compatible for that first
lifecycle. If the correction result is uncertain, the owner remains
`releasing` and queue admission stays blocked until the same token is replayed
successfully; a stale completion can supply its expected job id so it cannot
settle a newer owner generation. Better Auth organization hooks
sync active members plus unexpired pending invitations and reserve a new seat
before direct member or invitation writes. Seat holds are stored beside the
locked usage row, and reconciliation preserves other requests' in-flight
holds. Successful writes settle their own key; cancellations, removals, and
re-invites can reuse a settled lifecycle key. Active identity holds do not
expire automatically because the billing transaction cannot prove that a
Better Auth write has stopped; they remain fail-closed until an explicit
success/failure lifecycle hook or platform reconciliation resolves them. When
a Better Auth write aborts before its after-hook, the platform recovery route
must acquire the shared organization mutation lock, verify the exact generated
subject row is absent, and then release the hold with a writer-termination
proof. The identity source currently calls `releaseSeat()` only from
`afterRemoveMember`, `afterRejectInvitation`, and `afterCancelInvitation`;
Better Auth has no failed-write after hook for `createMember` or
`createInvitation`, so those failures use the platform recovery path.
These adapters are omitted when billing explicitly reports disabled, preserving
the legacy deployment path.

The service exposes `getEntitlement()`, `usageSnapshot()`, `checkUsage()`,
`enforceUsage()`, and `recordUsage()` aliases for identity, storage, scanner,
and Eve runtime adapters. Eve invocation cost reservation remains a separate
runtime-owned seam. A read snapshot may contain only the most recent configured
operation window, but every transactional PostgreSQL reload reads the durable
operation primary key and exact-key lookup reopens an aged released key without
charging it twice. Focused route, authoring, and worker tests prove that an
over-limit request performs no blob/source/scanner/member write; the
disposable PostgreSQL suite separately proves concurrent durable reservations,
aged-key replay, last-seat admission with lifecycle reuse and explicit abort
release, webhook deduplication, and event ordering. These tests do not prove a
configured Stripe account, production charge, or launch price approval.
