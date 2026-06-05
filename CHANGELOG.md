# Changelog

## 2026.6.5-1 - 2026-06-05

### Added

- beads validate does not detect dependency cycles ([pm-beads-27rw](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-27rw.toon))

## 2026.06.04-1 - 2026-06-04

### Added

- preflight: fail-fast Beads-JSONL schema gate before import ([pm-beads-7mj4](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-7mj4.toon))

## 2026.06.04 - 2026-06-04

### Added

- Timestamp fidelity, workspace dep validation, and import/export row filters ([pm-beads-vv5z](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-vv5z.toon))

## 2026.06.03 - 2026-06-02

### Added

- Round-trip deepening: idempotent upsert import + beads validate ([pm-beads-qxdz](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-qxdz.toon))

### Other

- Unit tests for upsert key + validate; functional round-trip with real data ([pm-beads-1rmb](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-1rmb.toon))
- beads validate <file\> command \(--json, nonzero exit on structural problems\) ([pm-beads-dxnh](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-dxnh.toon))
- Idempotent import: --upsert keyed on bead\_id marker ([pm-beads-vqsd](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-vqsd.toon))

## 2026.06.02 - 2026-06-02

### Added

- Add Beads JSONL exporter + id/dependency round-trip ([pm-beads-yd0o](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-yd0o.toon))

## 2026.06.01 - 2026-06-01

### Fixed

- Command handler threw plain Error \(no exitCode\) → runtime double-invocation ([pm-beads-itf1](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-itf1.toon))

## 2026.05.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-beads-dt52](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/features/pm-beads-dt52.toon))

### Fixed

- beads import returns error object instead of throwing \(exit 0 on failure + malformed file\) ([pm-beads-w7ru](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-w7ru.toon))
- beads import --dry-run silently ignored \(still writes\) ([pm-beads-nfpq](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/issues/pm-beads-nfpq.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-beads-rsp7](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-rsp7.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-beads-xwv6](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-xwv6.toon))
- Production-readiness audit 2026-05-28 ([pm-beads-tsm5](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-tsm5.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-beads-cvk6](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-cvk6.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-beads-jwwg](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-jwwg.toon))

### Other

- Release readiness hardening for pm-beads ([pm-beads-urtk](https://github.com/unbraind/pm-beads/blob/main/.agents/pm/tasks/pm-beads-urtk.toon))
