import { AGENTS, type Agent } from "./types.js";

const SETTING_FOR: Record<Agent, string> = {
  claude: "showClaude",
  codex: "showCodex",
  qwen: "showQwen",
  pi: "showPi",
  "command-code": "showCommandCode",
};

export function enabledAgents(settings: Readonly<Record<string, unknown>>): Agent[] {
  return AGENTS.filter((agent) => settings[SETTING_FOR[agent]] !== false);
}
