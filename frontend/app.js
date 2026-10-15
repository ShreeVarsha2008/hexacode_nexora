/* =========================================================
   SEALPAY — FRONTEND APPLICATION
   Works with the ORIGINAL index.html and style.css (no changes there).
   Extra labels, buttons and the risk panel are added by this file.
   Backend: Flask on port 5000 (see SEALPAY SHARED KEYS)
   Endpoints used:
     GET  /api/shipments
     GET  /api/shipments/<id>/audit
     POST /api/simulator/event
     POST /api/shipments/<id>/evaluate
     POST /api/shipments/<id>/verify-documents
     POST /api/demo/reset
   ========================================================= */


/* ---------------- CONFIGURATION ---------------- */

// The backend runs on port 5000. By default the page talks to the same
// machine it was opened from. To point it elsewhere, open the page with
// ?api=http://<backend-laptop-ip>:5000
const API_PARAM = new URLSearchParams(window.location.search).get("api");
const API_HOST = window.location.hostname || "localhost";
const API_BASE_URL = (API_PARAM || `http://${API_HOST}:5000`).replace(/\/$/, "");
const REFRESH_INTERVAL = 2000;

// Demo coordinates from the shared keys file
const PORT_POINT = { lat: 18.95, lng: 72.95 };      // JNPT Nhava Sheva
const WRONG_POINT = { lat: 19.99, lng: 73.79 };     // wrong location


/* ---------------- APPLICATION STATE ---------------- */

const $ = (id) => document.getElementById(id);

let shipments = [];
let selectedId = null;
let auditRecords = [];

let map = null;
let shipmentMarker = null;
let portMarker = null;
let routeLine = null;
let geofenceCircle = null;

let refreshInProgress = false;
let actionInProgress = false;


/* ---------------- HELPER FUNCTIONS ---------------- */

function formatINR(amount) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(Number(amount ?? 0));
}

function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function pretty(value) {
    // EN_ROUTE -> En route
    if (!value) return "—";
    const text = String(value).replace(/_/g, " ").toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function nowIso() {
    // 2026-10-14T10:45:00Z (no milliseconds, as in the shared keys file)
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function showNotice(message, type = "info") {
    const notice = $("notice");
    console.log(`[SealPay] ${message}`);

    if (!notice) {
        if (type === "error") window.alert(message);
        return;
    }

    notice.textContent = message;
    notice.className = `notice ${type}`;
    notice.hidden = false;

    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => { notice.hidden = true; }, 6000);
}

function setConnectionStatus(connected) {
    const status = $("connection-status");

    if (status) {
        status.textContent = connected ? "Connected to API" : "Disconnected — check backend";
        status.style.color = connected ? "#0d9488" : "#dc2626";
    }

    const dot = document.querySelector(".connection-dot");
    if (dot) dot.style.backgroundColor = connected ? "#0d9488" : "#dc2626";
}

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value ?? "—";
}

function getSelected() {
    return shipments.find((s) => s.shipment_id === selectedId) || null;
}


/* ---------------- API REQUESTS ---------------- */

async function apiRequest(endpoint, options = {}) {
    const headers = { "Accept": "application/json", ...(options.headers || {}) };

    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response;

    try {
        response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers });
    } catch (error) {
        setConnectionStatus(false);
        throw new Error(
            `Cannot reach the backend at ${API_BASE_URL}. ` +
            "Check that the backend teammate's Flask server is running."
        );
    }

    let result = {};
    const text = await response.text();

    if (text) {
        try {
            result = JSON.parse(text);
        } catch {
            result = { message: text.slice(0, 200) };
        }
    }

    if (!response.ok) {
        throw new Error(
            result.error || result.detail || result.message ||
            `Request failed: HTTP ${response.status}`
        );
    }

    setConnectionStatus(true);
    return result;
}


/* ---------------- SHIPMENT MAP ---------------- */

