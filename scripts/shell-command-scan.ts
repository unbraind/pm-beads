/**
 * Tokenises shell text into the commands it would actually run.
 *
 * A guard that decides "does any publish here omit `--provenance`" is only as
 * good as its idea of what a command is. The previous scan answered that
 * question with a regular expression: it blanked every quoted span so an
 * advisory `echo "npm publish"` could not read as an invocation, then split the
 * remainder on `&&`, `||`, `;` and a space-surrounded `|`.
 *
 * Both halves of that shortcut are wrong in the same direction -- they make the
 * gate report a pass it has not earned:
 *
 * - Blanking quoted spans deletes the argument being audited. `npm publish
 *   "--provenance"` runs with an attestation but scans as one without, and the
 *   reverse case is worse: `eval "npm publish"` and `bash -c 'npm publish'` are
 *   real unattested publishes that vanish entirely, leaving a conventional
 *   attested sibling elsewhere in the file to carry the audit to green.
 * - Splitting on three operators misses a backgrounding `&`, a pipe written
 *   without surrounding spaces (`true|npm publish`), and command substitution.
 *
 * So the text is tokenised the way a shell does it -- quotes resolved rather
 * than erased, operators recognised as operators, `$(...)`, backticks, `eval`
 * and `sh -c` payloads recursed into -- and each command records whether its
 * words were quoted. Nothing downstream has to guess.
 *
 * This is deliberately not a shell. It does not expand variables, globs or
 * arithmetic, and it does not track redirections. It exists to enumerate
 * candidate command invocations for auditing, where missing one is a security
 * failure and inventing one is merely noise.
 *
 * @packageDocumentation
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One word of a command, after quote resolution. */
export interface ShellToken {
  /** The word's text with its quoting removed. */
  value: string;
  /** True when any part of the word came from inside quotes. */
  quoted: boolean;
  /**
   * True when the word's FIRST character came from inside quotes.
   *
   * `quoted` alone cannot tell an assignment apart from a literal that merely
   * looks like one. `NPM_CONFIG_REGISTRY="https://example"` is a real
   * assignment whose value happens to be quoted, while `"FOO=bar"` is a single
   * quoted word that the shell does not treat as an assignment at all. Both set
   * `quoted`; only the second starts inside quotes.
   */
  startsQuoted: boolean;
}

/** One simple command: the words it would run, in order. */
export type ShellCommand = ShellToken[];

/**
 * Words that precede a command without being the command.
 *
 * `env FOO=bar npm publish` runs npm, not env, so a scan that reads the first
 * word as the command name would classify it as an `env` invocation and let the
 * publish through unaudited.
 *
 * The package runners (`npx`, `bunx`, `pnpx`) belong here for the same reason,
 * and they bring their own options: `npx --yes npm publish` runs npm behind two
 * words, not one. Option words following a prefix are therefore skipped too --
 * see `skipCommandPrefix`, which is where that rule is applied and bounded.
 *
 * Runners spelled as two words live in `TWO_WORD_PREFIXES` instead, because
 * their head word is only a wrapper in combination with the word after it.
 */
const COMMAND_PREFIXES = new Set([
  "env",
  "exec",
  "nohup",
  "command",
  "builtin",
  "sudo",
  "doas",
  "nice",
  "ionice",
  "time",
  "stdbuf",
  "timeout",
  "setsid",
  "xargs",
  "npx",
  "bunx",
  "pnpx",
  // Shell keywords introduce a command rather than being one. `if npm publish`
  // runs npm; a scan that reads `if` as the program audits nothing.
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
  "(",
]);

/**
 * Wrappers spelled as two words, mapped to the second word that completes them.
 *
 * `pnpm dlx npm publish` runs npm, but `pnpm publish` runs pnpm's own publish
 * and `pnpm install` runs no wrapper at all. Consuming the head word
 * unconditionally would therefore re-point an unrelated `pnpm` command at its
 * first argument, so the pair is only consumed when the second word matches.
 */
const TWO_WORD_PREFIXES = new Map([
  ["npm", new Set(["exec", "x"])],
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx", "exec"])],
  ["bun", new Set(["x", "run"])],
]);

/**
 * Reduce a program word to the name it runs.
 *
 * `/usr/local/bin/npm publish` runs npm, so a check against the whole word
 * would miss it. `String.prototype.split` always yields at least one element,
 * including for the empty string, so no fallback is needed or reachable here.
 *
 * @param word - The program word as written.
 * @returns The final path segment.
 */
