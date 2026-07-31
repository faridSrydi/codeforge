// Stub for @anthropic-ai/sandbox-runtime
export class SandboxManager {
  constructor() {}
  static isSupportedPlatform() { return false; }
  static isSandboxingEnabled() { return false; }
  start() { return Promise.resolve(); }
  stop() { return Promise.resolve(); }
}
export const SandboxRuntimeConfigSchema = {};
export class SandboxViolationStore {
  constructor() {}
  getViolations() { return []; }
}
