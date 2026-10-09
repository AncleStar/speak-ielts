import { describe, expect, it } from "vitest";
import { containsTerm } from "@/lib/thoughts/schema";

describe("vocabulary must occur as a complete word or phrase", () => {
  it("rejects fragments of longer words and an empty term", () => {
    expect(containsTerm("A party in a department store.", "art")).toBe(false);
    expect(containsTerm("We improved our skills.", "prove")).toBe(false);
    expect(containsTerm("anything", "")).toBe(false);
    expect(containsTerm("The ART of conversation.", "art")).toBe(true);
  });
  it("matches normalized phrases and apostrophes without treating regex symbols as operators", () => {
    expect(containsTerm("I gained PRACTICAL\nexperience; it’s useful.", "practical experience")).toBe(true);
    expect(containsTerm("It’s useful.", "it's")).toBe(true);
    expect(containsTerm("I use C++.", "C++")).toBe(true);
    expect(containsTerm("I use C.", "C++")).toBe(false);
  });
  it("does not split surrounding Unicode letters or phrase endings", () => {
    expect(containsTerm("Résumé skills are valuable.", "sum")).toBe(false);
    expect(containsTerm("These are practical experiences.", "practical experience")).toBe(false);
    expect(containsTerm("This is practical experience, not a theory.", "practical experience")).toBe(true);
  });
});
