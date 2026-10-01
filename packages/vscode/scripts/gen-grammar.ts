/**
 * Generates the TextMate grammar from Core's keyword set.
 *
 * A hand-written grammar would be a second copy of the keyword list, and it
 * would drift — exactly the failure `7k check` exists to prevent. So the
 * grammar is generated, and a test asserts the committed file is current.
 *
 *   npm run gen -w sevenk-vscode
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGrammar } from "../src/grammar.js";

const target = join(import.meta.dirname, "..", "syntaxes", "7k.tmLanguage.json");
writeFileSync(target, `${JSON.stringify(buildGrammar(), null, 2)}\n`, "utf8");
process.stdout.write(`wrote ${target}\n`);
