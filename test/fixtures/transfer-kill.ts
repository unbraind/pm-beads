/** Child-only crash probe: die after a real durable creation, before its chunk receipt. */
import { readFile } from 'node:fs/promises';
import { applyBeadsTransfer, type BeadsTransferPlan } from '../../transfer.ts';
const [pmRoot, file] = process.argv.slice(2);
const plan = JSON.parse(await readFile(file, 'utf8')) as BeadsTransferPlan;
await applyBeadsTransfer(pmRoot, plan, 'killed-transfer', {
  onRowTransition(context) { if (context.phase === 'after_create') process.kill(process.pid, 'SIGKILL'); },
});
