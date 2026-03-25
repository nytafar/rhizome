import { describe, expect, test } from "bun:test";
import { generateBaseCitekey, generateCitekey } from "../citekey";

describe("generateBaseCitekey", () => {
  test("matches spec example: smith + 2023 + ashwagandha", () => {
    const citekey = generateBaseCitekey({
      authors: [
        { family: "Smith", given: "J" },
        { family: "Patel", given: "R" },
      ],
      year: 2023,
      title: "Ashwagandha root extract reduces cortisol",
    });

    expect(citekey).toBe("smith2023ashwagandha");
  });

  test("matches spec example: first meaningful title word skips stopwords", () => {
    const citekey = generateBaseCitekey({
      authors: [{ family: "Jones", given: "K" }],
      year: 2024,
      title: "A randomized trial of curcumin in depression",
    });

    expect(citekey).toBe("jones2024randomized");
  });

  test("matches spec example with diacritics normalization", () => {
    const citekey = generateBaseCitekey({
      authors: [{ family: "Müller", given: "H" }],
      year: 2022,
      title: "Effects of berberine on glucose metabolism",
    });

    expect(citekey).toBe("muller2022effects");
  });

  test("falls back to first title token when all tokens are stopwords", () => {
    const citekey = generateBaseCitekey({
      authors: [{ family: "Ng", given: "A" }],
      year: 2021,
      title: "The and of in",
    });

    expect(citekey).toBe("ng2021the");
  });

  test("enforces max citekey length of 60 chars", () => {
    const citekey = generateBaseCitekey({
      authors: [{ family: "VeryLongLastnameWithDiacriticsÖÖÖ", given: "Q" }],
      year: 2026,
      title:
        "Hyperextraordinarilylongcompoundwordthatshouldbetruncatedbecauseitexceedssixtycharacters",
    });

    expect(citekey.length).toBeLessThanOrEqual(60);
    expect(citekey).toBe(
      "verylonglastnamewithdiacriticsooo2026hyperextraordinarilylongco",
    );
  });
});

describe("generateCitekey collision handling", () => {
  test("returns base citekey when no collision exists", () => {
    const citekey = generateCitekey({
      authors: [{ family: "Smith", given: "J" }],
      year: 2023,
      title: "Ashwagandha root extract reduces cortisol",
    });

    expect(citekey).toBe("smith2023ashwagandha");
  });

  test("appends b/c/d suffixes for collisions", () => {
    const input = {
      authors: [{ family: "Smith", given: "J" }],
      year: 2023,
      title: "Ashwagandha root extract reduces cortisol",
    };

    const b = generateCitekey(input, ["smith2023ashwagandha"]);
    const c = generateCitekey(input, ["smith2023ashwagandha", "smith2023ashwagandhab"]);
    const d = generateCitekey(input, [
      "smith2023ashwagandha",
      "smith2023ashwagandhab",
      "smith2023ashwagandhac",
    ]);

    expect(b).toBe("smith2023ashwagandhab");
    expect(c).toBe("smith2023ashwagandhac");
    expect(d).toBe("smith2023ashwagandhad");
  });

  test("keeps total length <= 60 when adding collision suffix", () => {
    const input = {
      authors: [{ family: "Superlongfamilynamewithmanycharacters", given: "Z" }],
      year: 2026,
      title: "Extraordinarilylengthytitlewordthatalreadyhitsmaxlengthconstraints",
    };

    const base = generateBaseCitekey(input);
    const collided = generateCitekey(input, [base]);

    expect(base.length).toBe(60);
    expect(collided.length).toBe(60);
    expect(collided.endsWith("b")).toBe(true);
  });
});
