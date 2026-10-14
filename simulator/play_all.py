import argparse, time
import requests
from simulator import build

# shipment -> (scenario, expected decision, expected payment_status)
PLAN = [
    ("FT12-001", "normal",         "RELEASE", "RELEASED"),
    ("FT12-002", "tamper",         "HOLD",    "ON_HOLD"),
    ("FT12-003", "wrong_location", "HOLD",    "ON_HOLD"),
    ("FT12-004", "normal",         "HOLD",    "ON_HOLD"),     # packing_list seeded MISSING
    ("FT12-005", "duplicate",      "WAIT",    "ESCROW_HELD"),
    ("FT12-006", "normal",         "RELEASE", "RELEASED"),    # then evaluated again
    ("FT12-007", "gps_jump",       "WAIT",    "ESCROW_HELD"),
]

p = argparse.ArgumentParser()
p.add_argument("--base-url", default="http://localhost:5000")
p.add_argument("--delay", type=float, default=0.5)
p.add_argument("--dry-run", action="store_true")
p.add_argument("--only", help="run just one shipment, e.g. FT12-002")
a = p.parse_args()

def post(path, body=None):
    r = requests.post(a.base_url + path, json=body, timeout=5)
    try:
        return r.json()
    except ValueError:
        return {"error": r.text[:100]}

if a.dry_run:
    for sid, scenario, dec, pay in PLAN:
        print(f"{sid}: {scenario:15} {len(build(sid, scenario))} events, expect {dec}/{pay}")
    raise SystemExit

print("Resetting demo data:", post("/api/demo/reset"))
passed = 0
total = 0

for sid, scenario, want_dec, want_pay in PLAN:
    if a.only and a.only != sid:
        continue
    print(f"\n=== {sid} ({scenario}) ===")
    for e in build(sid, scenario):
        r = post("/api/simulator/event", e)
        flag = "DUPLICATE" if r.get("duplicate") else "ok" if r.get("accepted") else r
        print(f"  {e['event_id']} {e['event_type']:11} -> {flag}")
        time.sleep(a.delay)

    res = post(f"/api/shipments/{sid}/evaluate")
    if sid == "FT12-006":   # second call must not pay twice
        res = post(f"/api/shipments/{sid}/evaluate")
        print("  already_released:", res.get("already_released"), "(expect True)")

    total += 1
    ok = res.get("decision") == want_dec and res.get("payment_status") == want_pay
    passed += ok
    print(f"  decision={res.get('decision')} payment={res.get('payment_status')} "
          f"reasons={res.get('reasons')}  [{'PASS' if ok else 'FAIL, expected ' + want_dec + '/' + want_pay}]")

print(f"\n{passed}/{total} shipments matched the test matrix")