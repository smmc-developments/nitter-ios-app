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

const configuredLevel = parseLogLevel(process.env.LOG_LEVEL);

export function createLogger(scope: string, defaultLevel: Exclude<LogLevel, 'silent'> = 'info'): Logger {
  const write = (level: Exclude<LogLevel, 'silent'>, message: string) => {
    if (!isLogLevelEnabled(level, configuredLevel)) return;
    const line = `[${new Date().toISOString()}] [${scope}] [${level}] ${message}`;
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
