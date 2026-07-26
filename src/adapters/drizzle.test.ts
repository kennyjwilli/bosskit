import { describe, expect, it } from "vitest";
import { parsePlaceholders } from "./drizzle";

describe("parsePlaceholders", () => {
  it("splits simple ordered placeholders into segments and values", () => {
    const { parts, reordered } = parsePlaceholders("select $1, $2", ["a", "b"]);
    expect(parts).toEqual(["select ", ", ", ""]);
    expect(reordered).toEqual(["a", "b"]);
  });

  it("duplicates a value for a repeated placeholder index", () => {
    const { parts, reordered } = parsePlaceholders("where a = $2 or b = $2", ["x", "y"]);
    // $2 appears twice → the same value ("y") is emitted at each occurrence.
    expect(parts).toEqual(["where a = ", " or b = ", ""]);
    expect(reordered).toEqual(["y", "y"]);
  });

  it("returns the whole text as one part when there are no placeholders", () => {
    const { parts, reordered } = parsePlaceholders("select now()", []);
    expect(parts).toEqual(["select now()"]);
    expect(reordered).toEqual([]);
  });
});
