import type { ChatSessionDO } from "./session";
import type { MatchmakerDO } from "./matchmaker";
import type { TelegramDO } from "./telegram";

export interface Env {
  DB: D1Database;
  MATCHMAKER: DurableObjectNamespace<MatchmakerDO>;
  SESSIONS: DurableObjectNamespace<ChatSessionDO>;
  TELEGRAM: DurableObjectNamespace<TelegramDO>;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  BOT_USERNAME: string;
  ADMIN_CHAT_ID?: string;
  GEOCODER_USER_AGENT: string;
  GEOCODER_URL?: string;
  SUPPORT_CONTACT: string;
}

export type Gender = "M" | "F" | "O";
export interface Filters {
  gender: Gender | "ANY";
  minAge: number;
  maxAge: number;
  location: "ANY" | "CITY" | "NEARBY";
}
export const FREE_FILTERS: Filters = { gender: "ANY", minAge: 18, maxAge: 99, location: "ANY" };
export interface User {
  telegram_id: number;
  public_id: string;
  display_name: string;
  gender: Gender;
  age: number;
  location_mode: "EXACT_COARSE" | "CITY";
  location_label: string;
  geohash: string;
  photo_files: string;
  credits: number;
  vip_until: number;
  daily_free_waves: number;
  waves_reset_at: number;
  state: "IDLE" | "QUEUED" | "IN_CHAT" | "INACTIVE";
  active_session_id: string | null;
  last_partner_id: number | null;
  filter_gender: Filters["gender"];
  filter_min_age: number;
  filter_max_age: number;
  filter_location: Filters["location"];
  is_banned: number;
  photo_suspended_until: number;
  last_active_at: number;
  created_at: number;
}
export interface Location {
  mode: User["location_mode"];
  label: string;
  geohash: string;
}
export interface Draft {
  step:
    | "adult"
    | "age"
    | "name"
    | "gender"
    | "location"
    | "city"
    | "city-confirm"
    | "photos"
    | "filters-age"
    | "wave";
  age?: number;
  name?: string;
  gender?: Gender;
  location?: Location;
  photos?: string[];
  target?: number;
}
export interface ChatRequest {
  id: string;
  sender_id: number;
  recipient_id: number;
  icebreaker_text: string | null;
  kind: "STANDARD" | "SUPER" | "RECONNECT";
  cost: number;
  uses_free: number;
  delivery_phase: number;
  delivered_at: number | null;
  created_at: number;
  status: string;
  expires_at: number;
}
export class UserError extends Error {}
export const DAY = 86_400_000;
export const menu = {
  keyboard: [
    [{ text: "🎲 Random chat" }, { text: "📍 People nearby" }],
    [{ text: "⚙️ Filters" }, { text: "👤 My profile" }],
    [{ text: "⭐ Shop" }, { text: "💰 Balance" }],
  ],
  resize_keyboard: true,
};
export const chatMenu = {
  keyboard: [
    [{ text: "/next" }, { text: "/stop" }],
    [{ text: "/viewonce" }, { text: "/photos" }, { text: "/reveal" }],
  ],
  resize_keyboard: true,
};
