import type { Rank } from "../cards/index.js";
import { rankStrength } from "./ranks.js";
import type {
  ComparisonResult,
  ClassifiedPlay,
  PlayPattern,
} from "./types.js";

function result<Result extends ComparisonResult>(value: Result): Result {
  return Object.freeze(value);
}

function sequenceLength(pattern: PlayPattern): number | undefined {
  switch (pattern.kind) {
    case "straight":
    case "consecutive-pairs":
    case "airplane":
    case "airplane-with-singles":
    case "airplane-with-pairs":
      return pattern.sequenceLength;
    default:
      return undefined;
  }
}

function mainRank(pattern: Exclude<PlayPattern, Readonly<{ kind: "rocket" }>>): Rank {
  return pattern.mainRank;
}

export function comparePlays(
  challenger: ClassifiedPlay,
  incumbent: ClassifiedPlay,
): ComparisonResult {
  const challengerPattern = challenger.pattern;
  const incumbentPattern = incumbent.pattern;

  if (challengerPattern.kind === "rocket") {
    return result({ outcome: incumbentPattern.kind === "rocket" ? "equal" : "higher" });
  }
  if (incumbentPattern.kind === "rocket") {
    return result({ outcome: "lower" });
  }

  const challengerIsBomb = challengerPattern.kind === "bomb";
  const incumbentIsBomb = incumbentPattern.kind === "bomb";
  if (challengerIsBomb !== incumbentIsBomb) {
    return result({ outcome: challengerIsBomb ? "higher" : "lower" });
  }

  if (challengerPattern.kind !== incumbentPattern.kind) {
    return result({ outcome: "incomparable", reason: "different-pattern" });
  }

  const challengerLength = sequenceLength(challengerPattern);
  const incumbentLength = sequenceLength(incumbentPattern);
  if (challengerLength !== incumbentLength) {
    return result({ outcome: "incomparable", reason: "different-length" });
  }

  const difference = rankStrength(mainRank(challengerPattern)) - rankStrength(mainRank(incumbentPattern));
  if (difference > 0) {
    return result({ outcome: "higher" });
  }
  if (difference < 0) {
    return result({ outcome: "lower" });
  }
  return result({ outcome: "equal" });
}
