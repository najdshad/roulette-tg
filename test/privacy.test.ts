import { describe, expect, it } from "vitest";
import { cellCenter, geohash, hasContact, hasUrl, validName } from "../src/privacy";

describe("profile privacy", () => {
  it("quantizes location without retaining a pin", () => {
    const hash = geohash(35.6892, 51.389);
    expect(hash).toHaveLength(5);
    const [lat, lon] = cellCenter(hash);
    expect(Math.abs(lat - 35.6892)).toBeLessThan(0.025);
    expect(Math.abs(lon - 51.389)).toBeLessThan(0.025);
    expect(lat).not.toBe(35.6892);
    expect(() => geohash(91, 1)).toThrow();
  });
  it("blocks contact details in profile names", () => {
    for (const name of [
      "@alice",
      "Alice https://evil.test",
      "+1 202 555 0101",
      "Alice\nSmith",
      "x",
    ])
      expect(() => validName(name)).toThrow();
    expect(validName("  نیلوفر  ")).toBe("نیلوفر");
    expect(hasContact("visit example.com")).toBe(true);
    expect(hasUrl("look at example.com")).toBe(true);
    expect(hasUrl("hello there")).toBe(false);
  });
});