function initializeMap() {
    const mapElement = $("shipment-map");

    if (!mapElement) {
        console.warn("Map container #shipment-map was not found.");
        return;
    }

    if (typeof L === "undefined") {
        console.error("Leaflet failed to load.");
        showNotice("The map library did not load. Check your internet connection.", "error");
        return;
    }

    map = L.map(mapElement).setView([18.72, 73.40], 9);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);
}

function updateMap(shipment) {
    if (!map || !shipment) return;

    [shipmentMarker, portMarker, routeLine, geofenceCircle].forEach((layer) => {
        if (layer) map.removeLayer(layer);
    });
    shipmentMarker = portMarker = routeLine = geofenceCircle = null;

    const position = shipment.last_position;
    const port = shipment.destination;
    const points = [];

    const hasPosition = position &&
        Number.isFinite(Number(position.lat)) && Number.isFinite(Number(position.lng));
    const hasPort = port &&
        Number.isFinite(Number(port.lat)) && Number.isFinite(Number(port.lng));

    if (hasPosition) {
        const coordinates = [Number(position.lat), Number(position.lng)];
        points.push(coordinates);
        shipmentMarker = L.marker(coordinates).addTo(map)
            .bindPopup(`Shipment ${shipment.shipment_id}<br>Latest reported position`);
    }

    if (hasPort) {
        const destination = [Number(port.lat), Number(port.lng)];
        points.push(destination);
        portMarker = L.marker(destination).addTo(map)
            .bindPopup(port.name || "Destination port");
        geofenceCircle = L.circle(destination, {
            radius: Number(port.radius_m || 2000),
            color: "#0d9488",
            fillColor: "#14b8a6",
            fillOpacity: 0.12,
            weight: 2
        }).addTo(map);
    }

    if (points.length === 2) {
        routeLine = L.polyline(points, {
            color: "#0d9488", weight: 3, opacity: 0.8, dashArray: "7, 8"
        }).addTo(map);
    }

    // Refit the map when the shipment changes or its position moves,
    // but not on every unchanged refresh.
    const key = `${shipment.shipment_id}|${position?.lat}|${position?.lng}`;
    if (map._sealPayKey !== key && points.length > 0) {
        if (points.length === 2) {
            map.fitBounds(points, { padding: [35, 35], maxZoom: 11 });
        } else {
            map.setView(points[0], 10);
        }
        map._sealPayKey = key;
    }
}


/* ---------------- SHIPMENT SELECTOR ---------------- */

function renderSelector() {
    const select = $("order-select");
    if (!select) return;

    const previousId = selectedId;
    select.replaceChildren();

    if (shipments.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No shipments available";
        select.appendChild(option);
        selectedId = null;
        return;
    }

    shipments.forEach((shipment) => {
        const option = document.createElement("option");
        option.value = shipment.shipment_id;
        option.textContent = `${shipment.shipment_id} — ${pretty(shipment.payment_status)}`;
        select.appendChild(option);
    });

    selectedId = shipments.some((s) => s.shipment_id === previousId)
        ? previousId
        : shipments[0].shipment_id;

    select.value = selectedId;
}


/* ---------------- SHIPMENT DETAILS ---------------- */

function renderShipment(shipment) {
    if (!shipment) return;

    setText("order-id", shipment.shipment_id);
    setText("buyer-name", shipment.buyer);
    setText("port-name", shipment.destination?.name);
    setText("supplier-name", shipment.supplier);
    setText("goods-name", shipment.goods);
    setText("order-amount", formatINR(shipment.amount_inr));
    setText("seal-id", pretty(shipment.seal_status));
    setText("order-eta", pretty(shipment.gps_status));

    const docs = shipment.documents || {};
    const verified = Object.values(docs).filter((v) => v === "VERIFIED").length;
    setText("delay-status",
        `${pretty(shipment.document_status)} (${verified}/${Object.keys(docs).length || 3})`);

    const status = $("order-status");
    if (status) {
        status.textContent = pretty(shipment.payment_status);
        status.className = `status-badge ${PAYMENT_BADGE[shipment.payment_status] || ""}`;
    }

    renderRisk(shipment);
    renderStages(shipment);
    updateMap(shipment);
}

