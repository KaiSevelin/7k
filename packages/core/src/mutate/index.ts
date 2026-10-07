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
 *
 * `removeService` and `removePipe` are here and are local in that same way, with one rule between them:
 * **a mutation may cost something and say so, but it does not leave the model not checking out.**
 * Nothing in the language refers to a service by name — a saga's host is derived from its `reacts` —
 * so removing one is a cost to report. A pipe *is* referred to by name, so removing one underneath an
 * `emits` leaves an unresolved reference, and that is refused with the clauses named. Removing those
 * clauses here instead was declined: it turns one local edit into an edit across every service that
 * touched the pipe, which is a larger promise than anything else in this module makes.
 *
 * ### Scenarios, which are not part of the language and are edited here anyway
 *
 * `addScenario`, `addPublish`, `addExpect` and `addAdvance` write to a scenario file (`30-scenarios.md`,
 * a sibling specification). They are here for the reason everything else is: one implementation, three
 * front ends. The boundary that matters is the one Core already keeps — a scenario is checked *against*
 * the model and never changes what it means — and editing text is not that boundary. Without them the
 * editing story stopped at the model, so a saga's missing `undo` was one click away and a scenario was
 * unreachable.
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
  addAdvance,
  addExpect,
  addField,
  addMessage,
  addPipe,
  addPublish,
  addRecord,
  addSaga,
  addScenario,
  addService,
  addStep,
  carriersOf,
  emittersOf,
  removePipe,
  removeService,
  setDeadline,
  setTerminal,
  setUndo,
  connectEmit,
  connectReact,
  disconnectEmit,
  disconnectReact,
  referenceTo,
  rename,
  type Editable,
} from "./operations.js";
