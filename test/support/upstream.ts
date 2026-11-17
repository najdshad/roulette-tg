export interface Sent {
  method: string;
  payload: Record<string, any>;
  at: number;
  result: any;
}
export interface Failure {
  method: string;
  chat?: number;
  code: number;
  remaining: number;
}
const calls: Sent[] = [];
const ids = new Map<number, number>();
let failure: Failure | null = null;

export async function fakeUpstream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/__test/reset") {
    calls.length = 0;
    failure = null;
    return Response.json({ ok: true });
  }
  if (url.pathname === "/__test/calls") return Response.json(calls);
  if (url.pathname === "/__test/fail") {
    failure = (await request.json()) as Failure;
    return Response.json({ ok: true });
  }
  if (url.hostname === "nominatim.openstreetmap.org") {
    const city = { lat: "35.6892", lon: "51.3890", address: { city: "Tehran", country: "Iran" } };
    return Response.json(url.pathname === "/search" ? [city] : city);
  }
  if (url.hostname !== "api.telegram.org") throw new Error("Unexpected outbound request in test");
  const method = url.pathname.split("/").at(-1)!;
  const payload = (await request.json()) as Record<string, any>;
  if (
    failure &&
    failure.remaining > 0 &&
    failure.method === method &&
    (failure.chat === undefined || failure.chat === payload.chat_id)
  ) {
    failure.remaining--;
    return Response.json({
      ok: false,
      error_code: failure.code,
      description:
        failure.code === 403
          ? "Forbidden"
          : failure.code === 429
            ? "Too many requests"
            : "Temporary failure",
      ...(failure.code === 429 ? { parameters: { retry_after: 1 } } : {}),
    });
  }
  const message = () => {
    const next = (ids.get(payload.chat_id) ?? 0) + 1;
    ids.set(payload.chat_id, next);
    return {
      message_id: next,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: "private" },
      text: payload.text,
    };
  };
  const result =
    method === "sendMediaGroup"
      ? payload.media.map(() => message())
      : method.startsWith("send") && method !== "sendChatAction"
        ? message()
        : true;
  calls.push({ method, payload, at: Date.now(), result });
  return Response.json({ ok: true, result });
}
export default { fetch: fakeUpstream };
