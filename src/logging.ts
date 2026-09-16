import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { EchoConfig } from './config.js';
type Level = 'error' | 'warn' | 'info' | 'debug';
export function createLogger(config: EchoConfig['logging']) {
  const priorities = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
  return (level: Level, event: string, data: Record<string, unknown> = {}) => {
    if (!config.file || priorities[level] > priorities[config.level]) return;
    try {
      const fields: Record<string, number | boolean> = {};
      for (const key of [
        'duration_ms',
        'sources',
        'chunks',
        'results',
        'requests',
        'ready',
      ])
        if (typeof data[key] === 'number' || typeof data[key] === 'boolean')
          fields[key] = data[key];
      const line =
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          event: event.slice(0, 80),
          ...fields,
        }) + '\n';
      if (Buffer.byteLength(line) > config.max_file_bytes) return;
      mkdirSync(dirname(config.file), { recursive: true });
      if (
        existsSync(config.file) &&
        statSync(config.file).size + Buffer.byteLength(line) >
          config.max_file_bytes
      ) {
        const oldest = config.file + '.' + config.retain;
        if (existsSync(oldest)) unlinkSync(oldest);
        for (let i = config.retain - 1; i >= 1; i--)
          if (existsSync(config.file + '.' + i))
            renameSync(config.file + '.' + i, config.file + '.' + (i + 1));
        renameSync(config.file, config.file + '.1');
      }
      appendFileSync(config.file, line, { mode: 0o600 });
    } catch {
      // Logging must never corrupt MCP stdout or turn a successful query into a failure.
    }
  };
}
