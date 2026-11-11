// npm run seed-official [-- <folder>]: publishes the official templates from
// seed/official/ (or the given folder) into the database in
// MARKETPLACE_DATA_DIR – the same as every server start does. Exits with 1
// when a package was invalid (the others are published all the same).
import { resolve } from "node:path";
import { seedOfficial, seedSummary, officialDir } from "../lib/official";
import { closeDb } from "../lib/db";

const dir = process.argv[2] ? resolve(process.argv[2]) : officialDir();
// One line per file below; only warnings go to the log as well.
const outcomes = await seedOfficial({ dir, log: { info: () => {}, warn: console.warn } });
for (const o of outcomes) console.log(`${o.result.padEnd(9)} ${o.file}${o.slug ? ` → /t/${o.slug}` : ""}${o.version ? ` v${o.version}` : ""}${o.reason ? ` (${o.reason})` : ""}`);
console.log(outcomes.length ? seedSummary(outcomes) : `No *.flowplan-template files in ${dir}.`);
closeDb();
process.exit(outcomes.some((o) => o.result === "invalid") ? 1 : 0);
