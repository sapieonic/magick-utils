export type ModelDef = { id: string; name: string; tag: string; icon: string };

export const MODELS: ModelDef[] = [
  { id: "claude", name: "Claude Sonnet 4.5", tag: "Anthropic", icon: "Sparkles" },
  { id: "deepseek", name: "DeepSeek V3", tag: "Fast & cheap", icon: "Zap" },
  { id: "kimi", name: "Kimi K2", tag: "Long context", icon: "Bot" },
];
