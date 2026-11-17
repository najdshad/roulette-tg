import { env as bindings } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, test, vi } from "vitest";
import { queueControl, sessionControl } from "./support/controls";
import { createHarness } from "./support/harness";
import { scenarios } from "./scenarios";
import { fakeUpstream } from "./support/upstream";
import type { Env } from "../src/types";

const env = bindings as unknown as Env;
beforeAll(() =>
  vi.stubGlobal("fetch", (input: RequestInfo, init?: RequestInit) =>
    fakeUpstream(new Request(input, init)),
  ),
);
afterAll(() => vi.unstubAllGlobals());
const h = createHarness(env, fakeUpstream, {
  session: (id, action, data) =>
    runInDurableObject(env.SESSIONS.getByName(id), (instance, state) =>
      sessionControl(instance, state, action, data),
    ),
  queue: (action, data) =>
    action === "evict"
      ? evictDurableObject(env.MATCHMAKER.getByName("global"))
      : runInDurableObject(env.MATCHMAKER.getByName("global"), (instance, state) =>
          queueControl(instance, state, action, data),
        ),
  reset: async () => {
    await runInDurableObject(env.MATCHMAKER.getByName("global"), (instance, state) =>
      queueControl(instance, state, "reset"),
    );
    await runInDurableObject(env.TELEGRAM.getByName("global"), async (_instance, state) => {
      await state.storage.deleteAll();
    });
  },
});
for (const scenario of scenarios)
  test(scenario.name, async () => {
    await h.reset();
    await scenario.run(h);
  });
