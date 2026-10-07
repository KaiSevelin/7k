/**
 * A canonical-JSON body, read from text.
 *
 * Here because two things need it and neither should re-derive it: a mutation handed a body has to know
 * the text parses before writing it into a file, and a tool that composed one has to be able to read its
 * own output back. The alternative was for `addPublish` to refuse a body outright on the grounds that it
 * could not know whether the text was legal — the honest answer while nothing could check, and the wrong
 * one now that something can.
 *
 * **Not `JSON.parse`.** A 7K body is canonical JSON as `01-kernel.md` section 7 defines it, which is not
 * quite JSON: a key may be written bare (`orderId: "ORD-1"`), a duration and a version are literals of
 * their own, and `$auto` is a generator directive lexed as an identifier. `JSON.parse` rejects the first
 * and mangles the rest, so this goes through the real lexer and the real body parser — which also means
 * what it accepts is exactly what a file would accept, rather than an approximation of it.
 *
 * In `parser/` rather than beside `jsonValue` in `literals.ts`, because the parser depends on that module
 * and not the other way round.
 */

import { lex } from "../lexer.js";
import { jsonValue, type JsonValue } from "../literals.js";
import { json } from "./common.js";
import { Cursor } from "./cursor.js";

export function readJsonBody(text: string): { value: JsonValue } | { problem: string } {
  const lexed = lex(text, "<body>");
  if (lexed.diagnostics.length > 0) return { problem: lexed.diagnostics[0]!.message };

  const cursor = new Cursor(lexed.tokens, "<body>");
  const node = json(cursor);
  if (cursor.diagnostics.length > 0) return { problem: cursor.diagnostics[0]!.message };
  // One value and nothing after it: a body with a stray token behind it parses as far as the value and
  // would then write something the file cannot read.
  if (!cursor.done) return { problem: "there is more here than one value" };
  return { value: jsonValue(node) };
}
