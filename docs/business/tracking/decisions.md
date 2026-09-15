# Decisions and constraints

Confirmed by the user:

- Target engineering teams; launch a business, not only a technical demo.
- Separate marketing site and product app, independently deployable in one monorepo.
- Each company gets a complete isolated portal, administration, billing console and company SSO.
- TanStack and Nitro, not Next.js; Rust CLI for Windows, macOS and Linux.
- Hosting portable across Nitro targets; Files SDK for blob storage; Neon accepted.
- Coordinate multiple Luna Max implementation agents and keep working increments merged into origin/main.
- Native GitHub CI may be bypassed due to billing restrictions; this does not prove cross-platform compatibility.
- Stripe account setup is last. No legal entity/support email/brand selected yet; do not invent them.
- Required scanning stays enabled; company access and legacy registry data must be preserved.
- App navigation currently feels cluttered: review and improve actual app and marketing interfaces.
- Maintain durable trackers and scratchpads; capture later work as it is discovered.

Proposals pending confirmation: final brand and commercial pricing. Domain availability and legal clearance are not established.
