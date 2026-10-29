import { required } from "./invariants.js";
import { Command } from "commander";

/** A browse command treats a leading -- as the boundary between options and literal query text. */
export class QueryCommand extends Command {
  private literalWords: string[] | undefined;

  override parseOptions(args: string[]): ReturnType<Command["parseOptions"]> {
    this.literalWords = undefined;
    // Commander ends option parsing at -- but still dispatches a matching subcommand afterward.
    // Capture that suffix before dispatch, leaving option validation to Commander. Stop at the
    // first operand so action arguments (such as `add -- TITLE`) keep their ordinary meaning.
    for (let index = 0; index < args.length; index++) {
      const token = required(args[index], "expected args[index]");
      if (token === "--") {
        this.literalWords = args.slice(index + 1);
        return super.parseOptions(args.slice(0, index));
      }
      const equals = token.startsWith("--") ? token.indexOf("=") : -1;
      const flag = equals < 0 ? token : token.slice(0, equals);
      const option = this.options.find((candidate) => candidate.long === flag || candidate.short === flag);
      // Query options use booleans and required single values. Delegate everything else intact,
      // including unknown flags, help, and subcommands, so this adapter cannot swallow errors.
      if (!option || option.optional || option.variadic || (equals >= 0 && !option.required)) break;
      if (option.required && equals < 0) index++;
    }
    return super.parseOptions(args);
  }

  query(words: string[]): string | undefined {
    const selected = this.literalWords ?? words;
    return selected.length ? selected.join(" ") : undefined;
  }
}
