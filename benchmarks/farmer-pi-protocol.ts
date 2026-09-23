/**
 * Farmer Policy Iteration Factory v1 — the frozen protocol, and the parser that
 * reads it.
 *
 * The protocol is a file, not a set of constants in code, because the thing
 * being frozen is *the whole configuration at once*: the model parameters, the
 * split sizes, the screen rules, the alpha, the promotion floor, the retry rule,
 * the attempt cap. A protocol spread across six modules cannot be hashed, and a
 * protocol that cannot be hashed cannot be shown to be the one that ran.
 *
 * `protocolHash` is the SHA-256 of the file's bytes. Every checkpoint, every
 * champion archive and every attempt record cites it, so a result produced
 * under a different protocol is identifiable after the fact rather than
 * arguable.
 *
 * ## Why there is a parser here at all
 *
 * The repository has one runtime dependency (`preact`) and a hand-written
 * Student-t quantile rather than a statistics package, on the principle that a
 * frozen decision path should be readable by anyone with the repository. The
 * same reasoning applies to a protocol file, and the alternative — JSON — is
 * worse for a document humans are meant to review and annotate.
 *
 * So this is a strict subset of YAML: block maps, block lists, and scalars.
 * There are no flow collections, no anchors, no aliases, no multi-line scalars
 * and no multiple documents, and each of those is a *refusal* with a message
 * rather than a silent misreading. A protocol file that needs one of them is a
 * protocol file that has outgrown this parser, which is a thing to notice
 * rather than to paper over.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./farmer-pi-stage.js";
import { verifyIdentities, type IdentityDigest } from "./farmer-pi-identity.js";
import { CF_FEATURE_SCHEMA_VERSION } from "./cf-dataset.js";
import { CF_FEATURE_NAMES } from "../src/core/ai/cf-features.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PROTOCOL_PATH = join(ROOT, "research", "farmer-pi", "protocol-v1.yaml");

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const REFUSED = [
  { pattern: /^\s*%/, why: "a YAML directive" },
  { pattern: /^\s*---/, why: "a document marker" },
  { pattern: /^\s*\.\.\./, why: "a document end marker" },
  { pattern: /[&*][A-Za-z_]/, why: "an anchor or alias" },
  { pattern: /^\s*[^#\s][^:]*:\s*[|>]\s*$/, why: "a block scalar" },
  { pattern: /:\s*[[{]/, why: "a flow collection" },
  { pattern: /^\s*-?\s*[[{].*[\]}]\s*$/, why: "a flow collection" },
];

type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };
type YamlLine = Readonly<{ number: number; indent: number; text: string }>;
type Cursor = { index: number };

const KEY_VALUE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

function scalar(text: string, lineNumber: number): YamlScalar {
  const value = text.trim();
  if (value === "" || value === "~" || value === "null") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    // A digit run too long to survive as a double stays a string rather than
    // becoming a silently imprecise number. A hex digest that happens to be all
    // digits is the case this is for, and it is rare enough that losing it to a
    // rounding error would be the kind of thing nobody notices.
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  if (/^-?\d*\.\d+([eE][-+]?\d+)?$/.test(value)) {
    return Number.parseFloat(value);
  }
  if (/^".*"$/.test(value)) {
    return JSON.parse(value) as string;
  }
  if (/^'.*'$/.test(value)) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[|>[\]{}&*!%]/.test(value)) {
    throw new ProtocolError(`Line ${lineNumber}: "${value}" is not a supported scalar.`);
  }
  return value;
}

function lineAt(lines: readonly YamlLine[], cursor: Cursor): YamlLine | undefined {
  return lines[cursor.index];
}

/** Consumes one `key: value` entry at `indent`, recursing for a nested block. */
function parseEntry(
  lines: readonly YamlLine[],
  cursor: Cursor,
  indent: number,
  path: string,
): Readonly<{ key: string; value: YamlValue }> {
  const line = lineAt(lines, cursor);
  if (line === undefined) {
    throw new ProtocolError(`Unexpected end of file inside ${path || "the document"}.`);
  }
  const match = KEY_VALUE.exec(line.text);
  if (match === null) {
    throw new ProtocolError(`Line ${line.number}: "${line.text}" is not "key: value".`);
  }
  const key = match[1] ?? "";
  const valueText = match[2] ?? "";
  cursor.index += 1;
  return Object.freeze({
    key,
    value: valueText === ""
      ? parseBlock(lines, cursor, indent + 2, `${path}.${key}`)
      : scalar(valueText, line.number),
  });
}

