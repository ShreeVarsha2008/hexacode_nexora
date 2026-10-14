from datetime import datetime
from geo import distance_m

SPEED_LIMIT_KMH = 150

def _parse(ts):
    # "2026-10-14T10:45:00Z" -> datetime
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))

def _level(score):
    if score >= 70:
        return "HIGH"
    if score >= 30:
        return "MEDIUM"
    return "LOW"

def score_shipment(shipment, events):
    """
    shipment: dict with destination{lat,lng,radius_m}, documents{...}, duplicate_count
    events:   accepted events in order, each with event_type, lat, lng,
              seal_intact, timestamp
    Returns {"score": int, "level": str, "reasons": [str]}
    """
    score = 0
    reasons = []
    dest = shipment["destination"]

    # 1. Seal tampering anywhere (+70)
    if any(not e["seal_intact"] for e in events):
        score += 70
        reasons.append("Seal tampering detected")

    # 2. Latest ARRIVAL outside the geofence (+40)
    arrivals = [e for e in events if e["event_type"] == "ARRIVAL"]
    if arrivals:
        a = arrivals[-1]
        d = distance_m(a["lat"], a["lng"], dest["lat"], dest["lng"])
        if d > dest["radius_m"]:
            score += 40
            reasons.append("Arrival reported outside destination geofence")

    # 3. Impossible speed between consecutive pings (+30, counted once)
    ordered = sorted(events, key=lambda e: _parse(e["timestamp"]))
    for prev, cur in zip(ordered, ordered[1:]):
        hours = (_parse(cur["timestamp"]) - _parse(prev["timestamp"])).total_seconds() / 3600
        if hours <= 0:
            continue
        km = distance_m(prev["lat"], prev["lng"], cur["lat"], cur["lng"]) / 1000
        if km / hours > SPEED_LIMIT_KMH:
            score += 30
            reasons.append("Unusual GPS jump")
            break

    # 4. Duplicate events (+10 each, max +20)
    dups = shipment.get("duplicate_count", 0) or 0
    if dups > 0:
        score += min(10 * dups, 20)
        reasons.append("Duplicate event received")

    # 5. Any document MISSING (+25)
    docs = shipment.get("documents", {}) or {}
    if any(v == "MISSING" for v in docs.values()):
        score += 25
        reasons.append("Documents missing or unverified")

    score = min(score, 100)
    if not reasons:
        reasons.append("No anomalies detected")
    return {"score": score, "level": _level(score), "reasons": reasons}