function renderStages(shipment) {
    const list = $("stage-list");
    if (!list) return;

    list.replaceChildren();
    (shipment.stages || []).forEach((stage) => {
        const row = document.createElement("div");
        row.className = "stage-row " + String(stage.status || "").toLowerCase();

        const name = document.createElement("span");
        name.textContent = `${stage.percent}% · ${stage.label}`;

        const amount = document.createElement("strong");
        const icon = stage.status === "RELEASED" ? "✓ Paid " : stage.status === "REFUNDED" ? "↩ Refunded " : "Waiting ";
        amount.textContent = icon + formatINR(stage.amount_inr);

        row.appendChild(name);
        row.appendChild(amount);
        list.appendChild(row);
    });

    const rate = Math.round(Number(shipment.commission_rate || 0) * 1000) / 10;
    setText("commission-note",
        `Platform commission ${rate}% on each payment · earned so far ${formatINR(shipment.platform_commission_inr)}` +
        (shipment.refunded_to_buyer_inr
            ? ` · refunded to buyer ${formatINR(shipment.refunded_to_buyer_inr)} (supplier bears this loss)` : ""));
}

const PAYMENT_BADGE = { ESCROW_HELD: "funded", ON_HOLD: "frozen", RELEASED: "", REFUNDED: "created" };
const RISK_BADGE = { LOW: "", MEDIUM: "funded", HIGH: "frozen" };

function renderRisk(shipment) {
    setText("risk-score", `${shipment.risk_score ?? 0} / 100`);

    const level = $("risk-level");
    if (level) {
        level.textContent = shipment.risk_level || "—";
        level.className = `status-badge ${RISK_BADGE[shipment.risk_level] || ""}`;
    }

    const list = $("risk-reasons");
    if (!list) return;

    list.replaceChildren();
    const reasons = shipment.risk_reasons || [];

    if (reasons.length === 0) {
        const item = document.createElement("li");
        item.className = "ok";
        item.textContent = "No risk signals detected.";
        list.appendChild(item);
        return;
    }

    reasons.forEach((reason) => {
        const item = document.createElement("li");
        item.textContent = reason;
        list.appendChild(item);
    });
}


/* ---------------- DASHBOARD STATISTICS & PAYMENTS ---------------- */

function sumAmount(filterFn) {
    return shipments.filter(filterFn)
        .reduce((sum, s) => sum + Number(s.amount_inr || 0), 0);
}

function sumField(field, filterFn = () => true) {
    return shipments.filter(filterFn).reduce((sum, s) => sum + Number(s[field] || 0), 0);
}

function renderStatistics() {
    const inEscrow = sumField("escrow_remaining_inr");

    setText("total-orders", shipments.length);
    setText("escrow-balance", formatINR(inEscrow));
    setText("in-transit",
        shipments.filter((s) => s.gps_status === "EN_ROUTE" &&
            s.payment_status !== "RELEASED" && s.payment_status !== "REFUNDED").length);
    setText("attention-count",
        shipments.filter((s) => s.payment_status === "ON_HOLD" || s.risk_level === "HIGH").length);

    setText("buyer-wallet", formatINR(inEscrow));
    setText("wallet-escrow", formatINR(sumField("paid_to_supplier_inr")));
    setText("supplier-wallet", formatINR(sumField("platform_commission_inr")));
    setText("refund-wallet", formatINR(sumField("refunded_to_buyer_inr")));
}


/* ---------------- ACTIVITY TIMELINE (AUDIT LOG) ---------------- */

function describeDetails(details) {
    if (!details || typeof details !== "object") return "";

    if (details.reason) return details.reason;

    if (details.stage) {
        return `Stage ${pretty(details.stage)} · paid ${formatINR(details.supplier_net_inr)}` +
            ` · platform fee ${formatINR(details.commission_inr)}`;
    }
    if (details.refund_inr !== undefined) {
        return `Refunded ${formatINR(details.refund_inr)} to buyer · supplier bears the loss`;
    }

    const parts = [];
    if (details.lat !== undefined && details.lng !== undefined) {
        parts.push(`Position ${Number(details.lat).toFixed(3)}, ${Number(details.lng).toFixed(3)}`);
    }
    if (details.seal_intact === false) parts.push("Seal broken");
    if (details.amount_inr !== undefined) parts.push(formatINR(details.amount_inr));
    if (details.event_id) parts.push(`Event ${details.event_id}`);
    return parts.join(" · ");
}

