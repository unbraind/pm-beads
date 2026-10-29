/** Shared supported SDK graph loader; never derive peer locations from executable paths. */
import { createRequire } from "node:module";
import type * as PmGraphSdk from "@unbrained/pm-cli/sdk/graph";
const require = createRequire(import.meta.url);
let loaded: typeof PmGraphSdk | undefined;
/** Acquire the public peer graph API lazily, only for operations that need graph analysis. */
export function beadsGraphSdk(): typeof PmGraphSdk {
  return loaded ??= require("@unbrained/pm-cli/sdk/graph") as typeof PmGraphSdk;
}