/**
 * Parses one block at `indent`, consuming lines from `cursor`.
 *
 * The cursor is an object rather than a number so the recursion can advance the
 * caller's position without returning a tuple at every level.
 */
function parseBlock(
  lines: readonly YamlLine[],
  cursor: Cursor,
  indent: number,
  path: string,
): YamlValue {
  const first = lineAt(lines, cursor);
  if (first === undefined) {
    return {};
  }
  if (first.text.startsWith("- ")) {
    return parseList(lines, cursor, indent, path);
  }
  return parseMap(lines, cursor, indent, path);
}

function parseMap(
  lines: readonly YamlLine[],
  cursor: Cursor,
  indent: number,
  path: string,
): { [key: string]: YamlValue } {
  const result: { [key: string]: YamlValue } = {};
  while (cursor.index < lines.length) {
    const line = lineAt(lines, cursor);
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new ProtocolError(
        `Line ${line.number}: unexpected indentation (${line.indent} spaces where ${indent} ` +
        `were expected) inside ${path || "the document"}.`,
      );
    }
    if (line.text.startsWith("- ")) {
      throw new ProtocolError(
        `Line ${line.number}: ${path || "the document"} is a map, so a list entry here is a ` +
        "mistake.",
      );
    }
    const entry = parseEntry(lines, cursor, indent, path);
    if (Object.prototype.hasOwnProperty.call(result, entry.key)) {
      throw new ProtocolError(
        `Line ${line.number}: duplicate key "${entry.key}" in ${path || "the document"}.`,
      );
    }
    result[entry.key] = entry.value;
  }
  return result;
}

function parseList(
  lines: readonly YamlLine[],
  cursor: Cursor,
  indent: number,
  path: string,
): YamlValue[] {
  const result: YamlValue[] = [];
  while (cursor.index < lines.length) {
    const line = lineAt(lines, cursor);
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new ProtocolError(
        `Line ${line.number}: unexpected indentation inside the list at ${path || "the document"}.`,
      );
    }
    if (!line.text.startsWith("- ")) {
      throw new ProtocolError(
        `Line ${line.number}: ${path || "the document"} is a list, so every entry must start ` +
        'with "- ".',
      );
    }
    const rest = line.text.slice(2);
    const inline = KEY_VALUE.exec(rest);
    if (inline !== null) {
      // The compact `- key: value` form. The first entry sits on the dash line
      // itself, so its nested block — if it has one — begins four columns in,
      // and the entry's *siblings* sit two columns in, one level below the dash.
      const item: { [key: string]: YamlValue } = {};
      const itemPath = `${path}[${result.length}]`;
      const firstKey = inline[1] ?? "";
      const firstValue = inline[2] ?? "";
      cursor.index += 1;
      item[firstKey] = firstValue === ""
        ? parseBlock(lines, cursor, indent + 4, `${itemPath}.${firstKey}`)
        : scalar(firstValue, line.number);
      while (cursor.index < lines.length) {
        const head = lineAt(lines, cursor);
        if (head === undefined || head.indent !== indent + 2 || head.text.startsWith("- ")) {
          break;
        }
        const entry = parseEntry(lines, cursor, indent + 2, itemPath);
        if (Object.prototype.hasOwnProperty.call(item, entry.key)) {
          throw new ProtocolError(`Line ${head.number}: duplicate key "${entry.key}" in ${itemPath}.`);
        }
        item[entry.key] = entry.value;
      }
      result.push(item);
      continue;
    }
    cursor.index += 1;
    result.push(rest === ""
      ? parseBlock(lines, cursor, indent + 2, `${path}[${result.length}]`)
      : scalar(rest, line.number));
  }
  return result;
}

