import { env as bindings } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, test, vi } from "vitest";
import { queueControl, sessionControl } from "./controls";
import { scenarios, type Harness } from "./scenarios";
import { fakeUpstream } from "./upstream";
import type { Env } from "../src/types";

const env = bindings as unknown as Env;
beforeAll(() =>
  vi.stubGlobal("fetch", (input: RequestInfo, init?: RequestInit) =>
    fakeUpstream(new Request(input, init)),
  ),
);
afterAll(() => vi.unstubAllGlobals());
const h: Harness = {
  env,
  calls: async () =>
    (await (await fakeUpstream(new Request("https://fake/__test/calls"))).json()) as any,
  fail: async (failure) => {
    await fakeUpstream(
      new Request("https://fake/__test/fail", { method: "POST", body: JSON.stringify(failure) }),
    );
  },
  session: async (id, action, data) =>
    runInDurableObject(env.SESSIONS.getByName(id), (instance, state) =>
      sessionControl(instance, state, action, data),
    ),
  queue: async (action) =>
    action === "evict"
      ? evictDurableObject(env.MATCHMAKER.getByName("global"))
      : runInDurableObject(env.MATCHMAKER.getByName("global"), (instance, state) =>
          queueControl(instance, state, action),
        ),
  reset: async () => {
    await fakeUpstream(new Request("https://fake/__test/reset"));
    await runInDurableObject(env.MATCHMAKER.getByName("global"), (instance, state) =>
      queueControl(instance, state, "reset"),
    );
    await runInDurableObject(env.TELEGRAM.getByName("global"), async (_instance, state) => {
      await state.storage.deleteAll();
    });
  },
};
for (const scenario of scenarios)
  test(scenario.name, async () => {
    await h.reset();
    await scenario.run(h);
  });
