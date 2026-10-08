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
 * **`moveToPackage`** is here, and all three of the specification's claims about it are true: it is the
 * largest, it is the only one that moves text between files, and it is the only one that can change a
 * message's wire type — which it reports. None of those is the hard part. The hard part is that a
 * reference's text depends on where it is read from, so a move changes the answer for every reference
 * *to* the declaration and every reference *inside* it, and an `import` is a consequence of that rather
 * than a warning about it. Whether the result still checks out is asked of `packageDependencies` with a
 * relocation, rather than reimplemented: a move that would leave a cycle or an upward tier dependency
 * is refused with the rule's own words.
 *
 * The data operations — `addValue`, `addRecord`, `addField`, `setConstraint` — are local in the same way
 * the connecting ones are, and are simply not written yet.
 *
 * `removeDecl` removes any declaration, and `removeService` and `removePipe` are the two wrappers that
 * name a kind. The rule here used to be **a mutation may cost something and say so, but it does not
 * leave the model not checking out**, and the second half of that was wrong — it was stricter than the
 * language. D20 requires a half-drawn model to parse, and `20-ir.md` section 5 describes the state a
 * removal leaves as one of the ordinary ones: *"a service with no pipes, an edge dragged into empty
 * space"*, where an unresolved reference is reported once at its own span and every dependent check
 * returns unknown rather than cascading. Editing is a process and a process has intermediate states;
 * refusing until everything pointing at a thing had been taken apart first was enforcing an order of
 * work nothing in the language asks for, and it made a connected pipe undeletable from an editor.
 *
 * So the rule is now **a mutation always says what it costs, and does not refuse a cost the language
 * itself tolerates.** What stays refused is what cannot be written at all: a declaration that is not
 * there, a file that was never parsed, a name already taken. Those are facts about the operation
 * rather than costs of it.
 *
 * Nothing rewrites a reference into a hole. `emits Work to inbound` is left exactly as written when
 * `inbound` goes: the name is the record of what was meant, it is what lets the pipe be put back or
 * another renamed into its place, and it is what the warning points at. What becomes unknown is the
 * resolution, which is the language's own answer and needs nothing written down.
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
  moveToPackage,
  removeDecl,
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
