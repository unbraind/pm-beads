# Changelog

## Unreleased

### Fixed

- Queue trailing separated heredoc after joined opener ([pm-beads-uwkq](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-uwkq.toon))
- Restore YAML indentation branch coverage after rebase ([pm-beads-mnb5](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-mnb5.toon))
- Use YAML block indentation for heredoc delimiters ([pm-beads-zroe](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-zroe.toon))
- Normalize shallower YAML heredoc delimiters ([pm-beads-g2p8](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-g2p8.toon))
- Recognize mixed and chained joined heredoc operators ([pm-beads-n3yd](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-n3yd.toon))
- Preserve successful assignment status across conditionals ([pm-beads-mdk1](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-mdk1.toon))
- Prevent piped brace-group state leaks and exercise here-strings ([pm-beads-5s28](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-5s28.toon))
- Preserve scalar assignments inside brace groups ([pm-beads-t9nz](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-t9nz.toon))
- Close multi-assignment, compound-status, and joined-heredoc bypasses ([pm-beads-rgro](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-rgro.toon))
- Close declaration, conditional-unset, and subshell scalar bypasses ([pm-beads-zcje](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-zcje.toon))
- Recognize ampersand-first scalar redirections ([pm-beads-8lhm](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-8lhm.toon))
- Pin pm-changelog 2026.8.30 before the next release ([pm-beads-h8cp](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-h8cp.toon))
- Remove the unused changelog verifier test import ([pm-beads-3uet](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-3uet.toon))
- Run the changelog date guard against same-day release suffixes ([pm-beads-7uxj](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-7uxj.toon))
- Rebase the changelog date verifier onto the current release workflow ([pm-beads-vuzd](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-vuzd.toon))
- Preserve scalar assignments with ampersand redirections ([pm-beads-pyjj](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-pyjj.toon))
- Close remaining PR 88 shell scalar review bypasses ([pm-beads-8001](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-8001.toon))
- CodeQL action updates split into mutually blocking pull requests ([pm-beads-1d0b](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-1d0b.toon))

## 2026.8.29 - 2026-08-29

### Fixed

- Shell scalar assignments are read from raw text, so a comment can flag an unattested publish ([pm-beads-dhgs](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-dhgs.toon))
- Track scalar unset and heredoc body lines in shellScalars ([pm-beads-vsnb](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-vsnb.toon))

## 2026.8.28 - 2026-08-28

### Fixed

- Prevent a failed provenance publish from silently falling back to an unattested publish ([pm-beads-y1gg](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-y1gg.toon))
- Release coverage gate is below 100 percent and omits executable tooling ([pm-beads-cjey](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-cjey.toon))
- Canonicalize complete workspace reads and adopt the current pm host contract ([pm-beads-1uz3](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-1uz3.toon))
- Keep beads export stdout as pure JSONL without host summary output ([pm-beads-y76h](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-y76h.toon))

### Security

- The identity gate deadlocks the one remediation its own failure message prescribes ([pm-beads-a3xr](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-a3xr.toon))
- Remove absolute host paths and non-public identities from the entire reachable Git history ([pm-beads-lajb](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-lajb.toon))

### Other

- Finish attested publishing review backlog ([pm-beads-bxqr](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-bxqr.toon))
- Alert on daily release failure and require merge drivers in CI ([pm-beads-rgm0](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-rgm0.toon))
- Resolve CodeRabbit findings on PR 75 ([pm-beads-bfw8](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-bfw8.toon))
- Resolve PR 75 review thread and history drift on lajb ([pm-beads-1bgo](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-1bgo.toon))

## 2026.8.16 - 2026-08-16

### Fixed

- A truncated list-all answer is consumed as if it were complete ([pm-beads-vulo](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-vulo.toon))

## 2026.8.14 - 2026-08-14

### Fixed

- Declaring the pm CLI as a runtime dependency gives consumers a second nested copy whenever their host pin differs ([pm-beads-yk8k](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-yk8k.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- Fix daily release ordering so npm publish no longer races ahead of the protected main push ([pm-beads-kbnm](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-kbnm.toon))
- Propagate the docstring gate entry guard fix ([pm-beads-sidy](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-sidy.toon))
- The mandatory docstring gate could skip its own scan and still exit zero ([pm-beads-cg9v](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-cg9v.toon))

### Other

- Adopt the canonical pm-ops docstring gate ([pm-beads-c7mx](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-c7mx.toon))

## 2026.8.7 - 2026-08-07

### Other

- Gate CI on strict tracked pm project health ([pm-beads-bzpz](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-bzpz.toon))

## 2026.8.4 - 2026-08-04

### Fixed

- Route terminal-status transitions through pm close for pm-cli 2026.8.3 ([pm-beads-dgk3](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-dgk3.toon))

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-beads-bjqg](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-bjqg.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-beads-wdyb](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-wdyb.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-beads-foyv](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-foyv.toon))

## 2026.7.28 - 2026-07-28

### Removed

- Replace the dynamic SDK runtime import with a typed top-level import and remove all source any ([pm-beads-w143](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-w143.toon))

### Other

- Adopt pm-cli 2026.7.28 and cover the flag-declaration form the host never validates ([pm-beads-9scl](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-9scl.toon))

