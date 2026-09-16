export interface StrategySnapshot {
  id: string;
  version: string;
  code: string;
  resources: Record<string, string>;
  fingerprint: string;
}
export interface ProfileSnapshot {
  configPath: string;
  revision: string;
  files: Record<string, string>;
  active: {
    chunker: string;
    tokenizer: string;
    embedding: string;
    retrieval: string;
  };
  chunker: StrategySnapshot;
  tokenizer: StrategySnapshot;
}
