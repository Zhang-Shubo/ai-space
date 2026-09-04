import { expect, test } from "bun:test";
import { greet } from "./index.ts";

test("greet returns a greeting", () => {
  expect(greet("Bun")).toBe("Hello, Bun!");
});
