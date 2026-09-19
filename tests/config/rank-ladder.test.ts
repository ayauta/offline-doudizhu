import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(`${path}/`));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

// Two adjacent joker literals only appear when someone writes the strength order
// out again. The canonical card table spells them apart (`rank: "small-joker"`),
// so it does not match. Every duplicate ladder in the repository has this shape.
const LADDER = /"small-joker",\s*"big-joker",/;

describe("rank ladder", () => {
  it("is written out in exactly one module", async () => {
    const carriers: string[] = [];
    for (const path of await sourceFiles(sourceRoot)) {
      if (LADDER.test(await readFile(path, "utf8"))) {
        carriers.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }

    expect(carriers).toEqual(["core/rules/ranks.ts"]);
  });
});
