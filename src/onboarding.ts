import type { Context } from "grammy/web";
import { clearDraft, getDraft, putDraft } from "./db";
import { highestPhoto, validName } from "./privacy";
import { call, lookupLocation, profile, tell } from "./telegram";
import { getUser } from "./db";
import { DAY, menu, UserError, type Draft, type Env, type Gender } from "./types";

const locationKeyboard = {
  keyboard: [
    [{ text: "📍 Share coarse location", request_location: true }],
    [{ text: "Choose city manually" }],
  ],
  resize_keyboard: true,
  one_time_keyboard: true,
};
export async function beginProfile(env: Env, id: number, editing = false): Promise<void> {
  await putDraft(env, id, { step: "adult", editing });
  await tell(
    env,
    id,
    "Welcome to Roulette. Meet someone new, privately.\n\nThis service is for adults 18+ only. Be respectful. Do not share another person’s private information.\n\nWe store a coarse location and Telegram photo references. Chat messages are scheduled for deletion after 24 hours. /privacy · /terms\n\nAre you 18 or older?",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "I am 18 or older", callback_data: "onboard:adult" }],
          [{ text: "I am under 18", callback_data: "onboard:underage" }],
        ],
      },
    },
  );
}
async function askLocation(env: Env, id: number, draft: Draft): Promise<void> {
  draft.step = "location";
  await putDraft(env, id, draft);
  await tell(
    env,
    id,
    "Share a location or choose your city and country. We store only a coarse ~5 km grid cell and city label, never your GPS pin. GPS is sent to OpenStreetMap’s geocoder to find the city.\nCity lookup: © OpenStreetMap contributors.",
    { reply_markup: locationKeyboard },
  );
}
async function askPhotos(env: Env, id: number, draft: Draft): Promise<void> {
  draft.step = "photos";
  draft.photos = [];
  await putDraft(env, id, draft);
  await tell(
    env,
    id,
    "Send 1–3 compressed profile photos using Telegram’s Photo option. Documents and other media are unsupported. Tap Done when ready.",
    { reply_markup: { keyboard: [[{ text: "Done with photos" }]], resize_keyboard: true } },
  );
}
export async function onboardingCallback(env: Env, id: number, action: string): Promise<void> {
  const draft = await getDraft(env, id);
  if (!draft) throw new UserError("This form has expired. Use /start or /profile.");
  if (action === "underage" && draft.step === "adult") {
    await clearDraft(env, id);
    await tell(env, id, "You must be at least 18 to use this service.");
    return;
  }
  if (action === "adult" && draft.step === "adult") {
    draft.step = "age";
    await putDraft(env, id, draft);
    await tell(env, id, "Enter your age as a whole number, from 18 to 99.", {
      reply_markup: { remove_keyboard: true },
    });
    return;
  }
  if (action.startsWith("gender-") && draft.step === "gender") {
    const gender = action.slice(7);
    if (!["M", "F", "O"].includes(gender))
      throw new UserError("Choose a gender using the buttons.");
    draft.gender = gender as Gender;
    await askLocation(env, id, draft);
    return;
  }
  if (action === "city-confirm" && draft.step === "city-confirm") {
    await askPhotos(env, id, draft);
    return;
  }
  if (action === "city-retry" && draft.step === "city-confirm") {
    draft.step = "city";
    delete draft.location;
    await putDraft(env, id, draft);
    await tell(env, id, "Enter your city and country, for example: Istanbul, Turkey.");
    return;
  }
  throw new UserError("That button belongs to an earlier step. Follow the latest prompt.");
}
export async function onboardingMessage(env: Env, ctx: Context, draft: Draft): Promise<void> {
  const id = ctx.from!.id;
  const message = ctx.message!;
  const text = message.text?.trim() ?? "";
  if (draft.step === "age") {
    if (!/^\d{2}$/.test(text) || Number(text) < 18 || Number(text) > 99)
      throw new UserError("Enter a whole-number age between 18 and 99.");
    draft.age = Number(text);
    draft.step = "name";
    await putDraft(env, id, draft);
    await tell(
      env,
      id,
      "What name should your profile show? Use 2–24 characters, without links or contact details.",
    );
  } else if (draft.step === "name") {
    draft.name = validName(text);
    draft.step = "gender";
    await putDraft(env, id, draft);
    await tell(env, id, "Choose your gender.", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Male", callback_data: "onboard:gender-M" },
            { text: "Female", callback_data: "onboard:gender-F" },
          ],
          [{ text: "Non-binary / Other", callback_data: "onboard:gender-O" }],
        ],
      },
    });
  } else if (draft.step === "location" || draft.step === "city") {
    if (message.location) {
      // Remove the native GPS message from Telegram as well as avoiding backend persistence.
      await call(env, "deleteMessage", { chat_id: id, message_id: message.message_id });
      const location = await lookupLocation(env, {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
      });
      draft.location = location;
      await askPhotos(env, id, draft);
    } else if (text === "Choose city manually" || !text) {
      draft.step = "city";
      await putDraft(env, id, draft);
      await tell(env, id, "Enter your city and country, for example: Tehran, Iran.", {
        reply_markup: { remove_keyboard: true },
      });
    } else {
      draft.location = await lookupLocation(env, text);
      draft.step = "city-confirm";
      await putDraft(env, id, draft);
      await tell(env, id, `Use ${draft.location.label}?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Use this city", callback_data: "onboard:city-confirm" }],
            [{ text: "Choose another city", callback_data: "onboard:city-retry" }],
          ],
        },
      });
    }
  } else if (draft.step === "photos") {
    if (message.photo?.length) {
      if ((draft.photos?.length ?? 0) >= 3)
        throw new UserError("You already have 3 photos. Tap Done with photos.");
      draft.photos ??= [];
      draft.photos.push(highestPhoto(message.photo)!);
      await putDraft(env, id, draft);
      await tell(
        env,
        id,
        `Photo ${draft.photos.length} of 3 added. Send another photo or tap Done with photos.`,
      );
    } else if (text === "Done with photos" || text === "/done") {
      if (!draft.photos?.length) throw new UserError("Add at least one compressed photo first.");
      await finish(env, id, draft);
    } else throw new UserError("Send a compressed photo (not a file), then tap Done with photos.");
  } else throw new UserError("Use the buttons in the latest prompt.");
}
async function finish(env: Env, id: number, draft: Draft): Promise<void> {
  if (!draft.name || !draft.gender || !draft.age || !draft.location || !draft.photos?.length)
    throw new UserError("Your profile is incomplete. Use /start to try again.");
  const now = Date.now();
  const existed = await getUser(env, id);
  await env.DB.prepare(
    `INSERT INTO users (telegram_id,public_id,display_name,gender,age,location_mode,location_label,geohash,photo_files,waves_reset_at,last_active_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET
    display_name=excluded.display_name,gender=excluded.gender,age=excluded.age,location_mode=excluded.location_mode,
    location_label=excluded.location_label,geohash=excluded.geohash,photo_files=excluded.photo_files,last_active_at=excluded.last_active_at`,
  )
    .bind(
      id,
      crypto.randomUUID(),
      draft.name,
      draft.gender,
      draft.age,
      draft.location.mode,
      draft.location.label,
      draft.location.geohash,
      JSON.stringify(draft.photos),
      (Math.floor(now / DAY) + 1) * DAY,
      now,
      now,
    )
    .run();
  await clearDraft(env, id);
  const user = (await getUser(env, id))!;
  await tell(
    env,
    id,
    existed
      ? "Profile updated."
      : "Your profile is ready. You received 10 welcome credits. Random chats are always free.",
    { reply_markup: menu },
  );
  await profile(env, user, user);
}
