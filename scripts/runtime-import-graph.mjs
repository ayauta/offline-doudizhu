import { posix } from "node:path";

/**
 * Runtime import closure for delivery entries.
 *
 * TypeScript 7 ships the native (Go) compiler and no longer exposes the
 * classic `ts.createSourceFile` text parser, so module edges are read with the
 * small scanner below rather than through the compiler API.
 *
 * Under `verbatimModuleSyntax`, only the `import type` / `export type` forms
 * are elided. A clause that merely carries `type` bindings still evaluates the
 * module: `import { type X } from "m"` emits `import {} from "m"`, and the
 * browser fetches `m` in development. Those are therefore runtime edges, and
 * the only thing this scanner needs to recognise is a `type` keyword directly
 * after `import` or `export`.
 *
 * ES module declarations are module-level only, so edges are read at brace
 * depth 0. Depth tracking has to survive the rest of the file, which is what
 * the string, comment, template, and regex skipping is for.
 */

const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Sentinel for any token that can end an expression, so `/` means division. */
const VALUE = "#value";

/** Sentinel for the start of the file, where `/` can only begin a regex. */
const START = "#start";

const MAX_STATEMENT_TOKENS = 400;

/**
 * An `export function`/`export class` declaration has no trailing `;`, so the
 * statement reader would otherwise run into whatever follows it. Stopping at a
 * declaration keyword keeps each statement's tokens its own.
 */
const DECLARATION_KEYWORDS = new Set([
  "async",
  "class",
  "const",
  "declare",
  "enum",
  "export",
  "function",
  "import",
  "interface",
  "let",
  "namespace",
  "type",
  "var",
]);

function isWordStart(character) {
  return /[A-Za-z_$]/.test(character);
}

function isWordPart(character) {
  return /[A-Za-z0-9_$]/.test(character);
}

function isSpace(character) {
  return character === " " || character === "\t" || character === "\r" ||
    character === "\n" || character === "\f" || character === "\v";
}

function readWordEnd(source, index) {
  let cursor = index;
  while (cursor < source.length && isWordPart(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function skipLineComment(source, index) {
  const end = source.indexOf("\n", index + 2);
  return end === -1 ? source.length : end;
}

function skipBlockComment(source, index) {
  const end = source.indexOf("*/", index + 2);
  if (end === -1) {
    throw new Error("Unterminated block comment");
  }
  return end + 2;
}

/**
 * Strings cannot span lines, so a quote with no partner on its own line is not
 * a string literal. That keeps JSX text such as `don't` from being read as an
 * unterminated string while still recognising every real literal.
 */
function findClosingQuote(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) {
      return cursor;
    }
    if (character === "\n") {
      return -1;
    }
    cursor += 1;
  }
  return -1;
}

function skipTemplateExpression(source, index) {
  let cursor = index;
  let depth = 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "{") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      cursor += 1;
      if (depth === 0) {
        return cursor;
      }
      continue;
    }
    if (character === "`") {
      cursor = skipTemplate(source, cursor);
      continue;
    }
    if (character === '"' || character === "'") {
      const end = findClosingQuote(source, cursor);
      cursor = end === -1 ? cursor + 1 : end + 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "/") {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    cursor += 1;
  }
  throw new Error("Unterminated template expression");
}

function skipTemplate(source, index) {
  let cursor = index + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "`") {
      return cursor + 1;
    }
    if (character === "$" && source[cursor + 1] === "{") {
      cursor = skipTemplateExpression(source, cursor + 2);
      continue;
    }
    cursor += 1;
  }
  throw new Error("Unterminated template literal");
}

function startsRegex(previousToken) {
  if (previousToken === VALUE || previousToken === ")" || previousToken === "]") {
    return false;
  }
  if (previousToken === "}") {
    return false;
  }
  // `</div>` is a JSX closing tag, not a division followed by a regex. A regex
  // literal after a comparison (`a < /re/`) is valid but vanishingly rare.
  if (previousToken === "<") {
    return false;
  }
  if (/^[A-Za-z_$]/.test(previousToken)) {
    return REGEX_PRECEDING_KEYWORDS.has(previousToken);
  }
  return true;
}

/**
 * A regex literal cannot span lines, so a `/` that opens one but finds no
 * closing `/` on the same line is a misread division rather than a regex. The
 * scanner fails loudly instead of silently swallowing the rest of the file.
 */
function skipRegex(source, index) {
  let cursor = index + 1;
  let inCharacterClass = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "\n") {
      throw new Error("Unterminated regular expression literal");
    }
    if (character === "[") {
      inCharacterClass = true;
    } else if (character === "]") {
      inCharacterClass = false;
    } else if (character === "/" && !inCharacterClass) {
      return cursor + 1;
    }
    cursor += 1;
  }
  throw new Error("Unterminated regular expression literal");
}

