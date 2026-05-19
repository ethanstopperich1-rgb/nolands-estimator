"use client";

/**
 * Interactive Google Maps view of the customer's roof with the cyan
 * polygon Gemini detected draped over the satellite imagery via a
 * GroundOverlay. The customer can pan, zoom, and confirm orientation
 * against the real aerial — much more reassuring than a static painted
 * PNG, especially for asymmetric or complex roofs where the static crop
 * sometimes makes people ask "is that really my house?".
 *
 * The cyan PNG is georeferenced against the same tile bounds the
 * source painted image was rendered at, so the polygon stays glued to
 * the roof through pan/zoom.
 *
 * When the cyan overlay isn't available (Gemini didn't return a usable
 * mask), the map still renders — the customer sees the interactive
 * satellite view without an overlay, which is strictly better than the
 * previous "no image at all" fallback.
 *
 * When Google Maps itself fails to load (rare; usually means an API key
 * misconfiguration), we fall back to the static composite PNG that the
 * server already produced.
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
  /** Static composite image (real aerial + cyan). Used as a fallback
   *  when the Google Maps JS loader fails. Null when even that isn't
   *  available — the component will render an empty card. */
  fallbackPngBase64: string | null;
  /** Optional alt text for the fallback image / a11y description. */
  altText?: string;
}

export default function RoofMap({
  centerLat,
  centerLng,
  zoom,
  overlay,
  fallbackPngBase64,
  altText = "Your roof, outlined on a satellite view",
}: RoofMapProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapErr, setMapErr] = useState<string | null>(null);

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
          // Top-down — `tilt: 0` disables the 45° aerial that Google
          // serves at high zoom in some areas. The cyan polygon was
          // calculated from straight-overhead imagery, so we keep the
          // view straight-overhead to match.
          tilt: 0,
          rotateControl: false,
          // Minimal chrome — the customer is here for the roof, not
          // for map UI. Pan + zoom still work via gestures.
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
          // Don't let the customer zoom out so far that the building
          // disappears or so far in that we get blurry upscaling.
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
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn(
            "[RoofMap] google_maps_load_failed",
            err instanceof Error ? err.message : String(err),
          );
          setMapErr(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      if (groundOverlay) groundOverlay.setMap(null);
    };
  }, [centerLat, centerLng, zoom, overlay]);

  if (mapErr && fallbackPngBase64) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`data:image/png;base64,${fallbackPngBase64}`}
        alt={altText}
        className="w-full h-full object-cover"
      />
    );
  }
  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      aria-label={altText}
      role="img"
    />
  );
}
