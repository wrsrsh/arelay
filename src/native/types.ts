export type NativeClient = "claude" | "codex";
export interface NativeWorkerConfig {
  command: string;
  model?: string;
}
export interface NativeConfig {
  enabled: boolean;
  codex?: NativeWorkerConfig;
  claude?: NativeWorkerConfig;
  timeoutMs: number;
  maxConcurrent: number;
  allowWrites: boolean;
}
export interface NativeAuth {
  installed: boolean;
  loggedIn: boolean;
  subscription: boolean;
  command?: string;
  message: string;
}
export interface NativeTask {
  target: NativeClient;
  task: string;
  cwd: string;
  model?: string;
  permission?: "read-only" | "workspace-write";
}
export interface NativeResult {
  target: NativeClient;
  text: string;
  durationMs: number;
}
export const defaultNativeConfig: NativeConfig = {
  enabled: false,
  timeoutMs: 600000,
  maxConcurrent: 3,
  allowWrites: false,
};
