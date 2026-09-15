# Brand and domain shortlist

**RDAP checked:** 15 September 2026 at 13:10:22 UTC<br>
**Registrar UI checked:** 15 September 2026, 13:18–13:20 UTC<br>
**Live registrar recheck:** 15 September 2026, 14:00–14:01 UTC (16 September 2026, 00:00–00:01 AEST)

**Status:** exploratory naming work. No domain was purchased or registered. No registrar account was used, no contact was made, and no trademark clearance was performed.

## Naming criteria

The name should be easy to say and spell, work for a developer-tool company, leave room for skills, releases, and policy, and avoid sounding like a generic “private skills” feature. A short name is useful only if the target markets, package names, social handles, and trademarks can be cleared together.

The two leading candidates from this pass are **ReleaseLoom** and **Vouchpack**. **DraftCove** was the requested backup for the live registrar check, but the public-name search found an exact product and it is now a hold/reject candidate. The other names remain comparison records; none has been cleared.

Suggested spoken forms for the three registrar-checked names are **ri-LEASE loom**, **VOUCH-pack**, and **DRAFT-cove**. These are pronunciation aids, not evidence of distinctiveness.

## Provisional naming scorecard

This is a screening aid for the next research step, not a selection or a legal opinion. Each criterion is rated from 1 (weak) to 5 (strong), using the limited public-name and registrar evidence in this document. The weighted score is only useful for deciding what to investigate next.

| Criterion | Weight | What to ask |
| --- | ---: | --- |
| Sayability and spelling | 20% | Can an engineer say it once and type it correctly later? |
| Meaning and product fit | 15% | Does it suggest the source, release, evidence, or team workflow without overpromising? |
| Room to grow | 15% | Can it cover skills, packs, policy, and releases if the product expands? |
| Collision signal | 25% | Do exact or close product, company, or category uses create confusion? |
| Domain path | 15% | Are sensible domains showing a non-premium registration path at the time of the check? |
| Ecosystem clearance | 10% | Are package, GitHub, social, and handle checks still open or showing a conflict? |

| Candidate | Say / spell | Meaning / fit | Room to grow | Collision signal | Domain path | Ecosystem clearance | Weighted screen | Next disposition |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **ReleaseLoom** | 4 | 5 | 4 | 3 | 4 | 2 | **3.7 / 5** | Advance to legal, package, and handle screening. |
| **Vouchpack** | 4 | 4 | 3 | 3 | 4 | 2 | **3.4 / 5** | Advance to the same screening; test whether “vouch” is clear in target markets. |
| **DraftCove** | 4 | 3 | 3 | 1 | 3 | 2 | **2.6 / 5** | Hold or reject because of the exact public-name collision. |

`Domain path` is rated 4 for the leading names because the public registrar showed a normal-looking result card, while the `.com` RDAP response was inconclusive. `Ecosystem clearance` remains 2 for every candidate because the package, repository, social, company, and trademark checks are not complete. Keep **Private Skills** as the working product name while the business decides; it is not scored as a rename candidate in this table.

## Candidate shortlist

