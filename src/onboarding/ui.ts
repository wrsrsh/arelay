import * as prompts from "@clack/prompts";
import type { Readable, Writable } from "node:stream";
import { palette, routePreview, terminalText } from "./theme.js";
import { WizardCancelled, type WizardUI } from "./types.js";

export function interactiveTerminal(
  inputTTY = process.stdin.isTTY,
  outputTTY = process.stdout.isTTY,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = (value: string | undefined) =>
    value !== undefined &&
    value !== "" &&
    value !== "0" &&
    value.toLowerCase() !== "false";
  return Boolean(
    inputTTY &&
    outputTTY &&
    env.TERM !== "dumb" &&
    !enabled(env.CI) &&
    !enabled(env.ARELAY_NO_TUI),
  );
}

export function createTerminalUI(
  options: {
    input?: Readable;
    output?: Writable & { columns?: number; isTTY?: boolean };
    color?: boolean;
  } = {},
): WizardUI {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  // Some SSH/PTY sessions report no size until the first resize event.
  if (output.isTTY && !output.columns) output.columns = 80;
  const color =
    options.color ??
    Boolean(
      output.isTTY &&
      !("NO_COLOR" in process.env) &&
      process.env.TERM !== "dumb",
    );
  const c = palette(color);
  const common = { input, output };
  const unwrap = <T>(value: T): Exclude<T, symbol> => {
    if (prompts.isCancel(value)) throw new WizardCancelled();
    return value as Exclude<T, symbol>;
  };
  return {
    intro() {
      prompts.intro(c.cyan("arelay"), common);
    },
    async select(question) {
      return unwrap(
        await prompts.select({ ...common, ...question, maxItems: 7 }),
      );
    },
    async text(question) {
      return unwrap(
        await prompts.text({
          ...common,
          ...question,
          validate: (value) => question.validate?.(value ?? ""),
        }),
      );
    },
    async password(question) {
      return unwrap(
        await prompts.password({
          ...common,
          message: question.message,
          mask: "*",
          clearOnError: true,
          validate: (value) => question.validate?.(value ?? ""),
        }),
      );
    },
    async confirm(message, initialValue) {
      return unwrap(
        await prompts.confirm({ ...common, message, initialValue }),
      );
    },
    note(message, title) {
      prompts.note(message, title ? c.cyan(title) : undefined, common);
    },
    warn(message) {
      prompts.note(message, "before you continue", common);
    },
    preview(config, clients, startService) {
      prompts.note(
        routePreview(config, clients, startService, color),
        c.cyan("your setup"),
        common,
      );
    },
    async progress<T>(message: string, action: () => Promise<T>): Promise<T> {
      // A committed multi-file operation must finish or roll back before exiting.
      // Do not let the spinner's default Ctrl+C handler terminate mid-write.
      const pendingSignals = () => {};
      process.on("SIGINT", pendingSignals);
      process.on("SIGTERM", pendingSignals);
      const spin = prompts.spinner({
        ...common,
        onCancel: pendingSignals,
        styleFrame: c.cyan,
      });
      spin.start(message);
      try {
        const result = await action();
        spin.stop("configuration saved");
        return result;
      } catch (error) {
        spin.error("setup could not finish");
        throw error;
      } finally {
        process.removeListener("SIGINT", pendingSignals);
        process.removeListener("SIGTERM", pendingSignals);
      }
    },
    outro(message) {
      prompts.outro(c.green(message), common);
    },
    cancel(message) {
      prompts.cancel(terminalText(message), common);
    },
  };
}
