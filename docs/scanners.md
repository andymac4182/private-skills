# Scanner selection

Research date: 9 September 2026. The recommended initial adapters are **Cisco Skill Scanner**, **NVIDIA SkillSpector**, and **SkillsGuard (Teycir)**. This ranks their suitability for a private registry using primary documentation and selected source inspection. It is not an independently benchmarked ranking of detection accuracy. The integrations remain planned.

These three are purpose-built skill scanners whose local profiles require no scanning-service subscription. Cisco offers the broadest initial integration surface; NVIDIA adds an independent analysis pipeline and dependency intelligence; SkillsGuard provides a lightweight independent rules engine. Hosting, compute, and optional model providers still have costs.

## Configuration and defaults

Each engine supports `disabled`, `advisory`, and `required`. After the adapter acceptance milestone, enable Cisco as required and NVIDIA/SkillsGuard as advisory. Administrators can promote either after calibrating results against their internal skills. Changing modes creates a policy revision and follows the re-evaluation rules in [the scanning contract](scanning-and-hooks.md).

Default profiles run locally inside disposable scanner environments with network access denied. External semantic analysis and dependency-metadata queries are separately named opt-ins. None of these integrations runs on the developer's machine during normal installation; the Rust CLI downloads the registry-approved artifact.

The commands below are preliminary adapter invocations documented by the projects. Implementation must select immutable scanner/rule/image versions and verify flags, JSON, exit behavior, and runtime requirements against those exact versions before enabling them. They are not installation instructions or evidence of a completed integration.

## 1. Cisco Skill Scanner

