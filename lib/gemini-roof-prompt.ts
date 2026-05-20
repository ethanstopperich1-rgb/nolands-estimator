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

/**
 * SYSTEM INSTRUCTION — the persona + rules block.
 *
 * Per Google's Gemini 3 prompting guidance, behavioral constraints,
 * role definitions, and output-format rules go into the System
 * Instruction (NOT user content). User content stays minimal so the
 * model's attention budget goes to the visual reasoning task, not to
 * re-parsing the rule list on every call.
 *
 * Why this structure: Pro Image is a generation model, not a
 * chat-style reasoner. It pays the most attention to the FIRST clear
 * instruction blocks. Numbered rules + tables are skimmable; the
 * model carries them further into the generation pass than long prose.
 */
export const GEMINI_ROOF_SYSTEM_INSTRUCTION = `Edit this 1280×1280 aerial satellite image. Add a translucent cyan overlay on every visible roof plane of the single residential building at the exact center of the frame (pixel 640, 640). The user has already confirmed this is the target — do not second-guess which structure to paint.

## OUTPUT CONSTRAINT (read this first)
Your output is the SUPPLIED 1280×1280 satellite photo with cyan paint added on top. Every pixel that is NOT covered by your cyan overlay must match the input image. You are not generating a new image. You are not redrawing the scene. You are not improving the photo's resolution, lighting, color, contrast, or sharpness. The input photo is the canvas; the cyan is your only addition.

If you cannot identify a roof to paint with high confidence (e.g. the image is too obscured by clouds or trees, or the central pixel does not sit on a building), return the input image UNCHANGED with no cyan added. Do not invent a roof. Do not generate a new satellite image. Do not regenerate the scene from scratch.

## STYLE
- Fill: cyan #38C5EE at ~40% opacity. Shingle texture, ridge caps, vents, and small fixtures must remain CLEARLY VISIBLE through the cyan.
- Outline: cyan #38C5EE at full opacity, crisp 2–3 pixel stroke along every legal edge. No feathering, no soft edges, no blurring.
- The effect is paint ADDED on top of the existing photo, not a replacement of it. Preserve the original pixels everywhere outside the painted area.

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
- Attached porches, sunrooms, lanais, and garages whose roof plane is visibly CONTINUOUS with the main house — **same pitch AND same surface material AND same color** as the main roof, plus no horizontal seam at the wall. If the appendage's surface texture/color is visibly different from the main roof (smooth bright metal where the main roof is shingle; white where the main roof is gray; corrugated where the main roof is flat), it is NOT the same roof system — do not paint it.
- Additions whose roof reads as part of the main structure (same height, same shingle direction, same material)

## DO NOT PAINT
- Lawn, driveway, sidewalk, patio, pool deck, pool, fence
- Tree canopy beside or over the house — foliage is bumpy, organic, irregular; no straight edges and no shingle texture
- Cast shadows on the ground
- Neighboring buildings — if ANY strip of lawn, walkway, or driveway separates them from the central house, they are different buildings
- Detached sheds, garages, or carports with ground between them and the main house
- Porches with a VISIBLY SHALLOWER separate roof — the giveaway is a clean horizontal seam at the wall where the porch roof tucks UNDER the main eave, plus a slope that reads flatter than the main roof
- Breezeways with their own separate structure
- **Screened pool enclosures / pool cages** — large flat or low-pitch panels next to the house with a dark mesh / screen surface. They show a fine grid or diamond pattern, NOT shingle or tile texture, and read noticeably darker and flatter than the adjacent roof. Common on Florida homes; often as large as the house roof itself. NEVER paint.
- **Paver / concrete pool decks and lanais** — uniform tan, gray, or terracotta surface AT GROUND LEVEL beside the pool. Has a repeating paver grid but no roof pitch, no eave shadow, no ridge. If you can see the pool water directly adjacent, the surrounding hard surface is deck, not roof.
- **Detached lanai / cabana roofs separated from the main roof** — a low, dark membrane or flat-tile structure with its own perimeter and a visible gap (deck, screen wall, or open air) between it and the main roof. Treat as a separate building.
- **Tile roof color trap** — Spanish / Mediterranean barrel-tile roofs (terracotta, brown, tan) sit next to paver decks and tile patios that share a very similar color. Discriminate by TEXTURE and ELEVATION: tile roof shows repeating curved barrel rows with sharp ridge/hip lines and casts a clear eave shadow; ground tile / pavers show a flat rectangular grid with no eave shadow. Color alone is NOT enough — require visible barrel texture AND a roof edge before painting.
- **Attached metal awnings, aluminum patio covers, and metal carport canopies** — narrow rectangular panels attached to one side or the rear of the house, often shading a side door, walkway, or patio. Almost always WHITE, SILVER, or LIGHT GRAY smooth metal with NO shingle / tile / barrel texture. The giveaway is a clear MATERIAL CONTRAST with the adjacent main roof (bright reflective metal vs. textured shingle or tile; pure white vs. gray / brown / terracotta). These are aftermarket hardware, NOT part of the main roof system being re-roofed. NEVER paint, even when the metal canopy directly abuts the main roof's eave. If the appendage shares an edge with the main roof but its surface looks like a different material, stop the cyan at the main roof's eave — do not extend cyan onto the metal awning.

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

Reminder: your output is the supplied photo with cyan paint added. Do not regenerate the scene. Do not invent a new image. Add cyan where the rules above say cyan goes; leave every other pixel as the input had it.`;

