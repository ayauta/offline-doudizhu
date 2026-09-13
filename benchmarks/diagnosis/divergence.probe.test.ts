/** Narrows a solver/oracle divergence to the rule they disagree about. */
import { describe, expect, it } from "vitest";
import { asCardId, createDeck, type CardId } from "../../src/core/cards/index.js";
import { transition, type GameState, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { commandsFrom, playingOf, solve } from "./exact-solver.js";
import { countsOf, oraclePlaysFor, oracleLandlordWins, type OracleShape } from "./exact-oracle.js";

const SEATS: readonly Seat[] = ["human", "ai-one", "ai-two"];
function makeState(hands: Record<Seat, readonly CardId[]>, turn: Seat, landlord: Seat): GameState {
  return Object.freeze({
    phase: "ready-to-play" as const,
    hands: Object.freeze({ human: Object.freeze([...hands.human]), "ai-one": Object.freeze([...hands["ai-one"]]), "ai-two": Object.freeze([...hands["ai-two"]]) }),
    bottomCards: Object.freeze([]), landlord, currentSeat: turn,
  }) as GameState;
}

describe("divergence narrowing", () => {
  it("prints both rule sets for the smallest diverging position", () => {
    const pool = [asCardId(0), asCardId(1), asCardId(2), asCardId(4), asCardId(5), asCardId(48)];
    const cases: Array<{ hands: Record<Seat, CardId[]>; turn: Seat; landlord: Seat }> = [];
    // Enumerate the same space, but stop at the first divergence.
    for (let mask = 0; mask < 4 ** pool.length; mask += 1) {
      const hands: Record<Seat, CardId[]> = { human: [], "ai-one": [], "ai-two": [] };
      let m = mask;
      let ok = true;
      for (const card of pool) {
        const who = m % 4; m = Math.floor(m / 4);
        if (who === 3) continue;
        const seat = SEATS[who];
        if (seat === undefined) { ok = false; break; }
        if (hands[seat].length >= 3) { ok = false; break; }
        hands[seat] = [...hands[seat], card];
      }
      if (!ok) continue;
      for (const turn of SEATS) for (const landlord of SEATS) cases.push({ hands, turn, landlord });
    }

    for (const { hands, turn, landlord } of cases) {
      const state = makeState(hands, turn, landlord);
      const playing = playingOf(state);
      if (playing === null) continue;
      const solver = solve(state);
      if (!solver.completed) continue;
      const oracleState = Object.freeze({
        hands: Object.freeze({ human: Object.freeze(countsOf(hands.human)), "ai-one": Object.freeze(countsOf(hands["ai-one"])), "ai-two": Object.freeze(countsOf(hands["ai-two"])) }),
        turn, landlord, lead: null as OracleShape | null, leadSeat: null as Seat | null, trailingPass: false, winner: null as Seat | null,
      });
      const oracle = oracleLandlordWins(oracleState);
      if (solver.landlordWins === oracle) continue;

      const engineMoves = commandsFrom(playing.seat, playing.view)
        .map((c) => (c.type === "pass" ? "pass" : [...c.cards].sort((a, b) => a - b).join(",")));
      const oracleMoves = oraclePlaysFor(countsOf(hands[turn]), null)
        .map((s) => `${String(s.length)}x${String(s.size)}@${String(s.rank)}${s.isBomb ? " BOMB" : ""}`);
      console.log([
        "",
        `DIVERGENCE turn=${turn} landlord=${landlord}`,
        `  hands human=${JSON.stringify(hands.human)} ai-one=${JSON.stringify(hands["ai-one"])} ai-two=${JSON.stringify(hands["ai-two"])}`,
        `  solver landlordWins=${String(solver.landlordWins)}  oracle=${String(oracle)}`,
        `  engine legal (${String(engineMoves.length)}): ${engineMoves.join(" | ")}`,
        `  oracle legal (${String(oracleMoves.length)}): ${oracleMoves.join(" | ")}`,
        "",
      ].join("\n"));
      // Also show what the engine does with an empty hand, the likely culprit.
      const emptyState = makeState({ human: hands.human, "ai-one": hands["ai-one"], "ai-two": hands["ai-two"] }, turn, landlord);
      void emptyState;
      expect(true).toBe(true);
      return;
    }
    console.log("no divergence found");
    expect(true).toBe(true);
  }, 900_000);
});
