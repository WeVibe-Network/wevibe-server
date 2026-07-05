/**
 * Lightweight MCP-over-SSE client for the WeVibe dashboard (browser environment).
 */

import { getConfig } from '@/lib/config';
import type { ConnectionError } from '@/lib/diagnostics-types';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}

function parseJsonObject(raw: string): { [key: string]: JsonValue } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type PendingRequest = {
  resolve: (value: JsonValue | undefined) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WeVibeMcpClient {
  private readonly baseUrl: string;
  private readonly sseUrl: string;
  private eventSource: EventSource | null = null;
  private messageUrl: string | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private _connectPromise: Promise<void> | null = null;
  private _state: ConnectionState = 'disconnected';
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly errorListeners = new Set<(err: ConnectionError) => void>();
  private _lastError: ConnectionError | null = null;

  constructor(baseUrl?: string) {
    const resolvedBaseUrl = baseUrl ?? getConfig().mcpUrl;
    const normalized = resolvedBaseUrl.replace(/\/$/, '');
    this.baseUrl = normalized;
    this.sseUrl = `${normalized}/sse`;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get lastError(): ConnectionError | null {
    return this._lastError;
  }

  set onStateChange(fn: ((state: ConnectionState) => void) | null) {
    this.stateListeners.clear();
    if (fn) {
      this.stateListeners.add(fn);
    }
  }

  addStateListener(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  addErrorListener(listener: (err: ConnectionError) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private setState(state: ConnectionState): void {
    this._state = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch {
        // Listener errors should not break the client
      }
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return String(error);
  }

  private notifyErrorListeners(error: ConnectionError): void {
    for (const listener of [...this.errorListeners]) {
      try {
        listener(error);
      } catch {
        // Listener errors should not break the client
      }
    }
  }

  private captureError(rawMessage: string): void {
    const capturedAt = new Date().toISOString();
    const capturedError: ConnectionError = {
      message: rawMessage,
      url: this.sseUrl,
      at: capturedAt,
    };

    this._lastError = capturedError;
    this.notifyErrorListeners(capturedError);

    const updateWithProbeResult = (probeResult: string): void => {
      if (!this._lastError || this._lastError.at !== capturedAt) {
        return;
      }

      const enrichedError: ConnectionError = {
        message: `${rawMessage} · /health probe: ${probeResult}`,
        url: this.sseUrl,
        at: capturedAt,
      };

      this._lastError = enrichedError;
      this.notifyErrorListeners(enrichedError);
    };

    try {
      fetch(`${this.baseUrl}/health`).then(response => {
        updateWithProbeResult(`reachable (HTTP ${response.status})`);
      }).catch((error: unknown) => {
        updateWithProbeResult(this.toErrorMessage(error));
      });
    } catch (error) {
      updateWithProbeResult(this.toErrorMessage(error));
    }
  }

  async connect(): Promise<void> {
    if (this._state === 'connected' && this.eventSource?.readyState === EventSource.OPEN) {
      return;
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  private _doConnect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.onerror = null;
      this.eventSource.close();
      this.eventSource = null;
    }
    this.messageUrl = null;

    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      const eventSource = new EventSource(this.sseUrl);
      this.eventSource = eventSource;
      const connectionTimeoutMs = 15000;

      const timeout = setTimeout(() => {
        eventSource.onerror = null;
        eventSource.close();
        this.eventSource = null;
        this.setState('error');
        const message = `MCP SSE connection to ${this.sseUrl} timed out after ${connectionTimeoutMs}ms (server unreachable)`;
        this.captureError(message);
        reject(new Error(message));
      }, connectionTimeoutMs);

      const onEndpoint = (event: MessageEvent) => {
        eventSource.removeEventListener('endpoint', onEndpoint);

        const endpointPath = event.data;
        try {
          const origin = new URL(this.sseUrl).origin;
          this.messageUrl = origin + endpointPath;
        } catch (error) {
          clearTimeout(timeout);
          eventSource.onerror = null;
          eventSource.close();
          this.eventSource = null;
          this.setState('error');
          const message = `Invalid MCP endpoint URL from ${this.sseUrl}: ${this.toErrorMessage(error)}`;
          this.captureError(message);
          reject(new Error(message));
          return;
        }

        this.initialize().then(() => {
          clearTimeout(timeout);
          this.setState('connected');
          resolve();
        }).catch(err => {
          clearTimeout(timeout);
          eventSource.onerror = null;
          eventSource.close();
          this.eventSource = null;
          this.setState('error');
          const message = `MCP initialize handshake failed on ${this.sseUrl}: ${this.toErrorMessage(err)}`;
          this.captureError(message);
          reject(new Error(message));
        });
      };

      eventSource.addEventListener('endpoint', onEndpoint);

      eventSource.addEventListener('message', (event: MessageEvent) => {
        this.handleIncomingMessage(event.data);
      });

      eventSource.onerror = () => {
        if (this._state === 'connecting') {
          clearTimeout(timeout);
          eventSource.onerror = null;
          eventSource.close();
          this.eventSource = null;
          this.setState('error');
          const message = `MCP SSE connection to ${this.sseUrl} failed (server unreachable / connection refused)`;
          this.captureError(message);
          reject(new Error(message));
          return;
        }
        if (this._state === 'connected') {
          eventSource.addEventListener('endpoint', (reconnectEvent: MessageEvent) => {
            try {
              const origin = new URL(this.sseUrl).origin;
              this.messageUrl = origin + reconnectEvent.data;
              this.initialize().catch((error: unknown) => {
                const message = `MCP SSE reconnect to ${this.sseUrl} failed: ${this.toErrorMessage(error)}`;
                this.captureError(message);
              });
            } catch (error) {
              const message = `MCP SSE reconnect to ${this.sseUrl} failed: ${this.toErrorMessage(error)}`;
              this.captureError(message);
            }
          }, { once: true });
        }
      };
    });
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.onerror = null;
      this.eventSource.close();
      this.eventSource = null;
    }
    this.messageUrl = null;
    this._connectPromise = null;

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
      this.pending.delete(id);
    }

    this.setState('disconnected');
  }

  private handleIncomingMessage(raw: string): void {
    const msg = parseJsonObject(raw);
    if (!msg) {
      return;
    }

    const id = msg.id;
    if (typeof id !== 'number' || !this.pending.has(id)) {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (isJsonObject(msg.error)) {
      const message = typeof msg.error.message === 'string' ? msg.error.message : 'RPC error';
      pending.reject(new Error(message));
      return;
    }

    if (msg.result === undefined || isJsonValue(msg.result)) {
      pending.resolve(msg.result);
      return;
    }

    pending.reject(new Error('RPC result is not valid JSON'));
  }

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wevibe-dashboard', version: '0.2.0' },
    }, 10000);

    await this.sendNotification('notifications/initialized');
  }

  private async sendRequest(
    method: string,
    params?: JsonValue,
    timeoutMs = 300000,
  ): Promise<JsonValue | undefined> {
    if (!this.messageUrl) {
      throw new Error('Not connected to MCP server');
    }

    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<JsonValue | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      fetch(this.messageUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(err => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private async sendNotification(method: string, params?: JsonValue): Promise<void> {
    if (!this.messageUrl) {
      return;
    }

    await fetch(this.messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch((error: unknown) => {
      console.warn(`[mcp-client] notification ${method} failed:`, error);
    });
  }

  async callTool<T = JsonValue | string>(
    name: string,
    args: Record<string, JsonValue> = {},
  ): Promise<T> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    if (!isJsonObject(result)) {
      throw new Error(`Tool ${name} returned invalid response shape`);
    }

    const content = result.content;
    if (!Array.isArray(content)) {
      throw new Error(`Tool ${name} returned no content array`);
    }

    const textBlock = content.find(
      (block): block is { type: string; text: string } => (
        isJsonObject(block)
        && typeof block.type === 'string'
        && typeof block.text === 'string'
      ),
    );

    if (result.isError === true) {
      throw new Error(textBlock?.text || `Tool ${name} failed`);
    }

    if (!textBlock?.text) {
      throw new Error(`Tool ${name} returned no text content`);
    }

    try {
      const parsed = JSON.parse(textBlock.text) as unknown;
      if (isJsonValue(parsed)) {
        return parsed as T;
      }
    } catch {
      // Non-JSON tool response falls back to raw text
    }

    return textBlock.text as T;
  }

  async healthCheck(baseUrl?: string): Promise<{ status: string; server: string; hub: string; sessions: number; }> {
    const resolvedBaseUrl = baseUrl ?? getConfig().mcpUrl;
    const normalized = resolvedBaseUrl.replace(/\/$/, '');
    const resp = await fetch(`${normalized}/health`);
    if (!resp.ok) {
      throw new Error(`Health check failed: ${resp.status}`);
    }
    return resp.json();
  }
}

let singleton: WeVibeMcpClient | null = null;

export function getMcpClient(): WeVibeMcpClient {
  if (singleton) {
    return singleton;
  }

  const defaultMcpUrl = getConfig().mcpUrl;
  const defaultUrl = typeof window !== 'undefined'
    ? (window.localStorage.getItem('wevibe-mcp-url') ?? defaultMcpUrl)
    : defaultMcpUrl;

  singleton = new WeVibeMcpClient(defaultUrl);
  return singleton;
}

export function resetMcpClient(baseUrl: string): WeVibeMcpClient {
  if (singleton) {
    singleton.disconnect();
  }

  singleton = new WeVibeMcpClient(baseUrl);

  if (typeof window !== 'undefined') {
    window.localStorage.setItem('wevibe-mcp-url', baseUrl);
  }

  return singleton;
}