function renderTimeline(records) {
    const container = $("event-timeline");
    if (!container) return;

    container.replaceChildren();

    if (!records || records.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No shipment events recorded yet.";
        container.appendChild(empty);
        return;
    }

    // Newest first
    [...records].reverse().forEach((record) => {
        const item = document.createElement("div");
        item.className = "timeline-item";

        const marker = document.createElement("div");
        marker.className = "timeline-marker";
        marker.textContent = "•";

        const body = document.createElement("div");

        const title = document.createElement("strong");
        title.textContent = pretty(record.event_type);

        const detail = document.createElement("p");
        detail.textContent = describeDetails(record.details);

        const time = document.createElement("time");
        time.textContent =
            `${formatDate(record.timestamp)} · hash ${String(record.hash || "").slice(0, 10)}…`;

        body.appendChild(title);
        if (detail.textContent) body.appendChild(detail);
        body.appendChild(time);

        item.appendChild(marker);
        item.appendChild(body);
        container.appendChild(item);
    });
}


/* ---------------- LOAD DASHBOARD ---------------- */

async function loadDashboard({ silent = false } = {}) {
    if (refreshInProgress) return;
    refreshInProgress = true;

    try {
        const result = await apiRequest("/api/shipments");
        shipments = Array.isArray(result) ? result : (result.shipments || []);

        renderSelector();
        renderStatistics();

        const shipment = getSelected();

        if (shipment) {
            renderShipment(shipment);
            auditRecords = await apiRequest(
                `/api/shipments/${encodeURIComponent(shipment.shipment_id)}/audit`
            );
            renderTimeline(auditRecords);
        } else {
            auditRecords = [];
            renderTimeline([]);
        }

        setConnectionStatus(true);
    } catch (error) {
        setConnectionStatus(false);
        if (!silent) showNotice(error.message, "error");
        console.error("Dashboard loading error:", error);
    } finally {
        refreshInProgress = false;
    }
}


/* ---------------- ACTION HELPER ---------------- */

const ACTION_BUTTONS =
    "#fund-btn, #bol-btn, #ship-btn, #audit-btn, #tamper-btn, #wrong-btn, #refund-btn, #reset-btn";

async function runAction(endpoint, options, onSuccess) {
    if (actionInProgress) return null;
    actionInProgress = true;

    const buttons = document.querySelectorAll(ACTION_BUTTONS);
    buttons.forEach((button) => { button.disabled = true; });

    try {
        const result = await apiRequest(endpoint, options);
        if (onSuccess) onSuccess(result);
        await loadDashboard({ silent: true });
        return result;
    } catch (error) {
        showNotice(error.message, "error");
        console.error("Action error:", error);
        return null;
    } finally {
        actionInProgress = false;
        buttons.forEach((button) => { button.disabled = false; });
    }
}

function requireSelected() {
    const shipment = getSelected();
    if (!shipment) showNotice("Please select a shipment first.", "error");
    return shipment;
}

function showDecision(result) {
    const text = `Decision: ${result.decision} · Payment: ${pretty(result.payment_status)}` +
        (result.already_released ? " · Already released, no second payout" : "") +
        (result.reasons?.length ? ` · ${result.reasons.join("; ")}` : "");

    const line = $("decision-line");
    if (line) line.textContent = text;

    const type = result.decision === "RELEASE" ? "success"
        : result.decision === "HOLD" ? "error" : "info";
    showNotice(text, type);
}


/* ---------------- BUTTON ACTIONS ---------------- */

