import { openRecordById } from "../panel/record.js";
import { isDrawing } from "./areas.js";
import { map } from "./map.js";

// A click on a point opens its record in the Station tab; clicking another point swaps it.
export function bindPopups() {
  map.on("mouseenter", "samples", () => { if (!isDrawing()) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "samples", () => { map.getCanvas().style.cursor = ""; });
  map.on("click", "samples", (event) => {
    if (isDrawing()) return;
    // A station sampled on several dates draws one point per measurement, all at the same
    // place. The click opens the most recent one; the record lists the other dates.
    const newest = event.features
      .map((feature) => feature.properties)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    openRecordById(newest.id, { sampleView: Boolean(newest.all) });
  });
  map.on("click", "cluster-circles", async (event) => {
    const [cluster] = map.queryRenderedFeatures(event.point, { layers: ["cluster-circles"] });
    if (!cluster) return;
    const zoom = await map.getSource("sample-clusters").getClusterExpansionZoom(cluster.properties.cluster_id);
    map.easeTo({ center: cluster.geometry.coordinates, zoom });
  });
}
