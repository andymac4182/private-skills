# Private registry refinement

The owner chose to leave skills.sh disconnected on 2026-09-10 while continuing
private-registry deployment and end-to-end refinement. This does not authorize
OIDC forwarding or imply that live external catalog coverage was verified.

## Current pass

- Distinguish intentional disconnection (`DIRECTORY_NOT_CONFIGURED`, not
  retryable) from a temporary upstream outage. Keep private workflows and
  public links usable without an external connection.
- Preserve scanner failure reasons when Rust directory/proxy polling sees a
  completed operation containing an error, instead of hiding the reason behind
  a later resolution failure.
- Verify the deployed service with a fresh required scan, immutable digest
  readback, existing private-pack installation, frozen reinstall, semantic
  search, and analytics receipts. Local checks alone do not prove these flows.

## Next reliability work

1. Add bounded `publish --wait` or operation waiting so callers can explicitly
   wait for admission and get a nonzero result for scanner or policy failure.
   The current successful publish command confirms submission, not approval.
2. Implement and test actor/body-bound mutation idempotency. The design's
   `Idempotency-Key` requirement is not yet implemented by the publish path or
   Rust client. Cover concurrent retries and safe reconciliation of uploaded
   objects when a mutation fails; do not delete an object referenced by a
   committed release after an ambiguous persistence error.
3. Complete an isolated hosted Neon/object-storage restore rehearsal. The local
   [restore test](restore-rehearsal.md) proves application fences and digest
   preservation but not provider backup recovery or restored scanner evidence.