export function parseProtocolYaml(text: string): YamlValue {
  const lines: YamlLine[] = [];
  for (const [offset, raw] of text.split("\n").entries()) {
    if (/^\s*\t/.test(raw)) {
      throw new ProtocolError(`Line ${offset + 1}: tabs are not indentation.`);
    }
    // A comment starts at a `#` that begins the line or follows whitespace, so
    // a `#` inside a value is left alone. The protocol has no values containing
    // `#` today; if one ever appears it will need quoting, which is the right
    // amount of friction for a frozen document.
    const withoutComment = raw.replace(/(^|\s)#.*$/, "");
    if (withoutComment.trim() === "") {
      continue;
    }
    for (const refused of REFUSED) {
      if (refused.pattern.test(withoutComment)) {
        throw new ProtocolError(
          `Line ${offset + 1}: this parser refuses ${refused.why}; see the file header.`,
        );
      }
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push(Object.freeze({ number: offset + 1, indent, text: withoutComment.trim() }));
  }
  if (lines.length === 0) {
    throw new ProtocolError("The protocol file is empty.");
  }
  const cursor: Cursor = { index: 0 };
  const value = parseBlock(lines, cursor, 0, "");
  if (cursor.index !== lines.length) {
    throw new ProtocolError(`Line ${lines[cursor.index]?.number ?? 0} was not consumed.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The typed protocol
// ---------------------------------------------------------------------------

/**
 * The protocol as the Factory reads it. Every field here is checked on load:
 * a protocol that is missing a rule is not a protocol with a default, it is a
 * protocol that cannot be frozen.
 */
export type FactoryProtocol = Readonly<{
  version: number;
  frozenAt: string;
  /**
   * True for a document that exists to exercise the pipeline on retired deals
   * and is never the Factory's protocol. It relaxes the *sizes* — a miniature
   * has to be small — and it changes where a promotion is archived, so a
   * rehearsal can walk the whole state machine without being able to produce
   * anything a real attempt could mistake for its own.
   */
  rehearsalOnly: boolean;
  /** The champion every attempt starts from. */
  startChampion: string;
  /** §41: candidate-training attempts, base and retry together. */
  attemptCap: number;
  /** §22: one retry per champion, at double the dataset. */
  retryPerChampion: number;
  model: Readonly<{
    objective: string;
    iterations: number;
    maxDepth: number;
    numLeaves: number;
    learningRate: number;
    minDataInLeaf: number;
    lambdaL1: number;
    lambdaL2: number;
    featureFraction: number;
    baggingFraction: number;
    baggingFreq: number;
    maxBin: number;
    threads: number;
    deterministic: boolean;
    forceColWise: boolean;
    seed: number;
    lightgbmVersion: string;
  }>;
  calibration: Readonly<{
    thresholds: readonly number[];
    families: number;
    alpha: number;
    minOverrideDeals: number;
    minSelectedNonzeroDeals: number;
  }>;
  offline: Readonly<{
    groups: number;
    minOverrideDeals: number;
    minSelectedNonzeroDeals: number;
  }>;
  stage1: Readonly<{ deals: number }>;
  formal: Readonly<{
    alpha: number;
    promotionFloor: number;
    designDelta: number;
    ladder: readonly number[];
  }>;
  attempt: Readonly<{
    blockDeals: number;
    trainDeals: number;
    calibrationDeals: number;
    offlineDeals: number;
    stage1Deals: number;
    formalReserveDeals: number;
    retryTrainFreshDeals: number;
    retryCalibrationDeals: number;
    retryOfflineDeals: number;
  }>;
  corpus: Readonly<{
    datasetVersion: number;
    snapshotSalt: string;
    groupSnapshotCap: number;
    seedBase: number;
  }>;
  referenceBoard: Readonly<{ poolId: string; start: number; end: number }>;
  /**
   * The four role identities and the feature schema, by hash. This is what
   * makes "the teammate is frozen" a statement about bytes rather than about a
   * commit message; `assertIdentitiesCurrent` re-derives them from the working
   * tree.
   */
  identities: Readonly<{
    teammate: IdentityDigest;
    landlord: IdentityDigest;
    strongSeat: IdentityDigest;
    top3: IdentityDigest;
    schema: Readonly<{ version: number; hash: string; columns: number }>;
  }>;
  /**
   * Blocks whose *content* is the contract. They are typed only as "present
   * and a map" because their job is to be read and hashed: a protocol document
   * that inlined them as loose constants would stop being the document of
   * record. §11 requires each of them to be covered, so their absence is an
   * error rather than a default.
   */
  blocks: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  stop: Readonly<{
    onDoubleReject: string;
    onAttemptLimit: string;
    onIntegrity: string;
    onResource: string;
    onManual: string;
  }>;
}>;

type YamlMap = { [key: string]: YamlValue };

function requireRecord(value: YamlValue | undefined, path: string): YamlMap {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${path} must be a map.`);
  }
  return value;
}

function requireNumber(record: YamlMap, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`${path}.${key} must be a finite number.`);
  }
  return value;
}

