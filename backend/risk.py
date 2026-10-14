from datetime import datetime
from geo import distance_m

def score_shipment(shipment, events):
    score = 0
    reasons = []

    if any(e["seal_intact"] is False for e in events):
        score += 70
        reasons.append("Seal tampering detected")

    d = shipment["destination"]
    arrivals = [e for e in events if e["event_type"] == "ARRIVAL"]
    if arrivals:
        a = arrivals[-1]
        if distance_m(a["lat"], a["lng"], d["lat"], d["lng"]) > d["radius_m"]:
            score += 40
            reasons.append("Arrival reported outside destination geofence")

    def t(x):
        return datetime.fromisoformat(x["timestamp"].replace("Z", "+00:00"))
    for prev, cur in zip(events, events[1:]):
        hours = (t(cur) - t(prev)).total_seconds() / 3600
        if hours > 0:
            km = distance_m(prev["lat"], prev["lng"], cur["lat"], cur["lng"]) / 1000
            if km / hours > 150:
                score += 30
                reasons.append("Unusual GPS jump")
                break

    dup = min(shipment.get("duplicate_count", 0) * 10, 20)
    if dup:
        score += dup
        reasons.append("Duplicate event received")

    if any(v == "MISSING" for v in shipment["documents"].values()):
        score += 25
        reasons.append("Documents missing or unverified")

    score = min(score, 100)
    level = "LOW" if score < 30 else "MEDIUM" if score < 70 else "HIGH"
    return {"score": score, "level": level, "reasons": reasons}