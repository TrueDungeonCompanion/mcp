/**
 * Streamable HTTP transport entrypoint for the TDC MCP server.
 *
 * Exposes a single `/mcp` endpoint that speaks the MCP Streamable HTTP protocol:
 *   - POST   /mcp  — JSON-RPC request (initialize or per-session message)
 *   - GET    /mcp  — SSE notification stream for the session (after initialize)
 *   - DELETE /mcp  — session termination
 *
 * Stateful mode: the server assigns a session id during `initialize` and returns it
 * in the `Mcp-Session-Id` response header; clients echo it on every subsequent
 * request so we can route messages to the right transport.
 */

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface HttpServerOptions {
  port: number;
  host: string;
  createServer: () => McpServer;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<void> {
  const { port, host, createServer } = opts;
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // One transport per active session. A transport is created on the initialize call,
  // then reused for every follow-up request on that session id until the client closes.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sessions: Object.keys(transports).length });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = headerValue(req, 'mcp-session-id');
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport; },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
        };
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json(jsonRpcError(-32000, 'Bad Request: No valid session ID provided'));
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP POST error:', err);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });

  // Shared handler for GET (SSE stream) and DELETE (session close) — both require a valid session id.
  const sessionedRequest = async (req: Request, res: Response) => {
    const sessionId = headerValue(req, 'mcp-session-id');
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  app.get('/mcp', sessionedRequest);
  app.delete('/mcp', sessionedRequest);

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.error(`TDC MCP listening on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}

function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}
