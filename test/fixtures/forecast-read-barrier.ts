/** Pause real contract-file I/O at an IPC barrier without replacing filesystem results. */
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const file = process.env.BEADS_FORECAST_BARRIER_FILE;
const point = process.env.BEADS_FORECAST_BARRIER_POINT;
if (!file || (point !== "opened" && point !== "statted") || !process.send) throw new Error("Missing forecast barrier configuration");

/** Let the parent mutate its real fixture, then resume the actual reader. */
async function barrier(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.once("message", message => message === "continue" ? resolve() : reject(new Error("Invalid barrier response")));
    process.send!(point, error => { if (error) reject(error); });
  });
  // The CLI/SDK child must be able to exit after producing its receipt.
  process.disconnect!();
}

const originalOpen = fs.open;
let intercepted = false;
fs.open = async (...args: Parameters<typeof originalOpen>) => {
  const handle = await originalOpen(...args);
  if (args[0] === file && !intercepted) {
    intercepted = true;
    if (point === "opened") await barrier();
    else {
      const originalStat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", { value: async () => {
        const info = await originalStat();
        await barrier();
        return info;
      } });
    }
  }
  return handle;
};
syncBuiltinESMExports();
