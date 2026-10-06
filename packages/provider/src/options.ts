/**
 * What a provider lets you adjust, declared by the provider.
 *
 * **How a message becomes C# is the provider's responsibility, and there is more than one good answer.**
 * A `record` with `init` setters, a sealed class, positional parameters, `System.Text.Json` or something
 * else — these are real choices with real trade-offs, and a provider that hard-coded one would be wrong
 * for somebody. So they are options, and a host's rule chain lets them be overridden per declaration:
 * the whole model one way, one awkward message another.
 *
 * They are **declared** rather than read out of an untyped bag for the same reason a selector that
 * matches nothing is an error: a manifest saying `messagetype` where the provider reads `messageType`
 * would otherwise do nothing at all, and look exactly like it worked. A declared option can also be
 * listed — `7k generate csharp --help` — which is how a uniform shell stays usable across targets whose
 * options cannot be uniform.
 *
 * **The line an option may not cross** is the one D48 draws. An option may change the *shape* of what is
 * generated. It may not change what the system *does*: no option makes an `effectively-once` pipe come
 * out at-least-once. That is not enforceable here — only the provider knows what its target can do — but
 * it is why an option is a choice between correct outputs, never a way to buy one by giving up another.
 */

export interface OptionSpec {
  /** As written in a manifest: `messageType`. */
  readonly name: string;
  /** One line, for `--help`. */
  readonly describe: string;
  readonly type: "string" | "boolean" | "number" | "enum";
  /** The permitted values, for `enum`. */
  readonly of?: readonly string[];
  readonly default?: unknown;
  /**
   * Where it may be set.
   *
   * `entry` is a decision about the whole output — a namespace, a target framework — and letting a rule
   * vary it per declaration would produce something that does not compile. `declaration` may be
   * overridden by a rule, which is what "adjust when needed" means in practice.
   */
  readonly scope: "entry" | "declaration";
}
