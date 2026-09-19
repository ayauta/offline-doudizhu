import { describe, expect, it } from "vitest";

import { feedbackMessage } from "../../src/ui/feedback-message.js";

function source(overrides: Partial<Parameters<typeof feedbackMessage>[0]> = {}) {
  return {
    aiFallbackNotice: false,
    feedback: null,
    selectionError: null,
    ...overrides,
  };
}

describe("live feedback message", () => {
  it("says nothing when there is nothing to report", () => {
    expect(feedbackMessage(source())).toBe("");
  });

  it("names each selection error", () => {
    expect(feedbackMessage(source({ selectionError: "unsupported-selection" })))
      .toBe("这些牌不能这样出");
    expect(feedbackMessage(source({ selectionError: "does-not-beat" })))
      .toBe("这手牌压不过桌上的牌");
    expect(feedbackMessage(source({ selectionError: "retry-selection" })))
      .toBe("这手牌暂时不能出，请重新选择");
  });

  it("ranks a selection error above every other notice", () => {
    expect(
      feedbackMessage(source({
        aiFallbackNotice: true,
        feedback: "no-response",
        selectionError: "does-not-beat",
      })),
    ).toBe("这手牌压不过桌上的牌");
  });

  it("ranks the fallback notice above the match feedback", () => {
    expect(feedbackMessage(source({ aiFallbackNotice: true, feedback: "all-pass" })))
      .toBe("当前电脑水平暂不可用，本局已使用默认水平");
  });

  it("reports the two match feedbacks last", () => {
    expect(feedbackMessage(source({ feedback: "no-response" }))).toBe("没有可以压过的牌");
    expect(feedbackMessage(source({ feedback: "all-pass" }))).toBe("都不叫，重新发牌");
  });
});
