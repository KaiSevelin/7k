/**
 * What a provider is.
 *
 * A provider turns the IR into files for one target — C#, Bicep, SQL Server, TypeScript. D48 puts
 * implementations outside the language, so this file is not a specification of *how* anything is
 * generated. It is the shape of the hand-over, and the two promises either side makes.
 *
 * **The provider's promise is D48's: it may fail, never weaken.** A provider that cannot honour a
 * declaration refuses it. It never emits something quieter than what the model says — a pipe declared
 * `effectively-once within 24h` becoming an at-least-once subscription is the failure 7K exists to
 * prevent, and it is not improved by a warning in a build log.
 *
 * **The run's promise is that the provider sees a whole model.** Selection decides what is *written*,
 * never what is *known*: a service generated on its own still resolves the pipes it publishes to, in
 * packages nobody asked to emit.
 */

import type { Decl, DeclKind, LinkedModel } from "@sevenk/core";
import type { Loss } from "./loss.js";
import type { OptionSpec } from "./options.js";
import type { NameTable } from "./names.js";

/**
 * A file a provider wants written.
 *
 * `path` is relative to the entry's output directory, with forward slashes. The host owns where that
 * directory is — and whether there is one at all, since Spider shows artifacts without writing any. A
 * provider never learns an absolute path, which is what keeps output relocatable, a golden-file test
 * honest, and a provider incapable of touching a disk.
 */
export interface Artifact {
  readonly path: string;
  readonly content: string;
  /**
   * The declarations this file was generated from, qualified.
   *
   * Provenance, and only a provider can know it: a path is a convention, not a fact. It is what lets a
   * tool answer "where did this file come from" by pointing at the model rather than by guessing from
   * a filename — and what lets Spider light up the declaration when you click the file.
   *
   * Optional because a provider may legitimately emit something derived from the model as a whole: a
   * project file, a registry, an index.
   */
  readonly from?: readonly string[];
  /**
   * What this file does not express.
   *
   * Legitimate for a *descriptive* artifact — a JSON Schema cannot carry a cross-field invariant, and
   * saying so is the honest thing. Not a way to ship an executable artifact that does less than the
   * model: that is a `Refusal`.
   */
  readonly losses: readonly Loss[];
}

/**
 * Something the provider cannot do.
 *
 * Carried as data rather than thrown, because a run reports every refusal from every provider at once.
 * Stopping at the first would be the generator equivalent of a compiler that reports one error.
 */
export interface Refusal {
  /** The declaration this is about, qualified: `shop.payments.commands`. */
  readonly at: string;
  /** What the model asks for, in the model's words: `effectively-once within 24h`. */
  readonly declared: string;
  /** Why this provider cannot do it, in the provider's own terms. */
  readonly because: string;
  /**
   * What the provider would write anyway, under `--draft`.
   *
   * Present when the gap can be carried *in the artifact* — a `#error`, a throwing stub, a resource that
   * fails validation. That is what makes forgiving generation safe: the defect travels with the code
   * rather than only with the report, so partial output cannot be mistaken for finished output.
   *
   * Absent when there is nothing honest to write, and then nothing is written for it even in a draft.
   */
  readonly draft?: readonly Artifact[];
}

/**
 * Where a declaration landed in the generated code.
 *
 * **What a host cannot work out and a provider cannot avoid knowing.** The model says `reacts
 * PlaceOrder from inbound`, so anyone can see that `OrderService` handles that message; nobody but the
 * provider knows the handler is called `HandlePlaceOrder`, because that name is the provider's own
 * convention applied to the model. A tool that wanted to set a breakpoint on it would otherwise have to
 * learn one naming convention per target, which is exactly the coupling D48 keeps out.
 *
 * **Reported, not predicted.** This is produced in the same pass that writes the file, from the same
 * function that names the method — so the symbol reported is the symbol written. D108 declined an
 * `emitsFor` predicate for the opposite reason: it would have been a second implementation of what
 * `generate` decides, with nothing able to check that the two agree. This one cannot disagree with
 * itself, and `path` is checked against the artifacts the provider handed back.
 *
 * Optional, because a provider with nothing useful to point at — Bicep names no handler — reports none.
 */
export interface GeneratedSymbol {
  /** The declaration this is about, qualified. For a handler, the message being handled. */
  readonly at: string;
  /** The service whose handler this is, qualified. Absent for anything that is not one. */
  readonly on?: string;
  /**
   * What kind of thing the symbol names.
   *
   * `handler` is the one a debugger wants: a function that runs when a message arrives. `type` is the
   * generated shape of a message or record, and `service` the class or module that holds the handlers.
   */
  readonly kind: "handler" | "type" | "service";
  /** What a debugger would break on, as that language spells it: `Shop.OrderService.HandlePlaceOrder`. */
  readonly symbol: string;
  /** The artifact that holds it, as `Artifact.path`. Checked against what was emitted. */
  readonly path?: string;
}

