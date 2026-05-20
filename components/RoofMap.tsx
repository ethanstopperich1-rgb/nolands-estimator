"use client";

/**
 * Interactive Google Maps view of the customer's roof with the cyan
 * polygon Gemini detected draped over the satellite imagery via a
 * GroundOverlay.
 *
 * Always renders the map container. If the Google Maps JS API fails to
 * load (key issue, referrer block, billing, etc.), we show the static
 * composite image AS WELL AS a visible badge with the actual error
 * message so we can diagnose. Prior versions hid the error behind a
 * silent fallback img, which made the failure indistinguishable from
 * "Pro Image had nothing to paint."
 */

import { useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";

export interface RoofMapProps {
  centerLat: number;
  centerLng: number;
  zoom: number;
  overlay: {
    base64: string;
    bounds: { north: number; south: number; east: number; west: number };
  } | null;
  fallbackPngBase64: string | null;
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
    let mapInstance: google.maps.Map | null = null;
    loadGoogle()
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        try {
          mapInstance = new g.maps.Map(containerRef.current, {
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
            groundOverlay.setMap(mapInstance);
          }
          if (!cancelled) setState("ready");
        } catch (mapBuildErr) {
          const msg =
            mapBuildErr instanceof Error
              ? mapBuildErr.message
              : String(mapBuildErr);
          console.warn("[RoofMap] map_construct_failed", msg);
          if (!cancelled) {
            setErrMsg(`map ctor: ${msg}`);
            setState("error");
          }
        }
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

  // Failure path — render fallback img IF AVAILABLE, but ALSO show the
  // error message visibly so the actual cause is diagnosable from a
  // screenshot. Prior version hid the error behind the img and we
  // couldn't tell why the map wasn't showing.
  if (state === "error") {
    return (
      <>
        {fallbackPngBase64 && (
          /* eslint-disable-next-line @next/next/no-img-element */
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
        )}
        <div
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            bottom: 8,
            padding: "8px 12px",
            background: "rgba(15, 27, 45, 0.85)",
            color: "#fff",
            fontSize: 11,
            lineHeight: 1.45,
            borderRadius: 4,
            fontFamily: "var(--vx-font-ui, system-ui, sans-serif)",
          }}
        >
          <div style={{ fontWeight: 600, letterSpacing: "0.05em" }}>
            Interactive map could not load
          </div>
          {errMsg ? (
            <div style={{ opacity: 0.85, marginTop: 2, fontSize: 10.5 }}>
              {errMsg}
            </div>
          ) : null}
        </div>
      </>
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
