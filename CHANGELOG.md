# Changelog

## Unreleased

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