function basename(word: string): string {
  const segments = word.split("/");
  return segments[segments.length - 1]!;
}

/** Commands whose string argument is itself shell text to be scanned. */
const SHELL_EVALUATORS = new Set(["eval", "bash", "sh", "dash", "zsh", "ksh"]);

/** True when the character ends a word outside of quotes. */
function isOperatorStart(character: string): boolean {
  return character === ";"
    || character === "&"
    || character === "|"
    || character === "\n"
    || character === "("
    || character === ")"
    || character === "{"
    || character === "}";
}

/**
 * Read a `$(...)` or backtick substitution and return its inner text.
 *
 * Nesting is counted so `$(echo $(npm publish))` yields the whole inner body
 * rather than stopping at the first `)`; a truncated body would drop the
 * invocation it contains.
 *
 * @param text - The full text being scanned.
 * @param start - Index of the character that opens the substitution.
 * @returns The inner text and the index just past the closing delimiter.
 */
function readSubstitution(text: string, start: number): { inner: string; end: number } {
  if (text[start] === "`") {
    const close = text.indexOf("`", start + 1);
    if (close === -1) return { inner: text.slice(start + 1), end: text.length };
    return { inner: text.slice(start + 1, close), end: close + 1 };
  }
  // A parenthesis inside quotes is a literal, not a delimiter. Counting it
  // closes the substitution early and truncates the body, so
  // `$(echo ")" && npm publish)` loses the publish entirely.
  let depth = 1;
  let index = start + 2;
  let single = false;
  let double = false;
  while (index < text.length && depth > 0) {
    const character = text[index]!;
    if (character === "\\") index += 2;
    else {
      // Quote state is bounded to one line. A workflow's prose carries
      // apostrophes -- "GitHub's", "workflow's" -- inside double-quoted
      // messages, and letting an unbalanced one persist across lines makes
      // every later parenthesis look quoted, so the substitution runs on and
      // swallows unrelated commands.
      if (character === "\n") { single = false; double = false; }
      else if (character === "'" && !double) single = !single;
      else if (character === '"' && !single) double = !double;
      else if (!single && !double && character === "(") depth += 1;
      else if (!single && !double && character === ")") depth -= 1;
      if (depth === 0) break;
      index += 1;
    }
  }
  return { inner: text.slice(start + 2, index), end: index + 1 };
}

/**
 * Split shell text into the simple commands it contains.
 *
 * Command substitutions are scanned as well as the command containing them,
 * because `VERSION=$(npm publish)` runs a publish however unusual that is, and a
 * gate that only looked at the outer assignment would miss it.
 *
 * `eval`, `bash -c` and their siblings receive the same treatment one level
 * deeper: their string argument is re-tokenised, so a publish smuggled through
 * an interpreter is enumerated alongside a plain one. Recursion is bounded --
 * shell text that nests evaluators more than a handful of levels deep is not
 * something this repository writes, and an unbounded walk over hostile input is
 * a denial of service rather than a stronger audit.
 *
 * @param text - Shell text, typically one file or one manifest script body.
 * @param depth - Current evaluator recursion depth; callers pass nothing.
 * @returns Every simple command found, outermost first.
 */
