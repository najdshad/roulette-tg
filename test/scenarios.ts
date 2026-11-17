import assert from "node:assert/strict";
import worker from "../src/index";
import { changeCredits, charge, getDraft, getUser } from "../src/db";
import { matchAction } from "../src/matchmaker";
import { blockUser } from "../src/moderation";
import { nearby } from "../src/discovery";
import { canPay, invoice, successfulPayment } from "../src/payments";
import { sessionAction } from "../src/session";
import { call } from "../src/telegram";
import {
  cellCenter,
  distanceBucket,
  geohash,
  highestPhoto,
  hasContact,
  hasUrl,
  validName,
} from "../src/privacy";
import { DAY, FREE_FILTERS, type Filters, type User } from "../src/types";
import type { Harness } from "./harness";
import type { Sent } from "./upstream";
let uid = 1000,
  updateId = 1,
  msgId = 100000;
export async function seed(h: Harness, overrides: Partial<User> = {}): Promise<User> {
  const id = ++uid,
    now = Date.now();
  await h.env.DB.prepare(
    `INSERT INTO users (telegram_id,public_id,display_name,gender,age,location_mode,location_label,geohash,photo_files,credits,waves_reset_at,last_active_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      crypto.randomUUID(),
      "Person " + id,
      "F",
      25,
      "EXACT_COARSE",
      "Tehran, Iran",
      "tnke4",
      JSON.stringify(["photo-small", "photo-large"]),
      100,
      (Math.floor(now / DAY) + 1) * DAY,
      now,
      now,
    )
    .run();
  for (const [key, value] of Object.entries(overrides)) {
    assert.ok(/^[a-z_]+$/.test(key));
    await h.env.DB.prepare(`UPDATE users SET ${key}=? WHERE telegram_id=?`).bind(value, id).run();
  }
  return (await getUser(h.env, id))!;
}
async function message(
  h: Harness,
  id: number,
  text?: string,
  extra: object = {},
  sameUpdate?: number,
): Promise<Response> {
  const update = {
    update_id: sameUpdate ?? updateId++,
    message: {
      message_id: msgId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id, type: "private" },
      from: { id, is_bot: false, first_name: "Private", username: "handle_" + id },
      ...(text === undefined
        ? {}
        : {
            text,
            ...(text.startsWith("/")
              ? {
                  entities: [
                    { type: "bot_command", offset: 0, length: text.split(" ")[0]!.length },
                  ],
                }
              : {}),
          }),
      ...extra,
    },
  };
  return webhook(h, update);
}
async function callback(h: Harness, id: number, data: string): Promise<Response> {
  return webhook(h, {
    update_id: updateId++,
    callback_query: {
      id: "cb" + updateId,
      from: { id, is_bot: false, first_name: "Private", username: "handle_" + id },
      chat_instance: "test",
      data,
      message: { message_id: 1, date: 1, chat: { id, type: "private" }, text: "card" },
    },
  });
}
async function webhook(
  h: Harness,
  update: object,
  secret = h.env.WEBHOOK_SECRET,
): Promise<Response> {
  return worker.fetch(
    new Request("https://bot.test/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(update),
    }),
    h.env,
  );
}
async function join(h: Harness, user: User, filters: Filters = FREE_FILTERS): Promise<void> {
  await matchAction(h.env, "join", { userId: user.telegram_id, filters, key: "join" + updateId++ });
}
async function pair(h: Harness, filtered = false): Promise<[User, User, string]> {
  const a = await seed(h),
    b = await seed(h, { gender: "M" });
  await join(h, a, filtered ? { ...FREE_FILTERS, gender: "M" } : FREE_FILTERS);
  await join(h, b);
  const current = (await getUser(h.env, a.telegram_id))!;
  assert.equal(current.state, "IN_CHAT");
  assert.ok(current.active_session_id);
  return [a, b, current.active_session_id];
}
async function relay(h: Harness, session: string, user: User, input: object = {}): Promise<void> {
  await sessionAction(h.env, session, "relay", {
    userId: user.telegram_id,
    messageId: msgId++,
    key: "relay" + updateId++,
    text: "Hello",
    ...input,
  });
}
const sentTo = (calls: Sent[], method: string, id: number) =>
  calls.filter((c) => c.method === method && c.payload.chat_id === id);

export const scenarios: { name: string; run(h: Harness): Promise<void> }[] = [
  {
    name: "profile validation and location encoding preserve coarse privacy",
    async run(h) {
      const hash = geohash(35.6892, 51.389),
        [lat, lon] = cellCenter(hash);
      assert.equal(hash.length, 5);
      assert.ok(Math.abs(lat - 35.6892) < 0.025);
      assert.ok(Math.abs(lon - 51.389) < 0.025);
      assert.notEqual(lat, 35.6892);
      assert.throws(() => geohash(91, 1));
      for (const name of [
        "@alice",
        "Alice https://evil.test",
        "+1 202 555 0101",
        "5551212",
        "۰۹۱۲۳۴۵۶۷۸۹",
        "Alice\nSmith",
        "x",
      ])
        assert.throws(() => validName(name));
      assert.equal(validName("  نیلوفر  "), "نیلوفر");
      assert.equal(hasContact("visit example.com"), true);
      assert.equal(hasUrl("https://example.com"), true);
      assert.equal(
        highestPhoto([
          { file_id: "large", file_unique_id: "1", width: 800, height: 800 },
          { file_id: "small", file_unique_id: "2", width: 10, height: 10 },
        ]),
        "large",
      );
      const a = await seed(h),
        b = await seed(h, { location_mode: "CITY" });
      assert.equal(distanceBucket(a, b), "Same City");
      assert.equal(distanceBucket(a, a), "< 2 km away");
    },
  },
  {
    name: "webhook authentication, duplicate receipts, and checkout validation",
    async run(h) {
      assert.equal((await webhook(h, { update_id: updateId++ }, "bad-secret")).status, 401);
      assert.equal((await worker.fetch(new Request("https://bot.test/health"), h.env)).status, 200);
      const u = await seed(h);
      const id = updateId++;
      assert.equal((await message(h, u.telegram_id, "/balance", {}, id)).status, 200);
      const count = (await h.calls()).length;
      assert.equal((await message(h, u.telegram_id, "/balance", {}, id)).status, 200);
      assert.equal((await h.calls()).length, count);
      assert.equal(
        await canPay(h.env, u.telegram_id, `v1:${u.telegram_id}:starter`, "XTR", 50),
        true,
      );
      assert.equal(
        await canPay(h.env, u.telegram_id, `v1:${u.telegram_id}:starter`, "USD", 50),
        false,
      );
      assert.equal(
        await canPay(h.env, u.telegram_id, `v1:${u.telegram_id + 1}:starter`, "XTR", 50),
        false,
      );
      await invoice(h.env, u.telegram_id, "popular");
      const purchase = (await h.calls()).find((c) => c.method === "sendInvoice")!;
      assert.equal(purchase.payload.currency, "XTR");
      assert.equal(purchase.payload.provider_token, "");
      assert.equal(purchase.payload.prices[0].amount, 150);
      const before = Date.now();
      assert.equal(
        (
          await webhook(h, {
            update_id: updateId++,
            pre_checkout_query: {
              id: "checkout-test",
              from: { id: u.telegram_id, is_bot: false, first_name: "Private" },
              currency: "XTR",
              total_amount: 50,
              invoice_payload: `v1:${u.telegram_id}:starter`,
            },
          })
        ).status,
        200,
      );
      const answer = (await h.calls()).find((c) => c.method === "answerPreCheckoutQuery")!;
      assert.equal(answer.payload.ok, true);
      assert.ok(answer.at - before < 10_000);
    },
  },
  {
    name: "five-step onboarding, input validation, photos, editing and one-time welcome balance",
    async run(h) {
      const id = ++uid;
      await message(h, id, "/start");
      await callback(h, id, "onboard:adult");
      await message(h, id, "17");
      assert.equal((await getDraft(h.env, id))!.step, "age");
      await message(h, id, "24");
      await message(h, id, "@private_handle");
      assert.equal((await getDraft(h.env, id))!.step, "name");
      await message(h, id, "Niloofar");
      await callback(h, id, "onboard:gender-O");
      await message(h, id, "Choose city manually");
      await message(h, id, "Tehran, Iran");
      const draft = (await getDraft(h.env, id))!;
      assert.equal(draft.location!.label, "Tehran, Iran");
      assert.equal(draft.location!.geohash.length, 5);
      assert.equal(draft.location!.mode, "CITY");
      assert.ok(!JSON.stringify(draft).includes("35.6892"));
      await callback(h, id, "onboard:city-confirm");
      await message(h, id, undefined, { document: { file_id: "not-photo", file_unique_id: "d" } });
      assert.equal((await getDraft(h.env, id))!.photos!.length, 0);
      for (let i = 0; i < 3; i++)
        await message(h, id, undefined, {
          photo: [
            { file_id: "small" + i, file_unique_id: "a", width: 10, height: 10 },
            { file_id: "large" + i, file_unique_id: "b", width: 800, height: 800 },
          ],
        });
      await message(h, id, undefined, {
        photo: [{ file_id: "fourth", file_unique_id: "x", width: 800, height: 800 }],
      });
      assert.equal((await getDraft(h.env, id))!.photos!.length, 3);
      const kept = (await getDraft(h.env, id))!.photos!;
      const callsBeforeDuplicate = (await h.calls()).length;
      await message(h, id, undefined, {
        photo: [{ file_id: kept[0], file_unique_id: "dup", width: 800, height: 800 }],
      });
      assert.equal((await getDraft(h.env, id))!.photos!.length, 3);
      assert.equal((await h.calls()).length, callsBeforeDuplicate);
      await message(h, id, "Done with photos");
      const user = (await getUser(h.env, id))!;
      assert.equal(user.credits, 10);
      assert.equal(user.gender, "O");
      assert.deepEqual(JSON.parse(user.photo_files), kept);
      assert.equal(await getDraft(h.env, id), null);
      await message(h, id, "/start");
      assert.equal((await getUser(h.env, id))!.credits, 10);
      await changeCredits(h.env, id, -3, `spent-before-edit:${id}`, "TEST");
      await callback(h, id, "edit");
      await callback(h, id, "onboard:adult");
      await message(h, id, "25");
      await message(h, id, "New Name");
      await callback(h, id, "onboard:gender-F");
      await message(h, id, undefined, { location: { latitude: 35.6892, longitude: 51.389 } });
      assert.ok(
        (await h.calls()).some((c) => c.method === "deleteMessage" && c.payload.chat_id === id),
      );
      const gpsDraft = JSON.stringify(await getDraft(h.env, id));
      assert.ok(!gpsDraft.includes("35.6892"));
      assert.ok(!gpsDraft.includes("51.389"));
      await message(h, id, undefined, {
        photo: [{ file_id: "updated-photo", file_unique_id: "x", width: 800, height: 800 }],
      });
      await message(h, id, "Done with photos");
      assert.equal((await getUser(h.env, id))!.credits, 7);
      assert.equal((await getUser(h.env, id))!.display_name, "New Name");
    },
  },
  {
    name: "credit debits are atomic and idempotent, and Stars receipts grant exactly once",
    async run(h) {
      const u = await seed(h, { credits: 10 });
      const results = await Promise.allSettled([
        changeCredits(h.env, u.telegram_id, -8, "debit-a", "TEST"),
        changeCredits(h.env, u.telegram_id, -8, "debit-b", "TEST"),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 2);
      const key = results[0]!.status === "fulfilled" ? "debit-a" : "debit-b";
      await changeCredits(h.env, u.telegram_id, -8, key, "TEST");
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 2);
      const payment = {
        currency: "XTR",
        total_amount: 150,
        invoice_payload: `v1:${u.telegram_id}:popular`,
        telegram_payment_charge_id: "charge-unique",
        provider_payment_charge_id: "",
      };
      await successfulPayment(h.env, u.telegram_id, payment);
      await successfulPayment(h.env, u.telegram_id, payment);
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 177);
      const vip = {
        ...payment,
        total_amount: 250,
        invoice_payload: `v1:${u.telegram_id}:vip`,
        telegram_payment_charge_id: "vip-1",
      };
      await successfulPayment(h.env, u.telegram_id, vip);
      const until = (await getUser(h.env, u.telegram_id))!.vip_until;
      assert.ok(until >= Date.now() + 7 * DAY - 2000);
      await successfulPayment(h.env, u.telegram_id, {
        ...vip,
        telegram_payment_charge_id: "vip-2",
      });
      const updated = (await getUser(h.env, u.telegram_id))!;
      assert.equal(updated.vip_until, until + 7 * DAY);
      assert.equal(updated.credits, 277);
      await charge(h.env, updated, 15, "vip-feature", "TEST");
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 277);
    },
  },
  {
    name: "atomic pairing, mutual filters, blocked users, and queue cancellation",
    async run(h) {
      const a = await seed(h, { gender: "M" }),
        b = await seed(h, { gender: "F" }),
        c = await seed(h, { gender: "M" });
      await join(h, a, { ...FREE_FILTERS, gender: "F" });
      await join(h, c, { ...FREE_FILTERS, gender: "F" });
      assert.equal((await getUser(h.env, a.telegram_id))!.state, "QUEUED");
      assert.equal((await getUser(h.env, c.telegram_id))!.state, "QUEUED");
      await blockUser(h.env, b, a);
      await join(h, b);
      assert.equal(
        (await getUser(h.env, c.telegram_id))!.active_session_id,
        (await getUser(h.env, b.telegram_id))!.active_session_id,
      );
      assert.equal((await getUser(h.env, a.telegram_id))!.state, "QUEUED");
      await matchAction(h.env, "leave", { userId: a.telegram_id });
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 100);
      const x = await seed(h),
        y = await seed(h),
        z = await seed(h);
      await Promise.all([join(h, x), join(h, y), join(h, z)]);
      const users = await Promise.all([x, y, z].map((u) => getUser(h.env, u.telegram_id)));
      assert.equal(users.filter((u) => u!.state === "IN_CHAT").length, 2);
      assert.equal(users.filter((u) => u!.state === "QUEUED").length, 1);
      const paired = users.filter((u) => u!.state === "IN_CHAT");
      assert.equal(paired[0]!.active_session_id, paired[1]!.active_session_id);
    },
  },
  {
    name: "paid search timeout refunds escrow and survives object eviction",
    async run(h) {
      const u = await seed(h);
      await join(h, u, { ...FREE_FILTERS, minAge: 30 });
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 95);
      await h.queue("evict");
      assert.equal((await h.queue("inspect")).length, 1);
      await h.queue("expire");
      await h.queue("alarm");
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 100);
      assert.equal((await getUser(h.env, u.telegram_id))!.state, "IDLE");
      assert.ok(
        (await h.calls()).some((c) =>
          c.payload.reply_markup?.inline_keyboard
            ?.flat()
            .some((b: any) => b.callback_data === "fallback:random"),
        ),
      );
    },
  },
  {
    name: "native filter controls save preferences and reserve the correct search fee",
    async run(h) {
      const user = await seed(h);
      await message(h, user.telegram_id, "/filters");
      await callback(h, user.telegram_id, "filter:gender:M");
      await callback(h, user.telegram_id, "filter:age");
      await message(h, user.telegram_id, "17-100");
      assert.equal((await getDraft(h.env, user.telegram_id))!.step, "filters-age");
      await message(h, user.telegram_id, "21-35");
      await callback(h, user.telegram_id, "filter:location:CITY");
      const saved = (await getUser(h.env, user.telegram_id))!;
      assert.equal(saved.filter_gender, "M");
      assert.equal(saved.filter_min_age, 21);
      assert.equal(saved.filter_max_age, 35);
      assert.equal(saved.filter_location, "CITY");
      await callback(h, user.telegram_id, "search");
      assert.equal((await getUser(h.env, user.telegram_id))!.credits, 95);
      await message(h, user.telegram_id, "/stop");
      assert.equal((await getUser(h.env, user.telegram_id))!.credits, 100);
    },
  },
  {
    name: "instant skips refund, payer messages do not settle, partner messages and 15 seconds settle",
    async run(h) {
      const [a, b, id] = await pair(h, true);
      await relay(h, id, a);
      await h.session(id, "patch", { started: Date.now() });
      await sessionAction(h.env, id, "close", { userId: b.telegram_id });
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 100);
      const [c, d, id2] = await pair(h, true);
      await relay(h, id2, d);
      await sessionAction(h.env, id2, "close", { userId: c.telegram_id });
      assert.equal((await getUser(h.env, c.telegram_id))!.credits, 95);
      const [e, f, id3] = await pair(h, true);
      await h.session(id3, "patch", { started: Date.now() - 16_000 });
      await h.session(id3, "alarm");
      await sessionAction(h.env, id3, "close", { userId: f.telegram_id });
      assert.equal((await getUser(h.env, e.telegram_id))!.credits, 95);
    },
  },
  {
    name: "anonymous relay, reply mapping, link restrictions, and photo pricing",
    async run(h) {
      const [a, b, id] = await pair(h);
      const source = msgId++;
      await relay(h, id, a, { text: "A private hello", messageId: source, key: "unique-relay" });
      const delivered = sentTo(await h.calls(), "sendMessage", b.telegram_id).find(
        (c) => c.payload.text === "A private hello",
      )!;
      assert.ok(delivered);
      assert.equal(delivered.payload.from_chat_id, undefined);
      assert.equal(delivered.payload.parse_mode, undefined);
      await relay(h, id, b, { text: "Reply to you", replyTo: delivered.result.message_id });
      const reply = sentTo(await h.calls(), "sendMessage", a.telegram_id).find(
        (c) => c.payload.text === "Reply to you",
      )!;
      assert.equal(reply.payload.reply_parameters.message_id, source);
      await relay(h, id, a, { text: "A follow-up", replyTo: source });
      assert.equal(
        sentTo(await h.calls(), "sendMessage", b.telegram_id).find(
          (c) => c.payload.text === "A follow-up",
        )!.payload.reply_parameters.message_id,
        delivered.result.message_id,
      );
      await h.session(id, "patch", { started: Date.now() });
      await assert.rejects(
        () => relay(h, id, a, { text: "https://example.com" }),
        /first 5 minutes/,
      );
      await assert.rejects(
        () => relay(h, id, a, { text: "hidden link", hasUrlEntity: true }),
        /first 5 minutes/,
      );
      await h.session(id, "patch", { started: Date.now() - 301_000 });
      await relay(h, id, a, { text: "https://example.com" });
      await relay(h, id, a, { text: undefined, file: "standard-photo" });
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 98);
      await sessionAction(h.env, id, "unlock", { userId: a.telegram_id, key: "unlock" });
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 94);
      await relay(h, id, a, { text: undefined, file: "another-photo" });
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 94);
      await sessionAction(h.env, id, "relay", {
        userId: a.telegram_id,
        messageId: source,
        key: "unique-relay",
        text: "A private hello",
      });
      assert.equal(
        sentTo(await h.calls(), "sendMessage", b.telegram_id).filter(
          (c) => c.payload.text === "A private hello",
        ).length,
        1,
      );
      const stored = await h.session(id, "inspect");
      assert.ok(!JSON.stringify(stored).includes("A private hello"));
      assert.ok(!JSON.stringify(stored).includes("standard-photo"));
      await message(h, a.telegram_id, undefined, { video: { file_id: "not-allowed" } });
      assert.ok(
        sentTo(await h.calls(), "sendMessage", a.telegram_id).some((c) =>
          c.payload.text.includes("Only text and compressed photos"),
        ),
      );
    },
  },
  {
    name: "View-Once photos require the recipient, reveal once, and delete on a ten-second alarm",
    async run(h) {
      const [a, b, id] = await pair(h);
      await sessionAction(h.env, id, "view-mode", { userId: a.telegram_id });
      await relay(h, id, a, { text: undefined, file: "one-time-reference" });
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 95);
      const state = (await h.session(id, "inspect")).state;
      const view = state.views[0];
      assert.equal(view.revealed, false);
      assert.equal(
        sentTo(await h.calls(), "sendPhoto", b.telegram_id).filter(
          (c) => c.payload.photo === "one-time-reference",
        ).length,
        0,
      );
      await assert.rejects(
        () => sessionAction(h.env, id, "reveal-photo", { userId: a.telegram_id, viewId: view.id }),
        /expired|revealed/,
      );
      const before = Date.now();
      await sessionAction(h.env, id, "reveal-photo", { userId: b.telegram_id, viewId: view.id });
      const photo = sentTo(await h.calls(), "sendPhoto", b.telegram_id).find(
        (c) => c.payload.photo === "one-time-reference",
      )!;
      assert.equal(photo.payload.has_spoiler, true);
      assert.equal(photo.payload.protect_content, true);
      const revealed = await h.session(id, "inspect");
      assert.ok(revealed.alarm >= before + 10_000);
      assert.ok(revealed.alarm <= Date.now() + 10_100);
      assert.ok(!JSON.stringify(revealed.state).includes("one-time-reference"));
      await assert.rejects(
        () => sessionAction(h.env, id, "reveal-photo", { userId: b.telegram_id, viewId: view.id }),
        /expired|revealed/,
      );
      // Exercise the real scheduled alarm and elapsed wall time.
      await new Promise((resolve) => setTimeout(resolve, 10_500));
      assert.ok(
        (await h.calls()).some(
          (c) =>
            c.method === "deleteMessages" &&
            c.payload.chat_id === b.telegram_id &&
            c.payload.message_ids.includes(photo.result.message_id),
        ),
      );
      assert.ok(
        (await h.calls()).some(
          (c) => c.method === "editMessageText" && c.payload.text === "🔒 Photo expired.",
        ),
      );
      assert.equal((await h.session(id, "inspect")).state.views.length, 0);
    },
  },
  {
    name: "24-hour deletion covers both histories, survives stop, and purges session state",
    async run(h) {
      const [a, b, id] = await pair(h);
      const source = msgId++;
      const before = Date.now();
      await relay(h, id, a, { messageId: source, text: "ephemeral text" });
      const delivered = sentTo(await h.calls(), "sendMessage", b.telegram_id).find(
        (c) => c.payload.text === "ephemeral text",
      )!;
      let snapshot = await h.session(id, "inspect");
      assert.ok(
        snapshot.messages.some(
          (r: any) =>
            r.target_chat_id === a.telegram_id &&
            r.target_msg_id === source &&
            r.delete_at >= before + DAY,
        ),
      );
      assert.ok(
        snapshot.messages.some(
          (r: any) =>
            r.target_chat_id === b.telegram_id && r.target_msg_id === delivered.result.message_id,
        ),
      );
      await sessionAction(h.env, id, "close", { userId: a.telegram_id });
      assert.equal((await getUser(h.env, b.telegram_id))!.active_session_id, null);
      snapshot = await h.session(id, "inspect");
      assert.equal(snapshot.state.closed, true);
      assert.ok(snapshot.messages.length > 0);
      await h.session(id, "expire");
      await h.session(id, "alarm");
      const deletions = (await h.calls()).filter((c) => c.method === "deleteMessages");
      assert.ok(
        deletions.some(
          (c) => c.payload.chat_id === a.telegram_id && c.payload.message_ids.includes(source),
        ),
      );
      assert.ok(
        deletions.some(
          (c) =>
            c.payload.chat_id === b.telegram_id &&
            c.payload.message_ids.includes(delivered.result.message_id),
        ),
      );
      assert.equal((await h.session(id, "inspect")).state, null);
      await assert.rejects(
        () =>
          sessionAction(h.env, id, "consent", { userId: a.telegram_id, username: "handle_one" }),
        /no longer available/,
      );
    },
  },
  {
    name: "deletion failures retain state for retry and incomplete close work resumes",
    async run(h) {
      const [a, b, id] = await pair(h, true);
      await h.session(id, "patch", { started: Date.now() });
      await sessionAction(h.env, id, "close", { userId: a.telegram_id });
      // Model interruption after the durable close intent but before D1 release.
      await h.env.DB.prepare(
        "UPDATE users SET state='IN_CHAT',active_session_id=? WHERE telegram_id IN (?,?)",
      )
        .bind(id, a.telegram_id, b.telegram_id)
        .run();
      await h.session(id, "patch", { released: false });
      await h.session(id, "alarm");
      assert.equal((await getUser(h.env, a.telegram_id))!.active_session_id, null);
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 100);
      await h.session(id, "expire");
      await h.fail({ method: "deleteMessages", chat: a.telegram_id, code: 503, remaining: 1 });
      await h.session(id, "alarm");
      const pending = await h.session(id, "inspect");
      assert.ok(pending.state);
      assert.ok(pending.messages.length > 0);
      assert.ok(pending.alarm >= Date.now() + 29_000);
      await h.session(id, "alarm");
      assert.equal((await h.session(id, "inspect")).state, null);
    },
  },
  {
    name: "nearby deck expands geohash prefixes, excludes inactive and blocked profiles, and hides account IDs",
    async run(h) {
      const a = await seed(h, { geohash: "s0000" }),
        b = await seed(h, { geohash: "s00zz" }),
        c = await seed(h, { geohash: "s0000", last_active_at: Date.now() - 4 * DAY }),
        d = await seed(h, { geohash: "s0000" });
      await blockUser(h.env, a, d);
      await nearby(h.env, a);
      const calls = await h.calls();
      const photos = sentTo(calls, "sendMediaGroup", a.telegram_id);
      assert.ok(photos.length > 0);
      const card = sentTo(calls, "sendMessage", a.telegram_id).find((c) =>
        c.payload.text.startsWith("📍 People nearby"),
      )!;
      const data = card.payload.reply_markup.inline_keyboard
        .flat()
        .map((v: any) => v.callback_data);
      assert.ok(data.includes(`request:${b.public_id}`));
      assert.ok(!JSON.stringify(data).includes(String(b.telegram_id)));
      assert.ok(!JSON.stringify(calls).includes(c.public_id));
      assert.ok(!JSON.stringify(calls).includes(d.public_id));
    },
  },
  {
    name: "async requests enforce daily quota, paid extras, Super Waves, reconnect prices and mutual acceptance",
    async run(h) {
      const sender = await seed(h);
      const targets = await Promise.all([0, 1, 2, 3, 4, 5].map(() => seed(h)));
      for (let i = 0; i < 4; i++)
        await matchAction(h.env, "request", {
          userId: sender.telegram_id,
          target: targets[i]!.telegram_id,
          key: "wave" + i,
        });
      assert.equal((await getUser(h.env, sender.telegram_id))!.credits, 98);
      assert.equal((await getUser(h.env, sender.telegram_id))!.daily_free_waves, 0);
      await matchAction(h.env, "request", {
        userId: sender.telegram_id,
        target: targets[4]!.telegram_id,
        key: "super",
        kind: "SUPER",
        icebreaker: "Tell me about your favorite book.",
      });
      assert.equal((await getUser(h.env, sender.telegram_id))!.credits, 88);
      const superRow = await h.env.DB.prepare(
        "SELECT id,icebreaker_text FROM chat_requests WHERE sender_id=? AND kind='SUPER'",
      )
        .bind(sender.telegram_id)
        .first<{ id: string; icebreaker_text: string | null }>();
      assert.equal(superRow!.icebreaker_text, null);
      await h.env.DB.prepare("UPDATE users SET last_partner_id=? WHERE telegram_id=?")
        .bind(targets[5]!.telegram_id, sender.telegram_id)
        .run();
      await matchAction(h.env, "request", {
        userId: sender.telegram_id,
        target: targets[5]!.telegram_id,
        key: "reconnect",
        kind: "RECONNECT",
      });
      assert.equal((await getUser(h.env, sender.telegram_id))!.credits, 73);
      await join(h, sender, { ...FREE_FILTERS, minAge: 20 });
      await matchAction(h.env, "accept", {
        userId: targets[4]!.telegram_id,
        requestId: superRow!.id,
      });
      assert.equal((await getUser(h.env, sender.telegram_id))!.credits, 73);
      assert.equal(
        (await getUser(h.env, sender.telegram_id))!.active_session_id,
        (await getUser(h.env, targets[4]!.telegram_id))!.active_session_id,
      );
      await assert.rejects(
        () =>
          matchAction(h.env, "accept", {
            userId: targets[3]!.telegram_id,
            requestId: superRow!.id,
          }),
        /no longer available/,
      );
      const reset = await seed(h, { daily_free_waves: 0, waves_reset_at: Date.now() - 1 });
      const recipient = await seed(h);
      await matchAction(h.env, "request", {
        userId: reset.telegram_id,
        target: recipient.telegram_id,
        key: "newday",
      });
      assert.equal((await getUser(h.env, reset.telegram_id))!.daily_free_waves, 2);
      assert.equal((await getUser(h.env, reset.telegram_id))!.credits, 100);
    },
  },
  {
    name: "undeliverable requests refund and 403 closes sessions with unsettled escrow",
    async run(h) {
      const sender = await seed(h, { daily_free_waves: 0 }),
        recipient = await seed(h);
      await h.fail({
        method: "sendMediaGroup",
        chat: recipient.telegram_id,
        code: 403,
        remaining: 1,
      });
      await assert.rejects(
        () =>
          matchAction(h.env, "request", {
            userId: sender.telegram_id,
            target: recipient.telegram_id,
            key: "failrequest",
          }),
        /could not be delivered/,
      );
      assert.equal((await getUser(h.env, sender.telegram_id))!.credits, 100);
      assert.equal((await getUser(h.env, recipient.telegram_id))!.state, "INACTIVE");
      const [a, b, id] = await pair(h, true);
      await h.session(id, "patch", { started: Date.now() });
      await h.fail({ method: "sendMessage", chat: b.telegram_id, code: 403, remaining: 10 });
      await assert.rejects(() => relay(h, id, a), /unavailable/);
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 100);
      assert.equal((await getUser(h.env, a.telegram_id))!.active_session_id, null);
      assert.equal((await getUser(h.env, b.telegram_id))!.state, "INACTIVE");
      assert.equal((await getUser(h.env, b.telegram_id))!.last_active_at, 0);
    },
  },
  {
    name: "three unique recent reports quarantine photos and block matchmaking and requests",
    async run(h) {
      const target = await seed(h);
      const reporters = await Promise.all([0, 1, 2].map(() => seed(h)));
      await blockUser(h.env, reporters[0]!, target, "spam");
      await blockUser(h.env, reporters[0]!, target, "spam");
      assert.equal((await getUser(h.env, target.telegram_id))!.photo_suspended_until, 0);
      await blockUser(h.env, reporters[1]!, target, "harassment");
      await blockUser(h.env, reporters[2]!, target, "underage");
      assert.ok((await getUser(h.env, target.telegram_id))!.photo_suspended_until > Date.now());
      assert.ok(
        sentTo(await h.calls(), "sendMessage", -100999).some((c) =>
          c.payload.text.includes(String(target.telegram_id)),
        ),
      );
      await assert.rejects(
        () =>
          matchAction(h.env, "request", {
            userId: target.telegram_id,
            target: reporters[0]!.telegram_id,
            key: "blocked",
          }),
        /unavailable/,
      );
      const partner = await seed(h);
      await join(h, target);
      await join(h, partner);
      const session = (await getUser(h.env, target.telegram_id))!.active_session_id!;
      await assert.rejects(
        () => relay(h, session, target, { text: undefined, file: "quarantined" }),
        /suspended/,
      );
    },
  },
  {
    name: "username exchange requires two button consents and /next avoids the last skipped partner",
    async run(h) {
      const [a, b, id] = await pair(h);
      await message(h, a.telegram_id, "/reveal");
      assert.ok(
        !(await h.calls()).some((c) => String(c.payload.text).includes("Your partner is @")),
      );
      await callback(h, a.telegram_id, `consent:${id}`);
      assert.ok(
        !(await h.calls()).some((c) => String(c.payload.text).includes("Your partner is @")),
      );
      await callback(h, b.telegram_id, `consent:${id}`);
      assert.ok(
        sentTo(await h.calls(), "sendMessage", a.telegram_id).some((c) =>
          c.payload.text.includes(`@handle_${b.telegram_id}`),
        ),
      );
      const consentCalls = (await h.calls()).filter((c) => c.method === "sendMessage").length;
      await callback(h, a.telegram_id, `consent:${id}`);
      assert.equal(
        (await h.calls()).filter((c) => c.method === "sendMessage").length,
        consentCalls,
      );
      const third = await seed(h);
      await message(h, a.telegram_id, "/next");
      await message(h, b.telegram_id, "/random");
      assert.equal((await getUser(h.env, a.telegram_id))!.state, "QUEUED");
      assert.equal((await getUser(h.env, b.telegram_id))!.state, "QUEUED");
      await join(h, third);
      assert.equal(
        (await getUser(h.env, a.telegram_id))!.active_session_id,
        (await getUser(h.env, third.telegram_id))!.active_session_id,
      );
      await message(h, third.telegram_id, "/stop");
      assert.equal((await getUser(h.env, a.telegram_id))!.active_session_id, null);
    },
  },
  {
    name: "interrupted request delivery resumes without a second charge and failed free requests restore quota",
    async run(h) {
      const sender = await seed(h, { daily_free_waves: 0 }),
        recipient = await seed(h);
      const id = `${sender.public_id.slice(0, 8)}-recover`;
      await h.env.DB.prepare(
        `INSERT INTO chat_requests (id,sender_id,recipient_id,cost,delivery_phase,created_at,expires_at) VALUES (?,?,?,2,1,?,?)`,
      )
        .bind(id, sender.telegram_id, recipient.telegram_id, Date.now(), Date.now() + DAY)
        .run();
      assert.equal((await getUser(h.env, sender.telegram_id))!.credits, 98);
      await matchAction(h.env, "request", {
        userId: sender.telegram_id,
        target: recipient.telegram_id,
        key: "recover",
      });
      assert.equal((await getUser(h.env, sender.telegram_id))!.credits, 98);
      assert.equal(sentTo(await h.calls(), "sendMediaGroup", recipient.telegram_id).length, 0);
      const row = await h.env.DB.prepare("SELECT delivered_at FROM chat_requests WHERE id=?")
        .bind(id)
        .first<{ delivered_at: number }>();
      assert.ok(row!.delivered_at);
      const count = (await h.calls()).length;
      await matchAction(h.env, "request", {
        userId: sender.telegram_id,
        target: recipient.telegram_id,
        key: "recover",
      });
      assert.equal((await h.calls()).length, count);
      const free = await seed(h),
        missing = await seed(h);
      await h.fail({
        method: "sendMediaGroup",
        chat: missing.telegram_id,
        code: 403,
        remaining: 1,
      });
      await assert.rejects(
        () =>
          matchAction(h.env, "request", {
            userId: free.telegram_id,
            target: missing.telegram_id,
            key: "free-failure",
          }),
        /could not be delivered/,
      );
      assert.equal((await getUser(h.env, free.telegram_id))!.daily_free_waves, 3);
      assert.equal((await getUser(h.env, free.telegram_id))!.credits, 100);
    },
  },
  {
    name: "hourly maintenance expires requests, clears icebreakers, drafts and old webhook receipts",
    async run(h) {
      const a = await seed(h),
        b = await seed(h),
        now = Date.now();
      await h.env.DB.batch([
        h.env.DB.prepare(
          `INSERT INTO chat_requests (id,sender_id,recipient_id,icebreaker_text,created_at,expires_at) VALUES ('cron-expired',?,?, 'old icebreaker',?,?)`,
        ).bind(a.telegram_id, b.telegram_id, now - DAY - 1, now - 1),
        h.env.DB.prepare("INSERT INTO drafts VALUES (?,?,?)").bind(
          a.telegram_id,
          JSON.stringify({ step: "age" }),
          now - 2 * DAY,
        ),
        h.env.DB.prepare("INSERT INTO update_receipts VALUES (-99,'DONE',0,?)").bind(now - 8 * DAY),
      ]);
      await worker.scheduled({} as ScheduledController, h.env);
      const request = await h.env.DB.prepare(
        "SELECT status,icebreaker_text FROM chat_requests WHERE id='cron-expired'",
      ).first<{ status: string; icebreaker_text: string | null }>();
      assert.equal(request!.status, "EXPIRED");
      assert.equal(request!.icebreaker_text, null);
      assert.equal(await getDraft(h.env, a.telegram_id), null);
      assert.equal(
        await h.env.DB.prepare("SELECT 1 FROM update_receipts WHERE update_id=-99").first(),
        null,
      );
    },
  },
  {
    name: "the Telegram gateway retries 429 and paces sends to each chat",
    async run(h) {
      const id = ++uid;
      await h.fail({ method: "sendMessage", chat: id, code: 429, remaining: 1 });
      await call(h.env, "sendMessage", { chat_id: id, text: "Retry me" });
      await Promise.all([
        call(h.env, "sendMessage", { chat_id: id, text: "First" }),
        call(h.env, "sendMessage", { chat_id: id, text: "Second" }),
      ]);
      const calls = sentTo(await h.calls(), "sendMessage", id).filter((c) =>
        ["First", "Second"].includes(c.payload.text),
      );
      assert.equal(calls.length, 2);
      assert.ok(calls[1]!.at - calls[0]!.at >= 950);
    },
  },
  {
    name: "failed photo relays refund, suspended View-Once refunds, and stale photos fall back to text",
    async run(h) {
      const [a, b, id] = await pair(h);
      await h.fail({ method: "sendPhoto", chat: b.telegram_id, code: 403, remaining: 1 });
      await assert.rejects(
        () => relay(h, id, a, { text: undefined, file: "undeliverable-photo" }),
        /unavailable/,
      );
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 100);

      const [c, d, id2] = await pair(h);
      await sessionAction(h.env, id2, "view-mode", { userId: c.telegram_id });
      await relay(h, id2, c, { text: undefined, file: "suspended-view" });
      assert.equal((await getUser(h.env, c.telegram_id))!.credits, 95);
      await h.env.DB.prepare("UPDATE users SET photo_suspended_until=? WHERE telegram_id=?")
        .bind(Date.now() + DAY, c.telegram_id)
        .run();
      const view = (await h.session(id2, "inspect")).state.views[0];
      await assert.rejects(
        () =>
          sessionAction(h.env, id2, "reveal-photo", {
            userId: d.telegram_id,
            viewId: view.id,
          }),
        /no longer available/,
      );
      assert.equal((await getUser(h.env, c.telegram_id))!.credits, 100);

      const viewer = await seed(h, { geohash: "u0000" }),
        subject = await seed(h, { geohash: "u0000" });
      await h.fail({ method: "sendMediaGroup", chat: viewer.telegram_id, code: 400, remaining: 1 });
      await nearby(h.env, viewer);
      assert.ok(
        sentTo(await h.calls(), "sendMessage", viewer.telegram_id).some((c) =>
          String(c.payload.text).startsWith(subject.display_name),
        ),
      );
    },
  },
  {
    name: "payment mismatches are recorded, never retried, and only the owner payload grants",
    async run(h) {
      const u = await seed(h, { credits: 10 });
      const base = {
        currency: "XTR",
        total_amount: 1,
        invoice_payload: `v1:${u.telegram_id}:popular`,
        telegram_payment_charge_id: "mismatch-amount",
        provider_payment_charge_id: "",
      };
      await successfulPayment(h.env, u.telegram_id, base);
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 185);
      const recorded = await h.env.DB.prepare(
        "SELECT package_id,stars_paid,credits_granted FROM star_transactions WHERE charge_id=?",
      )
        .bind("mismatch-amount")
        .first<{ package_id: string; stars_paid: number; credits_granted: number }>();
      assert.equal(recorded!.package_id, "popular");
      assert.equal(recorded!.stars_paid, 1);
      assert.equal(recorded!.credits_granted, 175);
      await successfulPayment(h.env, u.telegram_id, {
        ...base,
        invoice_payload: `v1:${u.telegram_id + 1}:popular`,
        telegram_payment_charge_id: "foreign-payload",
      });
      assert.equal((await getUser(h.env, u.telegram_id))!.credits, 185);
      const foreign = await h.env.DB.prepare(
        "SELECT credits_granted FROM star_transactions WHERE charge_id=?",
      )
        .bind("foreign-payload")
        .first<{ credits_granted: number }>();
      assert.equal(foreign!.credits_granted, 0);
      assert.equal(sentTo(await h.calls(), "sendMessage", -100999).length, 2);
    },
  },
  {
    name: "a pair journal whose user disappeared is cleared and does not block matching",
    async run(h) {
      const a = await seed(h),
        sessionId = "broken-pair-session";
      await h.queue("pair", {
        id: sessionId,
        a: a.telegram_id,
        b: 999999999,
        escrows: [],
        requestId: null,
      });
      await h.queue("alarm");
      assert.equal((await getUser(h.env, a.telegram_id))!.active_session_id, sessionId);
      await assert.rejects(() => relay(h, sessionId, a), /unavailable/);
      assert.equal((await getUser(h.env, a.telegram_id))!.active_session_id, null);
      const c = await seed(h),
        d = await seed(h);
      await join(h, c);
      await join(h, d);
      assert.equal((await getUser(h.env, c.telegram_id))!.state, "IN_CHAT");
      assert.equal(
        (await getUser(h.env, c.telegram_id))!.active_session_id,
        (await getUser(h.env, d.telegram_id))!.active_session_id,
      );
    },
  },
  {
    name: "an uninitialized session alarm refunds escrow and releases both users",
    async run(h) {
      const [a, b, id] = await pair(h, true);
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 95);
      await h.session(id, "patch", { initialized: false });
      await h.session(id, "alarm");
      assert.equal((await getUser(h.env, a.telegram_id))!.credits, 100);
      for (const user of [a, b]) {
        const after = (await getUser(h.env, user.telegram_id))!;
        assert.equal(after.active_session_id, null);
        assert.equal(after.state, "IDLE");
      }
      assert.equal((await h.session(id, "inspect")).state, null);
    },
  },
  {
    name: "relay rate limit rejects an eleventh message within ten seconds",
    async run(h) {
      const [a, b, id] = await pair(h);
      await h.session(id, "patch", {
        relayWindow: { [String(a.telegram_id)]: { start: Date.now(), count: 10 } },
      });
      const before = (await h.calls()).length;
      await assert.rejects(() => relay(h, id, a, { text: "eleven" }), /Too many messages/);
      assert.equal((await h.calls()).length, before);
      await h.session(id, "patch", {
        relayWindow: { [String(a.telegram_id)]: { start: Date.now() - 11_000, count: 10 } },
      });
      await relay(h, id, a, { text: "after the window" });
      assert.equal(
        sentTo(await h.calls(), "sendMessage", b.telegram_id).filter(
          (c) => c.payload.text === "after the window",
        ).length,
        1,
      );
    },
  },
];