async function verifyDocuments() {
    const shipment = requireSelected();
    if (!shipment) return;

    await runAction(
        `/api/shipments/${encodeURIComponent(shipment.shipment_id)}/verify-documents`,
        { method: "POST" },
        showDecision
    );
}

async function evaluatePayment() {
    const shipment = requireSelected();
    if (!shipment) return;

    await runAction(
        `/api/shipments/${encodeURIComponent(shipment.shipment_id)}/evaluate`,
        { method: "POST" },
        showDecision
    );
}

async function sendEvent(eventType, point, sealIntact, label) {
    const shipment = requireSelected();
    if (!shipment) return;

    const body = {
        event_id: `${shipment.shipment_id}-UI-${Date.now()}`,
        shipment_id: shipment.shipment_id,
        event_type: eventType,
        lat: point.lat,
        lng: point.lng,
        seal_intact: sealIntact,
        timestamp: nowIso(),
        source: "dashboard"
    };

    await runAction(
        "/api/simulator/event",
        { method: "POST", body: JSON.stringify(body) },
        (result) => {
            if (result.duplicate) {
                showNotice("Duplicate event rejected.", "info");
                return;
            }
            const s = result.shipment || {};
            showNotice(
                `${label} accepted. Payment: ${pretty(s.payment_status)} · ` +
                `Risk: ${s.risk_level || "—"} (${s.risk_score ?? 0})`,
                s.payment_status === "ON_HOLD" ? "error" : "success"
            );
        }
    );
}

const sendArrival = () => sendEvent("ARRIVAL", PORT_POINT, true, "Arrival at port");
const sendTamper = () => sendEvent("SEAL_TAMPER", shipmentPoint(), false, "Seal tamper");
const sendWrongLocation = () => sendEvent("ARRIVAL", WRONG_POINT, true, "Arrival at wrong location");

function shipmentPoint() {
    const p = getSelected()?.last_position;
    return p ? { lat: p.lat, lng: p.lng } : { lat: 18.6, lng: 73.5 };
}

async function refundBuyer() {
    const shipment = requireSelected();
    if (!shipment) return;

    if (!window.confirm("Goods damaged? Return the unpaid amount to the buyer (the supplier bears this loss)?")) return;

    await runAction(
        `/api/shipments/${encodeURIComponent(shipment.shipment_id)}/refund-buyer`,
        { method: "POST" },
        (result) => showNotice(
            `Buyer refunded ${formatINR(result.refund_inr)}. The supplier keeps only the stages already paid.`,
            "success")
    );
}

async function resetDemo() {
    if (!window.confirm("Reset the SealPay demo and reload the test shipments?")) return;

    const result = await runAction("/api/demo/reset", { method: "POST" });

    if (result) {
        selectedId = null;
        showNotice("Demo reset completed.", "success");
        await loadDashboard({ silent: true });
    }
}


/* ---------------- AUDIT HASH-CHAIN VERIFICATION ----------------
   Recomputes every hash in the browser using the rule from the shared
   keys file:
   sha256(prev_hash + shipment_id + event_type +
          json.dumps(details, sort_keys=True) + timestamp)
   and checks each record points at the previous one.
----------------------------------------------------------------- */

// Python-style json.dumps(value, sort_keys=True)
function pyDumps(value) {
    if (value === null || value === undefined) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") {
        return JSON.stringify(value).replace(
            /[\u007f-￿]/g,
            (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
        );
    }
    if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
    return "{" + Object.keys(value).sort()
        .map((key) => `${pyDumps(String(key))}: ${pyDumps(value[key])}`)
        .join(", ") + "}";
}

// Small pure-JS SHA-256 (the browser's crypto.subtle is unavailable
// on plain http:// pages that are not localhost).
function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    const bitLength = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padded.length - 4, bitLength >>> 0);

    const w = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = H;

        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }

        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
        H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
        H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    return H.map((n) => n.toString(16).padStart(8, "0")).join("");
}

