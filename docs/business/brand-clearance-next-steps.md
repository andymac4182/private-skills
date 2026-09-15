# Brand clearance next steps

**Prepared:** 16 September 2026 AEST (the live checks below were run on 15
September 2026 UTC)

**Status:** bounded public naming research. **Private Skills** remains the
working product name. This note does not select a name, rebrand the product,
register a domain, or provide legal or trademark clearance.

The screen covered the two current leads, five deliberately different naming
directions, public exact and near-name signals in developer and AI tooling,
authoritative RDAP queries, and an anonymous public registrar-page attempt. No
account, login, cart, checkout, purchase, registration, or outreach was used.

## Decision boundary

**ReleaseLoom** and **Vouchpack** remain the two leads from the existing
[brand and domain shortlist](brand-domain-shortlist.md) and
[market decision brief](market-decision-brief.md). They are candidates for the
next legal, package, handle, and customer-recall screen, not cleared brands.

| Candidate | Spoken form | Product fit | Main tradeoff | Public developer/AI collision signal |
| --- | --- | --- | --- | --- |
| **ReleaseLoom** | *ri-LEASE loom* | “Loom” gives a memorable way to describe weaving source identity, review evidence, policy, and releases into one repeatable path. It can cover skills, packs, and future capability types. | “Release” is descriptive but crowded, and the name can be mistaken for a release-management product. | [ReleaseOwl](https://www.releaseowl.com/) is a native DevOps platform for SAP that markets packaging, deployment, testing, compliance, and auditing. That is a strong adjacent release-workflow signal even though the quoted name is different. |
| **Vouchpack** | *VOUCH-pack* | Pairs an approval or provenance signal with a versioned pack. It is more distinctive than a generic “secure skills” name and maps to a visible release record. | “Pack” may narrow the story to collections, while “vouch” is already busy in security and developer identity. | [Vouchstack](https://vouchstack.io/) is a security-questionnaire SaaS. [Vouch Secure](https://docs.vouch-secure.com/introduction) markets AI-native security scanning, and [Vouch](https://vouch.sh/docs/) covers hardware-backed credentials, OIDC, registries, and developer integrations. |

The collision signals do not by themselves decide the name. They do mean both
leads need a package/repository search and a legal screen before any public
rename. The existing backup **DraftCove** remains a hold candidate because the
[exact DraftCove product](https://draftcove.world/) was found; its `.com` was
also recorded as registered / Make offer in the earlier registrar UI check.

## Five alternative directions

These are comparison directions rather than recommendations. Each expresses a
different product metaphor so the next conversation can test the meaning
before optimizing for a short domain.

| Direction | Name and pronunciation | Fit and tradeoffs | Public developer/AI collision screen |
| --- | --- | --- | --- |
| **Source / provenance** | **Sourceward** — *SOURCE-ward* | Immediately explains source-aware governance, pull-through, scanning, and provenance. The `-ward` pattern is crowded and the name can sound like a policy product. | [Stateward](https://www.stateward.com/) describes autonomous cybersecurity for codebases, AI-generated code review, dependency auditing, and compliance. [Trustward](https://trustward.ai/) describes governance for AI-built apps. An exact-name [Sourceward shop](https://sourceward.co.uk/) is a non-developer use. |
| **Proof / verification** | **Veridock** — *VERR-ih-dok* | A memorable landing-place metaphor for checking, identifying, and releasing a capability. “Veri-” is common, and “dock” may evoke Docker or hosting. | The [VeriDock GitHub organization](https://github.com/veridock) has document-verification and technical repositories, including an MCP/Ollama-related project. [PyPI `veridock`](https://pypi.org/project/veridock/0.1.5/) is a gRPC server-management tool, and [VeriDock](https://www.veridock.xyz/) is an AI freight-document product. This is an exact developer/technical collision; hold pending legal advice. |
| **Controlled delivery route** | **Packrail** — *PACK-rayl* | Tells a clear source-to-install story and can extend to packs, releases, and feeds. “Pack” can narrow the company story and “rail” carries logistics and payments associations. | Exact industrial [Packrail](https://catalog.minetti.com/Portals/0/pdf/Rulmeca/Rulmeca_Catalogo_UNIT.pdf) usage exists. [Packsmith](https://packsmith.ai/) is an AI fulfillment and distribution platform, a close pack-and-delivery adjacency. |
| **Verified ingress** | **Inletmark** — *IN-let-mark* | Makes the intake boundary and provenance mark explicit; it suits sources, packs, and provider connectors. It is literal and has an infrastructure or plumbing tone. | No exact `Inletmark` developer/AI product surfaced in this bounded search. Near-name AI/software results include [Info Inlet](https://infoinlet.com/) and [Inlet AI](https://www.getinlet.ai/team), so absence of an exact result is not clearance. |
| **Coined umbrella** | **Brintra** — *BRIN-truh* | A broad invented name can grow beyond a registry into policy, identity, and authoring. It needs explanation and may be heard or spelled as “Brinter.” | No exact or close developer/AI product surfaced in this bounded search. That is a search result, not a clearance result; the current `.com` RDAP record is registered and an existing [Brintra business listing](https://www.algomtl.com/brintra) is outside the target category. |

The five directions are intentionally different: source, proof, delivery,
ingress, and a coined umbrella. Keep **Private Skills** in product and
marketing copy while these are tested.

## RDAP registry screen

**Checked:** 15 September 2026 at **16:33:25.459 UTC**. The script first read
the IANA [RDAP DNS bootstrap registry](https://data.iana.org/rdap/dns.json),
then queried the authoritative service for each TLD:

- `.com`: [Verisign RDAP](https://rdap.verisign.com/com/v1/)
- `.dev`: [Google Registry RDAP](https://pubapi.registry.google/rdap/)
- `.ai`: [Identity Digital RDAP](https://rdap.identitydigital.services/rdap/)

The request was `GET /domain/<name>` with an RDAP JSON accept header. In the
table, **Registered** means HTTP 200 with a domain object, **Unregistered at
check** means a valid JSON 404 with `errorCode: 404`, and **Unverified** means
the service returned HTTP 404 with an empty body. These are registry responses
at one timestamp. They do not prove that a name is purchasable, non-premium,
legally usable, or available through a particular registrar. No DNS result was
used as an availability inference.

| Name | `.com` | `.dev` | `.ai` |
| --- | --- | --- | --- |
| ReleaseLoom | [Unverified — empty-body 404](https://rdap.verisign.com/com/v1/domain/releaseloom.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/releaseloom.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/releaseloom.ai) |
| Vouchpack | [Unverified — empty-body 404](https://rdap.verisign.com/com/v1/domain/vouchpack.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/vouchpack.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/vouchpack.ai) |
| Sourceward | [Registered](https://rdap.verisign.com/com/v1/domain/sourceward.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/sourceward.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/sourceward.ai) |
| Veridock | [Registered](https://rdap.verisign.com/com/v1/domain/veridock.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/veridock.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/veridock.ai) |
| Packrail | [Registered](https://rdap.verisign.com/com/v1/domain/packrail.com) | [Registered](https://pubapi.registry.google/rdap/domain/packrail.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/packrail.ai) |
| Inletmark | [Unverified — empty-body 404](https://rdap.verisign.com/com/v1/domain/inletmark.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/inletmark.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/inletmark.ai) |
| Brintra | [Registered](https://rdap.verisign.com/com/v1/domain/brintra.com) | [Unregistered at check](https://pubapi.registry.google/rdap/domain/brintra.dev) | [Unregistered at check](https://rdap.identitydigital.services/rdap/domain/brintra.ai) |

The `.com` empty-body results for the two leads remain **Unverified**. A valid
RDAP 404 for `.dev` or `.ai` is only **Unregistered at check**; it is not a
registration quote. Repeat RDAP immediately before any decision and investigate
premium, reserved, launch-policy, and local-registration conditions through a
registrar.

## Registrar view and its limits

On 15 September 2026 at approximately **16:36 UTC**, an isolated anonymous
headless HTTP attempt to the public [Namecheap domain-search pages](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.dev)
returned HTTP 403 challenge pages without a target result card or reliable
status marker. Public page retrieval also rejected the pages as unsafe. The
current registrar state is therefore **unavailable / blocked**, and this pass
does not claim that any name is currently UI-listed.

The prior successful public UI observations may still be cited as historical
evidence. During **15 September 2026, 15:54–15:57 UTC**, the Namecheap pages
for [ReleaseLoom `.com`](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.com),
[ReleaseLoom `.dev`](https://www.namecheap.com/domains/registration/results/?domain=releaseloom.dev),
[Vouchpack `.com`](https://www.namecheap.com/domains/registration/results/?domain=vouchpack.com),
and [Vouchpack `.dev`](https://www.namecheap.com/domains/registration/results/?domain=vouchpack.dev)
showed **Add to cart** and first-year prices. The `.com` cards showed
`$11.28/yr` (retail `$14.98`) and the `.dev` cards showed `$10.98/yr` (retail
`$15.98`). Those observations mean **registrar UI-listed at that historical
check**, not registered, reserved, or confirmed purchasable today. The `.com`
RDAP responses were still unverified and the `.dev` responses were unregistered
at that earlier check. No account, cart, checkout, purchase, or registration
was used. No CUA/browser session was used in this locked-Mac pass.

## Clearance gate

Before a name can replace Private Skills, repeat the public checks on the same
day and run the checks that RDAP and a registrar cannot answer:

1. Test spoken recall and spelling with the existing internal criterion of at
   least 8 of 10 readers choosing and typing the same name without help.
2. Search exact and close forms across GitHub organizations and repositories,
   npm, PyPI, crates.io, agent-skill directories, package scopes, and social
   handles. Record exact, near, and no-result outcomes with dates.
3. Obtain company-name, trademark, and target-market legal advice. A public
   search result or an unregistered domain is not a legal clearance.
4. Recheck authoritative RDAP and a registrar result within 24 hours of a
   decision. Keep **Registered**, **Unregistered at check**, **Registrar
   UI-listed**, and **Unverified** as separate states.
5. If a name is selected, prepare a migration map for the product descriptor,
   CLI, package scopes, URLs, and existing documentation. Until that decision
   and the clearance work are complete, retain **Private Skills** and `pskills`.