/** Everything one provider produced for one entry. */
export interface Generated {
  readonly artifacts: readonly Artifact[];
  readonly refusals: readonly Refusal[];
  /**
   * Where the declarations landed, for a tool that wants to point at the code rather than read it.
   *
   * Spider uses these to say which function handles a message and to offer a breakpoint on it — the
   * one thing standing between "Spider knows the model" and "Spider can stop your debugger on the
   * handler", and the only part of it a provider has to supply.
   */
  readonly symbols?: readonly GeneratedSymbol[];
}

/**
 * What a provider is handed.
 *
 * The same shape for every target, which is the point: a C# provider and a Bicep provider differ in
 * what they read and what they write, never in how they are called.
 *
 * **It is also the entire contact surface.** A provider is handed a model, some names and some options,
 * and returns text. It is given no filesystem, no manifest, no run and no reader — so a provider cannot
 * write a file, cannot know whether it is the CLI or Spider calling it, and cannot behave differently
 * depending on which. That is not a restriction a provider is asked to respect; it is the only thing it
 * can see.
 */
export interface Request {
  /**
   * The whole model, always.
   *
   * Not the selection. A provider resolves references into packages that are not being emitted, because
   * a model that did not resolve would not have checked, and the host refuses before calling anybody.
   */
  readonly model: LinkedModel;
  /** The declarations this entry asked to emit, in declaration order. */
  readonly selected: readonly Decl[];
  /**
   * Physical names, decided once for the whole run.
   *
   * A provider maps these to its own identifier conventions — casing in generated code is the
   * provider's decision (`10-grammar.md`) — but the name of anything two providers both refer to is
   * not. The C# that publishes to a topic and the Bicep that creates it have to agree, and they agree
   * by both being told rather than by both guessing.
   */
  readonly names: NameTable;
  /** How the output is to be split. A provider that cannot do the one asked for refuses the entry. */
  readonly layout: Layout;
  /** This entry's resolved options, after the rule chain. Typed by the provider. */
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * The options resolved for one declaration, after its matching rules.
   *
   * Separate from `options` because a rule may say more about `pipe:shop.payments.commands` than about
   * pipes generally, and the provider should not have to re-run the matcher to find out — which it
   * could not anyway, since it is never shown the rules.
   */
  optionsFor(decl: Decl): Readonly<Record<string, unknown>>;
}

/**
 * How a provider is asked to split its output.
 *
 * Declared rather than assumed, because single-file validity is language-specific: a C# provider can
 * concatenate into one file and a Bicep provider mostly cannot. A provider lists what it supports and
 * refuses the rest, instead of the host concatenating text it does not understand.
 */
export type Layout = "per-declaration" | "per-package" | "single";

export interface Provider {
  /** As a reader names it in a manifest: `csharp`. */
  readonly name: string;
  /** The exact target, for an artifact header: `C# 12 / .NET 8`. */
  readonly target: string;
  /** The layouts this provider can actually produce. */
  readonly layouts: readonly Layout[];
  /**
   * The declaration kinds this provider emits for.
   *
   * Declared for the same reason `layouts` is, and it is the same sentence with one word changed: a
   * provider lists what it can do with, instead of a host finding out by asking it to and seeing what
   * comes back. Without it the only way to learn that a Bicep provider has nothing to say about a
   * message is to generate and count the files, which costs a whole run and happens after whoever
   * asked has already asked.
   *
   * It is what lets a tool offer the right thing: Spider greys the providers that would produce
   * nothing for what you have selected, rather than listing four and leaving three of them silent.
   *
   * **A claim, and a checked one.** Every artifact carries the declarations it came `from`, so a
   * provider that declares `["pipe"]` and then emits a file from a message is reported by the run
   * (`provider-emitted-outside-kinds`) rather than quietly believed. That is the difference between
   * this and a declaration that would rot: an unenforceable claim about a provider's own behaviour
   * has no business in a contract, and this one is answerable by what the provider hands back.
   *
   * Kinds a provider reaches *through* count: C# emits a type for a `record` a selected message
   * holds, so `record` is one of its kinds even though nobody selects a record on its own.
   */
  readonly emits: readonly DeclKind[];
  /**
   * What this provider lets you adjust.
   *
   * How a message becomes C# is the provider's decision, and there is more than one good answer — so
   * the answers are options rather than something hard-coded, and a rule may vary them per
   * declaration. Declared rather than read out of an untyped bag so that a misspelled one is an error
   * instead of silence, and so that `--help` can list them.
   */
  readonly options: readonly OptionSpec[];
  generate(request: Request): Generated;
}
