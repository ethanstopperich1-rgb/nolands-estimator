"use client";

/**
 * Interactive Google Maps view of the customer's roof with the cyan
 * polygon Gemini detected draped over the satellite imagery via a
 * GroundOverlay.
 *
 * Resilience notes:
 *
 *   - The container uses absolute positioning inside a `position:
 *     relative` parent. The `result-card` wrapper provides `position:
 *     relative` and the aspect-ratio sizing; `inset: 0` makes this
 *     element fill it deterministically, sidestepping the
 *     aspect-ratio + h-full child race that some browsers hit.
 *   - Loading state is visible (a faint "Loading map…" caption) so a
 *     blank dark square never appears even on slow connections.
 *   - Errors render a visible, customer-readable message instead of
 *     silently falling back to a static image with no explanation.
 *     Fallback PNG is shown only when one is available; otherwise the
 *     error caption stands alone.
 *   - `loadGoogle()` is a shared singleton — if the address-autocomplete
 *     already loaded Maps on the hero, this promise resolves
 *     synchronously.
 */

import { useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";

export interface RoofMapProps {
  centerLat: number;
  centerLng: number;
  /** Static-Maps zoom the cyan polygon was produced at. The interactive
   *  map opens at this zoom so the polygon matches the satellite frame
   *  one-to-one on first render; the user can zoom out from there. */
  zoom: number;
  /** Transparent-background PNG of the cyan polygon plus the lat/lng
   *  bounds it should be georeferenced against. When null, the map
   *  renders without an overlay. */
  overlay: {
    base64: string;
    bounds: { north: number; south: number; east: number; west: number };
  } | null;
  /** Static composite image (real aerial + cyan). Used as a final
   *  fallback when the Google Maps JS loader fails. */
  fallbackPngBase64: string | null;
  /** Optional alt text for the fallback image / a11y description. */
  altText?: string;
}

type MapState = "loading" | "ready" | "error";

export default function RoofMap({
  centerLat,
  centerLng,
  zoom,
  overlay,
  fallbackPngBase64,
  altText = "Your roof, outlined on a satellite view",
}: RoofMapProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<MapState>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let groundOverlay: google.maps.GroundOverlay | null = null;
    loadGoogle()
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        const map = new g.maps.Map(containerRef.current, {
          center: { lat: centerLat, lng: centerLng },
          zoom,
          mapTypeId: "satellite",
          tilt: 0,
          rotateControl: false,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
          minZoom: 17,
          maxZoom: 22,
          keyboardShortcuts: false,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
        });
        if (overlay) {
          const bounds = new g.maps.LatLngBounds(
            { lat: overlay.bounds.south, lng: overlay.bounds.west },
            { lat: overlay.bounds.north, lng: overlay.bounds.east },
          );
          groundOverlay = new g.maps.GroundOverlay(
            `data:image/png;base64,${overlay.base64}`,
            bounds,
            { opacity: 1.0, clickable: false },
          );
          groundOverlay.setMap(map);
        }
        if (!cancelled) setState("ready");
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[RoofMap] google_maps_load_failed", msg);
        if (!cancelled) {
          setErrMsg(msg);
          setState("error");
        }
      });
    return () => {
      cancelled = true;
      if (groundOverlay) groundOverlay.setMap(null);
    };
  }, [centerLat, centerLng, zoom, overlay]);

  // Hard-failed path: show the static composite if we have one, otherwise
  // a readable error caption. Never leave the slot blank.
  if (state === "error") {
    if (fallbackPngBase64) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`data:image/png;base64,${fallbackPngBase64}`}
          alt={altText}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      );
    }
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontSize: 13,
          color: "var(--vx-muted, #8A7E68)",
          textAlign: "center",
        }}
      >
        Map could not load.
        {errMsg ? <div style={{ marginTop: 6, fontSize: 11 }}>{errMsg}</div> : null}
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
        aria-label={altText}
        role="img"
      />
      {state === "loading" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontSize: 12,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--vx-muted, #8A7E68)",
            background: "var(--vx-paper, #F5EFE0)",
          }}
        >
          Loading map…
        </div>
      )}
    </>
  );
}
