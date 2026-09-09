# Install analytics

Install analytics counts client-confirmed local install operations. It is not a
download counter, a page-view counter, or an inference from transfer grants.
The registry records a receipt only after a client has completed its local
install transaction or confirmed that the requested version is already
current. A missing receipt therefore reduces the reported count without
changing whether the install itself succeeded.

## Receipt lifecycle

An install authorization response includes a short-lived receipt ticket:

```json
{
  "authorization": { "id": "authz_..." },
  "receipt": {
    "id": "receipt_ticket_...",
    "authorizationId": "authz_...",
    "expiresAt": "2026-09-10T00:00:00.000Z"
  }
}
```

The ticket is bound to the authenticated organization, subject, authorization,
and immutable resolution. It expires after 24 hours. The ticket is telemetry
metadata; it does not grant an install or replace the authorization and
artifact-transfer checks.

After the local transaction commits, a client posts the result to
`POST /v1/install-receipts`:

```json
{
  "authorizationId": "authz_...",
  "changed": true,
  "agent": "codex",
  "platform": "macos",
  "clientVersion": "0.1.3"
}
```

`agent` is `codex`, `claude`, or `universal`; `platform` is `windows`,
`macos`, `linux`, or `other`. The route requires a reader-capable principal
with the `install:receipt` or `analytics:write` scope and applies the same
origin/session checks as other browser mutations.

The authorization id is the idempotency key. Replaying the same receipt for
the same subject returns the existing receipt; changing its metadata returns
`409 RECEIPT_CONFLICT`. An expired, missing, cross-organization, or
cross-subject ticket is rejected without disclosing another subject's
receipt. The server stores the resolution snapshot and digest with the receipt
so later catalog changes do not rewrite historical analytics.

The Rust `pskills` client submits a receipt only after its local transaction
commits. It retries transport failures and HTTP `408`, `425`, `429`, and
`5xx` responses once after a bounded 100 ms delay. A second failure is logged
as `install analytics receipt unavailable`; it does not roll back or turn a
successful local install into a failed install. Clients that do not implement
receipts remain install-compatible, but their activity is absent from these
aggregates.

## Admin report

`GET /v1/analytics?days=30` is restricted to an `admin` or `owner` principal
and the `analytics:read` or `registry:admin` scope. `days` defaults to 30 and
accepts 1 through 90. Dates and daily buckets are UTC. The response contains
the aggregate totals, one bucket for every day in the requested range, and up
to 20 changed skill members ranked by confirmed installs:

```json
{
  "days": 30,
  "from": "2026-08-11T00:00:00.000Z",
  "to": "2026-09-09T12:00:00.000Z",
  "totals": {
    "installOperations": 12,
    "skillInstalls": 8,
    "packInstalls": 2,
    "upToDateChecks": 2
  },
  "daily": [{
    "date": "2026-09-09",
    "installOperations": 1,
    "skillInstalls": 1,
    "packInstalls": 0,
    "upToDateChecks": 0
  }],
  "topSkills": [{
    "resourceId": "skill_...",
    "name": "@team/review",
    "version": "1.0.0",
    "installs": 3
  }]
}
```

Namespace visibility is applied while building the report. The analytics page
in the web app uses this endpoint and labels the result as client-confirmed
activity. It does not expose artifact bytes, source text, transfer URLs, or
credentials. Receipts are retained for up to 90 days and bounded at 100,000
records; expired receipts are pruned during receipt writes. Receipt tickets
have the same 100,000-record safety bound.

## Operations

Analytics state is part of the selected registry state repository. Keep the
receipt records in the same metadata backup and restore point as authorizations
and artifact identities. A state restore can change the report window; it must
not be repaired by editing receipt records directly. Check the API response
and the audit record when investigating a conflicting or missing receipt.

For the related semantic index and its rebuild procedure, see
[`docs/semantic-search.md`](semantic-search.md). For the separate Eve review
service, see [`docs/eve-reviewer.md`](eve-reviewer.md); Eve proposals are
human-reviewed and never become analytics receipts.