/** Reads tokens up to the end of the statement at depth 0. */
function readStatementTokens(source, start) {
  const tokens = [];
  let index = start;
  let depth = 0;
  let sawFrom = false;
  while (index < source.length && tokens.length < MAX_STATEMENT_TOKENS) {
    const character = source[index];
    if (isSpace(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === '"' || character === "'") {
      const end = findClosingQuote(source, index);
      if (end === -1) {
        return { tokens, end: index + 1 };
      }
      tokens.push({ kind: "string", value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (character === "`") {
      index = skipTemplate(source, index);
      tokens.push({ kind: "value" });
      continue;
    }
    if (character === "{") {
      depth += 1;
      tokens.push({ kind: "punct", value: "{" });
      index += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      tokens.push({ kind: "punct", value: "}" });
      index += 1;
      continue;
    }
    if (character === ";") {
      if (depth <= 0) {
        return { tokens, end: index + 1 };
      }
      index += 1;
      continue;
    }
    if (isWordStart(character)) {
      const end = readWordEnd(source, index);
      const word = source.slice(index, end);
      if (depth === 0 && tokens.length > 0 && !sawFrom && DECLARATION_KEYWORDS.has(word)) {
        return { tokens, end: index };
      }
      if (word === "from" && depth === 0) {
        sawFrom = true;
      }
      tokens.push({ kind: "word", value: word });
      index = end;
      continue;
    }
    tokens.push({ kind: "punct", value: character });
    index += 1;
  }
  return { tokens, end: index };
}

/** Index of the `from` keyword that binds a module specifier, or -1. */
function findFromKeyword(tokens) {
  let depth = 0;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token.kind === "punct" && token.value === "{") {
      depth += 1;
    } else if (token.kind === "punct" && token.value === "}") {
      depth -= 1;
    } else if (depth === 0 && token.kind === "word" && token.value === "from") {
      return position;
    }
  }
  return -1;
}

function specifierAfterFrom(tokens, fromPosition) {
  const candidate = tokens[fromPosition + 1];
  return candidate !== undefined && candidate.kind === "string" ? candidate.value : null;
}

function readModuleEdge(tokens) {
  const [first] = tokens;
  if (first === undefined) {
    return null;
  }
  // Side-effect import: `import "../main.js"` has no `from` clause.
  if (first.kind === "string") {
    return first.value;
  }
  if (first.kind === "word" && first.value === "type") {
    return null;
  }
  const fromPosition = findFromKeyword(tokens);
  if (fromPosition === -1) {
    return null;
  }
  return specifierAfterFrom(tokens, fromPosition);
}

function readDynamicImportSpecifier(source, openParenIndex) {
  let index = openParenIndex + 1;
  while (index < source.length && isSpace(source[index])) {
    index += 1;
  }
  const character = source[index];
  if (character !== '"' && character !== "'") {
    return null;
  }
  const end = findClosingQuote(source, index);
  return end === -1 ? null : source.slice(index + 1, end);
}

export function runtimeModuleSpecifiers(source) {
  const specifiers = [];
  let index = 0;
  let depth = 0;
  let previousToken = START;

  while (index < source.length) {
    const character = source[index];

    if (isSpace(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === '"' || character === "'") {
      const end = findClosingQuote(source, index);
      index = end === -1 ? index + 1 : end + 1;
      previousToken = VALUE;
      continue;
    }
    if (character === "`") {
      index = skipTemplate(source, index);
      previousToken = VALUE;
      continue;
    }
    if (character === "/") {
      index = startsRegex(previousToken) ? skipRegex(source, index) : index + 1;
      previousToken = VALUE;
      continue;
    }
    if (/[0-9]/.test(character)) {
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index])) {
        index += 1;
      }
      previousToken = VALUE;
      continue;
    }
    if (character === "{") {
      depth += 1;
      previousToken = "{";
      index += 1;
      continue;
    }
    if (character === "}") {
      depth = Math.max(0, depth - 1);
      previousToken = "}";
      index += 1;
      continue;
    }
    if (isWordStart(character)) {
      const end = readWordEnd(source, index);
      const word = source.slice(index, end);

      if (word === "import") {
        let next = end;
        while (next < source.length && isSpace(source[next])) {
          next += 1;
        }
        if (source[next] === "(") {
          const specifier = readDynamicImportSpecifier(source, next);
          if (specifier !== null && previousToken !== "typeof") {
            specifiers.push(specifier);
          }
          index = next + 1;
          previousToken = VALUE;
          continue;
        }
        if (source[next] !== "." && depth === 0) {
          const statement = readStatementTokens(source, end);
          const specifier = readModuleEdge(statement.tokens);
          if (specifier !== null) {
            specifiers.push(specifier);
          }
          index = statement.end;
          previousToken = VALUE;
          continue;
        }
      }

      if (word === "export" && depth === 0) {
        const statement = readStatementTokens(source, end);
        const specifier = readModuleEdge(statement.tokens);
        if (specifier !== null) {
          specifiers.push(specifier);
        }
        index = statement.end;
        previousToken = VALUE;
        continue;
      }

      previousToken = word;
      index = end;
      continue;
    }

    previousToken = character;
    index += 1;
  }

  return specifiers;
}

function resolveLocalImport(sources, fromPath, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const joined = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [joined];
  if (/\.[cm]?jsx?$/.test(joined)) {
    const stem = joined.replace(/\.[cm]?jsx?$/, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
  } else if (posix.extname(joined) === "") {
    candidates.push(
      `${joined}.ts`,
      `${joined}.tsx`,
      `${joined}.mts`,
      `${joined}/index.ts`,
      `${joined}/index.tsx`,
    );
  }
  return candidates.find((candidate) => sources.has(candidate)) ?? null;
}

export function runtimeImportClosure(inputSources, entryPath) {
  const sources = new Map(
    [...inputSources].map(([path, source]) => [path.replaceAll("\\", "/"), source]),
  );
  const normalizedEntry = entryPath.replaceAll("\\", "/");
  if (!sources.has(normalizedEntry)) {
    throw new Error(`Runtime import entry is missing: ${normalizedEntry}`);
  }

  const reached = new Set();
  const pending = [normalizedEntry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || reached.has(path)) {
      continue;
    }
    reached.add(path);
    const source = sources.get(path);
    if (source === undefined) {
      continue;
    }
    for (const specifier of runtimeModuleSpecifiers(source)) {
      const resolved = resolveLocalImport(sources, path, specifier);
      if (resolved !== null && !reached.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return reached;
}
