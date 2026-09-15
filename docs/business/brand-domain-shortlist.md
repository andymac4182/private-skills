# Brand and domain shortlist

**Checked:** 15 September 2026 at 13:10:22 UTC

**Status:** exploratory naming work. No domain was purchased or registered. No registrar account was used, no contact was made, and no trademark clearance was performed.

## Naming criteria

The name should be easy to say and spell, work for a developer-tool company, leave room for skills, releases, and policy, and avoid sounding like a generic “private skills” feature. A short name is useful only if the target markets, package names, social handles, and trademarks can be cleared together.

The six names at the top of the table are the candidates to take to a proper legal and registrar screen. **Packrail** and **Brintra** are retained as comparison records because they were considered during the naming pass; their collision signals make them hold or reject candidates.

## Candidate shortlist

| Candidate | Intended association | Exploratory collision signal | Next action |
| --- | --- | --- | --- |
| **ReleaseLoom** | Weaves source, review, and immutable releases into one repeatable path. | No collision finding recorded in this limited pass; this is not clearance. | Advance to legal screen and a live registrar check. |
| **Vouchpack** | A pack that carries a visible approval or provenance signal. | No collision finding recorded in this limited pass; this is not clearance. | Advance to legal screen; test whether “vouch” is clear in target markets. |
| **DraftCove** | A protected place for drafts before release. | No collision finding recorded in this limited pass; this is not clearance. | Keep as a backup; verify that “draft” does not confuse the release promise. |
| **PolicyLoom** | Turns policy and evidence into a repeatable release fabric. | No collision finding recorded in this limited pass; this is not clearance. | Keep as a product-oriented backup; assess whether it sounds too compliance-led. |
| **SourceLoom** | Connects source identity to a team release. | No collision finding recorded in this limited pass; this is not clearance. | Keep as a backup; screen for source-control naming conflicts. |
| **SkillCove** | A private, navigable home for team skills. | No collision finding recorded in this limited pass; this is not clearance. | Keep as a backup; screen for existing learning and skills products. |
| **Packrail** | A clear path from source pack to install. | Existing industrial/conveyor usage was found in an [industrial product catalogue](https://catalog.minetti.com/Portals/0/pdf/Rulmeca/Rulmeca_Catalogo_UNIT.pdf); both `packrail.com` and `packrail.dev` are registered in the RDAP check. | Hold or reject pending legal advice. |
| **Brintra** | Short invented name with a bright, infrastructure-tool sound. | An existing import/export business was found in this [business listing](https://www.algomtl.com/brintra); `brintra.com` is registered in the RDAP check. | Hold or reject pending legal advice. |

“No collision finding recorded” means the limited exploratory search did not add a recorded conflict. It does not mean the name is available, registrable, distinctive, or safe to use.

## RDAP method

The check used the IANA [RDAP DNS bootstrap registry](https://data.iana.org/rdap/dns.json), fetched at the timestamp above, to select the authoritative RDAP service for each TLD:

- `.com`: [Verisign RDAP](https://rdap.verisign.com/com/v1/)
- `.dev`: [Google Registry RDAP](https://pubapi.registry.google/rdap/)
- `.ai`: [Identity Digital RDAP](https://rdap.identitydigital.services/rdap/)

Each domain was requested with `GET /domain/<domain>` and an RDAP JSON accept header. Per the [IANA RDAP requirements](https://www.iana.org/help/rdap-requirements), a `200` response containing a domain object means the registration service returned a domain record, while a valid `404` means that the name was not found in that RDAP service at the time of the check. ICANN describes RDAP as the current standardized source for registration data in its [RDAP overview](https://www.icann.org/rdap/).

RDAP status is not a purchase quote. A `404` can still be affected by premium pricing, registry or registrar reservation, launch rules, local requirements, or a name that is not offered by a registrar. Trademark, company-name, package-name, social-handle, and common-law conflicts require separate research. No DNS no-answer result was treated as availability.

## Results

The result words have these precise meanings:

- **Registered:** RDAP returned `200` with a domain object.
- **Unregistered at check:** RDAP returned a valid JSON `404` / `errorCode: 404`. This is not a statement that the name is purchasable.
- **Unverified:** the service returned HTTP `404` with an empty body, so the result was not treated as a valid RDAP not-found response.

No domain in this table is **verified available**.

| Candidate | `.com` | `.dev` | `.ai` |
| --- | --- | --- | --- |
| ReleaseLoom | [Unverified: HTTP 404, empty body](https://rdap.verisign.com/com/v1/domain/releaseloom.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/releaseloom.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/releaseloom.ai) |
| Vouchpack | [Unverified: HTTP 404, empty body](https://rdap.verisign.com/com/v1/domain/vouchpack.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/vouchpack.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/vouchpack.ai) |
| DraftCove | [Registered](https://rdap.verisign.com/com/v1/domain/draftcove.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/draftcove.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/draftcove.ai) |
| PolicyLoom | [Registered](https://rdap.verisign.com/com/v1/domain/policyloom.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/policyloom.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/policyloom.ai) |
| SourceLoom | [Registered](https://rdap.verisign.com/com/v1/domain/sourceloom.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/sourceloom.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/sourceloom.ai) |
| SkillCove | [Registered](https://rdap.verisign.com/com/v1/domain/skillcove.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/skillcove.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/skillcove.ai) |
| Packrail | [Registered](https://rdap.verisign.com/com/v1/domain/packrail.com) | [Registered](https://pubapi.registry.google/rdap/domain/packrail.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/packrail.ai) |
| Brintra | [Registered](https://rdap.verisign.com/com/v1/domain/brintra.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/brintra.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/brintra.ai) |

## Recommendation and next steps

Keep **Private Skills** as the working name until the business chooses a new brand. If a rename is approved, take **ReleaseLoom** and **Vouchpack** into the next screen first; their `.dev` and `.ai` checks returned valid not-found responses, while their `.com` responses were inconclusive. Keep the other four as backups, and do not advance Packrail or Brintra without legal advice.

Before any public announcement or registration:

1. Run a professional trademark and company-name search in every target market.
2. Check the registrar directly for price, premium status, registry reservation, and purchase eligibility immediately before a decision.
3. Check package names, GitHub organization names, social handles, and common misspellings.
4. Obtain explicit business approval for the selected name and domain before registration.
