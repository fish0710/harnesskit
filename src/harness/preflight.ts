import type { GateReport, Contract } from "../types.js";
import type { SandboxPolicy } from "./sandbox/types.js";

export type PreflightSeverity = "warning" | "error";

export interface PreflightFinding {
  id: string;
  severity: PreflightSeverity;
  message: string;
  source: "static" | "setup" | "contract" | "sandbox";
  contractId?: string;
}

export interface PreflightStep {
  label: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GatePreflightReport {
  outcome: "ready" | "not_ready" | "blocked";
  staticFindings: PreflightFinding[];
  setup: PreflightStep[];
  selectedContracts: string[];
  remoteContracts: string[];
  hostLocalContracts: string[];
  gateReport?: GateReport;
  readinessErrors: PreflightFinding[];
  productFailures: string[];
  sandbox?: { id: string; snapshot: string; retained: boolean };
}

export interface GateReadinessLintInput {
  contracts: Contract[];
  policy: SandboxPolicy;
}

export interface GateReadinessClassification {
  readinessErrors: PreflightFinding[];
  productFailures: string[];
}

const MISSING_DEFAULT_TOOLS = new Set(["git", "pnpm", "yarn", "bun"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shellWordPattern(word: string): RegExp {
  return new RegExp(
    `(^|[^A-Za-z0-9_./-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_/-]|$)`,
  );
}

function includesShellWord(command: string, word: string): boolean {
  return shellWordPattern(word).test(command);
}

function sourcesNvm(command: string): boolean {
  return /(?:^|[\s"'`])(?:source|\.)\s+\/usr\/local\/nvm\/nvm\.sh(?:[\s"'`;|&]|$)/.test(command);
}

function hasBareNvmUse(command: string): boolean {
  return includesShellWord(command, "nvm") &&
    /\bnvm\s+use\b/.test(command) &&
    !sourcesNvm(command);
}

function usesNvmInstall(command: string): boolean {
  return includesShellWord(command, "nvm") && /\bnvm\s+install\b/.test(command);
}

function commandMentionsMissingTool(command: string): string | undefined {
  for (const tool of MISSING_DEFAULT_TOOLS) {
    if (includesShellWord(command, tool)) return tool;
  }
  return undefined;
}

function bootstrapMentionsTool(command: string, tool: string): boolean {
  if (tool === "pnpm") {
    return /\bcorepack\s+enable(?:\s+pnpm\b|\b)/.test(command) ||
      /\bnpm\s+(?:install|i)\s+-g\s+pnpm\b/.test(command);
  }
  if (tool === "yarn") {
    return /\bcorepack\s+enable(?:\s+yarn\b|\b)/.test(command) ||
      /\bnpm\s+(?:install|i)\s+-g\s+yarn\b/.test(command);
  }
  if (tool === "bun") {
    return /\bnpm\s+(?:install|i)\s+-g\s+bun\b/.test(command) ||
      /curl\b[\s\S]*\bbun\.sh\/install\b[\s\S]*\|\s*bash\b/.test(command);
  }
  if (tool === "git") {
    return /\bapt(?:-get)?\s+install\b[\s\S]*\bgit\b/.test(command);
  }
  return false;
}

function setupBootstrapsTool(policy: SandboxPolicy, tool: string): boolean {
  return policy.gateSetup.some((command) => bootstrapMentionsTool(command, tool));
}

function contractCommandText(contract: Contract): string | undefined {
  if (contract.type === "command" || contract.type === "boot") {
    const cmd = typeof contract.cmd === "string" ? contract.cmd : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String).join(" ")
      : "";
    return cmd ? `${cmd} ${args}`.trim() : undefined;
  }
  if (contract.type === "structure") {
    const tool = typeof contract.tool === "string" ? contract.tool : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String).join(" ")
      : "";
    return tool ? `${tool} ${args}`.trim() : undefined;
  }
  return undefined;
}

function httpContractUsesLoopback(contract: Contract): boolean {
  if (contract.type !== "http" || !isRecord(contract.trigger)) return false;
  const trigger = contract.trigger;
  const values = [trigger.url, trigger.baseUrl].filter(
    (value): value is string => typeof value === "string",
  );
  return values.some((value) => {
    try {
      const host = new URL(value).hostname;
      return host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".localhost");
    } catch {
      return false;
    }
  });
}

function runtimeFailureText(value: string): boolean {
  const text = value.toLowerCase();
  return text.includes("command not found") ||
    text.includes(": not found") ||
    text.includes("nvm: not found") ||
    text.includes("nvm.sh") ||
    text.includes("cannot find module") ||
    text.includes("module not found") ||
    text.includes("missing script") ||
    text.includes("enoent") ||
    text.includes("network is unreachable") ||
    text.includes("could not resolve host") ||
    text.includes("temporary failure in name resolution") ||
    text.includes("name or service not known");
}

function resultText(result: GateReport["results"][number]): string {
  return [
    result.errorReason ?? "",
    ...result.violations.flatMap((violation) => [
      violation.what,
      violation.why,
      violation.how,
      violation.file ?? "",
    ]),
  ].filter(Boolean).join("\n");
}

function finding(
  id: string,
  severity: PreflightSeverity,
  message: string,
  source: PreflightFinding["source"],
  contractId?: string,
): PreflightFinding {
  return {
    id,
    severity,
    message,
    source,
    ...(contractId ? { contractId } : {}),
  };
}

export function lintGateReadiness(input: GateReadinessLintInput): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  input.policy.gateSetup.forEach((command, index) => {
    const label = `gateSetup.${index + 1}`;
    if (hasBareNvmUse(command)) {
      findings.push(finding(
        `${label}.nvm`,
        "error",
        "Gate setup uses bare nvm. Use bash -lc 'source /usr/local/nvm/nvm.sh && nvm use <version> && ...'.",
        "static",
      ));
    }
    if (usesNvmInstall(command)) {
      findings.push(finding(
        `${label}.nvm-install`,
        "error",
        "Gate setup uses nvm install. Gate /usr/local/nvm is not writable; use a snapshot with the Node version preinstalled.",
        "static",
      ));
    }
    if (includesShellWord(command, "claude")) {
      findings.push(finding(
        `${label}.claude`,
        "error",
        "Gate setup must not run claude; Gate snapshots are intentionally agent-free.",
        "static",
      ));
    }
    const tool = commandMentionsMissingTool(command);
    if (tool && !bootstrapMentionsTool(command, tool)) {
      findings.push(finding(
        `${label}.tool`,
        "error",
        `Gate setup uses ${tool}, which is not in the default Gate snapshot. Install or enable it before invoking it.`,
        "static",
      ));
    }
  });

  for (const contract of input.contracts) {
    const command = contractCommandText(contract);
    if (command) {
      if (hasBareNvmUse(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm`,
          "error",
          "Contract command uses bare nvm. Source /usr/local/nvm/nvm.sh in gateSetup or in an explicit bash wrapper.",
          "static",
          contract.id,
        ));
      }
      if (usesNvmInstall(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm-install`,
          "error",
          "Contract command uses nvm install. Install Node versions in the Gate snapshot or gateSetup, not during contract execution.",
          "static",
          contract.id,
        ));
      }
      if (includesShellWord(command, "claude")) {
        findings.push(finding(
          `contract.${contract.id}.claude`,
          "error",
          "Gate contracts must not run claude; Gate snapshots do not include model tooling.",
          "static",
          contract.id,
        ));
      }
      const tool = commandMentionsMissingTool(command);
      if (tool && !setupBootstrapsTool(input.policy, tool)) {
        findings.push(finding(
          `contract.${contract.id}.tool`,
          "error",
          `Contract uses ${tool}, which is not in the default Gate snapshot and is not bootstrapped by gateSetup.`,
          "static",
          contract.id,
        ));
      }
      if (
        /\b(?:npm|pnpm|yarn|bun|pip3?)\s+(?:install|ci)\b/.test(command) ||
        /\b(?:curl|wget)\b/.test(command)
      ) {
        findings.push(finding(
          `contract.${contract.id}.network`,
          "warning",
          "Contract command appears to fetch dependencies or network resources. Move dependency installation to gateSetup before Gate network policy is applied.",
          "static",
          contract.id,
        ));
      }
    }
    if (httpContractUsesLoopback(contract) && input.policy.gateSetup.length === 0) {
      findings.push(finding(
        `contract.${contract.id}.loopback`,
        "warning",
        "Loopback HTTP contract targets the Gate sandbox. Add gateSetup that starts and waits for the service.",
        "static",
        contract.id,
      ));
    }
  }

  return findings;
}

export function classifyGateReportReadiness(
  report: GateReport,
): GateReadinessClassification {
  const readinessErrors: PreflightFinding[] = [];
  const productFailures: string[] = [];

  for (const result of report.results) {
    const text = resultText(result);
    if (result.status === "error") {
      readinessErrors.push(finding(
        `contract.${result.id}.error`,
        "error",
        text || "Gate contract returned error",
        "contract",
        result.id,
      ));
      continue;
    }
    if (result.status === "fail" && runtimeFailureText(text)) {
      readinessErrors.push(finding(
        `contract.${result.id}.runtime`,
        "error",
        text,
        "contract",
        result.id,
      ));
      continue;
    }
    if (result.status === "fail") {
      productFailures.push(result.id);
    }
  }

  return { readinessErrors, productFailures };
}