function requireInt(record: YamlMap, key: string, path: string): number {
  const value = requireNumber(record, key, path);
  if (!Number.isSafeInteger(value)) {
    throw new ProtocolError(`${path}.${key} must be an integer.`);
  }
  return value;
}

function requireString(record: YamlMap, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new ProtocolError(`${path}.${key} must be a non-empty string.`);
  }
  return value;
}

function requireBool(record: YamlMap, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new ProtocolError(`${path}.${key} must be true or false.`);
  }
  return value;
}

function requireNumbers(record: YamlMap, key: string, path: string): readonly number[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new ProtocolError(`${path}.${key} must be a non-empty list of finite numbers.`);
  }
  return Object.freeze(value as readonly number[]);
}

/**
 * The blocks §11 requires the protocol to cover. Each is a map whose contents
 * are the contract; the Factory checks that it is *there*, and hashes the whole
 * document so that what it says is fixed either way.
 */
export const REQUIRED_BLOCKS: readonly string[] = Object.freeze([
  "chain", "rng", "continuation", "checkpoint", "noPeek", "deadline", "runner",
]);

function parseDigest(record: YamlMap, path: string): IdentityDigest {
  const hash = requireString(record, "hash", path);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new ProtocolError(`${path}.hash is not a SHA-256 digest.`);
  }
  return Object.freeze({
    role: requireString(record, "role", path),
    entry: requireString(record, "entry", path),
    hash,
    files: requireInt(record, "files", path),
  });
}

function parseIdentities(
  raw: YamlMap,
): FactoryProtocol["identities"] {
  const schema = requireRecord(raw.schema, "protocol.identities.schema");
  return Object.freeze({
    teammate: parseDigest(requireRecord(raw.teammate, "protocol.identities.teammate"),
      "protocol.identities.teammate"),
    landlord: parseDigest(requireRecord(raw.landlord, "protocol.identities.landlord"),
      "protocol.identities.landlord"),
    strongSeat: parseDigest(requireRecord(raw.strongSeat, "protocol.identities.strongSeat"),
      "protocol.identities.strongSeat"),
    top3: parseDigest(requireRecord(raw.top3, "protocol.identities.top3"),
      "protocol.identities.top3"),
    schema: Object.freeze({
      version: requireInt(schema, "version", "protocol.identities.schema"),
      hash: requireString(schema, "hash", "protocol.identities.schema"),
      columns: requireInt(schema, "columns", "protocol.identities.schema"),
    }),
  });
}

