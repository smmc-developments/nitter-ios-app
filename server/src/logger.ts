export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase() || 'info';
  if (!LOG_LEVELS.includes(normalized as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
  }
  return normalized as LogLevel;
}

export function isLogLevelEnabled(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
  return priorities[messageLevel] >= priorities[configuredLevel];
}

export interface Logger {
  (message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LogEntry {
  id: number;
  ts: string;
  level: Exclude<LogLevel, 'silent'>;
  scope: string;
  message: string;
}

const configuredLevel = parseLogLevel(process.env.LOG_LEVEL);
const bufferSize = parseBufferSize(process.env.LOG_BUFFER_SIZE);
const buffer: LogEntry[] = [];
let nextLogId = 1;

function parseBufferSize(value: string | undefined): number {
  const parsed = Number(value ?? '1000');
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 100_000 ? parsed : 1_000;
}

/// Recent log entries, newest last. `after` is an exclusive id watermark so
/// clients can poll incrementally; `latest` is the current maximum id.
export function getLogs(options: { limit?: number; after?: number; minLevel?: LogLevel } = {}): {
  entries: LogEntry[];
  latest: number;
} {
  const limit = options.limit ?? 200;
  const after = options.after ?? 0;
  const minLevel = options.minLevel ?? 'debug';
  const entries = buffer
    .filter(entry => entry.id > after && isLogLevelEnabled(entry.level, minLevel))
    .slice(-limit);
  return { entries, latest: buffer.length ? buffer[buffer.length - 1].id : 0 };
}

export function createLogger(scope: string, defaultLevel: Exclude<LogLevel, 'silent'> = 'info'): Logger {
  const write = (level: Exclude<LogLevel, 'silent'>, message: string) => {
    if (!isLogLevelEnabled(level, configuredLevel)) return;
    const ts = new Date().toISOString();
    const line = `[${ts}] [${scope}] [${level}] ${message}`;
    buffer.push({ id: nextLogId++, ts, level, scope, message });
    if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  const logger = ((message: string) => write(defaultLevel, message)) as Logger;
  logger.debug = message => write('debug', message);
  logger.info = message => write('info', message);
  logger.warn = message => write('warn', message);
  logger.error = message => write('error', message);
  return logger;
}
