import { execSync } from 'node:child_process';

// Wire pm-cli's field-aware Git merge drivers into this clone's local Git config,
// but only when the `pm` CLI is actually available. Implemented in Node (rather than
// a POSIX `if ...; then ...; fi` shell guard) so it runs identically on POSIX shells
// and Windows cmd.exe (npm's default script shell) without any shell-operator parsing.
try {
  execSync('pm --version', { stdio: 'ignore' });
} catch {
  // `pm` is not installed (e.g. a production / `--omit=dev` install, or a consumer
  // machine without the CLI) — skip merge-driver wiring silently, don't fail install.
  process.exit(0);
}

// `pm` IS present: wire the drivers. If this genuinely fails, surface it (fail-loud,
// non-zero exit) rather than swallowing the error.
execSync('pm merge install', { stdio: 'inherit' });
