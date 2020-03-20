export enum LoggerLevel {
  Debug = 'debug',
  Log = 'log',
  Info = 'info',
  Warn = 'warn',
  Error = 'error'
}

export const levelToNumber = (level: LoggerLevel) => {
  switch (level) {
    case LoggerLevel.Debug:
      return 0;
    case LoggerLevel.Log:
      return 1;
    case LoggerLevel.Info:
      return 2;
    case LoggerLevel.Warn:
      return 3;
    case LoggerLevel.Error:
      return 4;
  }
};

export interface LoggerPayload {
  level: LoggerLevel;
  args: any[];
  timestamp: Date;
  namespaces: string[];
}

export type LoggerMiddleware = (payload: LoggerPayload, next: LoggerOutput) => void;
export type LoggerOutput = (payload: LoggerPayload) => void;

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

export class Logger {
  private output: LoggerOutput;
  private readonly namespaces: string[] = [];

  constructor(namespace?: string, parent?: Logger) {
    const parentNamespace = parent?.namespaces || [];
    if (namespace) {
      this.namespaces = parentNamespace.concat(namespace);
    } else {
      this.namespaces = parentNamespace;
    }

    if (parent) {
      this.output = payload => parent.output(payload);
    } else {
      this.output = noop;
    }
  }

  public debug(...args: any[]) {
    this.logRaw(LoggerLevel.Debug, args);
  }

  public log(...args: any[]) {
    this.logRaw(LoggerLevel.Log, args);
  }

  public info(...args: any[]) {
    this.logRaw(LoggerLevel.Info, args);
  }

  public warn(...args: any[]) {
    this.logRaw(LoggerLevel.Warn, args);
  }

  public error(...args: any[]) {
    this.logRaw(LoggerLevel.Error, args);
  }

  public logRaw(level: LoggerLevel, args: any[]) {
    this.output({
      level,
      args,
      timestamp: new Date(),
      namespaces: this.namespaces
    });
  }

  public addMiddleware(...middlewares: LoggerMiddleware[]) {
    const output = middlewares.reduceRight(
      (output: LoggerOutput, middleware) => payload => middleware(payload, output),
      this.output
    );
    this.output = output;
  }

  public outOutput(output: LoggerOutput) {
    this.output = output;
  }

  public createLogger(namespace?: string) {
    return new Logger(
      namespace ||
        Math.random()
          .toString(36)
          .substr(2, 5),
      this
    );
  }

  public static defaultInstance = new Logger('');
}

export const consoleOutput = (payload: LoggerPayload, next: LoggerOutput) => {
  const labels: any[] = [payload.timestamp, payload.level.toUpperCase().padStart(5)];
  if (payload.namespaces.length) {
    labels.push('[' + payload.namespaces.join(':') + ']:');
  } else {
    labels[1] += ':';
  }
  console[payload.level](...labels, ...payload.args);
  next(payload);
};

export const createFilterOutput = (level: LoggerLevel) => {
  const num = levelToNumber(level);
  return (payload: LoggerPayload, next: LoggerOutput) => {
    if (levelToNumber(payload.level) >= num) {
      next(payload);
    }
  };
};

export const createBufferedOutput = (level = LoggerLevel.Warn, size = 50) => {
  const buffer: LoggerPayload[] = [];
  const num = levelToNumber(level);
  return (payload: LoggerPayload, next: LoggerOutput) => {
    if (levelToNumber(payload.level) >= num) {
      for (const log of buffer) {
        next(log);
      }
      next(payload);
      buffer.length = 0;
    } else {
      buffer.push(payload);
      if (buffer.length > size) {
        buffer.shift();
      }
    }
  };
};

Logger.defaultInstance.addMiddleware(consoleOutput);

export default Logger.defaultInstance;
