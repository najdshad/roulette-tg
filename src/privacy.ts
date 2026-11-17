import { UserError, type Location, type User } from "./types";
import type { PhotoSize } from "grammy/types";

const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
export function highestPhoto(photos: readonly PhotoSize[]): string | undefined {
  return photos.reduce<PhotoSize | undefined>(
    (best, photo) =>
      !best || photo.width * photo.height > best.width * best.height ? photo : best,
    undefined,
  )?.file_id;
}
// Quantizing into a five-character cell discards the original GPS pin.
export function geohash(latitude: number, longitude: number): string {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new UserError("That location is invalid.");
  const lat = [-90, 90],
    lon = [-180, 180];
  let hash = "",
    bits = 0,
    value = 0;
  for (let i = 0; i < 25; i++) {
    const range = i % 2 === 0 ? lon : lat;
    const coordinate = i % 2 === 0 ? longitude : latitude;
    const midpoint = (range[0]! + range[1]!) / 2;
    const high = coordinate >= midpoint;
    range[high ? 0 : 1] = midpoint;
    value = value * 2 + Number(high);
    if (++bits === 5) {
      hash += alphabet[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}
export function cellCenter(hash: string): [number, number] {
  const lat = [-90, 90],
    lon = [-180, 180];
  let i = 0;
  for (const char of hash) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid stored geohash");
    for (let bit = 4; bit >= 0; bit--) {
      const range = i++ % 2 === 0 ? lon : lat;
      range[(value >> bit) & 1 ? 0 : 1] = (range[0]! + range[1]!) / 2;
    }
  }
  return [(lat[0]! + lat[1]!) / 2, (lon[0]! + lon[1]!) / 2];
}
export function distanceBucket(a: User, b: User): string {
  if (a.location_mode === "CITY" || b.location_mode === "CITY")
    return a.location_label === b.location_label ? "Same City" : "Nearby area";
  const [lat1, lon1] = cellCenter(a.geohash),
    [lat2, lon2] = cellCenter(b.geohash);
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return km < 2
    ? "< 2 km away"
    : km < 8
      ? "~5 km away"
      : km < 25
        ? "~15 km away"
        : a.location_label === b.location_label
          ? "Same City"
          : "Nearby area";
}
export function hasContact(text: string): boolean {
  return /(?:https?:\/\/|www\.|t\.me\/|@\w|\b(?:[a-z0-9-]+\.)+(?:[a-z]{2,63})(?:\b|\/)|\+?[\p{Nd}][\p{Nd}\s().-]{5,}[\p{Nd}])/iu.test(
    text,
  );
}
export function validName(text: string): string {
  const name = text.trim().normalize("NFKC");
  if (
    [...name].length < 2 ||
    [...name].length > 24 ||
    hasContact(name) ||
    /[\p{Cc}\p{Cf}]/u.test(name)
  )
    throw new UserError("Use a 2–24 character name without links, @handles, or phone numbers.");
  return name;
}
export function hasUrl(text: string): boolean {
  return /(?:https?:\/\/|www\.|t\.me\/|tg:\/\/|\b(?:[\p{L}\d-]+\.)+[\p{L}]{2,63}(?:\b|\/))/iu.test(
    text,
  );
}
interface GeoResult {
  lat: string;
  lon: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    country?: string;
  };
}
export async function locate(
  userAgent: string,
  input: { latitude: number; longitude: number } | string,
  endpoint = "https://nominatim.openstreetmap.org",
): Promise<Location> {
  const url = new URL(
    typeof input === "string" ? "search" : "reverse",
    endpoint.replace(/\/?$/, "/"),
  );
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  if (typeof input === "string") {
    if (input.length < 3 || input.length > 120 || hasContact(input))
      throw new UserError("Enter a city and country, for example: Shiraz, Iran.");
    url.searchParams.set("q", input);
    url.searchParams.set("limit", "1");
    url.searchParams.set("layer", "address");
  } else {
    // Validate before sending anything to the geocoder. The request is never logged.
    geohash(input.latitude, input.longitude);
    url.searchParams.set("lat", String(input.latitude));
    url.searchParams.set("lon", String(input.longitude));
    url.searchParams.set("zoom", "10");
  }
  let data: GeoResult | undefined;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent, "Accept-Language": "en" },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error("Geocoder unavailable");
    const json = (await response.json()) as GeoResult | GeoResult[];
    data = Array.isArray(json) ? json[0] : json;
  } catch {
    throw new UserError(
      "Location lookup is unavailable. Try again shortly or choose a city manually.",
    );
  }
  const address = data?.address;
  const city =
    address?.city || address?.town || address?.village || address?.municipality || address?.state;
  if (!data || !city || !address?.country)
    throw new UserError("City not found. Enter the city and country together.");
  return {
    mode: typeof input === "string" ? "CITY" : "EXACT_COARSE",
    label: `${city}, ${address.country}`,
    geohash:
      typeof input === "string"
        ? geohash(Number(data.lat), Number(data.lon))
        : geohash(input.latitude, input.longitude),
  };
}
