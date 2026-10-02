/**
 * The mutation API (`20-ir.md` section 7).
 *
 * In Core because section 7 says who it is for: "Spider edits through this. So does any CLI refactor
 * command and any future LSP code action — **one implementation, three front ends**." A second
 * implementation of "what does adding an `emits` do to a file" is how three front ends come to disagree
 * about it.
 *
 * ### What is here
 *
 * The operations a graph editor needs to connect things up, which are also the local ones: an insertion
 * before a closing brace, the removal of one clause, an append to a package's file. Nothing rewrites text
 * it did not write.
 *
 * ### What is not, and why
 *
 * **`rename`** updates references across every file *and the sidecars, atomically* (section 7, and 6.4).
 * The references are the easy half; the sidecars are the half that matters, because `layout.json` and
 * `views.json` key on a declaration's name, and a rename that missed them would silently discard every
 * saved position and every lens entry that named the old one. That wants doing properly rather than
 * soon.
 *
 * **`moveToPackage`** is "the largest structural mutation in the API, the only one that moves text
 * between files, and the only one that can change a message's wire type — so it reports that consequence
 * before applying". A mutation that can change what is on the wire is not the second thing to build.
 *
 * The data operations — `addValue`, `addRecord`, `addField`, `setConstraint` — are local in the same way
 * the connecting ones are, and are simply not written yet.
 */

export {
  apply,
  applyAll,
  invert,
  isPossible,
  refuse,
  type Mutation,
  type TextEdit,
} from "./edit.js";

export {
  addPipe,
  addService,
  connectEmit,
  connectReact,
  disconnectEmit,
  disconnectReact,
  referenceTo,
  type Editable,
} from "./operations.js";
