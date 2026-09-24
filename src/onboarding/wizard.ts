import { validateConfig } from "../config.js";
import type { BackendConfig, Config } from "../types.js";
import { providerLabel, terminalText } from "./theme.js";
import { validateCredential } from "./state.js";
import {
  WizardCancelled,
  type Choice,
  type Client,
  type CredentialStatus,
  type WizardServices,
  type WizardUI,
} from "./types.js";

const OPENAI_MODELS: Choice[] = [
  { value: "gpt-6-astra", label: "GPT-6 Astra", hint: "gpt-6-astra" },
  { value: "gpt-6-sol", label: "GPT-6 Sol", hint: "gpt-6-sol" },
  { value: "gpt-6-luna", label: "GPT-6 Luna", hint: "gpt-6-luna" },
  { value: "gpt-5.4", label: "GPT-5.4", hint: "gpt-5.4" },
];
const CLAUDE_MODELS: Choice[] = [
  {
    value: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    hint: "claude-opus-4-6",
  },
  {
    value: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "claude-sonnet-4-6",
  },
  {
    value: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "claude-haiku-4-5",
  },
];
const MODEL_CUSTOM = "__custom_model__";

export function validateModel(value: string): string | undefined {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)
    ? undefined
    : "Use a model/deployment ID without spaces or control characters.";
}
export function validateEndpoint(
  value: string,
  config: Config,
  protocol: "openai" | "anthropic",
): string | undefined {
  try {
    validateConfig({
      ...config,
      [protocol]: { ...config[protocol], baseUrl: value },
    });
  } catch {
    return "Use an HTTPS API base URL ending in /v1, with no key, query, or fragment. Localhost is allowed on another port.";
  }
  if (!new URL(value).pathname.replace(/\/+$/, "").endsWith("/v1"))
    return "Include the API version path, usually /v1 or /openai/v1.";
  return undefined;
}

async function chooseBackend(
  ui: WizardUI,
  config: Config,
  protocol: "openai" | "anthropic",
  detected?: BackendConfig,
): Promise<BackendConfig> {
  const current = config[protocol];
  const isOpenAI = protocol === "openai";
  const label = isOpenAI ? "OpenAI / Codex" : "Claude";
  const choices: Choice[] = [
    {
      value: "keep",
      label: `Keep ${providerLabel(current.baseUrl, protocol)}`,
      hint: terminalText(current.baseUrl),
    },
    ...(detected &&
    isOpenAI &&
    JSON.stringify(detected) !== JSON.stringify(current)
      ? [
          {
            value: "detected",
            label: "Use your existing Codex backend",
            hint: terminalText(detected.baseUrl),
          },
        ]
      : []),
    {
      value: "official",
      label: isOpenAI ? "OpenAI API" : "Anthropic API",
      hint: isOpenAI ? "api.openai.com" : "api.anthropic.com",
    },
    ...(isOpenAI
      ? [
          {
            value: "azure",
            label: "Azure AI Foundry",
            hint: "your Responses deployment",
          },
        ]
      : []),
    {
      value: "custom",
      label: "Custom endpoint",
      hint: isOpenAI
        ? "OpenAI Responses compatible"
        : "Anthropic Messages compatible",
    },
  ];
  const selected = await ui.select({
    message: `02 / provider · ${label}`,
    options: choices,
    initialValue: "keep",
  });
  let backend = structuredClone(current);
  if (selected === "detected" && detected) backend = structuredClone(detected);
  if (selected === "official") {
    const baseUrl = isOpenAI
      ? "https://api.openai.com/v1"
      : "https://api.anthropic.com/v1";
    backend = {
      ...backend,
      baseUrl,
      apiKeyEnv: isOpenAI ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
      authHeader: isOpenAI ? "authorization" : "x-api-key",
    };
  }
  if (selected === "azure" || selected === "custom") {
    const sameKind =
      providerLabel(current.baseUrl, protocol) === "Azure"
        ? selected === "azure"
        : selected === "custom";
    backend.baseUrl = await ui.text({
      message: `${label} API base URL`,
      ...(sameKind ? { initialValue: current.baseUrl } : {}),
      placeholder:
        selected === "azure"
          ? "https://YOUR-RESOURCE.services.ai.azure.com/openai/v1"
          : "https://your-provider.example/v1",
      validate: (value) => validateEndpoint(value, config, protocol),
    });
    backend.authHeader =
      selected === "azure"
        ? "api-key"
        : ((await ui.select({
            message: "How does this endpoint accept its API key?",
            options: [
              {
                value: "authorization",
                label: "Authorization: Bearer",
                hint: "OpenAI-compatible APIs",
              },
              { value: "api-key", label: "api-key", hint: "Azure" },
              {
                value: "x-api-key",
                label: "x-api-key",
                hint: "Anthropic-compatible APIs",
              },
            ],
            initialValue: backend.authHeader,
          })) as BackendConfig["authHeader"]);
    backend.apiKeyEnv = await ui.text({
      message: "Credential name",
      initialValue:
        selected === "azure" ? "AZURE_OPENAI_API_KEY" : backend.apiKeyEnv,
      validate: (value) =>
        /^[A-Z_][A-Z0-9_]*$/.test(value)
          ? undefined
          : "Use an environment variable name such as OPENAI_API_KEY.",
    });
  }
  const azure =
    providerLabel(backend.baseUrl, protocol) === "Azure" ||
    selected === "azure";
  const presets = azure ? [] : isOpenAI ? OPENAI_MODELS : CLAUDE_MODELS;
  const options: Choice[] = [
    {
      value: backend.model,
      label: terminalText(backend.model),
      hint: "current selection",
    },
    ...presets.filter((m) => m.value !== backend.model),
    {
      value: MODEL_CUSTOM,
      label: azure ? "Enter a deployment ID" : "Enter another model ID",
      hint: "use any model your provider supports",
    },
  ];
  const model = await ui.select({
    message: `03 / model · ${azure ? "Azure deployment" : label}`,
    options,
    initialValue: backend.model,
  });
  backend.model =
    model === MODEL_CUSTOM
      ? await ui.text({
          message: azure ? "Deployment ID" : "Model ID",
          initialValue: backend.model,
          validate: validateModel,
        })
      : model;
  return backend;
}