export function tokenizeCommands(text: string, depth = 0): ShellCommand[] {
  if (depth > 8) return [];
  const commands: ShellCommand[] = [];
  const nested: string[] = [];
  let command: ShellCommand = [];
  let value = "";
  let quoted = false;
  let startsQuoted = false;
  let started = false;

  const endWord = (): void => {
    if (!started) return;
    command.push({ value, quoted, startsQuoted });
    value = "";
    quoted = false;
    startsQuoted = false;
    started = false;
  };
  const endCommand = (): void => {
    endWord();
    if (command.length > 0) commands.push(command);
    command = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "#" && !started) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      endCommand();
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      index += 1;
      if (next === undefined) break;
      if (next === "\n") continue;
      value += next;
      if (!started) startsQuoted = false;
      started = true;
      continue;
    }
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      value += text.slice(index + 1, end);
      quoted = true;
      if (!started) startsQuoted = true;
      started = true;
      index = end;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        const inner = text[index]!;
        if (inner === "\\") {
          const next = text[index + 1];
          if (next !== undefined) {
            if (next !== "\n") value += next;
            index += 2;
            continue;
          }
          index += 1;
          continue;
        }
        if (inner === "`" || (inner === "$" && text[index + 1] === "(")) {
          const { inner: body, end } = readSubstitution(text, index);
          nested.push(body);
          index = end;
          continue;
        }
        value += inner;
        index += 1;
      }
      quoted = true;
      if (!started) startsQuoted = true;
      started = true;
      continue;
    }
    if (character === "$" && text[index + 1] === "{") {
      // `${name[0]}` is one word. The `{` here opens a parameter expansion, not
      // a brace group, so ending the command on it splits the expansion into
      // `$`, `name[0]` and whatever followed -- which reads
      // `${program[0]} publish` as a command named `publish`, and hides a
      // publish that reaches the shell through an expansion.
      let braces = 0;
      let end = index + 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "{") braces += 1;
        else if (text[end] === "}" && (braces -= 1) === 0) break;
      }
      value += text.slice(index, end + 1);
      index = end;
      if (!started) startsQuoted = false;
      started = true;
      continue;
    }
    if (character === "`" || (character === "$" && text[index + 1] === "(")) {
      const { inner, end } = readSubstitution(text, index);
      nested.push(inner);
      index = end - 1;
      if (!started) startsQuoted = false;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      endWord();
      continue;
    }
    if (isOperatorStart(character)) {
      // `2>&1` is one redirection, not a command ended by a backgrounding `&`.
      // The `&` belongs to the word only while that word is still an operator
      // awaiting its target.
      if (character === "&" && (/^[0-9]*[<>]>?$/.test(value) || (!started && text[index + 1] === ">"))) {
        value += character;
        started = true;
        continue;
      }
      endCommand();
      continue;
    }
    value += character;
    if (!started) startsQuoted = false;
    started = true;
  }
  endCommand();

  for (const body of nested) commands.push(...tokenizeCommands(body, depth + 1));
  for (const found of [...commands]) {
    const name = commandName(found);
    if (name === "find") {
      const args = commandArguments(found);
      for (let index = 0; index < args.length; index += 1) {
        const marker = args[index]!.value;
        if (marker !== "-exec" && marker !== "-execdir") continue;
        const end = args.slice(index + 1).findIndex(({ value }) => value === ";" || value === "+");
        if (end === -1) continue;
        const tail = args.slice(index + 1, index + 1 + end);
        if (tail.length > 0) commands.push(...tokenizeCommands(tail.map((token) => token.value).join(" "), depth + 1));
      }
    }
    // A YAML key's value is shell text, and it may arrive as ONE quoted word:
    // `run: "npm publish"` leaves a single token holding the whole command, so
    // the value has to be re-scanned rather than read as a program name.
    // A leading `- ` list marker may sit before the key.
    const keyAt = found[0]?.value === "-" ? 1 : 0;
    const key = found[keyAt];
    const bodyToken = found[keyAt + 1];
    const quotedBody = bodyToken?.quoted === true && /[\s;&|]/.test(bodyToken.value);
    if (key !== undefined && !key.startsQuoted && quotedBody && /^[A-Za-z_][A-Za-z0-9_-]*:$/.test(key.value)) {
      const body = found.slice(keyAt + 1).map((token) => token.value).join(" ");
      if (body.length > 0) commands.push(...tokenizeCommands(body, depth + 1));
    }
    // Every reading, not just the first: `sudo -u root bash -c '…'` resolves to
    // `root` on the primary reading, so recursing only there never reaches the
    // evaluator at all.
    for (const candidate of commandCandidates(found)) {
      const candidateName = commandName(candidate);
      if (candidateName === undefined || !SHELL_EVALUATORS.has(candidateName)) continue;
      const words = candidate.slice(1).map((argument) => argument.value);
      // The shell joins an evaluator's words with a space and evaluates the
      // result, so `eval "npm pub" "lish"` runs a publish that scanning each
      // argument on its own never sees. The join keeps the OPTION words too: drop
      // them and `eval "npm" "publish" "--provenance"` reconstructs as an
      // unattested publish and fails a workflow that is in fact attested.
      // `eval` joins every argument, so scanning its individual words would
      // invent commands that the shell never executes (`eval "npm publish"
      // "--provenance"`). Interpreters with a command-string option still need
      // the individual non-option readings because their option grammar is not
      // fully known here; the joined reading preserves flags after the script.
      const bodies = candidateName === "eval"
        ? new Set([words.join(" ")])
        : new Set([...words.filter((word) => !word.startsWith("-")), words.join(" ")]);
      for (const body of bodies) commands.push(...tokenizeCommands(body, depth + 1));
    }
  }
  return commands;
}