/**
 * USER TRIGGER — minimal anchor phrase that follows the image part in
 * user content. Per Google's Gemini 3 docs: "After a large block of
 * data, use a clear transition phrase to bridge the context and your
 * query, such as 'Based on the information above...'"
 *
 * The actual rules live in GEMINI_ROOF_SYSTEM_INSTRUCTION; this just
 * tells the model the image is delivered and asks it to execute.
 */
export const GEMINI_ROOF_USER_TRIGGER =
  "Based on the aerial image above, paint the central building's roof " +
  "per your system instructions and return the JSON object detection " +
  "for rooftop fixtures.";

/**
 * Back-compat alias — older callsites that import `GEMINI_ROOF_PROMPT`
 * still resolve to the full system instruction text. Once every call
 * uses the split shape we can remove this.
 */
export const GEMINI_ROOF_PROMPT = GEMINI_ROOF_SYSTEM_INSTRUCTION;

// ─── Flash rich-data schema (objects + facets + material + condition + …) ──
//
// Response schema for the Flash sidecar call that runs in parallel
// with the Pro Image paint call. Pro Image is busy painting; Flash
// carries all the structured-data work.
//
// Returns:
//   - objects[]: rooftop fixtures (vents, chimneys, skylights, etc.)
//   - facet_count_estimate: visual count of distinct roof planes
//   - roof_material: predominant covering material
//   - condition_hints[]: visible signs of wear, staining, damage, age
//
// Confidence is a float (0.0–1.0) on every field that can be wrong.
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
          // Google's native object-detection format. Per Gemini docs:
          //   "The coordinates, relative to image dimensions, scale to
          //    [0, 1000]. You need to descale these coordinates based
          //    on your original image size."
          // Order: [ymin, xmin, ymax, xmax]. We descale to 1280-px
          // tile space in app/api/gemini-roof/route.ts before persisting.
          // Asking for native format instead of our prior custom
          // {x, y, width, height} avoids fighting the model's training.
          box_2d: {
            type: "ARRAY",
            items: { type: "NUMBER" },
            description:
              "[ymin, xmin, ymax, xmax] normalized 0-1000 (Google's native object-detection format).",
          },
          confidence: {
            type: "NUMBER",
            description: "Float 0.0–1.0",
          },
        },
        required: ["type", "box_2d", "confidence"],
      },
    },
    facet_count_estimate: {
      type: "OBJECT",
      description:
        "Per-face count of every visible triangular or trapezoidal roof surface on the central building. A 4-sided hip roof = 4 facets (not 1). Hexagonal turret = 6 facets. See section 2 of the prompt for per-face counting calibration.",
      properties: {
        count: {
          type: "INTEGER",
          description:
            "Every visible triangular / trapezoidal roof surface counted separately. Simple gable = 2, simple hip = 4, cross-hip ranch = 8–12, multi-wing + turret = 20–40.",
        },
        complexity: {
          type: "STRING",
          enum: ["simple", "moderate", "complex"],
          description:
            "simple = 2–8 facets (gable, simple hip, L), moderate = 9–20 facets (cross-hip, multi-wing, single dormer cluster), complex = 21+ (multi-wing hip + turret, dormer cluster).",
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
