# Published pm SDK capability floor

Audited main: `f345866a0e9b523b1cfc65968d8d113bd81007c0`. Required API floor: **2026.9.8**.

Declared host floor: `2026.10.15`. npm peer: `>=2026.10.15`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: assertInitializedTracker` | 2026.8.21 | 2026.8.20 | [index.ts:41](../index.ts#L41) |
| `@unbrained/pm-cli/sdk :: commitWorkspaceTransaction` | 2026.7.19 | 2026.7.18 | [reconcile.ts:5](../reconcile.ts#L5), [transfer.ts:5](../transfer.ts#L5) |
| `@unbrained/pm-cli/sdk :: EXIT_CODE` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2), [identity.ts:2](../identity.ts#L2) |
| `@unbrained/pm-cli/sdk :: generateItemId` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2) |
| `@unbrained/pm-cli/sdk :: getHistoryPath` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2) |
| `@unbrained/pm-cli/sdk :: hashDocument` | 2026.7.23 | 2026.7.22 | [identity.ts:2](../identity.ts#L2) |
| `@unbrained/pm-cli/sdk :: inspectCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:41](../index.ts#L41) |
| `@unbrained/pm-cli/sdk :: listAllItemMetadata` | 2026.7.13 | 2026.7.12 | [index.ts:41](../index.ts#L41) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2) |
| `@unbrained/pm-cli/sdk :: parseTags` | 2026.5.14 | 2026.5.12 | [reconcile.ts:5](../reconcile.ts#L5) |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [identity.ts:2](../identity.ts#L2), [reconcile.ts:5](../reconcile.ts#L5), [transfer.ts:5](../transfer.ts#L5), [index.ts:41](../index.ts#L41) |
| `@unbrained/pm-cli/sdk :: PmCliError` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2), [identity.ts:2](../identity.ts#L2), [index.ts:41](../index.ts#L41) |
| `@unbrained/pm-cli/sdk :: preserveMutationStdinTokenFields` | 2026.8.24 | 2026.8.23 | [identity.ts:2](../identity.ts#L2), [reconcile.ts:5](../reconcile.ts#L5), [transfer.ts:5](../transfer.ts#L5), [index.ts:41](../index.ts#L41) |
| `@unbrained/pm-cli/sdk :: readHistorySnapshot` | 2026.9.8 | 2026.9.7 | [item-access.ts:2](../item-access.ts#L2) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2), [transfer.ts:5](../transfer.ts#L5) |
| `@unbrained/pm-cli/sdk :: resolveItemTypeRegistry` | 2026.5.14 | 2026.5.12 | [item-access.ts:2](../item-access.ts#L2) |
| `@unbrained/pm-cli/sdk :: resolveTypeSynonym` | 2026.7.23 | 2026.7.22 | [reconcile.ts:5](../reconcile.ts#L5) |
| `@unbrained/pm-cli/sdk :: runWithActiveExtensions` | 2026.7.21 | 2026.7.20 | [identity.ts:2](../identity.ts#L2) |
| `@unbrained/pm-cli/sdk :: setActiveExtensionHooks` | 2026.7.23 | 2026.7.22 | [identity.ts:2](../identity.ts#L2) |
| `@unbrained/pm-cli/sdk :: suppressHostOutput` | 2026.7.15 | 2026.7.14 | [index.ts:41](../index.ts#L41) |
| `@unbrained/pm-cli/sdk :: update` | 2026.7.7 | 2026.7.6 | [identity.ts:2](../identity.ts#L2) |
| `@unbrained/pm-cli/sdk :: verifyHistoryEntries` | 2026.7.24 | 2026.7.23 | [item-access.ts:2](../item-access.ts#L2) |
| `@unbrained/pm-cli/sdk :: writeFileAtomic` | 2026.5.14 | 2026.5.12 | [reconcile.ts:5](../reconcile.ts#L5), [sidecar.ts:6](../sidecar.ts#L6), [transfer.ts:5](../transfer.ts#L5) |
| `BeforeMutationHookContext.before` | 2026.8.2 | 2026.8.1 | [identity.ts:83](../identity.ts#L83) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [reconcile.ts:522](../reconcile.ts#L522), [sidecar.ts:326](../sidecar.ts#L326), [transfer.ts:410](../transfer.ts#L410), [index.ts:2677](../index.ts#L2677), [index.ts:2743](../index.ts#L2743), [index.ts:2788](../index.ts#L2788) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [identity.ts:106](../identity.ts#L106), [reconcile.ts:513](../reconcile.ts#L513), [transfer.ts:405](../transfer.ts#L405), [index.ts:2678](../index.ts#L2678), [index.ts:2740](../index.ts#L2740), [index.ts:2788](../index.ts#L2788) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [identity.ts:106](../identity.ts#L106), [reconcile.ts:511](../reconcile.ts#L511), [reconcile.ts:514](../reconcile.ts#L514), [reconcile.ts:528](../reconcile.ts#L528), [reconcile.ts:533](../reconcile.ts#L533), [sidecar.ts:324](../sidecar.ts#L324), [sidecar.ts:325](../sidecar.ts#L325), [sidecar.ts:327](../sidecar.ts#L327), [sidecar.ts:328](../sidecar.ts#L328), [transfer.ts:400](../transfer.ts#L400), [transfer.ts:406](../transfer.ts#L406), [transfer.ts:407](../transfer.ts#L407), [transfer.ts:416](../transfer.ts#L416), [transfer.ts:419](../transfer.ts#L419), [transfer.ts:420](../transfer.ts#L420), [index.ts:2677](../index.ts#L2677), [index.ts:2678](../index.ts#L2678), [index.ts:2702](../index.ts#L2702), [index.ts:2732](../index.ts#L2732), [index.ts:2788](../index.ts#L2788) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [identity.ts:106](../identity.ts#L106), [reconcile.ts:520](../reconcile.ts#L520), [reconcile.ts:529](../reconcile.ts#L529), [reconcile.ts:532](../reconcile.ts#L532), [transfer.ts:405](../transfer.ts#L405), [transfer.ts:412](../transfer.ts#L412), [transfer.ts:419](../transfer.ts#L419), [index.ts:2678](../index.ts#L2678), [index.ts:2702](../index.ts#L2702), [index.ts:2743](../index.ts#L2743), [index.ts:2788](../index.ts#L2788) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [identity.ts:101](../identity.ts#L101), [reconcile.ts:542](../reconcile.ts#L542), [sidecar.ts:342](../sidecar.ts#L342), [transfer.ts:435](../transfer.ts#L435), [index.ts:2652](../index.ts#L2652), [index.ts:2685](../index.ts#L2685), [index.ts:2746](../index.ts#L2746), [index.ts:2747](../index.ts#L2747), [index.ts:2791](../index.ts#L2791), [index.ts:2792](../index.ts#L2792) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [index.ts:2625](../index.ts#L2625) |
| `ExtensionApi.registerImporter` | 2026.5.1 | 2026.3.12 | [index.ts:2589](../index.ts#L2589) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [index.ts:2573](../index.ts#L2573) |
| `ImportExportContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:2592](../index.ts#L2592) |
| `ImportExportContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:2593](../index.ts#L2593) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:2592](../index.ts#L2592), [index.ts:2593](../index.ts#L2593), [index.ts:2628](../index.ts#L2628) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:2593](../index.ts#L2593), [index.ts:2628](../index.ts#L2628) |
| `PmClient.close` | 2026.7.6 | 2026.7.5 | [reconcile.ts:464](../reconcile.ts#L464) |
| `PmClient.create` | 2026.7.6 | 2026.7.5 | [reconcile.ts:455](../reconcile.ts#L455), [transfer.ts:302](../transfer.ts#L302), [index.ts:1199](../index.ts#L1199) |
| `PmClient.get` | 2026.7.6 | 2026.7.5 | [reconcile.ts:413](../reconcile.ts#L413), [reconcile.ts:441](../reconcile.ts#L441), [reconcile.ts:447](../reconcile.ts#L447) |
| `PmClient.listAllComplete` | 2026.8.18 | 2026.8.17 | [identity.ts:54](../identity.ts#L54), [reconcile.ts:244](../reconcile.ts#L244), [transfer.ts:412](../transfer.ts#L412), [index.ts:1942](../index.ts#L1942) |
| `PmClient.restore` | 2026.7.7 | 2026.7.6 | [reconcile.ts:463](../reconcile.ts#L463) |
| `PmClient.schemaAddField` | 2026.7.9 | 2026.7.8 | [identity.ts:28](../identity.ts#L28) |
| `PmClient.schemaListFields` | 2026.7.9 | 2026.7.8 | [identity.ts:26](../identity.ts#L26) |
| `PmClient.update` | 2026.7.6 | 2026.7.5 | [reconcile.ts:456](../reconcile.ts#L456), [index.ts:1199](../index.ts#L1199) |
| `WorkspaceTransactionTransitionContext.transition` | 2026.7.19 | 2026.7.18 | [reconcile.ts:485](../reconcile.ts#L485) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.7 | `c455dbda90d6f5aff55b23517683376ea6ab74d4a1540f3f8274590b1687c47e` |
| 2026.7.8 | `b892cce02e555decd3f0d09af0d2a5d8817494fe577e357ffaea84ef385a9b6a` |
| 2026.7.9 | `87600f77a82d5e66c8ac05f120b435a0fb22b5fad42ae5db4540bb4ca45a01ea` |
| 2026.7.12 | `a612224324e3ae91e2fc8c25f83d9a65fc13db66914aeb04ee65e16a523521be` |
| 2026.7.13 | `10d5b0f8787c643cb8caf58f656cc95097f6ac84fcdaa6ff59911780fcd894a5` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.18 | `44b48fe680cf330254a4ab8d42b55cbcee81ba5cf21e4d4550b40413265d64b9` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.20 | `6fbc1d789477491e007d03396dbf1dd2f09376220059887faf6f9d50668a6b08` |
| 2026.7.21 | `99151effed0e40579f01629f135a73384cb8e8f922c6c63da497638507009452` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.8.1 | `242013e81ed2c4329a3cb20d3e70fa58f6dbb627d00c2c1e883562e786850f80` |
| 2026.8.2 | `c9f8e516319ba4d6609ea0272e4fa70360668531c379ec54b29df8aa418293e3` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
| 2026.8.20 | `4a613893a4b1deffb92b12b2b6651a16b371cef2c2657dc4dcac52de41321156` |
| 2026.8.21 | `bbc0ccb9df0d7979563d384b778c30cb2858c9e63949d694475b776ec8c70aff` |
| 2026.8.23 | `31fdc154c4af68d64b3d4edc5d47e53c0e0a03f9e69f5b67222d3901bce67592` |
| 2026.8.24 | `c334544b8bb73a436b022b95621ef8151381790168800c080ee5cbe81e852b08` |
| 2026.9.7 | `9befaac9056ce94b2dff006e0fe2329c0b0c18479bf9c9f9027684789387c7ae` |
| 2026.9.8 | `529c08a4cb65507f86dc3f9b7efd673a031c6491156ae753c0a058d0d48e10bc` |
