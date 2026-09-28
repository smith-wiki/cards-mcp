import { createMcpHandler } from "agents/mcp/server";
import { isAuthorized } from "./auth";
import type { Env } from "./env";
import { createServer } from "./mcp";
import { ensureSchema } from "./schema";
import { sync } from "./sync";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    if (!(await isAuthorized(request, env))) return new Response("Unauthorized", { status: 401 });
    await ensureSchema(env);
    // Stateless: a fresh server per request. Callers are server-side (ChatGPT) behind Access;
    // browser Origins are limited to ChatGPT and local development.
    const handler = createMcpHandler(() => createServer(env), {
      corsOptions: false,
      allowedOriginHostnames: ["chatgpt.com", "localhost", "127.0.0.1"],
    });
    return handler(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env);
    const report = await sync(env);
    console.log(`sync: indexed ${report.cards} cards-repo Cards, ${report.blog} blog Cards`);
    if (report.failures.length) console.error(`sync failures:\n${report.failures.join("\n")}`);
  },
} satisfies ExportedHandler<Env>;
