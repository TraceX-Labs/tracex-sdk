// The few Node APIs @tracex/node uses (no @types/node dependency for the build)
declare module "node:os" {
  const os: { type(): string; release(): string; totalmem(): number };
  export default os;
}
declare const process: {
  version: string;
  arch: string;
  env: Record<string, string | undefined>;
  uptime(): number;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  listenerCount(event: string): number;
};
