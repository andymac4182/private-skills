# Tenant-bound Eve integration

`packages/eve-tenant/src/index.ts` is the shared credential boundary for the
registry host and the three Eve services. It does not replace the existing
static credentials used by the legacy default-company deployment. A tenant
request must first be resolved to a verified `organizationId`; the host then
creates a provider permanently bound to that id and to one Eve service.

The host-facing contract is:

```ts
const service = bindEveTenantService(provider, {
  tenantId: context.organizationId,
  service: 'skill-builder',
});

const headers = await service.headers(baseHeaders, {
  registrySessionId,
  draftId,
  draftRevision,
  draftDigest,
});
```

`EveTenantCredentialProvider.resolve` receives the same fixed `tenantId` and
service on every call:

```ts
resolve({
  tenantId,
  service,
  binding?,
  signal?,
}): Promise<{
  token?: string;
  authorization?: string;
  tenantId: string;
  service: EveTenantService;
  serviceIdentity: string;
  expiresAt: number;
}>;
```

The default implementation, `createEveTenantCredentialProvider`, signs a
short-lived HS256 bearer with `iss`, `aud`, `tenantId`, `serviceIdentity`,
`iat`, `exp`, and `jti`. The optional binding can carry a session, upload job,
review run, registry session, or the complete draft tuple. It intentionally
does not carry lease tokens, source bytes, or artifact contents. A token is
accepted only when the receiver verifies the signature, exact issuer, service
audience, service identity, expiry, selected tenant, and any route-owned
binding. The `X-PSkills-*` headers are routing metadata and are never trusted
without that bearer verification.

The host must fail closed when `PSKILLS_EVE_TENANT_DELEGATION_SECRET` is not
configured for a tenant deployment. It must not select a default-company
`PSKILLS_*_EVE_API_TOKEN`, registry token, or reviewer token as a fallback for
another company. A deployment may retain the existing static path for the
legacy default company. If a configured tenant route receives a token-shaped
value, `looksLikeEveTenantDelegation` can be used to refuse a legacy fallback
instead of masking a delegation failure.

## Integration checklist

### Upload review

1. In the host that implements `packages/upload-reviews/src/trigger.ts`,
   resolve `organizationId` from the authenticated tenant context and bind an
   `upload-reviewer` service provider. Use the `jobId` binding when creating
   the Eve session and include the bound authorization in the session request.
   Do not read a tenant from prompt text or an untrusted request body.
2. Pass the same tenant-bound authorization to the internal prepare,
   complete, and fail callbacks in `apps/upload-reviewer/agent/lib/api.ts`.
   The callback handler must verify the delegation and derive the organization
   from the verified claim before calling `claimForEveSession`; it must still
   check the lease and job/session state. `prepare_upload_review` must use the
   active verified caller and its job binding, never `auth.initiator` as a
   fallback for an internal delivery.
3. Keep upload-reviewer admission rules unchanged. A delegation grants route
   identity only; it does not authorize scanning, publication, or artifact
   mutation.

### Skill builder

1. In `packages/core/src/builder.ts`, bind a `skill-builder` provider for the
   request's verified organization. Use a binding containing the registry
   session and the complete draft tuple on the custom builder start request.
   Use the same bound provider for the Eve stream, prompt, and cancel calls.
2. In `apps/skill-builder/agent/channels/builder.ts`, authenticate the bearer
   with `createEveTenantAuth` (or `verifyEveTenantDelegation` plus
   `sessionAuthFromEveTenantPrincipal`) and require the active caller with
   `requireEveTenantCaller`. The channel must pass the verified tenant and
   draft binding to its registry calls; it must not accept those values from
   model-visible input.
3. In `apps/skill-builder/agent/tools/draft.ts`, make the registry client
   tenant-bound and assert that the loaded draft context, registry session,
   revision, and digest match the verified delegation. Keep proposal
   idempotency and ownership checks. Dynamic tools remain limited to the
   builder channel and do not gain apply, publish, scan, or execute access.
4. Preserve the existing configurable AI Gateway/provider and model settings
   in `apps/skill-builder/agent/lib/config.ts`. Tenant credential selection
   must not replace the configured provider or turn a model setting into a
   tenant-controlled input.

### Consolidation review

1. In the host that implements `packages/intelligence/src/reviewer-client.ts`,
   bind a `consolidation-reviewer` provider per verified organization. Include
   the review run/session binding when creating the Eve session and when
   calling the prepare, complete, and failure callbacks.
2. In `apps/reviewer/agent/channels/eve.ts` and
   `apps/reviewer/agent/lib/api.ts`, verify the delegation and derive the
   tenant from the active caller. The reviewer handler must use that tenant
   when reading candidate state and leases; it must never reuse the fixed
   default `organizationId` for a different tenant.
3. The host's `GET /internal/reviewer/dispatch` route enumerates the
   server-owned Better Auth organizations and starts one tenant-scoped run at
   a time. Its durable cursor advances bounded pages, and the host cron calls
   it every 15 minutes throughout the UTC day, so a large organization list is
   drained within the same daily window instead of starving IDs after the
   first page. The route requires the deployment `CRON_SECRET`; it never
   accepts a tenant selector from the request. Do not share a candidate
   snapshot or review session across tenants.
   Before reserving cost or calling Eve, the host durably changes the tenant's
   dispatch record from `claimed` to `starting`. A `starting` or `uncertain`
   record is fenced even after its lease expires and requires reconciliation;
   it is never automatically retried after a host crash because the provider
   may already have accepted the session. A definite provider rejection may
   release its claim for the next scheduled attempt.
4. Preserve the existing proposal-only boundary. Consolidation review cannot
   publish, merge, install, or bypass scanner admission.

## Billing seam

The credential helper intentionally has no billing dependency. The host may
wrap its service invocation with a reservation adapter before session creation
and settle or release it after the terminal callback:

```ts
interface EveTenantCostReservation {
  reserve(input: {
    tenantId: string;
    service: EveTenantService;
    operation: string;
    idempotencyKey: string;
  }): Promise<{ reservationId: string }>;
  settle(input: { reservationId: string; actualCostCents?: number }): Promise<void>;
  release(input: { reservationId: string }): Promise<void>;
  reconcile?(input: {
    reservationId: string;
    actualCostCents: number;
    operationKey?: string;
  }): Promise<void>;
}
```

The reservation id is host bookkeeping. It must not be placed in a prompt,
model-visible tool result, or bearer claims unless a later contract explicitly
requires that. Billing failures must prevent a new Eve session, while normal
lease and scanner admission rules remain authoritative for completion.

The Node host uses `createBillingEveCostReservation` to reserve a bounded
`eveCostCents` estimate before opening a review session. A definite provider
rejection releases that reservation with an explicit zero-cost reconciliation;
an uncertain transport or settlement failure retains the deterministic
reservation operation for retry. A later measured provider cost can call the
adapter's optional `reconcile` method. Seats, retained storage, and scanner
usage remain separate billing metrics owned by their respective admission
paths.

## Verification boundary

The package tests cover signing, exact tenant/service binding, broker-output
validation, sanitized Eve auth attributes, active-caller-only behavior, and
fail-closed environment configuration. Runtime wiring is still required in
the paths above. Until those hosts and internal handlers are wired and an
authenticated tenant-isolation test exercises each flow, this package alone
does not establish end-to-end tenant isolation.
