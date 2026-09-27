import { loadModule } from "pgsql-parser";

// Several unit suites call the synchronous parser directly. Loading the WASM
// module up front keeps each file independent of which file ran first, which
// matters once `bun test --parallel` spreads files across workers.
await loadModule();