function verifyChain(records) {
    let previous = "0".repeat(64);

    for (let i = 0; i < records.length; i++) {
        const r = records[i];

        if (r.prev_hash !== previous) return { valid: false, index: i, why: "link to previous record is broken" };

        const expected = sha256Hex(
            r.prev_hash + r.shipment_id + r.event_type + pyDumps(r.details) + r.timestamp
        );

        if (expected !== r.hash) return { valid: false, index: i, why: "record contents were changed" };

        previous = r.hash;
    }

    return { valid: true, count: records.length };
}

async function verifyAuditLog() {
    const shipment = requireSelected();
    if (!shipment) return;

    try {
        const records = await apiRequest(
            `/api/shipments/${encodeURIComponent(shipment.shipment_id)}/audit`
        );
        const result = verifyChain(records);

        if (result.valid) {
            showNotice(`Audit verified: all ${result.count} records form a valid hash chain.`, "success");
        } else {
            showNotice(
                `Audit verification FAILED at record #${result.index + 1}: ${result.why}.`,
                "error"
            );
        }
    } catch (error) {
        showNotice(`Audit verification failed: ${error.message}`, "error");
    }
}


/* ---------------- NAVIGATION ---------------- */

function initializeNavigation() {
    document.querySelectorAll("[data-view]").forEach((button) => {
        button.addEventListener("click", () => {
            const view = button.dataset.view;

            const sectionMap = {
                overview: ".welcome",
                shipments: ".shipment-panel",
                wallets: ".wallet-panel",
                audit: ".timeline-panel"
            };

            const target = document.querySelector(sectionMap[view] || `#${view}`);
            if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });

            document.querySelectorAll(".nav-item").forEach((item) => {
                item.classList.toggle("active", item === button);
            });
        });
    });
}


/* ---------------- CONNECT BUTTONS ---------------- */

function initializeControls() {
    $("fund-btn")?.addEventListener("click", verifyDocuments);
    $("bol-btn")?.addEventListener("click", sendArrival);
    $("ship-btn")?.addEventListener("click", evaluatePayment);
    $("audit-btn")?.addEventListener("click", verifyAuditLog);
    $("tamper-btn")?.addEventListener("click", sendTamper);
    $("refund-btn")?.addEventListener("click", refundBuyer);
    $("wrong-btn")?.addEventListener("click", sendWrongLocation);
    $("reset-btn")?.addEventListener("click", resetDemo);
    $("refresh-btn")?.addEventListener("click", () => loadDashboard());

    $("order-select")?.addEventListener("change", (event) => {
        selectedId = event.target.value;
        loadDashboard({ silent: true });
    });
}


/* ---------------- START APPLICATION ---------------- */

/* ---------------- LAYOUT TWEAKS (done here so index.html stays as is) ---------------- */

function relabel(id, text) {
    // Changes the small label that sits next to a value element.
    const label = $(id)?.parentElement?.querySelector("small");
    if (label) label.textContent = text;
}

function relabelWallet(id, text) {
    // Wallet rows look like <span><i class="dot"></i>Buyer</span><strong id=...>
    const span = $(id)?.parentElement?.querySelector("span");
    if (span && span.lastChild) span.lastChild.textContent = text;
}

function setButton(id, html) {
    const button = $(id);
    if (button) button.innerHTML = html;
}

