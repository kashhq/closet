import pino from 'pino';
import {
  createLoggerTo,
  type ErrorFields,
  type Logger,
  type LogLevel,
} from '../../src/logger';

interface LogFields {
  msg: string;
  /** The module's child logger name (`logger.child({ logger })`). */
  logger?: string;
  /** An error logged as `{ err }`, through closet's serializer (errorFields). */
  err?: ErrorFields;
  [key: string]: unknown;
}

export interface LogRecord extends LogFields {
  level: string;
}

/**
 * A pino destination that keeps every line it is written, parsed: what the
 * app would have logged, for specs that assert on logging.
 * Records arrive synchronously, so a request's lines are all here once
 * inject() resolves.
 */
export class LogCapture {
  readonly records: LogRecord[] = [];

  write(line: string): void {
    // The app's loggers write the label (src/logger.ts); a bare pino, the number.
    const { level, ...fields } = JSON.parse(line) as LogFields & {
      level: string | number;
    };
    this.records.push({
      ...fields,
      level: typeof level === 'number' ? pino.levels.labels[level] : level,
    });
  }

  /** Messages at `level`, oldest first; from one module's logger when `logger` is given. */
  messages(level: string, logger?: string): string[] {
    return this.records
      .filter(
        (record) =>
          record.level === level &&
          (logger === undefined || record.logger === logger),
      )
      .map((record) => record.msg);
  }

  /**
   * The lines one operation wrote (logOp, src/web/op-log.ts: `op` and its
   * fields), oldest first: what a spec asserts of an action's log, by its
   * fields, never its message.
   */
  ops(op: string): LogRecord[] {
    return this.records.filter((record) => record.op === op);
  }

  /**
   * messages(), each followed by its error's message (`msg: err.message`):
   * a line names the failure through `{ err }`, never in its text.
   */
  messagesWithError(level: string, logger?: string): string[] {
    return this.records
      .filter(
        (record) =>
          record.level === level &&
          (logger === undefined || record.logger === logger),
      )
      .map((record) =>
        record.err?.message
          ? `${record.msg}: ${record.err.message}`
          : record.msg,
      );
  }

  /** Every line as its message, error message and stack: for "never logged" checks. */
  text(): string {
    return this.records
      .map((record) =>
        [record.msg, record.err?.message, record.err?.stack].join('\n'),
      )
      .join('\n');
  }

  /**
   * The lines at `minLevel` and above written since `mark` (a
   * `records.length` read before the work), each with its error's stack:
   * for a failure message that has to name the server-side cause.
   */
  describeFrom(mark: number, minLevel: string): string {
    const floor = pino.levels.values[minLevel];
    const lines = this.records
      .slice(mark)
      .filter((record) => pino.levels.values[record.level] >= floor)
      .map((record) =>
        [`${record.level}: ${record.msg}`, record.err?.stack]
          .filter(Boolean)
          .join('\n'),
      );
    return lines.length === 0
      ? `nothing logged at ${minLevel} or above`
      : `the app logged:\n${lines.join('\n')}`;
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** A logger for a unit under test, and what it wrote. */
export function captureLogs(level: LogLevel = 'trace'): {
  logger: Logger;
  logs: LogCapture;
} {
  const logs = new LogCapture();
  return { logger: createLoggerTo(level, logs), logs };
}
