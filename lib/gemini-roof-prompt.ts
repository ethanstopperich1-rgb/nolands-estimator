/**
 * Hardcoded prompt + JSON response schema for Gemini 3 Pro Image roof
 * analysis.
 *
 * Revised 2026-05-16 (v3.1) — sharper boundary rules and a structured
 * "follow the roof, not the shadow" heuristic, plus a float confidence
 * (0.0–1.0) instead of the enum. The previous prompt versions tended
 * to either under-trace (skipped shadowed wings) or over-trace (bled
 * into lawn/canopy). This wording locks the boundary to actual roof
 * material features (straight edges, shingle texture, eave lines) and
 * gives Gemini explicit "when uncertain, paint less" guidance.
 *
 * Architecture context: the customer drags a pin onto the building
 * center; the tile is refetched centered on the pin at zoom 21. The
 * target building is guaranteed to be at pixel (640, 640) in a
 * 1280×1280 image. No Gemini needs to identify which building — the
 * pin does that.
 */

export const GEMINI_ROOF_PROMPT = `Edit this 1280×1280 aerial satellite image by painting a translucent cyan roof overlay on the single residential building at the exact center of the frame (pixel 640, 640). The user has confirmed this is the target building — do not second-guess which structure to annotate. Also return structured JSON identifying rooftop objects.

## Layer 1 — Roof overlay (image output)

### Rule #1: each roof plane is ONE solid, continuous polygon. No exceptions.

When you paint a roof plane, the cyan must fill the ENTIRE plane as a single continuous shape — eave to ridge, gable to gable. **No notches. No cutouts. No bite-outs along the inside edge. No triangular gaps that follow shadow lines. No holes around skylights or vents (those small fixtures sit ON the painted surface — paint right over them with the cyan and let the texture show through).**

The painted shape per roof plane is a CONVEX OR L-SHAPED POLYGON whose boundary is composed only of real roof edges:
- **Eaves** (where the roof meets open air at the bottom of a slope)
- **Ridges** (the highest line where two planes meet at the peak)
- **Hips** (sloped line running down a corner from the peak)
- **Valleys** (sloped line between two planes meeting in a V from above)
- **Rakes** (sloped edge along the open side of a gable)
- **Gable ends** (the vertical-facing wall at the end of a ridge)

That is the COMPLETE list of legal cyan boundaries. If a candidate boundary is none of those six things, it is not an edge — keep painting through it.

### Rule #2: shadow lines are NOT roof edges. They are darker shingle.

Shadows cast onto the roof by skylights, chimneys, dormers, vents, the ridge itself, or nearby trees create sharp dark lines that look like edges but ARE NOT. The shingle material is continuous underneath the shadow. The plane is still the same plane.

Common failure pattern to avoid:
A row of skylights along the south slope casts a row of triangular shadows pointing away from the sun. The model sees five sharp triangular dark shapes and "cuts" them out of the cyan, leaving five triangular holes in the overlay. **DO NOT do this.** Paint cyan straight through every one of those triangles. The roof slope above, below, between, and through the shadows is the same plane. The overlay across that slope should be one single rectangle with no triangular notches.

Test: if you are about to stop the cyan at a dark line, ask yourself which of the six legal edges it is. If you can't name one, keep painting.

### Rule #3: distinguishing shadow vs. real edge.

A real roof edge is a 3D geometric transition between surfaces facing different directions. In a satellite photo this shows as:
- A change in shingle texture orientation (granules align differently across the line)
- A change in average brightness because one plane catches more sun than the other (gradual, NOT a sharp triangular shape)
- A continuous line that spans a meaningful distance — typically at least 10–20% of the roof width

A shadow is a darkness pattern projected by a feature. It shows as:
- A sharp-edged dark patch with one or two straight boundaries (the rest is irregular)
- IDENTICAL shingle texture inside and outside the shadow
- A shape that points away from the sun (e.g. a triangular patch pointing east from a skylight in afternoon light)
- A length that's proportional to the height of the object casting it (~0.5–2× the object size, not the full roof)

When the patch is small, sharp-cornered, and matches the orientation of a nearby skylight/chimney/vent, it is a shadow. Paint through it.

### Outer boundary rules — where the cyan ends.

The overlay's outer edge must sit on one of the six legal edges where the roof material meets non-roof (sky, gutter, open air past the eave). Do NOT extend the cyan onto:
- **Cast shadows on the ground.** Shadows are soft-edged, desaturated gray-green or gray-brown, sit on grass or pavement, and have no shingle texture.
- **Tree canopy next to the house.** Foliage is bumpy, organic, irregular, clustered. No straight edges, no shingle pattern.
- **Lawn, driveway, pool, pool deck, patio, sidewalk, fence.**
- **Neighboring houses.** If there is any strip of ground (lawn, walkway, driveway) between the central roof and another rooftop, the other rooftop is a different building.
- **Detached sheds or garages** separated from the main house by ground.
- **Attached porches with a SEPARATE lower-pitched roof.** Many homes have a covered porch whose roof is visibly shallower (often near-flat) and meets the main house at a horizontal seam where the porch roof tucks UNDER the main roof's eave. Leave it OFF the cyan overlay. The clue: a clean horizontal seam at the wall plus a visibly shallower slope.
- **Carports and breezeways** whose roof structure is separate from the main house.

Attached porches, attached garages, sunrooms, and additions whose roof plane is visibly CONTINUOUS with the main house — same pitch, same shingle pattern, same height seam — ARE part of the target and should be overlaid. Continuity of plane, not physical attachment.

### Filling small gaps under tree canopy.

When tree branches partially cover the roof, paint cyan across the covered area as if the canopy were transparent — but only when the roof clearly continues underneath (visible roof on each side of the canopy lines up, eave line stays consistent, covered span is small). If most of the roof is hidden by trees, only paint what you can see. If unsure, paint less.

### Painting style.

Use translucent cyan #38C5EE at ~40% opacity. Add a crisp 2–3 pixel #38C5EE full-opacity outline along each legal outer edge AND along each legal interior edge (ridges, hips, valleys) where one cyan plane meets another. Shingle texture, ridge caps, vents, and small fixtures must remain clearly visible through the fill. The effect is painted, not pasted.

### Self-check before returning.

Before you finish, scan your output:
1. Does any cyan boundary follow a shadow line? Fix it — fill that area in.
2. Are there any triangular, sharp-cornered notches along the inside edge of any painted plane? Fix them — fill them in.
3. Are there small holes around skylights, vents, or chimneys? Fix them — paint over the fixtures.
4. Is each roof plane represented by ONE continuous polygon? If a single plane is showing as multiple disconnected shapes, merge them.

The painted shape per plane should be the same polygon a human architect would draw if asked to outline that plane on a printout. No funny notches, no shadow-shaped indentations.

## Layer 2 — Rooftop & site detection (JSON output)

Identify roof fixtures, visible damage, and surrounding site context. Use the schema below.

Rules:
- Only include rooftop objects on the central building's roof. Skip anything on neighboring roofs, in yards, or on the ground.
- Only include things you can directly see. Do NOT infer objects under tree canopy — the gap-filling rule applies to the overlay only.
- Coordinates are in image pixel space (0–1279 on each axis, origin top-left).
- Bounding box should tightly enclose the object.
- Confidence is a float between 0.0 and 1.0 reflecting certainty about both object type and presence.

For visible_damage, report each discrete signal you can SEE in the imagery — do not guess. Each entry is one discrete observation (e.g. "lifted shingles in the north slope"). Confidence reflects how clearly the damage is visible from this satellite angle.

For secondary_structures, list attached additions that share a continuous roof plane with the main house — porches, lanais, attached garages, sunrooms, additions. Skip detached structures.

For site_obstacles, list things visible around the roof that would affect crew access or material staging — heavy tree overhang, overhead utility wires crossing the roof, pool immediately adjacent, narrow side-yard access, fence enclosing the property.

For apparent_age_band, choose ONE band based on overall roof appearance — granule coverage, color uniformity, visible weathering. This is a rough banding, not a precise age.

## Aesthetic

Magazine-quality roof inspection report. Clean geometric cyan on photographic aerial source. The cyan should feel painted onto the roof, not pasted over it.`;

/**
 * Comprehensive JSON schema for the Gemini Flash sidecar call. Returns:
 *   - objects[]: rooftop fixtures (vents, chimneys, skylights, etc.)
 *   - facet_count_estimate: Gemini's visual count of distinct roof planes
 *   - roof_material: predominant covering material
 *   - condition_hints[]: visible signs of wear, staining, damage, age
 *
 * Confidence is a float (0.0–1.0) on every field that can be wrong.
 */
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
  // Only `objects` is required at the top level — Gemini Flash sometimes
  // omits the optional sub-objects if it can't confidently fill them.
  // We want partial responses to still parse cleanly.
  required: ["objects"],
} as const;
