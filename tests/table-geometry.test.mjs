import assert from "node:assert/strict";
import { seatEllipsePosition } from "../scripts/apps/table-geometry.js";

for (const count of [2, 6, 9, 10]) {
  const positions = Array.from({ length: count }, (_, index) => seatEllipsePosition(index, count));
  const normalized = positions.map((position) => {
    const x = (position.left - position.centerX) / position.radiusX;
    const y = (position.top - position.centerY) / position.radiusY;
    return (x * x) + (y * y);
  });
  for (const value of normalized) assert.ok(Math.abs(value - 1) < 1e-10, `Seat must lie on the ellipse for ${count} seats`);

  const deltas = positions.map((position, index) => {
    const next = positions[(index + 1) % positions.length];
    let delta = next.angle - position.angle;
    if (delta <= 0) delta += Math.PI * 2;
    return delta;
  });
  const expected = (Math.PI * 2) / count;
  for (const delta of deltas) assert.ok(Math.abs(delta - expected) < 1e-10, `Seats must be evenly spaced for ${count} seats`);
}

const nine = Array.from({ length: 9 }, (_, index) => seatEllipsePosition(index, 9));
assert.ok(nine[4].top > 76 && nine[4].top < 79, "Lower seats should use more of the available table height without entering the action dock");
assert.ok(nine[0].top > 13 && nine[0].top < 15, "Top seat should retain enough card clearance");

console.log("Table geometry test passed.");
