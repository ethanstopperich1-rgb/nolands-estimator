/**
 * Hardcoded prompts + JSON response schema for the Gemini roof-analysis
 * pipeline.
 *
 * Architecture context:
 *  - The customer drags a pin to the building's center.
 *  - The tile is refetched centered on the pin at zoom 21.
 *  - The target building is guaranteed to be at pixel (640, 640) in a
 *    1280×1280 image. Pro Image does NOT need to identify which building
 *    — the pin does that.
 *  - Pro Image's job is paint quality. Flash's job is everything else
 *    (objects, facets, material, condition, etc.).
 *
 * Last deep-revision: 2026-05-17. Calibrated against failures we've
 * seen in production:
 *   1. Cyan notched out around skylight shadows (the most painful and
 *      most recent).
 *   2. Attached porches with separate-pitched roofs being swept into
 *      the outline.
 *   3. Cast shadows on the lawn being painted as if they were roof.
 *   4. The top-side roof slope of skylight rows being skipped.
 */

// ─── Pro Image paint prompt ─────────────────────────────────────────────
//
// Goal: a magazine-clean cyan overlay on every visible roof plane of the
// central building. The prompt is structured as: one sentence task, then
// four numbered RULES (front-loaded — the most important behavior the
// model needs to internalize), then DO PAINT / DO NOT PAINT lists, then
// a shadow-vs-edge discrimination table, then a self-check.
//
// Why this structure: Pro Image is a generation model, not a chat-style
// reasoner. It pays the most attention to the FIRST clear instruction
// blocks. Long prose paragraphs at the front bury the most important
// rule. Numbered rules + tables are skimmable; the model carries them
// further into the generation pass.
export const GEMINI_ROOF_PROMPT = `Edit this 1280×1280 aerial satellite image. Paint a magazine-clean translucent cyan overlay on every visible roof plane of the single residential building at the exact center of the frame (pixel 640, 640). The user has already confirmed this is the target — do not second-guess which structure to annotate.

## STYLE
- Fill: cyan #38C5EE at ~40% opacity. Shingle texture, ridge caps, vents, and small fixtures must remain CLEARLY VISIBLE through the cyan.
- Outline: cyan #38C5EE at full opacity, crisp 2–3 pixel stroke along every legal edge. No feathering, no soft edges, no blurring.
- The effect is PAINTED on the roof, not pasted over it. Preserve photographic realism everywhere outside the painted area.

## RULE 1 — One continuous polygon per plane. No exceptions.
Every distinct roof plane (each unique direction the roof faces) is painted as ONE solid, gap-free polygon. **No notches. No triangular cutouts. No holes around fixtures. No bite-outs along inside edges. No indentations that follow shadow lines.**

If two planes meet at an interior edge (ridge, hip, or valley), the two cyan colors meet edge-to-edge with a single crisp stroke between them. If a plane is an L or T shape, the polygon is continuous — it just has corners.

## RULE 2 — Only six things are legal cyan boundaries
The cyan painted area's outer + interior boundaries consist ONLY of these six edge types:
- **Eave** — horizontal outer perimeter at the BOTTOM of a slope, where the roof meets the gutter / open air below
- **Ridge** — highest horizontal line where two opposing slopes meet at the peak
- **Hip** — sloped diagonal from a peak corner down to a building corner (hip roofs only)
- **Valley** — sloped inward-V where two adjacent planes meet (dormers, intersecting wings)
- **Rake** — sloped open-gable edge where the roof drops to air on one side
- **Gable end** — the vertical end-wall face of a gable triangle (visible from above as a line)

If a candidate boundary is none of these six, it is NOT an edge. Keep painting through it.

## RULE 3 — Paint OVER fixtures and shadows that sit on the roof
Small things on the roof do not interrupt the cyan. The roof continues underneath them.

- **Vents, plumbing boots, stacks** — small caps. Paint right over.
- **Chimneys** — the brick/stucco mass itself is NOT roof, so the cyan stops at the chimney's footprint walls. The shingles surrounding the chimney are still roof — paint them.
- **Skylights** — clear/translucent glass rectangles. The roof material is underneath the glass. Paint cyan over the skylight; the 40% opacity lets the glass show through.
- **HVAC units, satellite dishes, solar panels** — the metal/glass body is not roof, but the roof under and around them is. Paint up to the unit's footprint.
- **Cast shadows ON the roof** (from skylights, chimneys, dormers, ridges, neighboring trees) — the shingle material is identical inside and outside the shadow. Paint THROUGH the shadow.

⚠ The single most common failure pattern: a row of three skylights along the south slope casts three triangular shadows pointing east. The model sees three sharp dark triangles and "cuts" them out of the cyan, leaving three triangular notches. DO NOT do this. The plane is one continuous rectangle of cyan — paint through every shadow.

⚠ The second most common failure: skipping the roof slope ABOVE each skylight (between the skylight and the ridge). The roof above the skylight is the same plane as the roof below it. Paint a single continuous fill from eave to ridge, through the skylight, through its shadow.

## RULE 4 — Stop at the actual eave, not at the shadow on the lawn
At the perimeter, the cyan stops where the roof material visibly ends — where shingles meet gutter / open air / gable wall.

The cast shadow of the eave extends 5–15 feet past the eave onto the lawn. Stop the cyan at the eave itself, not at the shadow's edge on the grass. The lawn shadow is gray-green / gray-brown, has no shingle texture, and sits on a different surface (grass, pavement).

## DO PAINT
- The main roof of the central building
- Attached porches, sunrooms, lanais, and garages whose roof plane is visibly CONTINUOUS with the main house (same pitch, same shingle pattern, no horizontal seam at the wall)
- Additions whose roof reads as part of the main structure (same height, same shingle direction)

## DO NOT PAINT
- Lawn, driveway, sidewalk, patio, pool deck, pool, fence
- Tree canopy beside or over the house — foliage is bumpy, organic, irregular; no straight edges and no shingle texture
- Cast shadows on the ground
- Neighboring buildings — if ANY strip of lawn, walkway, or driveway separates them from the central house, they are different buildings
- Detached sheds, garages, or carports with ground between them and the main house
- Porches with a VISIBLY SHALLOWER separate roof — the giveaway is a clean horizontal seam at the wall where the porch roof tucks UNDER the main eave, plus a slope that reads flatter than the main roof
- Breezeways with their own separate structure

## TREE CANOPY EXCEPTION — when to paint through it
- IF the eave line aligns across the canopy gap AND visible roof on each side lines up in a clear continuation: paint THROUGH the canopy as if it were transparent.
- IF most of the roof is hidden by trees: paint only what you can see.
- IF you genuinely can't tell whether a dark patch is roof-under-canopy or canopy-over-lawn: do NOT paint it.

Slightly incomplete is correct when uncertain. Over-painting onto lawn/trees is wrong.

## SHADOW vs REAL EDGE — discrimination
| Real edge | Shadow on roof |
|-----------|----------------|
| Continuous line spanning a significant fraction of the roof | Short, sharp, often triangular |
| Shingle texture orientation changes across the line | IDENTICAL shingle texture on both sides |
| Plane brightness may differ gradually (sun angle on different facings) | Hard-edged dark patch with one or two straight sides |
| Sits at a geometric 3D transition between surfaces | Sits next to whatever feature casts it (skylight, chimney, dormer) |
| Eaves / ridges horizontal; hips / valleys / rakes sloped | Geometry follows sun angle, not roof structure |

If you cannot name the candidate boundary as one of the six legal edges (eave/ridge/hip/valley/rake/gable end), it is a shadow. Paint through it.

## SELF-CHECK BEFORE RETURNING
Walk your painted image once more:
1. Any cyan boundary that follows a shadow line? → Extend cyan across that boundary.
2. Triangular or sharp-cornered notches along any plane's inside edge? → Fill them.
3. Small unpainted holes around vents, chimneys, skylights, HVAC, dishes, or panels? → Paint over them (only the chimney mass / panel body itself stays uncovered).
4. Each distinct roof plane represented as ONE continuous polygon? → Merge disconnected pieces of the same plane.
5. Cyan extending past the eave onto the lawn shadow? → Pull it back to the eave.

A human architect outlining each plane on a printout draws clean, continuous polygons. Match that.`;

