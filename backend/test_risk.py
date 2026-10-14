from datetime import datetime, timedelta
from risk import score_shipment

BASE = datetime(2026, 10, 14, 10, 0, 0)
START = (18.52, 73.86)   # Pune
DEST = (18.95, 72.95)    # JNPT
WRONG = (19.99, 73.79)
DELHI = (28.61, 77.21)
STEPS = 8

def ts(minutes):
    return (BASE + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

def ev(i, etype, lat, lng, intact=True):
    return {"event_type": etype, "lat": lat, "lng": lng,
            "seal_intact": intact, "timestamp": ts(i * 10)}

def trip(target, upto=STEPS, tamper_at=None):
    """Pings every 10 min along a straight line from Pune to target.
    The last point (step 8) is the ARRIVAL. upto stops the trip early."""
    events, intact = [], True
    for i in range(upto + 1):
        f = i / STEPS
        lat = START[0] + (target[0] - START[0]) * f
        lng = START[1] + (target[1] - START[1]) * f
        etype = "GPS_PING"
        if tamper_at is not None and i == tamper_at:
            etype, intact = "SEAL_TAMPER", False
        if i == STEPS:
            etype = "ARRIVAL"
        events.append(ev(i, etype, lat, lng, intact))
    return events

def ship(dup=0, packing="VERIFIED"):
    return {"destination": {"name": "JNPT", "lat": 18.95, "lng": 72.95, "radius_m": 2000},
            "documents": {"bill_of_lading": "VERIFIED", "invoice": "VERIFIED",
                          "packing_list": packing},
            "duplicate_count": dup}

def check(name, shipment, events, score, level):
    r = score_shipment(shipment, events)
    assert r["score"] == score and r["level"] == level, f"{name}: got {r}"
    print("PASS", name, r)

check("001 valid arrival", ship(), trip(DEST), 0, "LOW")
check("002 tampered", ship(), trip(DEST, tamper_at=4), 70, "HIGH")
check("003 wrong GPS", ship(), trip(WRONG), 40, "MEDIUM")
check("004 missing docs", ship(packing="MISSING"), trip(DEST), 25, "LOW")
check("005 duplicate", ship(dup=1), trip(DEST, upto=5), 10, "LOW")
check("005b dup capped", ship(dup=5), trip(DEST, upto=5), 20, "LOW")
check("006 repeat release", ship(), trip(DEST), 0, "LOW")
check("007 gps jump", ship(), trip(DEST, upto=3) + [ev(4, "GPS_PING", *DELHI)], 30, "MEDIUM")
check("cap at 100", ship(packing="MISSING"), trip(WRONG, tamper_at=4), 100, "HIGH")
print("\nAll risk tests passed")