from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import datetime
import hashlib, json

from geo import distance_m

# Uses Person 3's real risk.py if it is in this folder, otherwise a fake one
try:
    from risk import score_shipment
except ImportError:
    def score_shipment(shipment, events):
        return {"score": 0, "level": "LOW", "reasons": []}

app = Flask(__name__)
CORS(app)

# ---- Staged payment settings (mock money only) ----
COMMISSION_RATE = 0.01          # platform keeps 1% of every payment to the supplier
STAGE_PLAN = [                  # (key, label, percent of shipment value)
    ("DOCUMENTS_VERIFIED", "Documents verified", 20),
    ("DISPATCHED", "Shipment on its way", 20),
    ("DELIVERED", "Safe arrival at port", 60),
]

SHIPMENTS = {}
EVENTS = {}
AUDIT = {}

def make_stages(amount):
    stages, used = [], 0
    for i, (key, label, pct) in enumerate(STAGE_PLAN):
        part = amount - used if i == len(STAGE_PLAN) - 1 else int(amount * pct / 100)
        used += part
        stages.append({"key": key, "label": label, "percent": pct,
                       "amount_inr": part, "status": "PENDING"})
    return stages

def new_shipment(sid, packing="VERIFIED"):
    amount = 500000
    return {
        "shipment_id": sid, "buyer": "Acme Imports", "supplier": "Sharma Exports",
        "goods": "500 cartons of cotton fabric", "amount_inr": amount,
        "destination": {"name": "JNPT Nhava Sheva", "lat": 18.95, "lng": 72.95, "radius_m": 2000},
        "gps_status": "EN_ROUTE", "seal_status": "INTACT",
        "document_status": "VERIFIED" if packing == "VERIFIED" else "MISSING",
        "documents": {"bill_of_lading": "VERIFIED", "invoice": "VERIFIED", "packing_list": packing},
        "payment_status": "ESCROW_HELD", "risk_score": 0, "risk_level": "LOW",
        "risk_reasons": [], "duplicate_count": 0,
        "stages": make_stages(amount), "commission_rate": COMMISSION_RATE,
        "escrow_remaining_inr": amount, "paid_to_supplier_inr": 0,
        "platform_commission_inr": 0, "refunded_to_buyer_inr": 0,
        "last_position": {"lat": 18.52, "lng": 73.86, "timestamp": "2026-10-14T10:00:00Z"},
    }

def add_audit(sid, event_type, details):
    prev = AUDIT[sid][-1]["hash"] if AUDIT[sid] else "0" * 64
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    data = prev + sid + event_type + json.dumps(details, sort_keys=True) + ts
    h = hashlib.sha256(data.encode()).hexdigest()
    AUDIT[sid].append({"id": len(AUDIT[sid]) + 1, "shipment_id": sid,
                       "event_type": event_type, "details": details,
                       "timestamp": ts, "prev_hash": prev, "hash": h})

def reset_data():
    SHIPMENTS.clear(); EVENTS.clear(); AUDIT.clear()
    for i in range(1, 8):
        sid = f"FT12-00{i}"
        SHIPMENTS[sid] = new_shipment(sid, "MISSING" if i == 4 else "VERIFIED")
        EVENTS[sid] = []
        AUDIT[sid] = []
        add_audit(sid, "SHIPMENT_CREATED", {"amount_inr": 500000})

reset_data()

def refresh_risk(sid):
    s = SHIPMENTS[sid]
    r = score_shipment(s, EVENTS[sid])
    s["risk_score"] = r["score"]
    s["risk_level"] = r["level"]
    s["risk_reasons"] = r["reasons"]

def inside(s, e):
    d = s["destination"]
    return distance_m(e["lat"], e["lng"], d["lat"], d["lng"]) <= d["radius_m"]

def release_stage(s, sid, key):
    """Pay one stage to the supplier (minus platform commission)."""
    st = next(x for x in s["stages"] if x["key"] == key)
    if st["status"] != "PENDING":
        return False
    gross = st["amount_inr"]
    fee = int(round(gross * COMMISSION_RATE))
    net = gross - fee
    st["status"] = "RELEASED"
    s["paid_to_supplier_inr"] += net
    s["platform_commission_inr"] += fee
    s["escrow_remaining_inr"] -= gross
    add_audit(sid, "STAGE_RELEASED", {"stage": key, "gross_inr": gross,
                                      "commission_inr": fee, "supplier_net_inr": net})
    return True

