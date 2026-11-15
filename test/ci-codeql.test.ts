/** Match GitHub path filters against executable and inert tracker changes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { matchesGlob } from 'node:path';
import { parseDocument } from 'yaml';

test('CodeQL includes executable tracker changes and filters tracker data', () => {
  const document = parseDocument(readFileSync('.github/workflows/codeql.yml', 'utf8'), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  for (const event of ['push', 'pull_request']) {
    const ignored: string[] = workflow.on[event]['paths-ignore'];
    for (const extension of ['js', 'mjs', 'cjs', 'ts']) {
      for (const file of [`.agents/pm/check.${extension}`, `.agents/pm/scripts/check.${extension}`]) {
        assert.equal(ignored.some(pattern => matchesGlob(file, pattern)), false, file);
      }
    }
    for (const file of ['.agents/pm/tasks/a.toon', '.agents/pm/history/a.jsonl', '.agents/pm/settings.json', 'README.md']) {
      assert.equal(ignored.some(pattern => matchesGlob(file, pattern)), true, file);
    }
  }
});
