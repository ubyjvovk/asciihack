/**
 * `edges` render style (docs/architecture.md §4.11): depth-based wireframe
 * over a very dim floor. Cell 2×2, sub 1×1, `needsDepth: true`; the shader
 * reads `linearDepth` at the cell centre and one sub-sample away in each of
 * the four cardinal directions and lights the cell green at a silhouette or
 * crease. It works on the **second difference of inverse depth**, which is
 * exactly zero across any plane in screen space, so flat ground and long
 * walls give no response at any distance while silhouettes *and* creases
 * (floor↔wall, building corners, the horizon against sky) still fire. Pure
 * `isEdge` mirrors the shader term for term so node tests are the spec.
 */
import type { RenderStyle } from '../style';

/** Edge tint written when {@link isEdge} fires. */
export const EDGE_COLOUR: readonly [number, number, number] = [0.25, 1.0, 0.6];

/** Multiplier applied to the exposed scene colour on non-edge cells. */
export const FLOOR_GAIN = 0.12;

/** Sky cut-off as a fraction of `cameraFar`; anything at or past this is treated as sky. */
export const SKY_FRACTION = 0.98;

/** Second-difference threshold on inverse depth (`k`); mirrors the shader's `EDGE_K`. */
export const EDGE_K = 0.02;

/**
 * True when the cell should be drawn as an edge. `dC` is `linearDepth` at
 * the cell centre and `neighbours` is the four one-sub-sample depths in the
 * order `[dL, dR, dU, dD]` (the pair order matters: L/R and U/D are tested
 * independently). A cell is an edge when the centre and any neighbour
 * disagree on `sky` (depth ≥ {@link SKY_FRACTION} · `far`), or — with all
 * samples non-sky — when either cardinal pair shows a bend in inverse depth:
 * `|wL + wR − 2·wC| > k·wC` or `|wU + wD − 2·wC| > k·wC`, `w = 1/d`,
 * `k = {@link EDGE_K}`. All samples sky is never an edge. Pure; the shader
 * runs the same test in `main()`.
 */
export function isEdge(
  dC: number,
  neighbours: readonly [number, number, number, number],
  far: number,
  k = EDGE_K,
): boolean {
  const [dL, dR, dU, dD] = neighbours;
  const skyThr = SKY_FRACTION * far;
  const isSky = (d: number): boolean => d >= skyThr;
  const cSky = isSky(dC);

  // Sky rule: centre/neighbour disagreement on `sky` is always an edge.
  if (
    isSky(dL) !== cSky ||
    isSky(dR) !== cSky ||
    isSky(dU) !== cSky ||
    isSky(dD) !== cSky
  ) {
    return true;
  }
  // All samples sky is never an edge (and there is no bend to measure).
  if (cSky) return false;

  // Second difference of inverse depth across the L/R and U/D cardinals.
  const wC = 1 / dC;
  const wL = 1 / dL;
  const wR = 1 / dR;
  const wU = 1 / dU;
  const wD = 1 / dD;
  if (Math.abs(wL + wR - 2 * wC) > k * wC) return true;
  if (Math.abs(wU + wD - 2 * wC) > k * wC) return true;
  return false;
}

/**
 * §4.11 "edges" fragment. Reads five `linearDepth` samples (centre + 4
 * neighbours one sub-sample away in uv), applies the same sky / inverse-depth
 * second-difference logic as {@link isEdge}, and outputs either
 * {@link EDGE_COLOUR} or the exposed scene colour dimmed by
 * {@link FLOOR_GAIN}.
 */
const EDGES_FRAGMENT = `
const float EDGE_K = 0.02;
const float SKY_FRAC = 0.98;
void main() {
  vec2 cell = floor(vUv * grid);
  vec2 centreUv = (cell + 0.5) / grid;
  vec2 stepUv = 1.0 / sceneSize;
  float dC = linearDepth(centreUv);
  float dL = linearDepth(centreUv + vec2(-stepUv.x, 0.0));
  float dR = linearDepth(centreUv + vec2( stepUv.x, 0.0));
  float dU = linearDepth(centreUv + vec2(0.0,  stepUv.y));
  float dD = linearDepth(centreUv + vec2(0.0, -stepUv.y));
  float skyThr = SKY_FRAC * cameraFar;
  bool cSky = dC >= skyThr;
  bool edge = false;

  // Sky rule, term for term with isEdge.
  if (cSky != (dL >= skyThr)) edge = true;
  if (cSky != (dR >= skyThr)) edge = true;
  if (cSky != (dU >= skyThr)) edge = true;
  if (cSky != (dD >= skyThr)) edge = true;

  // Inverse-depth second difference over non-sky samples.
  if (!edge && !cSky) {
    float wC = 1.0 / dC;
    float wL = 1.0 / dL;
    float wR = 1.0 / dR;
    float wU = 1.0 / dU;
    float wD = 1.0 / dD;
    if (abs(wL + wR - 2.0 * wC) > EDGE_K * wC) edge = true;
    if (abs(wU + wD - 2.0 * wC) > EDGE_K * wC) edge = true;
  }

  vec3 sceneCol = texture2D(tScene, centreUv).rgb * exposure;
  vec3 outCol = edge ? vec3(0.25, 1.0, 0.6) : sceneCol * 0.12;
  gl_FragColor = vec4(outCol, 1.0);
}
`;

/** Single-entry registry for the `edges` id (docs/architecture.md §4.11). */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'edges',
    label: 'EDGES',
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    needsDepth: true,
    fragment: EDGES_FRAGMENT,
    makeUniforms(): Record<string, never> {
      return {};
    },
  },
];