// ─── Flash rich-data schema (objects + facets + material + condition + …) ──
//
// This is the response schema for the Flash sidecar call that runs in
// parallel with the Pro Image paint call. Pro Image is busy painting;
// Flash carries all the structured-data work.
export const GEMINI_ROOF_SCHEMA = {
  type: "OBJECT",
  properties: {
    objects: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: {
            type: "STRING",
            enum: [
              "vent",
              "chimney",
              "hvac_unit",
              "skylight",
              "plumbing_boot",
              "satellite_dish",
              "solar_panel",
            ],
          },
          center_pixel: {
            type: "ARRAY",
            items: { type: "NUMBER" },
            description: "[x, y] center of the object in pixel coordinates",
          },
          bounding_box: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              width: { type: "NUMBER" },
              height: { type: "NUMBER" },
            },
            required: ["x", "y", "width", "height"],
          },
          confidence: {
            type: "NUMBER",
            description: "Float 0.0–1.0",
          },
        },
        required: ["type", "center_pixel", "bounding_box", "confidence"],
      },
    },
    facet_count_estimate: {
      type: "OBJECT",
      description:
        "Visual count of distinct roof planes (gable ends, hip sides, dormers, etc.) on the central building.",
      properties: {
        count: { type: "INTEGER", description: "Distinct planes visible." },
        complexity: {
          type: "STRING",
          enum: ["simple", "moderate", "complex"],
          description:
            "simple = 2–4 planes (gable/simple hip), moderate = 5–10 planes (multi-wing hip), complex = 11+ planes (cross hips, dormers, additions).",
        },
        confidence: { type: "NUMBER" },
      },
      required: ["count", "complexity", "confidence"],
    },
    roof_material: {
      type: "OBJECT",
      properties: {
        type: {
          type: "STRING",
          enum: [
            "asphalt_shingle_3tab",
            "asphalt_shingle_architectural",
            "concrete_tile",
            "clay_tile_barrel",
            "clay_tile_flat",
            "metal_standing_seam",
            "metal_corrugated",
            "wood_shake",
            "slate",
            "membrane_flat",
            "unknown",
          ],
        },
        confidence: { type: "NUMBER" },
      },
      required: ["type", "confidence"],
    },
    condition_hints: {
      type: "ARRAY",
      description:
        "Visible condition signals from the satellite image. Each hint is a discrete observable feature (not an overall grade). Empty array when the roof looks clean.",
      items: {
        type: "OBJECT",
        properties: {
          hint: {
            type: "STRING",
            enum: [
              "moss_or_algae",
              "dark_streaking",
              "shingle_wear_granule_loss",
              "missing_tabs",
              "patches_or_repairs",
              "tarp_visible",
              "ponding_water",
              "tree_debris",
              "rust_staining",
              "uniform_clean",
            ],
          },
          confidence: { type: "NUMBER" },
        },
        required: ["hint", "confidence"],
      },
    },
    visible_damage: {
      type: "ARRAY",
      description:
        "Discrete damage observations visible in the imagery. Each entry is one observation, not an overall grade. Empty array when no damage is visible.",
      items: {
        type: "OBJECT",
        properties: {
          kind: {
            type: "STRING",
            enum: [
              "lifted_shingles",
              "missing_shingles",
              "exposed_underlayment",
              "ridge_cap_lifting",
              "visible_sagging",
              "displaced_tiles",
              "blistering",
              "hail_bruising_pattern",
              "wind_streak_pattern",
              "patched_area",
            ],
          },
          location_hint: {
            type: "STRING",
            description: "Short phrase describing where on the roof (e.g. 'north slope', 'ridge near chimney').",
          },
          confidence: { type: "NUMBER" },
        },
        required: ["kind", "confidence"],
      },
    },
    secondary_structures: {
      type: "ARRAY",
      description:
        "Attached additions whose roof plane is visibly continuous with the main house and should be included in the measurement.",
      items: {
        type: "OBJECT",
        properties: {
          kind: {
            type: "STRING",
            enum: [
              "attached_garage",
              "attached_carport",
              "screened_lanai",
              "covered_porch",
              "sunroom",
              "addition_wing",
              "shed_attached",
            ],
          },
          confidence: { type: "NUMBER" },
        },
        required: ["kind", "confidence"],
      },
    },
    site_obstacles: {
      type: "ARRAY",
      description:
        "Surrounding-site features that affect crew access, dumpster staging, or material delivery.",
      items: {
        type: "OBJECT",
        properties: {
          kind: {
            type: "STRING",
            enum: [
              "heavy_tree_overhang",
              "overhead_utility_wires",
              "pool_adjacent",
              "narrow_side_yard",
              "fenced_property",
              "shared_driveway",
              "steep_grade",
            ],
          },
          confidence: { type: "NUMBER" },
        },
        required: ["kind", "confidence"],
      },
    },
    apparent_age_band: {
      type: "OBJECT",
      description:
        "Rough age banding from visible weathering, granule coverage, and color uniformity. Not a precise age.",
      properties: {
        band: {
          type: "STRING",
          enum: [
            "new_under_5y",
            "mid_5_to_15y",
            "mature_15_to_25y",
            "end_of_life_25y_plus",
            "indeterminate",
          ],
        },
        confidence: { type: "NUMBER" },
      },
      required: ["band", "confidence"],
    },
  },
  // Only `objects` is required at the top level — Flash sometimes omits
  // the optional sub-objects if it can't confidently fill them. We want
  // partial responses to still parse cleanly.
  required: ["objects"],
} as const;