/**
 * True when an unquoted word is a redirection operator rather than a command word.
 *
 * A redirection and its target are not part of the command the shell runs, so
 * `> /dev/null npm publish` runs npm. A scan that reads words in order sees `>`
 * as the program and audits nothing. The forms accepted here are the ones a
 * workflow actually writes: the plain operators, a file-descriptor prefix
 * (`2>`, `2>>`), the duplicating forms (`>&`, `2>&1`, `&>`), and the read-write
 * form `<>`. `<>` has to be named explicitly: it is not `<` followed by `>`, so
 * without it the operator was read as a joined redirection that consumes no
 * target, its target `/dev/null` became the command word, and the real
 * `npm publish` after it was never audited.
 *
 * @param token - One command word.
 * @returns True when the word is a redirection operator.
 */
function isRedirection(token: ShellToken): boolean {
  if (token.startsQuoted) return false;
  return /^(?:[0-9]*(?:>>?|<>|<<?<?)&?[0-9-]*|&>>?)$/.test(token.value);
}

/**
 * Drop a command's redirections, so only the words it runs remain.
 *
 * An operator written apart from its target (`> file`) consumes the word after
 * it; one written joined to it (`>file`, `2>&1`) consumes nothing further.
 *
 * @param command - One simple command's tokens.
 * @returns The command without its redirections.
 */
function withoutRedirections(command: ShellCommand): ShellCommand {
  const kept: ShellCommand = [];
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (!isRedirection(token)) {
      // A joined form such as `>file` or `2>&1` is one word and takes no target.
      if (!token.startsQuoted && /^(?:[0-9]*>>?|[0-9]*<<?<?|&>>?)[^\s]/.test(token.value)) continue;
      kept.push(token);
      continue;
    }
    // A bare operator takes the next word as its target.
    if (!/&[0-9-]$/.test(token.value)) index += 1;
  }
  return kept;
}

/**
 * Walk past the words that precede the program a command runs.
 *
 * Three kinds of word are not the program: a leading `NAME=value` assignment, a
 * wrapper listed in `COMMAND_PREFIXES`, and -- only once a wrapper has been
 * seen -- that wrapper's own options. The last rule is what reaches the publish
 * in `npx --yes npm publish`; it stays behind the wrapper condition so that a
 * command whose own first word is an option is still reported as written rather
 * than silently re-pointed at one of its arguments.
 *
 * An option's separate value (`sudo -u root npm publish`) is not skipped,
 * because which options take a value differs per wrapper, and guessing wrong
 * would move the reported program rather than merely widen the search.
 *
 * @param command - One simple command's tokens.
 * @returns The index of the program word, or the command's length when there is none.
 */
