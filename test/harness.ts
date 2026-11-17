import type { Env } from "../src/types";
import type { Failure, Sent } from "./upstream";

export interface Harness {
  env: Env;
  calls(): Promise<Sent[]>;
  fail(failure: Failure): Promise<void>;
  session(
    id: string,
    action: "inspect" | "patch" | "expire" | "alarm",
    data?: object,
  ): Promise<any>;
  queue(
    action: "reset" | "inspect" | "expire" | "alarm" | "evict" | "pair",
    data?: object,
  ): Promise<any>;
  reset(): Promise<void>;
}
export interface HarnessDriver {
  session(id: string, action: string, data: object): Promise<any>;
  queue(action: string, data: object): Promise<any>;
  reset(): Promise<void>;
}
// One harness body for Vitest and the plain-workerd runner; only the transport differs.
export function createHarness(
  env: Env,
  upstream: (request: Request) => Promise<Response>,
  driver: HarnessDriver,
): Harness {
  return {
    env,
    calls: async () =>
      (await (await upstream(new Request("https://fake/__test/calls"))).json()) as Sent[],
    fail: async (failure) => {
      await upstream(
        new Request("https://fake/__test/fail", { method: "POST", body: JSON.stringify(failure) }),
      );
    },
    session: (id, action, data = {}) => driver.session(id, action, data),
    queue: (action, data = {}) => driver.queue(action, data),
    reset: async () => {
      await upstream(new Request("https://fake/__test/reset"));
      await driver.reset();
    },
  };
}
