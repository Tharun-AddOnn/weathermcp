import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * Every log line goes to stderr. On the stdio transport, stdout is the JSON-RPC
 * channel - a stray console.log there corrupts the stream and the client drops
 * the connection with a parse error.
 */
export function log(msg: string): void {
  process.stderr.write(`[mcp-weather] ${msg}\n`);
}

/**
 * Mirrors log lines to the connected client as MCP `notifications/message`, so
 * a developer can watch the elicitation flow from inside the client's own log
 * panel instead of hunting for the server's stderr.
 *
 * Sending is best-effort: a client that never called `logging/setLevel`, or one
 * that has already disconnected, must not break a tool call.
 */
export class McpLogger {
  constructor(
    private readonly server: Server,
    private readonly name: string,
  ) {}

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const suffix = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
    log(`${level}: ${message}${suffix}`);
    void this.server
      .sendLoggingMessage({ level, logger: this.name, data: { message, ...data } })
      .catch(() => {
        /* client is not listening for logs; stderr already has it */
      });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.emit('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.emit('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.emit('warning', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.emit('error', message, data);
  }
}
