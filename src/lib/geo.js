import proj4 from "proj4";

const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";
let sourceProjection = null;

export function useProjection(definition) {
  sourceProjection = definition;
}

export function toLngLat(easting, northing) {
  return proj4(sourceProjection, WGS84, [easting, northing]);
}

export function toLngLatDeep(coordinates) {
  if (typeof coordinates[0] === "number") return toLngLat(coordinates[0], coordinates[1]);
  return coordinates.map(toLngLatDeep);
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

export function polygonsOf(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

export function boundingBox(ring) {
  const xs = ring.map((point) => point[0]);
  const ys = ring.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list) => list.reduce((hull, point) => {
    while (hull.length >= 2 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
    hull.push(point);
    return hull;
  }, []);
  const lower = chain(sorted);
  const upper = chain([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// Hull padded by roughly 400 m so the stations sit inside the polygon rather than on its edge.
export function areaAround(points, padding = 0.004) {
  const corners = points.flatMap(([lng, lat]) => [
    [lng - padding, lat - padding], [lng + padding, lat - padding],
    [lng + padding, lat + padding], [lng - padding, lat + padding],
  ]);
  const hull = convexHull(corners);
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...hull, hull[0]]] } };
}