/**
 * Re-derives every identity from the working tree and compares it with what the
 * protocol froze.
 *
 * Called before the first deal of an attempt. A policy that moved under a
 * running Factory invalidates every number it has produced, including the ones
 * already archived, so this is an `INTEGRITY_STOP` and not a warning.
 */
export function assertIdentitiesCurrent(protocol: FactoryProtocol): void {
  const schema = protocol.identities.schema;
  if (schema.version !== CF_FEATURE_SCHEMA_VERSION ||
    schema.columns !== CF_FEATURE_NAMES.length) {
    throw new ProtocolError(
      `The protocol froze schema ${schema.version} with ${schema.columns} columns; the tree has ` +
      `${CF_FEATURE_SCHEMA_VERSION} with ${CF_FEATURE_NAMES.length}.`,
    );
  }
  verifyIdentities([protocol.identities.teammate, protocol.identities.landlord,
    protocol.identities.strongSeat, protocol.identities.top3]);
}

export function parseProtocol(text: string): FactoryProtocol {
  const raw = requireRecord(parseProtocolYaml(text), "protocol");
  const model = requireRecord(raw.model, "protocol.model");
  const calibration = requireRecord(raw.calibration, "protocol.calibration");
  const offline = requireRecord(raw.offline, "protocol.offline");
  const stage1 = requireRecord(raw.stage1, "protocol.stage1");
  const formal = requireRecord(raw.formal, "protocol.formal");
  const attempt = requireRecord(raw.attempt, "protocol.attempt");
  const corpus = requireRecord(raw.corpus, "protocol.corpus");
  const board = requireRecord(raw.referenceBoard, "protocol.referenceBoard");
  const stop = requireRecord(raw.stop, "protocol.stop");

  const protocol: FactoryProtocol = Object.freeze({
    version: requireInt(raw, "version", "protocol"),
    frozenAt: requireString(raw, "frozenAt", "protocol"),
    rehearsalOnly: raw.rehearsalOnly === undefined
      ? false
      : requireBool(raw, "rehearsalOnly", "protocol"),
    startChampion: requireString(raw, "startChampion", "protocol"),
    attemptCap: requireInt(raw, "attemptCap", "protocol"),
    retryPerChampion: requireInt(raw, "retryPerChampion", "protocol"),
    model: Object.freeze({
      objective: requireString(model, "objective", "protocol.model"),
      iterations: requireInt(model, "iterations", "protocol.model"),
      maxDepth: requireInt(model, "maxDepth", "protocol.model"),
      numLeaves: requireInt(model, "numLeaves", "protocol.model"),
      learningRate: requireNumber(model, "learningRate", "protocol.model"),
      minDataInLeaf: requireInt(model, "minDataInLeaf", "protocol.model"),
      lambdaL1: requireNumber(model, "lambdaL1", "protocol.model"),
      lambdaL2: requireNumber(model, "lambdaL2", "protocol.model"),
      featureFraction: requireNumber(model, "featureFraction", "protocol.model"),
      baggingFraction: requireNumber(model, "baggingFraction", "protocol.model"),
      baggingFreq: requireInt(model, "baggingFreq", "protocol.model"),
      maxBin: requireInt(model, "maxBin", "protocol.model"),
      threads: requireInt(model, "threads", "protocol.model"),
      deterministic: requireBool(model, "deterministic", "protocol.model"),
      forceColWise: requireBool(model, "forceColWise", "protocol.model"),
      seed: requireInt(model, "seed", "protocol.model"),
      lightgbmVersion: requireString(model, "lightgbmVersion", "protocol.model"),
    }),
    calibration: Object.freeze({
      thresholds: requireNumbers(calibration, "thresholds", "protocol.calibration"),
      families: requireInt(calibration, "families", "protocol.calibration"),
      alpha: requireNumber(calibration, "alpha", "protocol.calibration"),
      minOverrideDeals: requireInt(calibration, "minOverrideDeals", "protocol.calibration"),
      minSelectedNonzeroDeals:
        requireInt(calibration, "minSelectedNonzeroDeals", "protocol.calibration"),
    }),
    offline: Object.freeze({
      groups: requireInt(offline, "groups", "protocol.offline"),
      minOverrideDeals: requireInt(offline, "minOverrideDeals", "protocol.offline"),
      minSelectedNonzeroDeals:
        requireInt(offline, "minSelectedNonzeroDeals", "protocol.offline"),
    }),
    stage1: Object.freeze({ deals: requireInt(stage1, "deals", "protocol.stage1") }),
    formal: Object.freeze({
      alpha: requireNumber(formal, "alpha", "protocol.formal"),
      promotionFloor: requireNumber(formal, "promotionFloor", "protocol.formal"),
      designDelta: requireNumber(formal, "designDelta", "protocol.formal"),
      ladder: requireNumbers(formal, "ladder", "protocol.formal"),
    }),
    attempt: Object.freeze({
      blockDeals: requireInt(attempt, "blockDeals", "protocol.attempt"),
      trainDeals: requireInt(attempt, "trainDeals", "protocol.attempt"),
      calibrationDeals: requireInt(attempt, "calibrationDeals", "protocol.attempt"),
      offlineDeals: requireInt(attempt, "offlineDeals", "protocol.attempt"),
      stage1Deals: requireInt(attempt, "stage1Deals", "protocol.attempt"),
      formalReserveDeals: requireInt(attempt, "formalReserveDeals", "protocol.attempt"),
      retryTrainFreshDeals: requireInt(attempt, "retryTrainFreshDeals", "protocol.attempt"),
      retryCalibrationDeals: requireInt(attempt, "retryCalibrationDeals", "protocol.attempt"),
      retryOfflineDeals: requireInt(attempt, "retryOfflineDeals", "protocol.attempt"),
    }),
    corpus: Object.freeze({
      datasetVersion: requireInt(corpus, "datasetVersion", "protocol.corpus"),
      snapshotSalt: requireString(corpus, "snapshotSalt", "protocol.corpus"),
      groupSnapshotCap: requireInt(corpus, "groupSnapshotCap", "protocol.corpus"),
      seedBase: requireInt(corpus, "seedBase", "protocol.corpus"),
    }),
    referenceBoard: Object.freeze({
      poolId: requireString(board, "poolId", "protocol.referenceBoard"),
      start: requireInt(board, "start", "protocol.referenceBoard"),
      end: requireInt(board, "end", "protocol.referenceBoard"),
    }),
    identities: parseIdentities(requireRecord(raw.identities, "protocol.identities")),
    blocks: Object.freeze(Object.fromEntries(
      REQUIRED_BLOCKS.map((name) => [
        name,
        Object.freeze(requireRecord(raw[name], `protocol.${name}`) as Record<string, unknown>),
      ]),
    )),
    stop: Object.freeze({
      onDoubleReject: requireString(stop, "onDoubleReject", "protocol.stop"),
      onAttemptLimit: requireString(stop, "onAttemptLimit", "protocol.stop"),
      onIntegrity: requireString(stop, "onIntegrity", "protocol.stop"),
      onResource: requireString(stop, "onResource", "protocol.stop"),
      onManual: requireString(stop, "onManual", "protocol.stop"),
    }),
  });
  assertProtocolConsistency(protocol);
  return protocol;
}

