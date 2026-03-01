import { describe, expect, it } from "vitest";

import * as mod from "../src/index.js";

describe("opensubsonic-types", () => {
  it("exports type module symbols", () => {
    expect(mod).toBeTypeOf("object");
  });
});