## 2026.7.27 - 2026-07-27

### Fixed

- beads validate and beads diff fail to register on pm-cli 2026.7.27 because each redeclares the host-owned --json global ([pm-beads-080q](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-080q.toon))

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([pm-beads-i8t0](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-i8t0.toon))

### Other

- Adopt typed SDK define builders for every registration ([pm-beads-c4rw](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-c4rw.toon))

## 2026.7.26 - 2026-07-26

### Fixed

- Documented install command fails: pm install github.com/unbraind/pm-beads cannot resolve an entry file ([pm-beads-00wh](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-00wh.toon))

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-beads-89ni](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-89ni.toon))

## 2026.7.25 - 2026-07-25

### Fixed

- pm item reads are capped at Node's 1 MiB spawnSync default, so a mature tracker fails with no diagnosis ([pm-beads-6a9l](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-6a9l.toon))

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-beads-anzm](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-anzm.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Merge-safety docs follow-up: clarify verify scope + pin pm-cli 2026.7.22 (Greptile P1/P2) ([pm-beads-fiq7](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-fiq7.toon))
- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-beads-dlsd](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-dlsd.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-beads-crk5](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-crk5.toon))

## 2026.7.19 - 2026-07-19

### Other

- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-beads-87lb](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-87lb.toon))

## 2026.7.11 - 2026-07-11

### Added

- Full pm ecosystem production pass for pm-beads ([pm-beads-vxw7](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-vxw7.toon))

### Other

- Adopt current pm SDK, changelog, Node types, TypeScript 7, and checkout action ([pm-beads-8wev](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-8wev.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-beads-j4up](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-j4up.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-beads-7wd9](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-7wd9.toon))
- Regenerate CHANGELOG after pm close item ([pm-beads-tsu9](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-tsu9.toon))

## 2026.6.12 - 2026-06-12

### Added

- Hard import gate, history-consistent timestamps, first-class import/export contracts ([pm-beads-q3t0](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-q3t0.toon))

### Fixed

- beads validate --no-workspace is a silent no-op (runtime normalizes flag to workspace:false) ([pm-beads-u440](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-u440.toon))
- Promote pm beads validate to first-class command registration ([pm-beads-azv0](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-azv0.toon))

### Other

- Align pm-beads with pm CLI 2026.6.12 release readiness ([pm-beads-pib4](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-pib4.toon))
- Restore pm CLI runtime dependency for pm-beads ([pm-beads-w7n9](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-w7n9.toon))

## 2026.6.9 - 2026-06-09

### Added

- Add beads diff for round-trip fidelity auditing ([pm-beads-tjrz](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-tjrz.toon))

## 2026.6.8 - 2026-06-08

### Other

- Full-cycle hardening wave: pm-beads ([pm-beads-n412](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-n412.toon))

## 2026.6.7 - 2026-06-07

### Added

- Preserve Beads planning fields across import and export ([pm-beads-t5s9](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-t5s9.toon))

### Other

- Harden release readiness checks ([pm-beads-xdzs](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-xdzs.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-beads-j930](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/chores/pm-beads-j930.toon))

## 2026.6.5-1 - 2026-06-05

### Added

- beads validate does not detect dependency cycles ([pm-beads-27rw](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-27rw.toon))

## 2026.6.4-1 - 2026-06-04

### Added

- preflight: fail-fast Beads-JSONL schema gate before import ([pm-beads-7mj4](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-7mj4.toon))

## 2026.6.4 - 2026-06-04

### Added

- Timestamp fidelity, workspace dep validation, and import/export row filters ([pm-beads-vv5z](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-vv5z.toon))

## 2026.6.3 - 2026-06-02

### Added

- Round-trip deepening: idempotent upsert import + beads validate ([pm-beads-qxdz](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-qxdz.toon))

### Other

- Unit tests for upsert key + validate; functional round-trip with real data ([pm-beads-1rmb](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-1rmb.toon))
- beads validate <file\> command (--json, nonzero exit on structural problems) ([pm-beads-dxnh](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-dxnh.toon))
- Idempotent import: --upsert keyed on bead_id marker ([pm-beads-vqsd](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-vqsd.toon))

## 2026.6.2 - 2026-06-02

### Added

- Add Beads JSONL exporter + id/dependency round-trip ([pm-beads-yd0o](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-yd0o.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- Command handler threw plain Error (no exitCode) → runtime double-invocation ([pm-beads-itf1](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-itf1.toon))

## 2026.5.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-beads-dt52](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-dt52.toon))

### Fixed

- beads import returns error object instead of throwing (exit 0 on failure + malformed file) ([pm-beads-w7ru](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-w7ru.toon))
- beads import --dry-run silently ignored (still writes) ([pm-beads-nfpq](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-nfpq.toon))

### Other

- Production-readiness audit 2026-05-29 ([pm-beads-e6t2](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-e6t2.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-beads-rsp7](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-rsp7.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-beads-xwv6](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-xwv6.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-beads-cvk6](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-cvk6.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-beads-jwwg](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-jwwg.toon))

### Other

- Release readiness hardening for pm-beads ([pm-beads-urtk](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-urtk.toon))
