import type { NativeConfig } from "./native/types.js";

// API payloads are open-ended wire objects. Validate supported variants at the boundary.
export type JsonObject = Record<string, any>;

export interface BackendConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  authHeader: "authorization" | "api-key" | "x-api-key";
}

export interface Config {
  version: 1;
  mode?: "native" | "api";
  native?: NativeConfig;
  port: number;
  openai: BackendConfig;
  anthropic: BackendConfig;
  routes: { claudeSubagentModel: string; codexSubagentModel: string };
  requestTimeoutMs: number;
  maxBodyBytes: number;
}

export interface Paths {
  dir: string;
  config: string;
  credentials: string;
  state: string;
  logs: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
