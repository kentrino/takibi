/// <reference types="node" />
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The `sqld` binary the remote tests run against, from `TAKIBI_SQLD`
 * (libsql-server 0.24.32 from https://github.com/tursodatabase/libsql/releases
 * is what the tests were written against). Unset: the remote tests skip.
 */
export const SQLD_BIN = process.env.TAKIBI_SQLD || undefined;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * One local `sqld` with namespaces: each namespace is its own database,
 * addressed by the first label of the host name (`http://NAME.localhost:PORT`).
 */
export class Sqld {
  #process: ChildProcess | undefined;
  #namespaces = 0;
  readonly directory = mkdtempSync(join(tmpdir(), "takibi-sqld-"));
  httpPort = 0;
  adminPort = 0;

  async start(): Promise<void> {
    if (SQLD_BIN === undefined) throw new Error("TAKIBI_SQLD is not set");
    if (this.httpPort === 0) {
      this.httpPort = await freePort();
      this.adminPort = await freePort();
    }
    const child = spawn(
      SQLD_BIN,
      [
        "--db-path",
        join(this.directory, "data"),
        "--http-listen-addr",
        `127.0.0.1:${this.httpPort}`,
        "--admin-listen-addr",
        `127.0.0.1:${this.adminPort}`,
        "--enable-namespaces",
      ],
      { stdio: "ignore" },
    );
    this.#process = child;
    const exited = new Promise<never>((_resolve, reject) =>
      child.once("exit", (code) => reject(new Error(`sqld exited with ${String(code)}`))),
    );
    exited.catch(() => undefined);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ready = await fetch(`http://127.0.0.1:${this.httpPort}/health`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) return;
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 100)), exited]);
    }
    throw new Error("sqld did not become ready");
  }

  /** Kill the server at once, as a crash would. */
  async kill(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    if (child === undefined || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }

  async stop(): Promise<void> {
    await this.kill();
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** Create a new, empty database and return its namespace. */
  async createDatabase(hint: string): Promise<string> {
    this.#namespaces += 1;
    const name = `t${this.#namespaces}-${hint.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(
      0,
      60,
    );
    const namespace = name.replace(/-+$/, "");
    const response = await fetch(
      `http://127.0.0.1:${this.adminPort}/v1/namespaces/${namespace}/create`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (!response.ok) {
      throw new Error(
        `creating namespace ${namespace}: ${response.status} ${await response.text()}`,
      );
    }
    return namespace;
  }

  url(namespace: string, port = this.httpPort): string {
    return `http://${namespace}.localhost:${port}`;
  }
}

type Fault = {
  /** A fragment of the request body (a SQL text) that arms the fault. */
  match: string;
  /**
   * `response`: forward the request, let the server finish it, then cut the
   * connection before the response reaches the client (a lost response).
   * `request`: cut the connection without forwarding anything.
   */
  lose: "response" | "request";
};

/**
 * An HTTP proxy in front of sqld that drops the next request or response
 * whose body contains a given SQL fragment, once.
 */
export class FaultProxy {
  #fault: (Fault & { hit: () => void }) | undefined;
  readonly #server: http.Server;
  port = 0;

  constructor(upstreamPort: () => number) {
    this.#server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const fault = this.#fault;
        const armed = fault !== undefined && body.toString("utf8").includes(fault.match);
        if (armed) this.#fault = undefined;
        if (armed && fault.lose === "request") {
          fault.hit();
          request.socket.destroy();
          return;
        }
        const upstream = http.request(
          {
            host: "127.0.0.1",
            port: upstreamPort(),
            method: request.method,
            path: request.url,
            headers: request.headers,
          },
          (reply) => {
            if (armed) {
              reply.resume();
              reply.on("end", () => {
                fault.hit();
                request.socket.destroy();
              });
              return;
            }
            response.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(response);
          },
        );
        upstream.on("error", () => request.socket.destroy());
        upstream.end(body);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.port = (this.#server.address() as AddressInfo).port;
  }

  /** Arm one fault; the promise settles once it struck. */
  arm(fault: Fault): Promise<void> {
    return new Promise((resolve) => {
      this.#fault = { ...fault, hit: resolve };
    });
  }

  get armed(): boolean {
    return this.#fault !== undefined;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }
}
