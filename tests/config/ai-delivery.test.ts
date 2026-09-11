import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAIN_FORBIDDEN_PATHS,
  MAIN_RUNTIME_ENTRIES,
  WORKER_ENTRY,
  WORKER_REQUIRED_PATHS,
} from "../../scripts/ai-delivery-rules.mjs";
import { runtimeImportClosure } from "../../scripts/runtime-import-graph.mjs";

const repositoryRoot = new URL("../../", import.meta.url);

describe("enhanced AI delivery boundary", () => {
  it("keeps enhanced implementation modules out of the main-thread AI barrel", async () => {
    const source = await readFile(new URL("src/core/ai/index.ts", repositoryRoot), "utf8");

    expect(source).not.toMatch(/hand-analyzer|master-policy|scoring-policy|state-evaluator/);
  });

  it("keeps every enhanced implementation outside both main delivery closures", async () => {
    const rootPath = new URL(repositoryRoot).pathname;
    const sourceRoot = join(rootPath, "src");
    const sources = new Map<string, string>();
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
          sources.set(
            relative(rootPath, path).replaceAll("\\", "/"),
            await readFile(path, "utf8"),
          );
        }
      }
    };
    await visit(sourceRoot);

    for (const entry of MAIN_RUNTIME_ENTRIES) {
      const closure = runtimeImportClosure(sources, entry);
      expect(MAIN_FORBIDDEN_PATHS.filter((path) => closure.has(path))).toEqual([]);
    }

    const workerClosure = runtimeImportClosure(sources, WORKER_ENTRY);
    expect(WORKER_REQUIRED_PATHS.filter((path) => !workerClosure.has(path))).toEqual([]);
  });
});