function enhanceLayout() {
    relabel("seal-id", "SEAL STATUS");
    relabel("order-eta", "GPS STATUS");
    relabel("delay-status", "DOCUMENTS");

    relabelWallet("buyer-wallet", "In escrow");
    relabelWallet("wallet-escrow", "Paid to supplier");
    relabelWallet("supplier-wallet", "Platform commission");

    // 4th wallet row: refunds to the buyer
    const lastRow = $("supplier-wallet")?.parentElement;
    if (lastRow && !$("refund-wallet")) {
        const row = lastRow.cloneNode(true);
        row.querySelector("strong").id = "refund-wallet";
        row.querySelector("strong").textContent = "—";
        if (row.querySelector("span") && row.querySelector("span").lastChild) {
            row.querySelector("span").lastChild.textContent = "Refunded to buyer";
        }
        lastRow.after(row);
    }

    setButton("fund-btn", "01 &nbsp; Verify documents");
    setButton("bol-btn", "02 &nbsp; Arrival at port");
    setButton("ship-btn", "03 &nbsp; Evaluate payment");

    // Two extra demo buttons, placed before "Verify audit log"
    const audit = $("audit-btn");
    if (audit && !$("tamper-btn")) {
        const tamper = document.createElement("button");
        tamper.id = "tamper-btn";
        tamper.className = "button button-danger full-button";
        tamper.innerHTML = "&#9888; &nbsp; Simulate seal tamper";

        const wrong = document.createElement("button");
        wrong.id = "wrong-btn";
        wrong.className = "button button-danger full-button";
        wrong.innerHTML = "&#9873; &nbsp; Arrival at wrong place";

        const refund = document.createElement("button");
        refund.id = "refund-btn";
        refund.className = "button button-secondary full-button";
        refund.innerHTML = "&#8617; &nbsp; Refund buyer (goods damaged)";

        audit.before(tamper, wrong, refund);
        audit.innerHTML = "04 &nbsp; Verify audit log";
    }

    // Small style rules for the risk panel and the extra buttons
    if (!document.getElementById("sealpay-extra-style")) {
        const style = document.createElement("style");
        style.id = "sealpay-extra-style";
        style.textContent =
            "#risk-panel .risk-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}" +
            "#risk-panel .risk-score{font-size:22px;font-weight:800}" +
            "#risk-reasons{margin:0;padding-left:18px;font-size:12px;color:#58677b}" +
            "#risk-reasons li{margin:4px 0}#risk-reasons li.ok{color:#158354;list-style:none;margin-left:-18px}" +
            "#decision-line{font-size:11px;color:#58677b;margin:12px 0 0;overflow-wrap:anywhere}" +
            ".actions-panel .full-button{margin-bottom:8px}" +
            "#stage-panel .stage-row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #e6ebf2;font-size:12px;color:#58677b}" +
            "#stage-panel .stage-row.released strong{color:#158354}#stage-panel .stage-row.refunded strong{color:#bd3745}" +
            "#commission-note{font-size:11px;color:#58677b;margin:12px 0 0;overflow-wrap:anywhere}";
        document.head.appendChild(style);
    }

    // Payment stages panel + risk panel under the wallet panel
    const column = document.querySelector(".right-column");
    if (column && !$("stage-panel")) {
        const stagePanel = document.createElement("article");
        stagePanel.className = "panel";
        stagePanel.id = "stage-panel";
        stagePanel.innerHTML =
            '<div class="panel-heading"><div><p class="eyebrow">STAGED PAYMENT</p>' +
            "<h3>Payment stages</h3></div></div>" +
            '<div id="stage-list"></div>' +
            '<p id="commission-note">—</p>';
        const w = column.querySelector(".wallet-panel");
        if (w) w.after(stagePanel); else column.prepend(stagePanel);
    }
    if (column && !$("risk-panel")) {
        const panel = document.createElement("article");
        panel.className = "panel";
        panel.id = "risk-panel";
        panel.innerHTML =
            '<div class="panel-heading"><div><p class="eyebrow">AI RISK SCORE</p>' +
            "<h3>Explainable risk</h3></div></div>" +
            '<div class="risk-top"><span class="risk-score" id="risk-score">—</span>' +
            '<span class="status-badge" id="risk-level">—</span></div>' +
            '<ul id="risk-reasons"></ul>' +
            '<p id="decision-line">Last decision: none yet</p>';
        const anchor = $("stage-panel") || column.querySelector(".wallet-panel");
        if (anchor) anchor.after(panel); else column.prepend(panel);
    }
}


function initializeApp() {
    enhanceLayout();
    initializeMap();
    initializeNavigation();
    initializeControls();

    loadDashboard();

    window.setInterval(() => loadDashboard({ silent: true }), REFRESH_INTERVAL);

    console.log("SealPay frontend initialized.");
    console.log("Backend URL:", API_BASE_URL);
}

document.addEventListener("DOMContentLoaded", initializeApp);