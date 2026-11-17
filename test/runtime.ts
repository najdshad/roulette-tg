import {
  ChatSessionDO as Session,
  MatchmakerDO as Matcher,
  TelegramDO as Telegram,
} from "../src/index";
import { queueControl, sessionControl } from "./controls";
import { scenarios, type Harness } from "./scenarios";
import type { Env } from "../src/types";

export class ChatSessionDO extends Session {
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.replace("/__test/", "");
    if (new URL(request.url).pathname.startsWith("/__test/"))
      return Response.json(await sessionControl(this, this.ctx, action, await request.json()));
    return super.fetch(request);
  }
}
export class MatchmakerDO extends Matcher {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/__test/"))
      return Response.json(
        await queueControl(this, this.ctx, new URL(request.url).pathname.slice(8)),
      );
    return super.fetch(request);
  }
}
export class TelegramDO extends Telegram {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/reset") {
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
interface TestEnv extends Env {
  TEST_UPSTREAM: Fetcher;
  TEST_MIGRATIONS: { queries: string[] }[];
}
export default {
  async test(_ctrl: unknown, env: TestEnv) {
    for (const migration of env.TEST_MIGRATIONS)
      await env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)));
    const control = async (stub: DurableObjectStub, action: string, data = {}) => {
      const response = await stub.fetch(`https://test/__test/${action}`, {
        method: "POST",
        body: JSON.stringify(data),
      });
      return response.json();
    };
    const h: Harness = {
      env,
      calls: async () =>
        (await (await env.TEST_UPSTREAM.fetch("https://fake/__test/calls")).json()) as any,
      fail: async (failure) => {
        await env.TEST_UPSTREAM.fetch("https://fake/__test/fail", {
          method: "POST",
          body: JSON.stringify(failure),
        });
      },
      session: async (id, action, data) => control(env.SESSIONS.getByName(id), action, data),
      queue: async (action) => {
        try {
          return await control(env.MATCHMAKER.getByName("global"), action);
        } catch (error) {
          if (action !== "evict") throw error;
        }
      },
      reset: async () => {
        await env.TEST_UPSTREAM.fetch("https://fake/__test/reset");
        await control(env.MATCHMAKER.getByName("global"), "reset");
        await control(env.TELEGRAM.getByName("global"), "reset");
      },
    };
    for (const scenario of scenarios) {
      await h.reset();
      console.log(`RUN ${scenario.name}`);
      await scenario.run(h);
      console.log(`PASS ${scenario.name}`);
    }
    console.log(`${scenarios.length} runtime scenarios passed.`);
  },
};
