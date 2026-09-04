import { describe, expect, it } from "vitest";

import { handNaturalWidth } from "../../src/ui/layout/hand-layout.js";

describe("natural hand width", () => {
  it("keeps one card at physical width and two cards one preferred step apart", () => {
    expect(handNaturalWidth(1)).toBe("var(--hand-card-width)");
    expect(handNaturalWidth(2)).toBe(
      "calc(var(--hand-card-width) + var(--hand-card-step))",
    );
  });

  it("adds one preferred step for every gap in a normal 17-card hand", () => {
    const width = handNaturalWidth(17);
    expect(width.match(/var\(--hand-card-step\)/g)).toHaveLength(16);
  });

  it("treats an empty transient hand as one stable card-width slot", () => {
    expect(handNaturalWidth(0)).toBe("var(--hand-card-width)");
  });
});
