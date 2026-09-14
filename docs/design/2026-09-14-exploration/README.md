# Private Skills design exploration · 2026-09-14

This folder is a review artifact for comparing seven generated visual
directions: three baseline product concepts and four color studies. Open
[`index.html`](index.html) directly in a browser. The tabs support keyboard
arrow/Home/End navigation, and each image has an **Open large preview** button.

Every label, count, status, skill name, and screen state shown in the gallery is
conceptual sample data. The gallery is static, makes no API calls, and does not
represent a live page or a production data set.

## Included images

| Gallery entry | Copied image | Role in the review |
| --- | --- | --- |
| Baseline overview | `baseline-overview.png` | Home/catalog hierarchy |
| Baseline discovery | `baseline-discovery.png` | Search and comparison density |
| Baseline editor | `baseline-editor.png` | Review and release flow |
| Mineral | `mineral.png` | Graphite surfaces with ochre signal color |
| Terracotta | `terracotta.png` | Clay red with ink and cream |
| Plum | `plum.png` | Berry dark with lilac lift |
| Cobalt Studio | `cobalt.png` | Cobalt navigation with seafoam actions |

The seven files were copied from the generated-image workspace on 14 September
2026. The supplied source files and the existing `docs/design` PNGs remain
untouched. The source mapping is:

- `baseline-overview.png` ← `exec-3169a1d2-e03a-4d3e-a5b3-3249838d9a60.png`
- `baseline-discovery.png` ← `exec-ad7f00cb-e717-447d-b8a2-8be46dce86b5.png`
- `baseline-editor.png` ← `exec-12dad9e9-7f81-4bf1-b6db-58626a129667.png`
- `mineral.png` ← `exec-45049765-78e1-4c5c-8c67-a845198cd1a5.png`
- `terracotta.png` ← `exec-54869e76-14ad-4498-bbb8-b892fd7d92f5.png`
- `plum.png` ← `exec-8b116ea6-f3a7-4348-a682-483c77df30d0.png`
- `cobalt.png` ← `exec-526cdb89-b38c-47b7-8a3f-9f87bdb74fe0.png`

## Inspiration and palette decision

The exploration is informed by the editorial transitions and motion language
of [transitions.dev](https://transitions.dev/), the catalog and developer-tool
density of [libraries.dev](https://libraries.dev/), and the grain/gradient
sensibility of [grainient.supply](https://grainient.supply/). Those references
are inspiration only; this artifact has no external assets or scripts.

**Cobalt Studio** is the provisional direction selected after comparing the
alternatives. The review favored its precise table and editor readability, blue
action color separation from green success states, navy rail, and restrained
hero art. **Mineral** is the strongest dark alternative; **Terracotta** remains
the warm option, with some risk of warning color confusion and heavier serif
density; **Plum** remains the expressive option and a possible Eve accent.
Baseline overview, discovery, and editor are included as structural references
rather than palette choices.

## Implementation and evidence

The current working tree carries the first Cobalt-oriented experience pass:

- A command palette opens with `⌘K`/`Ctrl+K`, filters registry sections, supports
  arrow/Enter/Escape navigation, traps focus, and restores the opener.
- Source discovery is compacted around the search task, with suggested queries,
  provider access details, exact source identity, response summaries, and an
  inline resolve-progress panel.
- Eve prompts now expose focused suggestions, clearer working/attention states,
  draft context, and `⌘Enter`/`Ctrl+Enter` send behavior.
- Overview and shared styles carry the Cobalt direction through the hero,
  action rail, metric cards, tables, route transitions, and reduced-motion
  behavior.

A prior full test gate passed **853 tests with 7 opt-in skips**. After the latest
CSS fixes, the final code checks now pass TypeScript typecheck, **17 focused tests
across 5 files**, and `pnpm build`. Root is coordinating the final browser/layout
review. The isolated browser fixture run `current53405` then verified compact
overview and discovery screenshots, visible provider failure summaries, Eve
suggestion chips filling a 74-character prompt without submitting it, `⌘K`/Escape
focus return to `skill-builder-prompt`, and catalog/Eve layouts at 390px without
horizontal overflow. No current-origin warnings or errors were observed. The
long-source regression also passed at a 390px viewport with 390px scroll width;
imported hash identity and version remained bounded in the right-hand detail
area. This isolated fixture evidence is not a production or release claim. The
UI uses existing API-backed data; no fake product data was added, and the images
in this folder remain conceptual sample data.

## Implementation handoff

The Cobalt direction remains provisional until the browser review and release
checks are complete. UI implementation agents own the final theme tokens,
responsive behavior, accessibility verification, and any follow-up refinements;
this folder records the decision and evidence without changing app code.
