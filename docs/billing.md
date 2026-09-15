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
`GET /v1/billing/invoices`, active Better Auth seat holds at
`GET /v1/billing/seat-reservations`, and POST
checkout, portal, and raw-body webhook paths. The route factory authenticates
the request, requires an `owner` or `admin` role, derives the organization from
the server principal, and never accepts a browser organization, customer, or
subscription selector. Hosted actions are closed unless the service reports a
provider, a configured recurring Price ID, trusted return URLs, and verified
webhook signing.

When a Better Auth member or invitation write fails after `beforeAddMember` or
`beforeCreateInvitation` reserves a seat, the host can first inspect the exact
opaque hold key through `GET /v1/billing/seat-reservations`, then call
`POST /v1/billing/seat-recovery` with that key and a proof object whose kind is
`known-failure` or `writer-terminated` plus a bounded operator incident or
request reference. The route is owner/admin-only and takes the tenant only from
the authenticated principal. Billing records the proof with the settled hold,
retries with the same proof idempotently, rejects a different proof, and
rejects a hold already committed or released by an identity lifecycle hook.
The operator must establish that the identity writer returned a known failure
or was terminated and verify that no member/invitation row was committed before
calling recovery; an old hold is never expired automatically.

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
and lifecycle expiry/removal/missed hooks, one signed webhook delivery is
durably claimed, and an older out-of-order event cannot replace newer
subscription state. The normal unit suite uses the provider-neutral fake
repository and is not presented as this database proof.

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

The core registry reserves scan work before native publish, rescan, source
import, and OpenClaw queue admission. It reserves retained bytes before a
publish blob write and before import completion stores an acquired bundle.
Authoring reserves draft bytes before create/upload/revision writes and scan
units before draft publication. The worker repeats the scan reservation with
the same job key before source acquisition, download, materialization, or
scanner execution, so queue admission and retries charge one operation. A
definite no-write or pre-scanner failure may release its reservation with an
explicit-zero reconciliation; after a provider or blob write may have
succeeded, the charged reservation remains held for durable object
reconciliation. Better Auth organization hooks
sync active members plus unexpired pending invitations and reserve a new seat
before direct member or invitation writes. Seat holds are stored beside the
locked usage row, and reconciliation preserves other requests' in-flight
holds. Successful writes settle their own key; cancellations, removals, and
re-invites can reuse a settled lifecycle key. Active identity holds do not
expire automatically because the billing transaction cannot prove that a
Better Auth write has stopped; they remain fail-closed until an explicit
success/failure lifecycle hook or operator reconciliation resolves them. When
a Better Auth write aborts before its after-hook, the host must use the
owner/admin `seat-recovery` path with the exact generated subject key and
explicit failure proof; that durable abort path is safe to retry and is covered
by the disposable PostgreSQL lifecycle proof. The identity source currently
calls `releaseSeat()` only from `afterRemoveMember`, `afterRejectInvitation`,
and `afterCancelInvitation`; Better Auth has no failed-write after hook for
`createMember` or `createInvitation`, so those failures use the recovery path.
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
