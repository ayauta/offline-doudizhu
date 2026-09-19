import type { MatchFeedback, SelectionError } from "../app/session/table-view.js";

export interface FeedbackSource {
  readonly selectionError: SelectionError | null;
  readonly aiFallbackNotice: boolean;
  readonly feedback: MatchFeedback | null;
}

// One line of live feedback at a time. A rejected selection is about the cards the
// player just touched, so it outranks a notice about the computer; the match
// feedback is the quietest of the three.
export function feedbackMessage(source: FeedbackSource): string {
  if (source.selectionError === "unsupported-selection") {
    return "这些牌不能这样出";
  }
  if (source.selectionError === "does-not-beat") {
    return "这手牌压不过桌上的牌";
  }
  if (source.selectionError === "retry-selection") {
    return "这手牌暂时不能出，请重新选择";
  }
  if (source.aiFallbackNotice) {
    return "当前电脑水平暂不可用，本局已使用默认水平";
  }
  if (source.feedback === "no-response") {
    return "没有可以压过的牌";
  }
  if (source.feedback === "all-pass") {
    return "都不叫，重新发牌";
  }
  return "";
}