function skipCommandPrefix(command: ShellCommand): number {
  let index = 0;
  let sawPrefix = false;
  while (index < command.length) {
    const token = command[index]!;
    if (!token.startsQuoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      index += 1;
      continue;
    }
    const base = basename(token.value);
    if (COMMAND_PREFIXES.has(base)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    const second = command[index + 1];
    if (second !== undefined && TWO_WORD_PREFIXES.get(base)?.has(second.value) === true) {
      sawPrefix = true;
      index += 2;
      continue;
    }
    if (sawPrefix && !token.startsQuoted && token.value.startsWith("-")) {
      index += 1;
      continue;
    }
    // A YAML key carries the command as its value: `run: npm publish` runs npm,
    // and reading `run:` as the program audits nothing. Workflow files are
    // scanned as raw text, so the key is a word like any other. Only a leading
    // key is consumed, and only one, so an argument that merely ends in a colon
    // is untouched.
    // A YAML list marker precedes the key on the same line: `- run: npm publish`.
    if (index === 0 && !token.startsQuoted && token.value === "-") {
      sawPrefix = true;
      index += 1;
      continue;
    }
    if (index <= 1 && !token.startsQuoted && /^[A-Za-z_][A-Za-z0-9_-]*:$/.test(token.value)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/**
 * Name the program a command runs, or nothing when it runs none.
 *
 * Leading `NAME=value` assignments and wrapper words are skipped, and a path is
 * reduced to its basename so `/usr/local/bin/npm publish` is recognised. The
 * distinction this exists to draw is command *position*: `echo npm publish`
 * prints three words and publishes nothing, while the previous scan searched
 * the whole line for the word `npm` and counted it as an invocation.
 *
 * @param command - One simple command's tokens.
 * @returns The program's basename, or undefined for an empty or assignment-only command.
 */
export function commandName(input: ShellCommand): string | undefined {
  const command = withoutRedirections(input);
  const token = command[skipCommandPrefix(command)];
  return token === undefined ? undefined : basename(token.value);
}

/**
 * Enumerate every reading of a command that could name a program.
 *
 * `commandName` answers "what does this command run" and answers it once. That
 * is right for reporting and wrong for auditing, because a wrapper's options
 * are not all known: `sudo -u root npm publish` stops at `root`, since `-u`
 * takes a value and nothing here knows that. Enumerating the value-taking
 * options of every wrapper would be a list that silently goes stale, and each
 * omission is a publish that disappears from the audit.
 *
 * So once a wrapper has been consumed, every later word is also offered as a
 * possible program, with the words after it as its arguments. An auditor asking
 * "does any publish here lack an attestation" then cannot miss one behind a
 * wrapper option it has never heard of.
 *
 * The cost is noise, never a miss: `sudo -u npm publish` -- a user actually
 * named `npm` -- is offered as a publish that no shell would run. For a gate
 * whose failure mode is an unattested release, a spurious finding an operator
 * dismisses is the cheaper error.
 *
 * A command with no wrapper yields exactly one reading, so ordinary commands
 * are unaffected.
 *
 * @param command - One simple command's tokens.
 * @returns Each candidate reading, the command's own first.
 */
export function commandCandidates(input: ShellCommand): ShellCommand[] {
  const command = withoutRedirections(input);
  const start = skipCommandPrefix(command);
  const candidates: ShellCommand[] = [];
  if (start < command.length) candidates.push(command.slice(start));
  if (start === 0) return candidates;
  for (let index = start + 1; index < command.length; index += 1) {
    const token = command[index]!;
    if (token.value.startsWith("-")) continue;
    candidates.push(command.slice(index));
  }
  return candidates;
}

/**
 * List a command's arguments -- everything after its program name.
 *
 * @param command - One simple command's tokens.
 * @returns The argument tokens, in order.
 */
export function commandArguments(input: ShellCommand): ShellToken[] {
  const command = withoutRedirections(input);
  return command.slice(skipCommandPrefix(command) + 1);
}

/** A tracked file's path and contents. */
export interface SourceFile {
  /** Repository-relative path. */
  file: string;
  /** File contents. */
  text: string;
}

/**
 * Collapse shell and YAML line continuations so one logical command is one string.
 *
 * A backslash at end of line joins the next line; without this every multi-line
 * invocation looks like a set of fragments, none of which carries both the
 * version input and the date flag.
 *
 * @param text - Raw file contents.
 * @returns The same text with continuations joined.
 */
export function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

/**
 * A supported Bash array declaration, with quoted and escaped parentheses kept
 * inside the declaration rather than mistaken for its closing delimiter.
 *
 * Unsupported constructs such as command substitutions are deliberately left
 * unmatched. Their references then remain unresolved and the attestation audit
 * fails closed instead of guessing at an array's contents.
 */
const BASH_ARRAY_DECLARATION = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(((?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\\'"()])*)\)/g;

/**
 * Index bash array assignments so a shared options array can be expanded.
 *
 * The release workflows declare `common=( ... )` once and pass `"${common[@]}"`
 * to each invocation, precisely so the invocations cannot drift. A scan that
 * reads only the invocation line therefore sees none of the shared flags.
 * Quoted or escaped closing parentheses are members, not array boundaries; an
 * unsupported array shape is left unknown so verification fails closed.
 *
 * @param text - File contents with continuations already joined.
 * @returns Array name mapped to the flag text it holds.
 */
export function bashArrays(text: string): Map<string, string> {
  const arrays = new Map<string, string>();
  for (const match of text.matchAll(BASH_ARRAY_DECLARATION)) {
    arrays.set(match[1]!, match[2]!.replace(/\s+/g, " ").trim());
  }
  return arrays;
}

/** Mask executable substitutions without changing outer shell syntax. */
function maskSubstitutions(line: string): string {
  let masked = "";
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\") {
      const escaped = line[index + 1];
      masked += escaped === undefined ? "$DYNAMIC" : character + escaped;
      index += 1;
    } else if (character === "'" && !double) {
      single = !single;
      masked += character;
    } else if (character === '"' && !single) {
      double = !double;
      masked += character;
    } else if (!single && (character === "`" || (character === "$" && line[index + 1] === "("))) {
      const substitution = readSubstitution(line, index);
      masked += "$DYNAMIC";
      index = substitution.end - 1;
    } else {
      masked += character;
    }
  }
  return masked;
}

/** Return only a line's outer commands, masking executable substitutions. */
function topLevelCommands(line: string): ShellCommand[] {
  return tokenizeCommands(maskSubstitutions(line));
}

/** Mask brace groups that a pipe or background operator runs outside the parent shell. */
function maskExternalBraceGroups(line: string): string {
  const stack: number[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      continue;
    }
    if (single || double) continue;
    if (character === "{") stack.push(index);
    else if (character === "}") {
      const start = stack.pop();
      if (start === undefined) continue;
      let next = index + 1;
      while (line[next] === " " || line[next] === "\t") next += 1;
      const operator = line[next];
      const following = line[next + 1];
      if ((operator === "|" && following !== "|")
        || (operator === "&" && following !== "&" && following !== ">")) {
        ranges.push({ start, end: index + 1 });
      }
    }
  }
  if (ranges.length === 0) return line;
  const characters = [...line];
  for (const { start, end } of ranges) characters.fill(" ", start, end);
  return characters.join("");
}

/**
 * Return commands whose scalar mutations certainly run in the parent shell.
 *
 * The first command of a semicolon-delimited list runs unconditionally. A later
 * `&&`/`||` command is guarded, while either side of a pipe and a backgrounded
 * command runs outside the parent-shell state tracked by `shellScalars`.
 */
function parentShellStateCommands(line: string): ShellCommand[] {
  const masked = maskExternalBraceGroups(maskSubstitutions(line));
  const segments: Array<{ text: string; before: string; after: string }> = [];
  let start = 0;
  let before = "";
  let single = false;
  let double = false;
  let wordStarted = false;
  let wordStart = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    const character = masked[index];
    if (character === undefined) {
      segments.push({ text: masked.slice(start), before, after: "" });
      break;
    }
    if (character === "\\") {
      wordStarted = true;
      index += 1;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      wordStarted = true;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      wordStarted = true;
      continue;
    }
    if (single || double) {
      wordStarted = true;
      continue;
    }
    if (character === "#" && !wordStarted) {
      segments.push({ text: masked.slice(start, index), before, after: "" });
      break;
    }
    if (character === " " || character === "\t" || character === "\r") {
      wordStarted = false;
      wordStart = index + 1;
      continue;
    }
    // In `2>&1`, the ampersand is part of the redirection word rather than a
    // background operator, so it cannot change the assignment's shell scope.
    if (character === "&" && (/^[0-9]*[<>]>?$/.test(masked.slice(wordStart, index)) || masked[index + 1] === ">")) {
      wordStarted = true;
      continue;
    }
    if (character === ";" || character === "&" || character === "|" || character === "(" || character === ")") {
      const doubled = masked[index + 1] === character && (character === "&" || character === "|");
      const operator = doubled ? character + character : character;
      segments.push({ text: masked.slice(start, index), before, after: operator });
      index += doubled ? 1 : 0;
      start = index + 1;
      before = operator;
      wordStarted = false;
      wordStart = index + 1;
      continue;
    }
    wordStarted = true;
  }

  const stateCommands: ShellCommand[] = [];
  let status: boolean | undefined;
  for (const { text, before: preceding, after } of segments) {
    if (preceding === "" || preceding === ";") status = true;
    const executes = preceding === "&&" ? status === true
      : preceding === "||" ? status === false
        : preceding === "" || preceding === ";";
    const commands = tokenizeCommands(text);
    const command = commands.length === 1 ? commands[0] : undefined;
    if (executes && command !== undefined && after !== "|" && after !== "&") stateCommands.push(command);

    if (preceding === "|" || preceding === "&" || preceding === "(" || preceding === ")"
      || after === "|" || after === "&" || after === "(" || after === ")") {
      status = undefined;
    } else if (executes && command !== undefined) {
      const words = withoutRedirections(command);
      if (words.length === 1 && words[0]?.value === "true") status = true;
      else if (words.length === 1 && words[0]?.value === "false") status = false;
      else if (words.length > 0 && words.every((word) => {
        if (word.startsQuoted) return false;
        const binding = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(word.value);
        return binding !== null && isLiteralScalar(binding[1]!);
      })) status = true;
      else status = undefined;
    }
  }
  return stateCommands;
}

/** Shell builtins whose assignment operands persist in the current shell. */
const SCALAR_DECLARATIONS = new Set(["export", "readonly", "declare", "typeset"]);

/** A scalar value must remain inert when textually expanded and re-tokenised. */
function isLiteralScalar(value: string): boolean {
  return !/[$`"'();&|<>]/.test(value);
}

/**
 * Index scalar assignments so a command held in a variable can be audited.
 *
 * `CMD="npm publish"` followed by `$CMD` runs a publish that no scan of the
 * invocation line can see, because the invocation line contains no publish. The
 * assignment is where the command actually is. `NPM=npm` followed by
 * `$NPM publish` hides one the same way, so unquoted values are indexed too.
 *
 * A name is taken only where a line OPENS with one assignment carrying a fully
 * literal value and holds nothing else before its end or a `;`. `NPM=npm; cmd`
 * therefore binds, because the semicolon ends the assignment and the shell keeps
 * it afterwards, while `NPM=npm cmd` does not, because that binding lasts only
 * for the command it precedes. Requiring the line to OPEN with the assignment is
 * what keeps a `;` inside a comment from exposing one. That single rule keeps
 * the scan from inventing
 * bindings the shell never makes, each of which let an unattested publish
 * borrow a flag and pass the gate:
 *
 * - `# FLAG=--provenance` is a comment, and a comment is not a line that is
 *   only an assignment.
 * - `echo "config NPM=npm"` is a command with an argument, not an assignment.
 * - `FLAG=--provenance some-command` binds only for that one command; the shell
 *   does not keep it afterwards, so neither does this map.
 * - `$(FLAG=--provenance)` binds inside a subshell that the outer shell never
 *   sees.
 * - `NPM=npm$SUFFIX` and `NPM=npm$(printf foo)` are not literal. The value must
 *   match to the end of the line, so a prefix is never mistaken for the whole
 *   value -- the mistake that let a scan analyse a different command from the
 *   one the shell runs.
 *
 * `export NPM=npm`, a trailing `# comment` and a CRLF line ending are all still
 * assignments: refusing them left `$NPM` unresolved, and an attested publish
 * elsewhere in the file then satisfied the non-vacuity guard, so being too
 * strict here passes an unattested publish just as being too loose does.
 *
 * Escapes are honoured outside single quotes, so `NPM=npm\\ publish` is one word
 * holding a command while `CMD='"'"'a\\b'"'"' keeps its backslash as the shell does.
 * A value that still carries a substitution, backtick, quote or parenthesis
 * after unescaping is refused: inlining `pkg_name="$(node -p …)"` injects an
 * unbalanced parenthesis into an unrelated command, and the scan then reports
 * invocations that are not there while losing the one that is -- a false
 * verdict in both directions, which is worse than not resolving the variable.
 *
 * A binding cleared by `unset` is removed, so an expansion after the unset
 * resolves to empty in the map just as it does in the shell. Without this,
 * `FLAG=--provenance; unset FLAG` followed by `npm publish $FLAG` would borrow
 * the flag from a binding the shell no longer holds and pass the gate.
 *
 * Lines inside a here-document body are text fed to a command, not shell
 * assignments. An assignment-shaped line such as `FLAG=--provenance` inside a
 * `cat <<EOF ... EOF` block must not be indexed, or the same false pass opens.
 *
 * @param text - File contents with continuations already joined.
 * @returns Variable name mapped to the literal text it holds.
 */
export function shellScalars(text: string): Map<string, string> {
  const scalars = new Map<string, string>();
  // Keep the YAML block indentation separate from shell heredoc semantics.
  // Only <<- strips tabs; an ordinary << delimiter must otherwise match exactly.
  const heredocs: Array<{ delimiter: string; stripTabs: boolean; yamlIndent: string }> = [];
  for (const line of text.split("\n")) {
    const activeHeredoc = heredocs[0];
    if (activeHeredoc !== undefined) {
      const yamlNormalized = line.startsWith(activeHeredoc.yamlIndent)
        ? line.slice(activeHeredoc.yamlIndent.length)
        : line;
      const candidate = (activeHeredoc.stripTabs ? yamlNormalized.replace(/^\t+/, "") : yamlNormalized).replace(/\r$/, "");
      if (candidate === activeHeredoc.delimiter) heredocs.shift();
      continue;
    }

    const commands = topLevelCommands(line);
    for (const stateCommand of parentShellStateCommands(line)) {
      const command = withoutRedirections(stateCommand);
      const first = command[0];
      const plainBindings = command.map((token) => !token.startsQuoted
        ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token.value)
        : null);
      if (plainBindings.every((binding) => binding !== null)) {
        for (const binding of plainBindings) {
          if (isLiteralScalar(binding![2]!)) scalars.set(binding![1]!, binding![2]!);
        }
      }
      if (first !== undefined && !first.startsQuoted && SCALAR_DECLARATIONS.has(first.value)) {
        for (const token of command.slice(1)) {
          const binding = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token.value);
          if (binding !== null && isLiteralScalar(binding[2]!)) scalars.set(binding[1]!, binding[2]!);
        }
      }
      if (first?.value === "unset" && !first.startsQuoted) {
        for (const arg of command.slice(1).map((token) => token.value)) {
          if (arg === "-v") continue;
          if (arg === "-f") break;
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) scalars.delete(arg);
        }
      }
    }

    // Detect the operator from shell tokens, not raw text: quoted and commented
    // `<<EOF` text is not a heredoc. `<<<` remains a here-string. The shell also
    // accepts whitespace between `<<`/`<<-` and its delimiter.
    for (const command of commands) {
      for (let index = 0; index < command.length; index += 1) {
        const opener = command[index]!;
        let delimiter: string | undefined;
        let stripTabs = false;
        const joined = !opener.startsQuoted ? /^(?:.*?[^<])?[0-9]*<<(-?)([^<\s]+)$/.exec(opener.value) : null;
        if (joined !== null) {
          stripTabs = joined[1] === "-";
          delimiter = joined[2]!;
        } else if (!opener.startsQuoted && (opener.value === "<<" || opener.value === "<<-")) {
          stripTabs = opener.value === "<<-";
          delimiter = command[index + 1]?.value;
          index += 1;
        }
        if (delimiter !== undefined) {
          heredocs.push({ delimiter, stripTabs, yamlIndent: /^[ \t]*/.exec(line)![0] });
        }
      }
    }
  }
  return scalars;
}

/**
 * Expand `$name` and `${name}` references against the file's scalar assignments.
 *
 * An unknown name is left in place for the same reason an unknown array is:
 * erasing it would turn "not understood" into "carries no flags", which reads
 * as a pass.
 *
 * @param line - One logical command.
 * @param scalars - Scalar assignments from the same file.
 * @returns The command with known scalar references inlined.
 */
export function expandScalars(line: string, scalars: Map<string, string>): string {
  // One of the two alternatives always captures the name, so there is no
  // nameless match to guard against.
  return line.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced?: string, bare?: string) => scalars.get(braced ?? bare!) ?? whole);
}

/**
 * Expand Bash array references against the file's array declarations.
 *
 * Both whole-array forms (`"${name[@]}"` and `"${name[*]}"`) and indexed
 * elements (`${name[0]}`) are resolved. Indexed elements are tokenised from
 * the declaration so a quoted member keeps its single-word value. An unknown
 * name or out-of-range element is left untouched; the verifier rejects an
 * unresolved indexed expression when it could be the command word rather than
 * quietly treating it as a non-publish.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with known array references inlined.
 */
export function expandArrays(line: string, arrays: Map<string, string>): string {
  // Two passes rather than one alternation. A single pattern would hand the
  // callback one defined group and one undefined group per match, and the
  // narrowing needed to tell them apart leaves a branch no input can reach.
  // The two shapes are disjoint -- `[@]`/`[*]` against a decimal index -- so
  // matching them separately is the same substitution, stated once each.
  const whole = line.replace(
    /"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[@*\]\}"?/g,
    (match: string, name: string) => arrays.get(name) ?? match,
  );
  return whole.replace(
    /"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[(-?\d+)\]\}"?/g,
    (match: string, name: string, indexText: string) =>
      tokenizeCommands(arrays.get(name) ?? "")[0]?.[Number(indexText)]?.value ?? match,
  );
}

/** The outcome of one verifier run. */
export interface VerifierResult {
  /** Reasons the run failed; empty means it passed. */
  failures: string[];
  /** Lines describing what was checked, for the operator. */
  notes: string[];
}

