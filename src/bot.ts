import { Bot, type Context } from "grammy/web";
import { clearDraft, getDraft, getUser, putDraft } from "./db";
import { nearby, publicUser } from "./discovery";
import { filtered, matchAction, savedFilters } from "./matchmaker";
import { blockUser } from "./moderation";
import { beginProfile, onboardingCallback, onboardingMessage } from "./onboarding";
import { highestPhoto } from "./privacy";
import { canPay, invoice, shop, successfulPayment } from "./payments";
import { sessionAction } from "./session";
import { profile, TelegramError, tell, type TelegramResult } from "./telegram";
import { chatMenu, FREE_FILTERS, menu, UserError, type Env, type User } from "./types";

const actionKey = (ctx: Context) => `u${ctx.update.update_id}`;
async function filtersMenu(env: Env, user: User): Promise<void> {
  const f = savedFilters(user);
  await tell(
    env,
    user.telegram_id,
    `⚙️ Roulette filters\nGender: ${{ ANY: "Any", M: "Male", F: "Female", O: "Non-binary / Other" }[f.gender]}\nAge: ${f.minAge}–${f.maxAge}\nLocation: ${{ ANY: "Anywhere", CITY: "Same city", NEARBY: "Nearby region" }[f.location]}\n\nFiltered searches hold 5 credits in escrow (VIP is free). The fee settles after a partner message or 15 seconds connected. An instant skip refunds it.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Any gender", callback_data: "filter:gender:ANY" },
            { text: "Male", callback_data: "filter:gender:M" },
            { text: "Female", callback_data: "filter:gender:F" },
            { text: "Other", callback_data: "filter:gender:O" },
          ],
          [{ text: "Set age range", callback_data: "filter:age" }],
          [
            { text: "Anywhere", callback_data: "filter:location:ANY" },
            { text: "Same city", callback_data: "filter:location:CITY" },
            { text: "Nearby", callback_data: "filter:location:NEARBY" },
          ],
          [
            {
              text: filtered(f) ? "Search · 5-credit escrow" : "Search for free",
              callback_data: "search",
            },
          ],
        ],
      },
    },
  );
}

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN, {
    botInfo: {
      id: Number(env.BOT_TOKEN.split(":")[0]),
      is_bot: true,
      first_name: "Roulette",
      username: env.BOT_USERNAME,
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  bot.api.config.use(async (_previous, method, payload) => {
    const response = await env.TELEGRAM.getByName("global").fetch("https://internal/call", {
      method: "POST",
      body: JSON.stringify({ method, payload }),
    });
    return (await response.json()) as TelegramResult as never;
  });
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (error instanceof UserError && ctx.from) {
        await tell(env, ctx.from.id, error.message);
        return;
      }
      if (error instanceof TelegramError && error.code === 403) return;
      throw error;
    }
  });
  // Checkout runs before profile, chat, or onboarding work to keep it within Telegram's 10s deadline.
  bot.on("pre_checkout_query", async (ctx) => {
    const p = ctx.preCheckoutQuery;
    const ok = await canPay(env, ctx.from.id, p.invoice_payload, p.currency, p.total_amount);
    await ctx.answerPreCheckoutQuery(
      ok,
      ok
        ? {}
        : {
            error_message:
              "This invoice is unavailable. Finish /start and choose a new package in /shop.",
          },
    );
  });
  bot.on("message:successful_payment", async (ctx) => {
    await successfulPayment(env, ctx.from.id, ctx.message.successful_payment);
  });
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    await next();
  });
  bot.command("help", async (ctx) => {
    await tell(
      env,
      ctx.from!.id,
      "🎲 /random — free roulette\n/search — saved filters (5-credit escrow)\n/filters — change preferences\n/nearby — browse active people nearby\n/profile — preview or edit your profile\n/next — end chat and find a free random partner\n/stop — end chat or cancel search\n/photos — standard photo pass (4 credits/session)\n/viewonce — next photo self-destructs (5 credits)\n/reveal — consensual username exchange\n/balance · /shop · /cancel\n/privacy · /terms · /paysupport\n\nOnly text and compressed photos are supported. Activity indicators appear while the bot relays content; Telegram does not send live user typing events to bots.",
    );
  });
  bot.command("privacy", async (ctx) => {
    await tell(
      env,
      ctx.from!.id,
      "We store your adult profile, a coarse five-character geohash (~5 km cell), city/country label, Telegram photo references, balance and payment receipts, blocks and reports. We never store GPS pins or image files. Wave icebreakers are kept until the request is delivered or expires. GPS coordinates are sent once to OpenStreetMap’s Nominatim geocoder; choose a city manually if you prefer.\n\nDuring chats we keep message IDs for replies and deletion; relayed text passes through without being stored. Incoming and relayed chat messages are scheduled for deletion after 24 hours; View-Once delivery after 10 seconds. Telegram outages, blocked bots, and client copies can prevent deletion. Protected content cannot guarantee screenshot prevention. Profiles persist until you ask the operator to remove them. /paysupport for operator contact.",
    );
  });
  bot.command("terms", async (ctx) => {
    await tell(
      env,
      ctx.from!.id,
      "Adults 18+ only. No harassment, illegal content, exploitation, or sharing others’ private details. Block or report unsafe profiles. Three unique reports in 24 hours suspend photo privileges pending review.\n\nCredits purchase bot features, have no cash value, and cannot be transferred. VIP waives feature credit costs for 7 days; additional passes extend the expiry. Paid requests are consumed when delivered, whether accepted or declined. Purchases do not renew automatically. For payment issues or refunds use /paysupport.\n\nMessages have deletion timers, but no bot can guarantee that a recipient has not copied them.",
    );
  });
  bot.command("paysupport", async (ctx) => {
    await tell(
      env,
      ctx.from!.id,
      `Payment support\n${env.SUPPORT_CONTACT}\nInclude the Telegram payment receipt and a description of the issue. Never share passwords or login codes.`,
    );
  });
  bot.command("start", async (ctx) => {
    const user = await getUser(env, ctx.from!.id);
    if (!user) {
      await beginProfile(env, ctx.from!.id);
      return;
    }
    if (user.is_banned)
      throw new UserError("Your account is suspended. Contact the operator through /paysupport.");
    await clearDraft(env, user.telegram_id);
    if (user.state === "INACTIVE")
      await env.DB.prepare("UPDATE users SET state='IDLE',last_active_at=? WHERE telegram_id=?")
        .bind(Date.now(), user.telegram_id)
        .run();
    if (user.active_session_id) {
      await tell(
        env,
        user.telegram_id,
        "You are still connected to your partner. /next finds a new free random match; /stop ends this chat.",
        { reply_markup: chatMenu },
      );
      return;
    }
    if (user.state === "QUEUED") {
      await tell(env, user.telegram_id, "Your search is still running. /stop cancels it.");
      return;
    }
    await tell(
      env,
      user.telegram_id,
      "Welcome back. Choose a random chat, browse nearby profiles, or update your profile.",
      { reply_markup: menu },
    );
  });
  bot.use(async (ctx, next) => {
    const user = await getUser(env, ctx.from!.id);
    if (user?.is_banned)
      throw new UserError("Your account is suspended. Contact the operator through /paysupport.");
    if (user)
      await env.DB.prepare(
        "UPDATE users SET last_active_at = ? WHERE telegram_id = ? AND last_active_at < ?",
      )
        .bind(Date.now(), user.telegram_id, Date.now() - 60_000)
        .run();
    await next();
  });
  bot.command("cancel", async (ctx) => {
    const user = await getUser(env, ctx.from!.id);
    await clearDraft(env, ctx.from!.id);
    if (user?.active_session_id)
      await sessionAction(env, user.active_session_id, "cancel-view", { userId: user.telegram_id });
    await tell(
      env,
      ctx.from!.id,
      user ? "Pending input cancelled." : "Onboarding cancelled. Use /start when ready.",
      {
        reply_markup: user?.active_session_id ? chatMenu : user ? menu : { remove_keyboard: true },
      },
    );
  });
  bot.on("callback_query:data", async (ctx) => {
    // Acknowledge before geocoding, discovery or session work.
    await ctx.answerCallbackQuery();
    const [action, value, detail] = ctx.callbackQuery.data.split(":");
    const id = ctx.from.id,
      key = actionKey(ctx);
    if (action === "onboard") {
      await onboardingCallback(env, id, value!);
      return;
    }
    const user = await getUser(env, id);
    if (!user) throw new UserError("Create a profile with /start first.");
    if (action === "edit") {
      if (user.state === "QUEUED" || user.active_session_id)
        throw new UserError("Use /stop before editing your profile.");
      await beginProfile(env, id, true);
      return;
    }
    if (action === "buy") {
      await invoice(env, id, value!);
      return;
    }
    if (action === "nearby") {
      await nearby(env, user, Number(value) || 0);
      return;
    }
    if (action === "filter") {
      if (user.active_session_id || user.state === "QUEUED")
        throw new UserError("Use /stop before changing your filters.");
      if (value === "age") {
        await putDraft(env, id, { step: "filters-age" });
        await tell(
          env,
          id,
          "Enter minimum and maximum ages, for example: 21-35. Allowed range: 18–99. /cancel to cancel.",
        );
        return;
      }
      if (value === "gender" && ["ANY", "M", "F", "O"].includes(detail!))
        await env.DB.prepare("UPDATE users SET filter_gender = ? WHERE telegram_id = ?")
          .bind(detail, id)
          .run();
      else if (value === "location" && ["ANY", "CITY", "NEARBY"].includes(detail!))
        await env.DB.prepare("UPDATE users SET filter_location = ? WHERE telegram_id = ?")
          .bind(detail, id)
          .run();
      else throw new UserError("Invalid filter choice.");
      await filtersMenu(env, (await getUser(env, id))!);
      return;
    }
    if (action === "search") {
      await clearDraft(env, id);
      await matchAction(env, "join", { userId: id, filters: savedFilters(user), key });
      return;
    }
    if (action === "fallback") {
      const filters =
        value === "random" ? FREE_FILTERS : { ...savedFilters(user), location: "ANY" };
      await matchAction(env, "join", { userId: id, filters, key });
      return;
    }
    if (action === "accept" || action === "decline") {
      await matchAction(env, action, { userId: id, requestId: value, key });
      if (action === "decline") await tell(env, id, "Request declined.");
      else await clearDraft(env, id);
      return;
    }
    if (["request", "wave", "reconnect", "block", "report", "reason"].includes(action!)) {
      const target = await publicUser(env, value!);
      if (action === "request" || action === "reconnect") {
        await matchAction(env, "request", {
          userId: id,
          target: target.telegram_id,
          kind: action === "reconnect" ? "RECONNECT" : "STANDARD",
          key,
        });
        return;
      }
      if (action === "wave") {
        if (user.active_session_id) throw new UserError("Finish your chat before sending a wave.");
        await putDraft(env, id, { step: "wave", target: target.telegram_id });
        await tell(
          env,
          id,
          `Write a short icebreaker for ${target.display_name} (1–200 characters, no contact details). They receive it with a notification. Costs 10 credits, free with VIP. /cancel to cancel.`,
        );
        return;
      }
      if (action === "block") {
        await blockUser(env, user, target);
        return;
      }
      if (action === "report") {
        await tell(
          env,
          id,
          "Why are you reporting this profile? Reporting also blocks the person.",
          {
            reply_markup: {
              inline_keyboard: ["Harassment", "Spam", "Underage", "Other"].map((reason) => [
                {
                  text: reason,
                  callback_data: `reason:${target.public_id}:${reason.toLowerCase()}`,
                },
              ]),
            },
          },
        );
        return;
      }
      if (!["harassment", "spam", "underage", "other"].includes(detail!))
        throw new UserError("Choose a report reason.");
      await blockUser(env, user, target, detail);
      return;
    }
    if (action === "view") {
      await sessionAction(env, value!, "reveal-photo", { userId: id, viewId: detail, key });
      return;
    }
    if (action === "consent" || action === "unlock") {
      if (user.active_session_id !== value) throw new UserError("That chat has ended.");
      await sessionAction(env, value!, action, { userId: id, username: ctx.from.username, key });
      return;
    }
    throw new UserError("That button is no longer available.");
  });
  bot.on("message", async (ctx) => {
    const id = ctx.from.id,
      text = ctx.message.text?.trim() ?? "",
      key = actionKey(ctx);
    const user = await getUser(env, id);
    const command = (text.split(/\s/)[0] ?? "").split("@")[0]!.toLowerCase();
    const aliases: Record<string, string> = {
      "🎲 Random chat": "/random",
      "📍 People nearby": "/nearby",
      "⚙️ Filters": "/filters",
      "👤 My profile": "/profile",
      "⭐ Shop": "/shop",
      "💰 Balance": "/balance",
    };
    const action = aliases[text] ?? command;
    if (action === "/stop" || action === "/next") {
      await clearDraft(env, id);
      if (user?.active_session_id)
        await sessionAction(env, user.active_session_id, "close", { userId: id });
      if (user) await matchAction(env, "leave", { userId: id, key });
      if (action === "/next" && user)
        await matchAction(env, "join", { userId: id, filters: FREE_FILTERS, key });
      else
        await tell(env, id, "Stopped. Choose your next step.", {
          reply_markup: user ? menu : { remove_keyboard: true },
        });
      return;
    }
    const draft = await getDraft(env, id);
    if (
      draft &&
      !["/profile", "/shop", "/balance", "/random", "/nearby", "/filters", "/search"].includes(
        action,
      )
    ) {
      if (draft.step === "filters-age") {
        const range = text.match(/^(\d{2})\s*[-– ]\s*(\d{2})$/);
        if (!user || !range || +range[1]! < 18 || +range[2]! > 99 || +range[1]! > +range[2]!)
          throw new UserError("Use an age range like 18-35, within 18–99.");
        await env.DB.prepare(
          "UPDATE users SET filter_min_age=?,filter_max_age=? WHERE telegram_id=?",
        )
          .bind(+range[1]!, +range[2]!, id)
          .run();
        await clearDraft(env, id);
        await filtersMenu(env, (await getUser(env, id))!);
        return;
      }
      if (draft.step === "wave") {
        if (!user) throw new UserError("Finish /start first.");
        await matchAction(env, "request", {
          userId: id,
          target: draft.target,
          kind: "SUPER",
          icebreaker: text,
          key,
        });
        await clearDraft(env, id);
        return;
      }
      await onboardingMessage(env, ctx, draft);
      return;
    }
    if (!user) {
      await beginProfile(env, id);
      return;
    }
    if (action === "/profile") {
      await profile(env, user, user);
      await tell(
        env,
        id,
        "Your profile. Editing replaces your name, age, gender, location and photos.",
        { reply_markup: { inline_keyboard: [[{ text: "Edit profile", callback_data: "edit" }]] } },
      );
      return;
    }
    if (action === "/shop") {
      await shop(env, id);
      return;
    }
    if (action === "/balance") {
      await tell(
        env,
        id,
        `Balance: ${user.credits} credits\n${user.vip_until > Date.now() ? `VIP until ${new Date(user.vip_until).toISOString().slice(0, 16).replace("T", " ")} UTC` : "VIP inactive"}\nFree nearby requests today: ${user.waves_reset_at <= Date.now() ? 3 : user.daily_free_waves} (resets at 00:00 UTC)`,
      );
      return;
    }
    if (["/random", "/nearby", "/filters", "/search"].includes(action)) {
      if (user.active_session_id)
        throw new UserError("You are in a chat. Use /stop or /next first.");
      await clearDraft(env, id);
      if (action === "/random" || action === "/search")
        await matchAction(env, "join", {
          userId: id,
          filters: action === "/random" ? FREE_FILTERS : savedFilters(user),
          key,
        });
      if (action === "/nearby") await nearby(env, user);
      if (action === "/filters") await filtersMenu(env, user);
      return;
    }
    if (["/photos", "/viewonce", "/reveal"].includes(action)) {
      if (!user.active_session_id) throw new UserError("Start a chat first with /random.");
      if (action === "/viewonce")
        await sessionAction(env, user.active_session_id, "view-mode", { userId: id, key });
      else
        await tell(
          env,
          id,
          action === "/photos"
            ? "Unlock all your standard photos for this session for 4 credits? VIP is free. View-Once still costs 5 credits each."
            : "Exchange public Telegram usernames only if you both agree. Tap below to consent to sharing your @username.",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      action === "/photos" ? "Unlock · 4 credits" : "I agree to share my @username",
                    callback_data: `${action === "/photos" ? "unlock" : "consent"}:${user.active_session_id}`,
                  },
                ],
              ],
            },
          },
        );
      return;
    }
    if (text.startsWith("/"))
      throw new UserError("Unknown command. Use /help to see available commands.");
    if (!user.active_session_id)
      throw new UserError("Choose /random to meet someone or /nearby to browse profiles.");
    if (!ctx.message.text && !ctx.message.photo)
      throw new UserError(
        "Only text and compressed photos are supported. Documents, videos, voice notes and stickers are not accepted.",
      );
    await sessionAction(env, user.active_session_id, "relay", {
      userId: id,
      key,
      messageId: ctx.message.message_id,
      replyTo: ctx.message.reply_to_message?.message_id,
      text: ctx.message.text,
      file: ctx.message.photo ? highestPhoto(ctx.message.photo) : undefined,
      caption: ctx.message.caption,
      hasUrlEntity: [...(ctx.message.entities ?? []), ...(ctx.message.caption_entities ?? [])].some(
        (e) => e.type === "url" || e.type === "text_link",
      ),
    });
  });
  return bot;
}
