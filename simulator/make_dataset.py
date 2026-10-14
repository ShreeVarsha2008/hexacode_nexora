import json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(HERE, "..", "backend"))
from simulator import build
from risk import score_shipment

random.seed(42)  # same dataset every run

SCENARIOS = ["normal", "tamper", "wrong_location", "duplicate", "gps_jump", "missing_docs"]
PER_SCENARIO = 4

def shipment_info(missing_docs=False, dup=0):
    return {
        "destination": {"name": "JNPT Nhava Sheva", "lat": 18.95, "lng": 72.95, "radius_m": 2000},
        "documents": {"bill_of_lading": "VERIFIED", "invoice": "VERIFIED",
                      "packing_list": "MISSING" if missing_docs else "VERIFIED"},
        "duplicate_count": dup,
    }

def jitter(events):
    for e in events:
        e["lat"] = round(e["lat"] + random.uniform(-0.003, 0.003), 5)
        e["lng"] = round(e["lng"] + random.uniform(-0.003, 0.003), 5)

records = []
n = 1
for scenario in SCENARIOS:
    for _ in range(PER_SCENARIO):
        sid = f"FT12-D{n:02d}"
        n += 1
        events = build(sid, "normal" if scenario == "missing_docs" else scenario)
        jitter(events)

        # separate accepted events from duplicates, like the backend does
        seen, accepted, dups = set(), [], 0
        for e in events:
            if e["event_id"] in seen:
                dups += 1
            else:
                seen.add(e["event_id"])
                accepted.append(e)

        ship = shipment_info(missing_docs=(scenario == "missing_docs"), dup=dups)
        records.append({
            "shipment_id": sid,
            "scenario": scenario,
            "shipment": ship,
            "events": events,
            "expected_risk": score_shipment(ship, accepted),
        })

with open(os.path.join(HERE, "dataset.json"), "w") as f:
    json.dump(records, f, indent=2)

print(f"Wrote {len(records)} shipments")
for r in records:
    x = r["expected_risk"]
    print(r["shipment_id"], r["scenario"].ljust(15), x["score"], x["level"])