def evaluate(sid):
    s = SHIPMENTS[sid]
    evs = EVENTS[sid]
    arrivals = [e for e in evs if e["event_type"] == "ARRIVAL"]

    def out(decision, status, reasons, already=False):
        s["payment_status"] = status
        return {"shipment_id": sid, "decision": decision, "payment_status": status,
                "already_released": already, "reasons": reasons}

    def hold(reason):
        add_audit(sid, "PAYMENT_HELD", {"reason": reason})
        return out("HOLD", "ON_HOLD", [reason])

    # Rule 1: already finished (paid in full, or refunded)
    if s["payment_status"] == "RELEASED":
        add_audit(sid, "REPEAT_RELEASE_BLOCKED", {})
        return out("RELEASE", "RELEASED", ["Payment already released"], already=True)
    if s["payment_status"] == "REFUNDED":
        add_audit(sid, "REPEAT_RELEASE_BLOCKED", {})
        return out("REFUNDED", "REFUNDED", ["Buyer already refunded"], already=True)
    # Rule 2: tamper, never clears (money already paid stays paid, the rest is frozen)
    if any(e["seal_intact"] is False for e in evs):
        return hold("Seal tampering detected")
    # Rule 3: latest arrival outside radius
    if arrivals and not inside(s, arrivals[-1]):
        return hold("Arrival reported outside destination geofence")

    docs_ok = s["document_status"] == "VERIFIED"
    risk_high = s["risk_level"] == "HIGH"

    # Early stages: paid while the goods travel safely
    paid = []
    if docs_ok and not risk_high:
        if release_stage(s, sid, "DOCUMENTS_VERIFIED"):
            paid.append("Documents verified")
        if evs and release_stage(s, sid, "DISPATCHED"):
            paid.append("Shipment on its way")

    # Rule 4: no arrival yet
    if not arrivals:
        reasons = ["Shipment still in transit"]
        if paid:
            reasons.append("Stage paid: " + ", ".join(paid))
        return out("WAIT", "ESCROW_HELD", reasons)
    # Rule 5: documents
    if not docs_ok:
        return hold("Documents missing or unverified")
    # Rule 6: risk
    if risk_high:
        return hold("Risk score too high")
    # Rule 7: final stage
    release_stage(s, sid, "DELIVERED")
    add_audit(sid, "PAYMENT_RELEASED", {"amount_inr": s["amount_inr"]})
    return out("RELEASE", "RELEASED", ["All conditions met"])

@app.get("/api/shipments")
def list_shipments():
    return jsonify(list(SHIPMENTS.values()))

@app.get("/api/shipments/<sid>")
def get_shipment(sid):
    if sid not in SHIPMENTS:
        return jsonify({"error": "shipment not found"}), 404
    return jsonify(SHIPMENTS[sid])

@app.post("/api/simulator/event")
def simulator_event():
    e = request.get_json(silent=True) or {}
    need = ["event_id", "shipment_id", "event_type", "lat", "lng", "seal_intact", "timestamp"]
    missing = [k for k in need if k not in e]
    if missing:
        return jsonify({"error": "missing fields: " + ", ".join(missing)}), 400
    if e["event_type"] not in ("GPS_PING", "SEAL_TAMPER", "ARRIVAL"):
        return jsonify({"error": "bad event_type"}), 400
    sid = e["shipment_id"]
    if sid not in SHIPMENTS:
        return jsonify({"error": "shipment not found"}), 404
    s = SHIPMENTS[sid]

    # Duplicate event
    if any(x["event_id"] == e["event_id"] for x in EVENTS[sid]):
        s["duplicate_count"] += 1
        add_audit(sid, "DUPLICATE_EVENT_REJECTED", {"event_id": e["event_id"]})
        refresh_risk(sid)
        return jsonify({"accepted": False, "duplicate": True})

    # Accepted event
    EVENTS[sid].append(e)
    s["last_position"] = {"lat": e["lat"], "lng": e["lng"], "timestamp": e["timestamp"]}
    if e["seal_intact"] is False:
        s["seal_status"] = "TAMPERED"
    if e["event_type"] == "ARRIVAL":
        s["gps_status"] = "AT_DESTINATION" if inside(s, e) else "WRONG_LOCATION"
    add_audit(sid, e["event_type"], {"event_id": e["event_id"], "lat": e["lat"],
                                     "lng": e["lng"], "seal_intact": e["seal_intact"]})
    refresh_risk(sid)
    evaluate(sid)
    return jsonify({"accepted": True, "duplicate": False, "shipment": s})

@app.post("/api/shipments/<sid>/evaluate")
def evaluate_endpoint(sid):
    if sid not in SHIPMENTS:
        return jsonify({"error": "shipment not found"}), 404
    refresh_risk(sid)
    return jsonify(evaluate(sid))

@app.post("/api/shipments/<sid>/verify-documents")
def verify_documents(sid):
    if sid not in SHIPMENTS:
        return jsonify({"error": "shipment not found"}), 404
    s = SHIPMENTS[sid]
    for k in s["documents"]:
        s["documents"][k] = "VERIFIED"
    s["document_status"] = "VERIFIED"
    add_audit(sid, "DOCUMENTS_VERIFIED", {})
    refresh_risk(sid)
    result = evaluate(sid)
    result["shipment"] = s
    return jsonify(result)

@app.post("/api/shipments/<sid>/refund-buyer")
def refund_buyer(sid):
    """Goods lost or damaged: the money not yet paid goes back to the buyer.
    The supplier keeps only the stages already paid, so the loss is the supplier's."""
    if sid not in SHIPMENTS:
        return jsonify({"error": "shipment not found"}), 404
    s = SHIPMENTS[sid]
    if s["payment_status"] != "ON_HOLD":
        return jsonify({"error": "Refund is only possible while the payment is ON HOLD"}), 409
    refund = s["escrow_remaining_inr"]
    s["refunded_to_buyer_inr"] = refund
    s["escrow_remaining_inr"] = 0
    s["payment_status"] = "REFUNDED"
    for st in s["stages"]:
        if st["status"] == "PENDING":
            st["status"] = "REFUNDED"
    add_audit(sid, "BUYER_REFUNDED", {"refund_inr": refund, "supplier_loss_inr": refund})
    return jsonify({"shipment_id": sid, "decision": "REFUND", "payment_status": "REFUNDED",
                    "already_released": False, "refund_inr": refund,
                    "reasons": ["Goods damaged or tampered: unpaid amount returned to buyer"],
                    "shipment": s})

@app.get("/api/shipments/<sid>/audit")
def get_audit(sid):
    if sid not in SHIPMENTS:
        return jsonify({"error": "shipment not found"}), 404
    return jsonify(AUDIT[sid])

@app.post("/api/demo/reset")
def demo_reset():
    reset_data()
    return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)