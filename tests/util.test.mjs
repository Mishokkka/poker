import assert from "node:assert/strict";

const { parseStrictInteger } = await import("../scripts/util.js");

for (const [input, expected] of [["0", 0], [" 42 ", 42], ["-7", -7], ["+8", 8], [12, 12]]) {
  assert.equal(parseStrictInteger(input, "InvalidInteger"), expected);
}

for (const input of ["", " ", "1.5", "1e3", "12chips", "0x10", null, true, [], Number.NaN, Number.POSITIVE_INFINITY, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => parseStrictInteger(input, "InvalidInteger"), /InvalidInteger/);
}

console.log("Strict integer parser test passed.");
