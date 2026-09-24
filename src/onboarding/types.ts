import type { BackendConfig, Config } from "../types.js";

export type Client = "claude" | "codex";
export interface Choice {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}
export interface SelectQuestion {
  message: string;
  options: Choice[];
  initialValue?: string;
}
export interface TextQuestion {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}
export interface WizardUI {
  intro(): void;
  select(question: SelectQuestion): Promise<string>;
  text(question: TextQuestion): Promise<string>;
  password(question: TextQuestion): Promise<string>;
  confirm(message: string, initialValue: boolean): Promise<boolean>;
  note(message: string, title?: string): void;
  warn(message: string): void;
  preview(config: Config, clients: Client[], startService: boolean): void;
  progress<T>(message: string, action: () => Promise<T>): Promise<T>;
  outro(message: string): void;
  cancel(message: string): void;
}
export interface CredentialStatus {
  source: "environment" | "credentials file" | "Keychain";
  /** A service can read it without inheriting this shell's environment. */
  persistent: boolean;
}
export interface SetupPreview {
  status: "ready" | "managed" | "blocked";
  message: string;
}
export interface WizardInitialState {
  config: Config;
  existing: boolean;
  codexBackend?: BackendConfig;
}
export interface WizardPlan {
  config: Config;
  /** New secrets entered during this wizard, never included in a preview. */
  credentials: Record<string, string>;
  clients: Client[];
  startService: boolean;
}
export interface ApplyResult {
  service: "started" | "skipped" | "failed";
  message?: string;
}
export interface WizardServices {
  load(): Promise<WizardInitialState>;
  credential(name: string): Promise<CredentialStatus | undefined>;
  preview(
    client: Client,
    config: Config,
    availableKeys: ReadonlySet<string>,
  ): Promise<SetupPreview>;
  apply(plan: WizardPlan): Promise<ApplyResult>;
}
export class WizardCancelled extends Error {
  constructor() {
    super("Setup cancelled");
    this.name = "WizardCancelled";
  }
}
