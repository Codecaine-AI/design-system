// Codemod review fixture, round 2: chart and map options and calls are not CSS, even under style-named keys.
declare const L: { geoJSON: (d: unknown, o: unknown) => unknown };
declare const feature: { setProperty: (k: string, v: string) => void };
export const option = { graphic: [{ type: "rect", style: { fill: "#ffffff" } }] };
export const mapStyles = [{ featureType: "water", stylers: [{ color: "#ffffff" }] }];
export const layer = { id: "bg", type: "background", paint: { "background-color": "#ffffff" } };
L.geoJSON(null, { style: { color: "#ffffff" } });
feature.setProperty("color", "#ffffff");
let cached: string | null
export const options = { legend: { color: "#ffffff" } }