**License/runtime:** Apache-2.0; Python with native scanner dependencies. Current development documentation specifies CPython 3.11–3.14 and warns that published wheels may have a different compatibility contract. Pin and verify the release rather than assuming `main` describes PyPI. [Project documentation](https://github.com/cisco-ai-defense/skill-scanner).

**Coverage:** skill directories, static patterns, bytecode inspection, command pipelines, correlation, and optional Python behavioral dataflow. JSON/SARIF support and an extensible analyzer interface make it the preferred first adapter. [Official overview](https://github.com/cisco-ai-defense/skill-scanner/blob/main/docs-site/index.mdx).

```sh
skill-scanner scan /input/skill --use-behavioral --format json --output /output/cisco.json
```

**Privacy/default:** required after acceptance; local core plus behavioral analysis. Keep LLM, meta-analysis, AI Defense, and VirusTotal integrations disabled. Their credentials, content exposure, and possible costs are separate from the free local profile. Automated detection remains incomplete, as Cisco's own limitations and evaluation explain. [CLI and limitations](https://github.com/cisco-ai-defense/skill-scanner).

## 2. NVIDIA SkillSpector

**License/runtime:** Apache-2.0; Python, with current documentation specifying Python 3.12–3.14. It accepts local directories and archives and offers regex, AST, YARA, and optional LLM analysis. [License](https://github.com/NVIDIA/SkillSpector/blob/main/LICENSE), [runtime documentation](https://github.com/NVIDIA/SkillSpector/blob/main/docs/PI_EXTENSION.md).

```sh
skillspector scan /input/skill --no-llm --format json --output /output/nvidia.json
```

**Privacy/default:** advisory, LLM disabled, network denied. **`--no-llm` does not disable all network calls:** SC4 sends dependency names and versions to OSV.dev. With network denied, its limited bundled vulnerability list replaces live lookup; record degraded dependency coverage explicitly. Administrators may separately permit OSV metadata egress. LLM mode sends eligible file contents to the configured provider. [Trust model](https://github.com/NVIDIA/SkillSpector#trust-model-and-data-egress).

**Integration limits:** JSON/SARIF are available. Exit 0 includes both SAFE and CAUTION; exit 1 indicates a score above 50; exit 2 indicates error. Parse findings and coverage rather than trusting exit 0. Image, encrypted/binary, non-English, and runtime attacks have gaps. [Integration contract and limitations](https://github.com/NVIDIA/SkillSpector#integrating-skillspector).

The programmatic inspection ledger records excluded, skipped, and failed files and can support coverage reporting. [Developer reference](https://github.com/NVIDIA/SkillSpector/blob/main/docs/DEVELOPMENT.md).

## 3. SkillsGuard (Teycir)

**License/runtime:** MIT, with the complete grant/copyright text embedded in its README and MIT declared in package metadata. Node ≥18.3; no runtime dependencies. Use a maintained compatible Node release in the pinned worker image. [License text](https://github.com/Teycir/SkillsGuard#license), [package metadata](https://github.com/Teycir/SkillsGuard/blob/main/package.json).

```sh
skillsguard /input/skill --json --no-color --no-config > /output/skillsguard.json
```

**Privacy/default:** advisory, local CLI, network denied. It scans supported text/script types with regex and bounded decoding, producing JSON/SARIF. The project says it is **not currently published to npm**: build a pinned source revision into the worker image. The hosted API receives content and only scans one file per request, so it is unsuitable for our default bundle pipeline. [Usage and distribution](https://github.com/Teycir/SkillsGuard).

**Integration limits:** markdown-context exclusions and inline suppression comments can hide relevant content. `--no-config` prevents automatic config loading; it does not establish that every suppression is disabled. Verify coverage and suppression handling before allowing required mode. Its value is an additional independent signal, not proof that regex inspection captures intent. [Limitations](https://github.com/Teycir/SkillsGuard#limitations).

## Alternatives considered

| Candidate | Why it is outside the initial three |
| --- | --- |
| **Snyk Agent Scan**, formerly mcp-scan | Skill content goes to its API; CLI output is experimental. Snyk asks registry integrations to use designated APIs and warns that large-scale standard-API use is abuse. Consider only after explicit integration terms and privacy configuration; do not promise a free registry backend. [Project](https://github.com/snyk/agent-scan). |
| **Mondoo skillcheck** | Apache-2.0 client using hash reputation. Unknown skills appear clean/fail open, making it unsuitable for evaluating new private content. Potential additional known-bad lookup. [Project](https://github.com/mondoohq/skillcheck). |
| **SkillScan Security** | Retired July 2026, archived, and explicitly receiving no further security fixes. Its authors advise against new adoption. [Retirement notice](https://github.com/kurtpayne/skillscan-security). |
| **Sentry skill-scanner** | Apache-2.0, JSON-capable. Text analysis covers immediate reference/script files; selected structural checks recurse. Its surrounding workflow expects intent review. Useful audit helper, weaker automatic whole-bundle fit. [Repository](https://github.com/getsentry/skills), [source](https://github.com/getsentry/skills/blob/main/skills/skill-scanner/scripts/scan_skill.py). |
| **mannanj/skillguard** | AGPL-3.0-only or commercial licensing; endpoint guard/aggregator with optional Cisco and Snyk engines. Adds overlap and licensing complexity. [Project](https://github.com/mannanj/skillguard). |
| **Gitleaks** | MIT local secrets scanner; worthwhile future complementary adapter, but not a skill-intent scanner. Maintainer now limits changes to security patches. [Project](https://github.com/gitleaks/gitleaks). |
| **Semgrep CE** | LGPL-2.1 source-code engine; useful for bundled scripts, with function/file analysis limits and separately licensed rule packs. Later SAST adapter rather than a purpose-built skills scanner. [Project](https://github.com/semgrep/semgrep). |

## Adapter acceptance

Before an adapter can become required:

- Verify the pinned release against benign and malicious fixtures, nested scripts, unfamiliar extensions, code fences, encoded payloads, and binaries. Measure false positives on representative internal skills.
- Confirm publisher-controlled configs, baselines, inline suppressions, and custom rules cannot suppress registry-required findings. Where upstream cannot disable them, expose and remediate the limitation before promotion.
- Account for enumerated, analyzed, skipped, oversized, and unsupported files. Zero analyzed files or missing required coverage cannot pass.
- Verify timeouts, crashes, denied network, truncated output, malformed JSON, and unexpected exit codes become explicit non-success states.
- Confirm the adapter scans the sealed distribution payload and does not execute skill code or contact unauthorized destinations.

The product owns authorization and thresholds. Scanner-native “safe” labels are evidence only; the UI reports whether the artifact passed the selected policy. See [scanning and hooks](scanning-and-hooks.md) for execution, normalization, quarantine, and exception rules.
