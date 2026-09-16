import { existsSync } from 'node:fs';
import { loadConfig, type EchoConfig } from './config.js';
import { EchoError } from './profile-store.js';
export function configurationRuntime(path: string, initial?: EchoConfig) {
  const runtimeKey = (config: EchoConfig) =>
    JSON.stringify({
      ...config.runtime,
      sqlite_busy_timeout_ms: config.runtime.sqlite_busy_timeout_ms ?? 5000,
    });
  let boot = initial,
    latest = initial;
  return {
    async snapshot(): Promise<EchoConfig | undefined> {
      if (!existsSync(path)) {
        if (boot)
          throw new EchoError(
            'CONFIG_RELOAD',
            'Configuration is missing; query was not executed',
            'Restore the configuration file',
          );
        return undefined;
      }
      let candidate: EchoConfig;
      try {
        candidate = await loadConfig(path);
      } catch (error) {
        throw new EchoError(
          'CONFIG_RELOAD',
          'Configuration reload failed; query was not executed: ' +
            (error instanceof Error ? error.message : String(error)),
          'Fix the configuration, then retry',
        );
      }
      if (
        boot &&
        (candidate.database !== boot.database ||
          runtimeKey(candidate) !== runtimeKey(boot))
      )
        throw new EchoError(
          'RESTART_REQUIRED',
          'Database or runtime settings changed; query was not executed',
          'Restart the MCP service to apply database/runtime changes',
        );
      boot ??= candidate;
      latest = candidate;
      return candidate;
    },
    latest: () => latest,
  };
}
