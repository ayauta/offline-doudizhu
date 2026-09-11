import { describe, expect, it } from "vitest";

import { runtimeModuleSpecifiers } from "../../scripts/runtime-import-graph.mjs";

/**
 * The runtime closure gate is only as good as its scanner: a specifier it
 * misses is a boundary violation nobody ever sees. These cases pin the
 * behaviour the closure depends on.
 *
 * Known limitation: two apostrophes inside JSX text on one line are read as a
 * string literal. No source file does that, and the failure is loud rather
 * than silent.
 */

describe("runtime module specifier scanning", () => {
  it("reads side-effect imports that have no from clause", () => {
    expect(runtimeModuleSpecifiers(`import "../main.js";`)).toEqual(["../main.js"]);
    expect(runtimeModuleSpecifiers(`import "./styles.css";`)).toEqual(["./styles.css"]);
  });

  it("reads every binding form of a static import", () => {
    expect(runtimeModuleSpecifiers(`import a from "./a.js";`)).toEqual(["./a.js"]);
    expect(runtimeModuleSpecifiers(`import * as ns from "./b.js";`)).toEqual(["./b.js"]);
    expect(runtimeModuleSpecifiers(`import { a, b as c } from "./c.js";`)).toEqual(["./c.js"]);
    expect(runtimeModuleSpecifiers(`import a, { b } from "./d.js";`)).toEqual(["./d.js"]);
    expect(runtimeModuleSpecifiers(`import {\n  a,\n  b,\n} from "./e.js";`)).toEqual(["./e.js"]);
  });

  it("elides import type but keeps a clause that only carries type bindings", () => {
    expect(runtimeModuleSpecifiers(`import type { X } from "./a.js";`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`import type X from "./b.js";`)).toEqual([]);
    // Under verbatimModuleSyntax this emits `import {} from "./c.js"`, so the
    // browser still evaluates the module: it is a runtime edge, not a type edge.
    expect(runtimeModuleSpecifiers(`import { type X } from "./c.js";`)).toEqual(["./c.js"]);
    expect(runtimeModuleSpecifiers(`import { type X, Y } from "./d.js";`)).toEqual(["./d.js"]);
  });

  it("reads re-export forms and elides export type", () => {
    expect(runtimeModuleSpecifiers(`export * from "./a.js";`)).toEqual(["./a.js"]);
    expect(runtimeModuleSpecifiers(`export * as ns from "./b.js";`)).toEqual(["./b.js"]);
    expect(runtimeModuleSpecifiers(`export { a } from "./c.js";`)).toEqual(["./c.js"]);
    expect(runtimeModuleSpecifiers(`export { type A } from "./d.js";`)).toEqual(["./d.js"]);
    expect(runtimeModuleSpecifiers(`export type { A } from "./e.js";`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`export type * from "./f.js";`)).toEqual([]);
  });

  it("ignores declarations that are not re-exports", () => {
    expect(runtimeModuleSpecifiers(`export { a };`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`export const a = 1;`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`export interface I { a: string }`)).toEqual([]);
    expect(
      runtimeModuleSpecifiers(`export default function f() {}\nimport a from "./x.js";`),
    ).toEqual(["./x.js"]);
    expect(
      runtimeModuleSpecifiers(`export interface I { a: string }\nimport a from "./y.js";`),
    ).toEqual(["./y.js"]);
  });

  it("does not read specifiers out of comments or strings", () => {
    expect(runtimeModuleSpecifiers(`// import a from "./bait.js";`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`/* import a from "./bait.js"; */`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`const text = "import a from './bait.js'";`)).toEqual([]);
    expect(runtimeModuleSpecifiers("const text = `import a from \"./bait.js\"`;")).toEqual([]);
    expect(
      runtimeModuleSpecifiers(`import a from "./real.js"; // import b from "./bait.js";`),
    ).toEqual(["./real.js"]);
  });

  it("finds dynamic imports and skips the type-position form", () => {
    expect(runtimeModuleSpecifiers(`const load = () => import("./a.js");`)).toEqual(["./a.js"]);
    expect(runtimeModuleSpecifiers(`const p = import("./b.js");`)).toEqual(["./b.js"]);
    expect(runtimeModuleSpecifiers(`type T = typeof import("./c.js");`)).toEqual([]);
  });

  it("ignores import.meta and identifiers that merely begin with import or export", () => {
    expect(runtimeModuleSpecifiers(`const url = new URL("./w.js", import.meta.url);`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`const important = "./bait.js";`)).toEqual([]);
    expect(runtimeModuleSpecifiers(`const exported = "./bait.js";`)).toEqual([]);
  });

  it("survives JSX without mistaking markup for operators", () => {
    expect(runtimeModuleSpecifiers(`function C() { return <div class="a">don't</div>; }`)).toEqual([]);
    expect(
      runtimeModuleSpecifiers(`function C() { return <br />; }\nimport a from "./x.js";`),
    ).toEqual(["./x.js"]);
    expect(
      runtimeModuleSpecifiers(`function C() { return <><p>{1}</p></>; }\nimport a from "./z.js";`),
    ).toEqual(["./z.js"]);
  });

  it("survives template literals, division, and regex literals holding quotes", () => {
    expect(
      runtimeModuleSpecifiers("const s = `a${ b(`${c}`) }d`;\nimport a from \"./x.js\";"),
    ).toEqual(["./x.js"]);
    expect(runtimeModuleSpecifiers(`const d = a / b;\nimport a from "./x.js";`)).toEqual(["./x.js"]);
    expect(runtimeModuleSpecifiers(`const re = /["']/;\nimport a from "./x.js";`)).toEqual(["./x.js"]);
  });

  it("fails loudly rather than silently mis-scanning an unterminated construct", () => {
    expect(() => runtimeModuleSpecifiers(`const re = /open;\nimport a from "./x.js";`)).toThrow();
    expect(() => runtimeModuleSpecifiers("const s = `open;\nimport a from \"./x.js\";")).toThrow();
    expect(() => runtimeModuleSpecifiers(`/* open\nimport a from "./x.js";`)).toThrow();
  });
});
