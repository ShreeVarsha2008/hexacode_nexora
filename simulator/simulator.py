import argparse, time
from datetime import datetime, timedelta, timezone

START = (18.52, 73.86)   # Pune
DEST = (18.95, 72.95)    # JNPT Nhava Sheva
WRONG = (19.99, 73.79)
DELHI = (28.61, 77.21)
STEPS = 8                # 8 legs x 10 min = 80 min trip

def build(sid, scenario):
    target = WRONG if scenario == "wrong_location" else DEST
    # gps_jump and duplicate stop in transit (matches FT12-005 / FT12-007)
    last = {"duplicate": 5, "gps_jump": 4}.get(scenario, STEPS)
    t0 = datetime.now(timezone.utc).replace(microsecond=0)
    events, intact = [], True

    for i in range(last + 1):
        f = i / STEPS
        lat = START[0] + (target[0] - START[0]) * f
        lng = START[1] + (target[1] - START[1]) * f
        etype = "GPS_PING"

        if scenario == "tamper" and i == 4:
            etype, intact = "SEAL_TAMPER", False    # stays False afterwards
        if scenario == "gps_jump" and i == last:
            lat, lng = DELHI                        # teleport ~1,100 km in 10 min
        if i == STEPS:
            etype = "ARRIVAL"

        events.append({
            "event_id": f"{sid}-{i + 1:04d}",
            "shipment_id": sid,
            "event_type": etype,
            "lat": round(lat, 5), "lng": round(lng, 5),
            "seal_intact": intact,
            "timestamp": (t0 + timedelta(minutes=10 * i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "simulator",
        })

    if scenario == "duplicate":
        events.append(dict(events[3]))   # same event_id sent again
    return events

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--shipment", default="FT12-001")
    p.add_argument("--scenario", default="normal",
                   choices=["normal", "tamper", "wrong_location", "duplicate", "gps_jump"])
    p.add_argument("--base-url", default="http://localhost:5000")
    p.add_argument("--delay", type=float, default=2.0)
    p.add_argument("--dry-run", action="store_true", help="print only, don't call the API")
    a = p.parse_args()

    events = build(a.shipment, a.scenario)
    url = f"{a.base_url}/api/simulator/event"

    for e in events:
        print(e["event_id"], e["event_type"], e["lat"], e["lng"], "intact" if e["seal_intact"] else "TAMPERED")
        if not a.dry_run:
            import requests
            r = requests.post(url, json=e, timeout=5)
            print("   ->", r.status_code, r.text[:100])
            time.sleep(a.delay)