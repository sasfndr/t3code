// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This transport is also used by standalone CLI protocol probes outside an Effect runtime; its owner awaits close on scope release.
import * as NodeChildProcess from "node:child_process";

export interface NativeRpcMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** One owned CLI process. Never logs wire payloads or inherited credentials. */
export class NativeCliConnection {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sequence = 0;
  private buffer = "";
  private closed = false;
  private readonly exited: Promise<void>;

  constructor(options: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    onMessage: (message: NativeRpcMessage) => void;
    onClose?: (error: Error) => void;
    signal?: AbortSignal;
  }) {
    this.child = NodeChildProcess.spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    const abort = () => {
      void this.close();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    this.child.once("close", () => options.signal?.removeEventListener("abort", abort));
    if (options.signal?.aborted) abort();
    const fail = (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      options.onClose?.(error);
    };
    this.child.once("error", (error) => fail(error));
    this.child.once("close", (code) =>
      fail(new Error(`CLI connection closed (${code ?? "signal"}).`)),
    );
    this.child.stdin.on("error", (error) => fail(error));
    // Drain stderr without retaining private CLI diagnostics in app state.
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024) {
        fail(new Error("CLI protocol frame exceeds 16 MiB."));
        this.child.kill();
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message: NativeRpcMessage;
        try {
          message = JSON.parse(line) as NativeRpcMessage;
        } catch {
          fail(new Error("CLI emitted an invalid JSON protocol frame."));
          this.child.kill();
          return;
        }
        if (!message || typeof message !== "object") {
          fail(new Error("CLI emitted an invalid protocol envelope."));
          this.child.kill();
          return;
        }
        if (typeof message.id === "number" && !message.method) {
          const entry = this.pending.get(message.id);
          if (!entry) continue;
          this.pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.error) entry.reject(new Error(message.error.message));
          else entry.resolve(message.result);
        } else {
          try {
            options.onMessage(message);
          } catch {
            fail(new Error("CLI event handler rejected a protocol frame."));
            this.child.kill();
            return;
          }
        }
      }
    });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("CLI connection is closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CLI request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  send(message: NativeRpcMessage): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(force);
    }
  }
}

/** Headless JSONL runner for CLIs whose interactive session server is incomplete. */
export class NativeJsonlRun {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  readonly completed: Promise<number>;
  constructor(options: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    onRecord: (record: unknown) => void;
  }) {
    this.child = NodeChildProcess.spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdin.end();
    this.child.stderr.resume();
    let buffer = "";
    this.completed = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) {
          this.child.kill();
          reject(new Error("CLI frame exceeds 16 MiB."));
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            options.onRecord(JSON.parse(line));
          } catch {
            this.child.kill();
            reject(new Error("Invalid CLI event."));
            return;
          }
        }
      });
      this.child.once("close", (code) => {
        if (buffer.trim()) {
          try {
            options.onRecord(JSON.parse(buffer));
          } catch {
            reject(new Error("Invalid CLI event."));
            return;
          }
        }
        resolve(code ?? -1);
      });
    });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(force);
    }
  }
}

/** Read a CLI JSON document without ever including its stdout/stderr in errors. */
export function readNativeCliJson(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      options.command,
      [...options.args],
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("CLI catalogue command failed."));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("CLI catalogue is not valid JSON."));
        }
      },
    );
  });
}
