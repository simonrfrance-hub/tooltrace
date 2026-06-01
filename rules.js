// Rules engine. Runs on every incoming location ping for an asset.
// Everything here is computed from the location stream the vendor pushes us —
// the tag itself reports nothing but lat/long/time.

// Haversine distance in metres between two points.
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Thresholds. Tighten them automatically when an asset is in "stolen mode".
function thresholds(stolen) {
  return stolen
    ? { moveMeters: 20, silenceMinutes: 10 }   // jumpy + eager when we're hunting
    : { moveMeters: 50, silenceMinutes: 60 };  // calm default to avoid GPS-jitter noise
}

// Given the asset, the new ping, and the previous ping (or null), decide which
// alerts to raise. Returns an array of {type, message}.
export function evaluate(asset, ping, prev) {
  const alerts = [];
  const { moveMeters, silenceMinutes } = thresholds(asset.stolen_mode);

  // 1. Geofence exit — most reliable trigger. True even if the tag was silent
  //    for hours and the next report is from far away.
  if (asset.fence_lat != null && asset.fence_radius_m != null) {
    const fromFence = distanceMeters(
      asset.fence_lat, asset.fence_lng, ping.latitude, ping.longitude
    );
    if (fromFence > asset.fence_radius_m) {
      alerts.push({
        type: 'geofence_exit',
        message: `Left geofence — ${Math.round(fromFence)}m from zone centre (radius ${asset.fence_radius_m}m).`,
      });
    }
  }

  if (prev) {
    // 2. Movement detected — compare to the previous known position.
    const moved = distanceMeters(
      prev.latitude, prev.longitude, ping.latitude, ping.longitude
    );
    if (moved > moveMeters) {
      alerts.push({
        type: 'movement',
        message: `Moved ${Math.round(moved)}m since last report.`,
      });
    }

    // 3. Re-appeared after silence — the practical version of "connected to a
    //    device". The crowd network doesn't tell us which phone relayed it, so
    //    a fresh report after a quiet gap is our proxy for "heard again".
    const gapMin = (Date.parse(ping.received_at) - Date.parse(prev.received_at)) / 60000;
    if (Number.isFinite(gapMin) && gapMin >= silenceMinutes) {
      alerts.push({
        type: 'reappeared',
        message: `Back online after ${Math.round(gapMin)} min of silence (likely heard by a nearby device).`,
      });
    }
  }

  return alerts;
}