| Candidate | Intended association | Exploratory collision signal | Next action |
| --- | --- | --- | --- |
| **ReleaseLoom** | Weaves source, review, and immutable releases into one repeatable path. | No exact product result was recorded for the quoted name in this limited pass, but close results include [LeaseLoom](https://leaseloom.org/), [Reeloom](https://reeloom.app/), and [ReleaseOwl](https://www.sap.com/products/technology-platform/partners/releaseowl-private-limited-releaseowl-native-devops-platform.html). | Advance to legal screen and a live registrar check; treat spelling and search collision as open risks. |
| **Vouchpack** | A pack that carries a visible approval or provenance signal. | No exact product result was recorded for the quoted name in this limited pass; [Vouchstack](https://vouchstack.io/) is a close security-software name. | Advance to legal screen; test whether “vouch” is clear in target markets. |
| **DraftCove** | A protected place for drafts before release. | Exact public site [DraftCove](https://draftcove.world/) found; [NameStation](https://www.namestation.com/names/software-studio) also lists DraftCove as a software-studio name. | Hold or reject; do not treat `.dev` availability as clearance. |
| **PolicyLoom** | Turns policy and evidence into a repeatable release fabric. | Exact [PolicyLoom](https://www.buildnextapp.com/preview-idea/policyloom-10598) app concept found. | Hold or reject pending legal advice. |
| **SourceLoom** | Connects source identity to a team release. | Exact [SourceLoom](https://sourceloom.me/factory) apparel manufacturer found. | Hold or reject pending legal advice. |
| **SkillCove** | A private, navigable home for team skills. | Exact [SkillCove](https://skillcove.social/) directory product found, with additional education/community uses in search results. | Hold or reject pending legal advice. |
| **Packrail** | A clear path from source pack to install. | Existing industrial/conveyor usage was found in an [industrial product catalogue](https://catalog.minetti.com/Portals/0/pdf/Rulmeca/Rulmeca_Catalogo_UNIT.pdf); both `packrail.com` and `packrail.dev` are registered in the RDAP check. | Hold or reject pending legal advice. |
| **Brintra** | Short invented name with a bright, infrastructure-tool sound. | An existing import/export business was found in this [business listing](https://www.algomtl.com/brintra); `brintra.com` is registered in the RDAP check. | Hold or reject pending legal advice. |

The public collision screen used quoted-name web searches on 15 September 2026. Search results are incomplete and may include similar names, parked domains, generated-name pages, or unrelated uses. A missing result does not mean the name is available, registrable, distinctive, or safe to use.

## RDAP method

The check used the IANA [RDAP DNS bootstrap registry](https://data.iana.org/rdap/dns.json), fetched at the timestamp above, to select the authoritative RDAP service for each TLD:

- `.com`: [Verisign RDAP](https://rdap.verisign.com/com/v1/)
- `.dev`: [Google Registry RDAP](https://pubapi.registry.google/rdap/)
- `.ai`: [Identity Digital RDAP](https://rdap.identitydigital.services/rdap/)

Each domain was requested with `GET /domain/<domain>` and an RDAP JSON accept header. Per the [IANA RDAP requirements](https://www.iana.org/help/rdap-requirements), a `200` response containing a domain object means the registration service returned a domain record, while a valid `404` means that the name was not found in that RDAP service at the time of the check. ICANN describes RDAP as the current standardized source for registration data in its [RDAP overview](https://www.icann.org/rdap/).

RDAP status is not a purchase quote. A `404` can still be affected by premium pricing, registry or registrar reservation, launch rules, local requirements, or a name that is not offered by a registrar. Trademark, company-name, package-name, social-handle, and common-law conflicts require separate research. No DNS no-answer result was treated as availability.

## Registrar UI check

The public [Namecheap domain search](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.dev) was checked without signing in or adding anything to the cart. The target card showed **Add to cart** and an annual price for each result marked “UI-listed” below. This is a registrar's public availability indication at that moment; it is not a completed registration or a guarantee that checkout will accept the name. Prices are shown in USD and can change with promotion, tax, account eligibility, premium status, or checkout rules. No cart, account, or purchase action was used.

| Candidate | `.com` | `.dev` |
| --- | --- | --- |
| ReleaseLoom | [UI-listed: `$11.28/yr`, retail `$14.98/yr`; page also showed a new-customer `$6.79` promotion](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.com) | [UI-listed: `$10.98/yr`, retail `$15.98/yr` (31% off)](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.dev) |
| Vouchpack | [UI-listed: `$11.28/yr`, retail `$14.98/yr`; page also showed a new-customer `$6.79` promotion](https://www.namecheap.com/domains/registration/results/?domain=vouchpack.com) | [UI-listed: `$10.98/yr`, retail `$15.98/yr` (31% off)](https://www.namecheap.com/domains/registration/results/?domain=vouchpack.dev) |
| DraftCove | [Registered in 2025; `Make offer`; no annual registration price shown](https://www.namecheap.com/domains/registration/results/?domain=draftcove.com) | [UI-listed: `$10.98/yr`, retail `$15.98/yr` (31% off)](https://www.namecheap.com/domains/registration/results/?domain=draftcove.dev) |

The `.com` pages for ReleaseLoom and Vouchpack displayed the exact result card with **Add to cart**, even though the Verisign responses in the earlier RDAP pass had empty-body `404` responses. The registrar UI is recorded as a live indication, while the RDAP result remains **unverified** under the method below. The DraftCove `.com` page displayed **Registered in 2025** and **Make offer**, so it is not a normal new-registration candidate.

### Live registrar recheck

On 15 September 2026 from 14:00 to 14:01 UTC (16 September 2026 from 00:00 to 00:01 AEST), the `.com` and `.dev` endpoints for the two leading candidates and the DraftCove backup were opened again in the public Namecheap results UI. The target card was read without signing in, opening a cart, or submitting any form. “UI-listed” means the page displayed **Add to cart** and a first-year price; it does not mean the name was purchased, reserved, or guaranteed to pass checkout.

| Domain | Result visible during recheck | Price or status shown | Evidence |
| --- | --- | --- | --- |
| `releaseloom.com` | UI-listed; **Add to cart** | `$11.28/yr`, retail `$14.98/yr`; page also showed the new-customer `$6.79` `NEWCOM679` promotion | [Namecheap result](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.com) |
| `releaseloom.dev` | UI-listed; **Add to cart** | `$10.98/yr`, retail `$15.98/yr`; 31% off | [Namecheap result](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.dev) |
| `vouchpack.com` | UI-listed; **Add to cart** | `$11.28/yr`, retail `$14.98/yr`; page also showed the new-customer `$6.79` `NEWCOM679` promotion | [Namecheap result](https://www.namecheap.com/domains/registration/results/?domain=vouchpack.com) |
| `vouchpack.dev` | UI-listed; **Add to cart** | `$10.98/yr`, retail `$15.98/yr`; 31% off | [Namecheap result](https://www.namecheap.com/domains/registration/results/?domain=vouchpack.dev) |
| `draftcove.com` | **Registered in 2025**; **Make offer** | No normal annual registration price shown | [Namecheap result](https://www.namecheap.com/domains/registration/results/?domain=draftcove.com) |
| `draftcove.dev` | UI-listed; **Add to cart** | `$10.98/yr`, retail `$15.98/yr`; 31% off | [Namecheap result](https://www.namecheap.com/domains/registration/results/?domain=draftcove.dev) |

The leading `.com` pages continued to conflict with the earlier Verisign RDAP responses that returned an empty-body `404`. Keep those `.com` statuses **Unverified**, and treat the registrar pages as live UI indications only. Promotions, first-year pricing, premium status, and checkout eligibility can change between this check and any future decision. The `.ai` values in the RDAP table were not rechecked in this UI pass and must be checked again if `.ai` is part of the final choice.

## Results

The result words have these precise meanings:

- **Registered:** RDAP returned `200` with a domain object.
- **Unregistered at check:** RDAP returned a valid JSON `404` / `errorCode: 404`. This is not a statement that the name is purchasable.
- **Unverified:** the service returned HTTP `404` with an empty body, so the result was not treated as a valid RDAP not-found response.

No domain in this table is **verified as successfully registerable**. Namecheap's UI listed ReleaseLoom `.com`/`.dev`, Vouchpack `.com`/`.dev`, and DraftCove `.dev` as candidate registrations at the registrar check time; those indications remain subject to checkout, registry, premium, and legal conditions.

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

Keep **Private Skills** as the working name until the business chooses a new brand. If a rename is approved, take **ReleaseLoom** and **Vouchpack** into the next screen first; the Namecheap UI listed both `.com` and `.dev` as candidate registrations, while the `.com` RDAP responses were inconclusive. DraftCove was the checked backup but is now a hold/reject candidate because of an exact public-name collision. Treat PolicyLoom, SourceLoom, SkillCove, Packrail, and Brintra as hold/reject backups until a proper clearance pass changes that assessment.

Before any public announcement or registration:

1. Run a professional trademark and company-name search in every target market.
2. Check the registrar directly for price, premium status, registry reservation, and purchase eligibility immediately before a decision.
3. Check package names, GitHub organization names, social handles, and common misspellings.
4. Obtain explicit business approval for the selected name and domain before registration.

## Detailed naming research backlog

These checks are deliberately sequenced so a memorable name does not become a costly rename before the product, package, and public identity can move together. No outreach, account creation, purchase, or registration is part of this backlog.

| ID | Check | Evidence to collect | Decision gate |
| --- | --- | --- | --- |
| N1 | Business choice | A written choice between keeping Private Skills and advancing ReleaseLoom or Vouchpack. | Do not change public product copy until a choice exists. |
| N2 | Spoken and written recall | Ten consenting readers hear each finalist once, then type and pronounce it; record errors and associations. | Advance a finalist only if at least 8 of 10 spell it correctly and no repeated pronunciation problem appears. |
| N3 | Product and package collisions | Exact and close searches on GitHub, npm, crates.io, PyPI, major agent-skill directories, and package registries. | A finalist with a confusing package or repository collision returns to hold, regardless of domain status. |
| N4 | Company, social, and trademark screen | Search target-market company records, handles, and trademark databases; preserve query date and jurisdiction. | Legal review decides whether a name is usable; this document cannot clear it. |
| N5 | Registrar and registry recheck | Within 24 hours of a registration decision, repeat `.com`, `.dev`, and optional `.ai` checks for price, premium label, registry response, and checkout eligibility. | A public UI card is sufficient only to queue the next check; it is never proof of purchasability. |
| N6 | Migration impact | List changes for the marketing app, application app, shared brand package, docs, analytics labels, support destination, package names, redirects, and deployment variables. | Approve the rename only when the migration list has an owner and rollback path. |

### Recheck cadence

The 15 September UTC registrar observations are a dated research snapshot. Treat them as stale for a registration decision after seven days, or sooner if the business is ready to announce a name. Run the final registry and registrar checks in the same session as the decision, record the UTC timestamp, and capture whether a premium or resale flow appears. Check again after any legal or package conflict changes the candidate list.

### Selection rule

Until N1–N6 are complete, keep **Private Skills** in public copy and use **ReleaseLoom** and **Vouchpack** only as exploratory candidates. If the user chooses a finalist, update the brand package and both deployable apps in one planned change, preserve redirects where required, and keep domain registration as a separate explicitly approved action. Do not infer a trademark clearance, package availability, or customer preference from the scorecard or the registrar UI.
