const JAVASCRIPT_RULES = Object.freeze([
  {
    label: "Array/String/TypedArray.prototype.at requires Chrome/WebView 92",
    name: "at",
    pattern: /\.\s*at\s*\(/g,
  },
  {
    label: "Object.hasOwn requires Chrome/WebView 93",
    name: "hasOwn",
    pattern: /\bObject\s*\.\s*hasOwn\s*\(/g,
  },
  {
    label: "structuredClone requires Chrome/WebView 98",
    name: "structuredClone",
    pattern: /\bstructuredClone\s*\(/g,
  },
  {
    label: "Array.prototype.findLast requires Chrome/WebView 97",
    name: "findLast",
    pattern: /\.\s*findLast\s*\(/g,
  },
  {
    label: "Array.prototype.findLastIndex requires Chrome/WebView 97",
    name: "findLastIndex",
    pattern: /\.\s*findLastIndex\s*\(/g,
  },
  {
    label: "change-array-by-copy methods require Chrome/WebView 110",
    name: null,
    pattern: /\.\s*(?:toReversed|toSorted|toSpliced|with)\s*\(/g,
  },
  {
    label: "individual translate animation keyframes require Chrome/WebView 104",
    name: "translate",
    pattern: /\btranslate\s*:/g,
  },
]);

function maskCommentsAndStrings(source) {
  const characters = [...source];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index];
    const next = characters[index + 1];
    if (character === "/" && next === "/") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length && characters[index] !== "\n") {
        characters[index] = " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length) {
        if (characters[index] === "*" && characters[index + 1] === "/") {
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 2;
          break;
        }
        if (characters[index] !== "\n") {
          characters[index] = " ";
        }
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      characters[index] = " ";
      index += 1;
      while (index < characters.length) {
        const current = characters[index];
        if (current === "\\") {
          characters[index] = " ";
          if (index + 1 < characters.length && characters[index + 1] !== "\n") {
            characters[index + 1] = " ";
          }
          index += 2;
          continue;
        }
        if (current === quote) {
          characters[index] = " ";
          index += 1;
          break;
        }
        if (current !== "\n") {
          characters[index] = " ";
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return characters.join("");
}

function location(source, index) {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const lastLineBreak = before.lastIndexOf("\n");
  return { column: index - lastLineBreak, line };
}

export function findWebView90CompatibilityViolations(source, displayPath) {
  const masked = maskCommentsAndStrings(source);
  const violations = [];
  for (const rule of JAVASCRIPT_RULES) {
    for (const match of masked.matchAll(rule.pattern)) {
      const matched = match[0];
      const methodOffset = rule.name === null
        ? matched.search(/[A-Za-z]/)
        : matched.lastIndexOf(rule.name);
      const { column, line } = location(source, match.index + methodOffset);
      violations.push(`${displayPath}:${line}:${column}: ${rule.label}`);
    }
  }
  return violations.sort((left, right) => {
    const leftPosition = left.match(/:(\d+):(\d+):/);
    const rightPosition = right.match(/:(\d+):(\d+):/);
    return Number(leftPosition?.[1]) - Number(rightPosition?.[1]) ||
      Number(leftPosition?.[2]) - Number(rightPosition?.[2]);
  });
}

export function findWebView90StylesheetViolations(source, displayPath) {
  const masked = maskCommentsAndStrings(source);
  const violations = [];
  const individualTransform = /\b(?:translate|scale|rotate)\s*:/g;
  for (const match of masked.matchAll(individualTransform)) {
    const { column, line } = location(source, match.index);
    violations.push(
      `${displayPath}:${line}:${column}: individual CSS transform properties require Chrome/WebView 104`,
    );
  }

  const rule = /\{([^{}]*)\}/g;
  for (const ruleMatch of masked.matchAll(rule)) {
    const body = ruleMatch[1];
    const bodyOffset = ruleMatch.index + ruleMatch[0].indexOf(body);
    const dynamicViewport = /\b(min-height|height|max-height)\s*:\s*100dvh\b/g;
    for (const match of body.matchAll(dynamicViewport)) {
      const property = match[1];
      const before = body.slice(0, match.index);
      const fallback = new RegExp(`\\b${property}\\s*:\\s*100vh\\b`);
      if (!fallback.test(before)) {
        const { column, line } = location(source, bodyOffset + match.index);
        violations.push(
          `${displayPath}:${line}:${column}: 100dvh requires an earlier 100vh fallback in the same rule`,
        );
      }
    }
  }

  return violations.sort();
}
