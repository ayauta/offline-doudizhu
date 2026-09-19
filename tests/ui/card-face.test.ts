import { describe, expect, it } from "vitest";

import { asCardId } from "../../src/core/cards/index.js";
import { cardName, isRed } from "../../src/ui/components/card-face.js";

describe("card face naming", () => {
  it("names the jokers by their rank rather than by suit", () => {
    expect(cardName(asCardId(52))).toBe("小王");
    expect(cardName(asCardId(53))).toBe("大王");
  });

  it("names standard cards suit first so a screen reader reads 黑桃A", () => {
    expect(cardName(asCardId(0))).toBe("梅花3");
    expect(cardName(asCardId(51))).toBe("黑桃2");
  });

  it("draws the big joker and both red suits in red", () => {
    expect(isRed(asCardId(53))).toBe(true);
    expect(isRed(asCardId(1))).toBe(true);
    expect(isRed(asCardId(2))).toBe(true);
  });

  it("draws the small joker and both black suits in black", () => {
    expect(isRed(asCardId(52))).toBe(false);
    expect(isRed(asCardId(0))).toBe(false);
    expect(isRed(asCardId(3))).toBe(false);
  });
});
