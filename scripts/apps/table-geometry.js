export function seatEllipsePosition(index, maxSeats) {
  const count = Math.max(2, Number(maxSeats) || 2);
  const seatIndex = Math.max(0, Number(index) || 0);
  const angle = ((seatIndex / count) * Math.PI * 2) - (Math.PI / 2);
  const centerX = 50;
  const centerY = 46;
  const radiusX = 43;
  const radiusY = 32;

  return {
    angle,
    left: centerX + (radiusX * Math.cos(angle)),
    top: centerY + (radiusY * Math.sin(angle)),
    centerX,
    centerY,
    radiusX,
    radiusY
  };
}