/**
 * The checks that make the protocol *one* configuration rather than a pile of
 * numbers that happen to be in the same file.
 *
 * Each of these is a way for two parts of the document to disagree while every
 * individual field still looks reasonable, which is exactly the class of error
 * a frozen protocol exists to prevent.
 */
export function assertProtocolConsistency(protocol: FactoryProtocol): void {
  const { attempt } = protocol;
  const base = attempt.trainDeals + attempt.calibrationDeals + attempt.offlineDeals +
    attempt.stage1Deals + attempt.formalReserveDeals;
  const retry = attempt.retryTrainFreshDeals + attempt.retryCalibrationDeals +
    attempt.retryOfflineDeals + attempt.stage1Deals + attempt.formalReserveDeals;
  if (base > attempt.blockDeals || retry > attempt.blockDeals) {
    throw new ProtocolError(
      `An attempt block of ${attempt.blockDeals} deals cannot hold its own base (${base}) or ` +
      `retry (${retry}) layout.`,
    );
  }
  if (attempt.stage1Deals !== protocol.stage1.deals) {
    throw new ProtocolError(
      `protocol.stage1.deals is ${protocol.stage1.deals} but the attempt layout reserves ` +
      `${attempt.stage1Deals}.`,
    );
  }
  if (attempt.formalReserveDeals !== Math.max(...protocol.formal.ladder)) {
    throw new ProtocolError(
      `The formal reserve is ${attempt.formalReserveDeals} but the largest ladder rung is ` +
      `${Math.max(...protocol.formal.ladder)}. A formal run that cannot be served is a " +
        "protocol that cannot be run."`,
    );
  }
  if (attempt.offlineDeals !== protocol.offline.groups) {
    throw new ProtocolError(
      `The offline pool holds ${attempt.offlineDeals} deals but the screen is sized for ` +
      `${protocol.offline.groups}.`,
    );
  }
  if (protocol.calibration.thresholds.length !== protocol.calibration.families) {
    throw new ProtocolError(
      "The calibration family count must equal the number of thresholds, because the " +
      "Bonferroni correction divides alpha by the number of tests actually run.",
    );
  }
  if (protocol.corpus.seedBase !== 0) {
    throw new ProtocolError(
      "The corpus seed base must be zero: the tournament's dealSeed is seedBase + dealIndex, " +
      "and a non-zero base puts the corpus and the strength run on different decks.",
    );
  }
  if (protocol.corpus.datasetVersion !== 5) {
    throw new ProtocolError("Factory v1's dataset version is 5.");
  }
  if (protocol.corpus.groupSnapshotCap !== 3) {
    throw new ProtocolError("The per-group snapshot cap is three, as every earlier round.");
  }
  const boardSize = protocol.referenceBoard.end - protocol.referenceBoard.start + 1;
  if (boardSize !== 400) {
    throw new ProtocolError(
      `The reference board must be 400 retired deals; it spans ${boardSize}.`,
    );
  }
}

export function protocolHashOf(text: string): string {
  return sha256(text);
}

export function readProtocolText(path: string = PROTOCOL_PATH): string {
  return readFileSync(path, "utf8");
}

/** The protocol and the hash of the exact bytes it was read from. */
export function loadProtocol(path: string = PROTOCOL_PATH): Readonly<{
  protocol: FactoryProtocol;
  hash: string;
}> {
  const text = readProtocolText(path);
  return Object.freeze({ protocol: parseProtocol(text), hash: protocolHashOf(text) });
}

/**
 * Refuses to run under a protocol other than the one an attempt registered.
 *
 * This is the check behind "Factory 正式运行期间禁止修改 protocol": a runner
 * pointed at an edited file stops before it deals anything, rather than
 * producing a stage whose numbers belong to two protocols.
 */
export function assertProtocolHash(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new ProtocolError(
      `This attempt was registered under protocol ${expected} but the file now hashes to ` +
      `${actual}. A protocol is changed by stopping the Factory and opening a new one, never ` +
      "by editing the file under a running attempt.",
    );
  }
}
