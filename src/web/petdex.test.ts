import { describe, expect, test } from "bun:test";
import { findPet, parseManifest, suggestPets } from "./petdex.ts";

const manifest = {
  v: 2,
  assetBase: "https://assets.example/",
  fields: ["slug", "displayName", "kind", "submittedBy", "spritesheet", "petJson", "zip", "spriteVersionNumber"],
  pets: [
    ["boba", "Boba", "creature", "someone", "pets/boba-abc/sprite.webp", "pets/boba-abc/petjson.json", "pets/boba-abc/zip.zip", 2],
    ["capy", "Capy", "creature", null, "pets/capy-def/sprite.webp", "pets/capy-def/petjson.json", null, 1],
    ["lulu-capybara", "Lulu Capybara", "creature", "lulu", "pets/lulu-1/sprite.webp", "pets/lulu-1/petjson.json", null, 1],
    ["naitang", "奶糖", "character", "x", "pets/naitang-9/sprite.webp", "pets/naitang-9/petjson.json", null, 1],
    ["capy-2", "Capy", "creature", null, "pets/capy-2/sprite.webp", "pets/capy-2/petjson.json", null, 1],
    ["bad-row", "Bad"],
    ["plain", "Plain", "object", null, "http://insecure.example/sprite.webp", "j", null, 1],
  ],
};

describe("parseManifest", () => {
  test("resolves sheet paths against assetBase and skips rows it cannot use", () => {
    const pets = parseManifest(manifest);
    expect(pets.map((p) => p.slug)).toEqual(["boba", "capy", "lulu-capybara", "naitang", "capy-2"]);
    expect(pets[0]).toEqual({ slug: "boba", name: "Boba", kind: "creature", by: "someone", url: "https://assets.example/pets/boba-abc/sprite.webp", version: 2 });
    expect(pets[1]?.by).toBeNull();
    expect(pets[1]?.version).toBe(1);
  });

  test("rejects anything that is not a v2 compact manifest", () => {
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest({ v: 1, pets: [] })).toThrow();
    expect(() => parseManifest({ ...manifest, fields: ["slug"] })).toThrow();
  });
});

describe("findPet", () => {
  const pets = parseManifest(manifest);
  test("prefers the exact slug, then the exact name, then prefixes, then substrings", () => {
    expect(findPet(pets, "capy")?.slug).toBe("capy");
    expect(findPet(pets, " Lulu Capybara ")?.slug).toBe("lulu-capybara");
    expect(findPet(pets, "奶糖")?.slug).toBe("naitang");
    expect(findPet(pets, "lulu")?.slug).toBe("lulu-capybara");
    expect(findPet(pets, "capybara")?.slug).toBe("lulu-capybara");
    expect(findPet(pets, "BOBA")?.slug).toBe("boba");
  });
  test("returns nothing for an empty or unknown name", () => {
    expect(findPet(pets, "")).toBeUndefined();
    expect(findPet(pets, "dragon")).toBeUndefined();
  });
});

describe("suggestPets", () => {
  const pets = parseManifest(manifest);
  test("lists best matches first without repeats", () => {
    expect(suggestPets(pets, "capy").map((p) => p.slug)).toEqual(["capy", "capy-2", "lulu-capybara"]);
    expect(suggestPets(pets, "a", 2)).toHaveLength(2);
    expect(suggestPets(pets, "")).toEqual([]);
  });
});