export type WizardOutcome = "saved" | "cancelled" | "service-failed";
export async function runWizard(
  ui: WizardUI,
  services: WizardServices,
  options: { environment?: NodeJS.ProcessEnv } = {},
): Promise<WizardOutcome> {
  const environment = options.environment ?? process.env;
  const initial = await services.load();
  let draft = structuredClone(initial.config);
  const secrets: Record<string, string> = {};
  let selection = "both";
  ui.intro();
  ui.note(
    initial.existing
      ? "Your current settings are loaded. Nothing changes until you confirm."
      : "Pick a route, choose models, then review. Nothing is saved until you confirm.",
    "before we start",
  );
  try {
    for (;;) {
      selection = await ui.select({
        message: "01 / routing · which clients do you want to configure?",
        options: [
          {
            value: "both",
            label: "Both directions",
            hint: "Claude → OpenAI · Codex → Claude",
          },
          {
            value: "claude",
            label: "Claude Code → OpenAI subagents",
            hint: "leave Codex settings as they are",
          },
          {
            value: "codex",
            label: "Codex → Claude subagents",
            hint: "leave Claude Code settings as they are",
          },
          {
            value: "none",
            label: "Backends only",
            hint: "choose models without editing either client",
          },
        ],
        initialValue: selection,
      });
      const clients: Client[] =
        selection === "both"
          ? ["claude", "codex"]
          : selection === "none"
            ? []
            : [selection as Client];
      // Codex still needs its original OpenAI/Azure endpoint for main-model traffic.
      draft.openai = await chooseBackend(
        ui,
        draft,
        "openai",
        initial.codexBackend,
      );
      if (selection !== "claude")
        draft.anthropic = await chooseBackend(ui, draft, "anthropic");
      ui.note(
        "The list contains suggested model IDs, not an account check. Azure uses your deployment name. No API requests are made during setup.",
        "models",
      );
      validateConfig(draft);
      const needed =
        selection === "claude"
          ? [draft.openai]
          : [draft.openai, draft.anthropic];
      const credentialStates = new Map<string, CredentialStatus>();
      for (const name of new Set(needed.map((backend) => backend.apiKeyEnv))) {
        const existing = await services.credential(name);
        if (existing) credentialStates.set(name, existing);
        const pending = Object.hasOwn(secrets, name);
        const canStoreEnv =
          !pending &&
          existing?.source === "environment" &&
          Boolean(environment[name]);
        const choice = await ui.select({
          message: `04 / credentials · ${name}`,
          options: [
            ...(pending || existing
              ? [
                  {
                    value: "keep",
                    label: pending
                      ? "Keep the key entered in this session"
                      : `Use the key from ${existing!.source}`,
                    hint:
                      pending || existing?.persistent
                        ? "available to the background service"
                        : "foreground only; not saved for the service",
                  },
                ]
              : []),
            ...(canStoreEnv
              ? [
                  {
                    value: "store-env",
                    label: "Save this environment key privately",
                    hint: "allow the login service to use it",
                  },
                ]
              : []),
            {
              value: "paste",
              label: "Paste an API key",
              hint: "masked input · saved with owner-only permissions",
            },
            {
              value: "later",
              label: "Set this up later",
              hint: "save configuration without activating new routes",
            },
          ],
          initialValue: pending || existing?.persistent ? "keep" : "paste",
        });
        if (choice === "paste") {
          secrets[name] = await ui.password({
            message: `Paste ${name}`,
            validate: (value) => {
              try {
                validateCredential(name, value);
              } catch {
                return "Enter a key without whitespace, quotes, or control characters.";
              }
              return undefined;
            },
          });
        } else if (choice === "store-env") {
          const value = environment[name]!;
          validateCredential(name, value);
          secrets[name] = value;
        } else if (choice === "later") {
          delete secrets[name];
          credentialStates.delete(name);
        }
      }
      // Do not save a key for a provider the user selected and then changed away from.
      const activeNames = new Set([
        draft.openai.apiKeyEnv,
        draft.anthropic.apiKeyEnv,
      ]);
      for (const name of Object.keys(secrets))
        if (!activeNames.has(name)) delete secrets[name];
      const startService = await ui.confirm(
        "05 / service · start now and keep running at login?",
        true,
      );
      if (!startService)
        ui.note(
          "The existing service is not stopped or restarted. If it is running, it keeps its loaded settings until you restart it.",
          "service left unchanged",
        );
      const available = new Set(Object.keys(secrets));
      const missing: string[] = [];
      for (const name of new Set(needed.map((backend) => backend.apiKeyEnv))) {
        const status = credentialStates.get(name);
        if (status && (!startService || status.persistent)) available.add(name);
        if (!available.has(name)) missing.push(name);
      }
      const problems: string[] = [];
      for (const client of clients) {
        const preview = await services.preview(client, draft, available);
        if (preview.status === "blocked")
          problems.push(`${client}: ${terminalText(preview.message)}`);
      }
      ui.preview(draft, clients, startService);
      if (clients.includes("codex"))
        ui.warn(
          "Codex keeps its main model, but uses direct function tools and v1 agents. Hosted web search is disabled for that session. You can restore it with arelay unsetup codex.",
        );
      if (clients.includes("claude"))
        ui.note(
          "Claude Code keeps executing tools. Deferred tool search is disabled so complete tool definitions can cross providers.",
          "Claude Code",
        );
      if (missing.length)
        ui.warn(
          `Not ready for ${startService ? "background" : "foreground"} requests: ${missing.join(", ")}. You can save the configuration and add keys later.`,
        );
      for (const problem of problems) ui.warn(problem);
      const canActivate =
        clients.length > 0 && !missing.length && !problems.length;
      const action = await ui.select({
        message: "06 / review · what would you like to do?",
        options: [
          {
            value: "activate",
            label: "Save and activate selected routes",
            hint: "back up client settings before changing them",
            disabled: !canActivate,
          },
          {
            value: "save",
            label: "Save backends only",
            hint: "existing client routes are not removed",
          },
          {
            value: "edit",
            label: "Change my selections",
            hint: "nothing has been saved",
          },
          {
            value: "cancel",
            label: "Cancel",
            hint: "leave everything unchanged",
          },
        ],
        initialValue: canActivate ? "activate" : "save",
      });
      if (action === "edit") continue;
      if (action === "cancel") throw new WizardCancelled();
      if (action === "activate" && !canActivate)
        throw new Error("Selected routes are not ready to activate");
      const appliedClients = action === "activate" ? clients : [];
      if (action === "save" && clients.length)
        ui.preview(draft, [], startService);
      if (
        !(await ui.confirm(
          `Write config${Object.keys(secrets).length ? " and private credentials" : ""}${appliedClients.length ? `, configure ${appliedClients.join(" + ")}` : ""}${startService ? ", and install/restart the login service" : ""}?`,
          true,
        ))
      )
        throw new WizardCancelled();
      const result = await ui.progress("saving your setup", () =>
        services.apply({
          config: draft,
          credentials: secrets,
          clients: appliedClients,
          startService,
        }),
      );
      if (result.service === "failed") {
        ui.warn(
          result.message ??
            "Configuration was saved, but the service could not start. Run arelay service install.",
        );
        ui.outro("settings saved · service needs attention");
        return "service-failed";
      }
      if (appliedClients.length)
        ui.note(
          "Restart the clients you configured. arelay status checks the service; arelay stats shows routed requests.",
          "next",
        );
      else
        ui.note(
          "Client settings were left as they were. Run arelay setup when you want to activate a route. Saved backend changes can still affect clients already using arelay.",
          "next",
        );
      ui.outro(
        result.service === "started"
          ? "saved · background service enabled · arelay setup to change it"
          : "saved · service unchanged · arelay setup to change it",
      );
      return "saved";
    }
  } catch (error) {
    if (!(error instanceof WizardCancelled)) throw error;
    ui.cancel("Setup cancelled. No configuration changes were saved.");
    return "cancelled";
  } finally {
    // Best-effort release of references; JavaScript strings cannot be securely zeroed.
    for (const name of Object.keys(secrets)) delete secrets[name];
  }
}
