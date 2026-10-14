
/* =========================================================
   SEALPAY — FRONTEND APPLICATION
   Matches the IDs in your existing index.html
   Backend: FastAPI on port 8000
   ========================================================= */


/* ---------------- CONFIGURATION ---------------- */

const API_HOST = window.location.hostname || "localhost";
const API_BASE_URL = `http://${API_HOST}:8000`;
const REFRESH_INTERVAL = 2000;


/* ---------------- APPLICATION STATE ---------------- */

const $ = (id) => document.getElementById(id);

let orders = [];
let selectedOrderId = null;

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
        maximumFractionDigits: 2
    }).format(Number(amount ?? 0));
}


function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short"
    });
}


function showNotice(message, type = "info") {
    const notice = $("notice");

    console.log(`[SealPay] ${message}`);

    if (!notice) {
        if (type === "error") {
            window.alert(message);
        }
        return;
    }

    notice.textContent = message;
    notice.className = `notice ${type}`;
    notice.hidden = false;

    clearTimeout(showNotice.timer);

    showNotice.timer = setTimeout(() => {
        notice.hidden = true;
    }, 4500);
}


function setConnectionStatus(connected) {
    const status = $("connection-status");

    if (status) {
        status.textContent = connected
            ? "Connected to API"
            : "Disconnected — check backend";

        status.style.color = connected ? "#0d9488" : "#dc2626";
    }

    const dot = document.querySelector(".connection-dot");

    if (dot) {
        dot.style.backgroundColor = connected
            ? "#0d9488"
            : "#dc2626";
    }
}


function collectionFrom(result, key) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.[key])) return result[key];

    return [];
}


function getSelectedOrder() {
    return orders.find(
        (order) => order.id === selectedOrderId
    ) || null;
}


/* ---------------- API REQUESTS ---------------- */

async function apiRequest(endpoint, options = {}) {
    const headers = {
        "Accept": "application/json",
        ...(options.headers || {})
    };

    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    let response;

    try {
        response = await fetch(
            `${API_BASE_URL}${endpoint}`,
            {
                ...options,
                headers
            }
        );
    } catch (error) {
        setConnectionStatus(false);

        throw new Error(
            `Cannot reach the backend at ${API_BASE_URL}. ` +
            "Check that your backend teammate has started FastAPI."
        );
    }

    let result = {};

    const text = await response.text();

    if (text) {
        try {
            result = JSON.parse(text);
        } catch {
            result = { message: text };
        }
    }

    if (!response.ok) {
        throw new Error(
            result.error ||
            result.detail ||
            result.message ||
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
        showNotice(
            "The map library did not load. Check your internet connection.",
            "error"
        );
        return;
    }

    map = L.map(mapElement).setView([18.72, 73.40], 9);

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">' +
                "OpenStreetMap</a> contributors",
            maxZoom: 19
        }
    ).addTo(map);
}


function updateMap(order) {
    if (!map || !order) return;

    // Remove previous layers before redrawing them.
    // This prevents duplicate markers and geofence circles
    // during automatic dashboard refreshes.

    if (shipmentMarker) {
        map.removeLayer(shipmentMarker);
        shipmentMarker = null;
    }

    if (portMarker) {
        map.removeLayer(portMarker);
        portMarker = null;
    }

    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }

    if (geofenceCircle) {
        map.removeLayer(geofenceCircle);
        geofenceCircle = null;
    }

    const position = order.last_position;
    const port = order.port;
    const points = [];

    const hasPosition =
        position &&
        Number.isFinite(Number(position.lat)) &&
        Number.isFinite(Number(position.lng));

    const hasPort =
        port &&
        Number.isFinite(Number(port.lat)) &&
        Number.isFinite(Number(port.lng));

    if (hasPosition) {
        const coordinates = [
            Number(position.lat),
            Number(position.lng)
        ];

        points.push(coordinates);

        shipmentMarker = L.marker(coordinates)
            .addTo(map)
            .bindPopup(
                `Shipment ${order.id}<br>Latest reported position`
            );
    }

    if (hasPort) {
        const destination = [
            Number(port.lat),
            Number(port.lng)
        ];

        points.push(destination);

        portMarker = L.marker(destination)
            .addTo(map)
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
            color: "#0d9488",
            weight: 3,
            opacity: 0.8,
            dashArray: "7, 8"
        }).addTo(map);
    }

    // Fit the map only when the selected order changes.
    // This avoids the map jumping around every two seconds.
    const mapOrderId = order.id;

    if (map._sealPayOrderId !== mapOrderId && points.length > 0) {
        if (points.length === 2) {
            map.fitBounds(points, {
                padding: [35, 35],
                maxZoom: 10
            });
        } else {
            map.setView(points[0], 10);
        }

        map._sealPayOrderId = mapOrderId;
    }
}


/* ---------------- ORDER SELECTOR ---------------- */

function renderOrderSelector() {
    const select = $("order-select");

    if (!select) return;

    const previousId = selectedOrderId;

    select.replaceChildren();

    if (orders.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No orders available";

        select.appendChild(option);
        selectedOrderId = null;
        return;
    }

    orders.forEach((order) => {
        const option = document.createElement("option");

        option.value = order.id;
        option.textContent =
            `${order.id} — ${order.status || "UNKNOWN"}`;

        select.appendChild(option);
    });

    selectedOrderId = orders.some(
        (order) => order.id === previousId
    )
        ? previousId
        : orders[0].id;

    select.value = selectedOrderId;
}


/* ---------------- ORDER DETAILS ---------------- */

function renderOrder(order) {
    if (!order) return;

    const fields = {
        "order-id": order.id,
        "buyer-name": order.buyer,
        "port-name": order.port?.name,
        "supplier-name": order.supplier,
        "goods-name": order.goods,
        "order-amount": formatINR(order.amount),
        "seal-id": order.seal_id,
        "order-eta": formatDate(order.eta),
        "delay-status": order.delayed ? "Delayed" : "On schedule"
    };

    Object.entries(fields).forEach(([id, value]) => {
        const element = $(id);

        if (element) {
            element.textContent = value ?? "—";
        }
    });

    const status = $("order-status");

    if (status) {
        status.textContent = order.status || "UNKNOWN";
        status.className =
            `status-badge status-${String(
                order.status || "unknown"
            ).toLowerCase()}`;
    }

    updateMap(order);
}


/* ---------------- DASHBOARD STATISTICS ---------------- */

function renderStatistics() {
    const total = orders.length;

    const inTransit = orders.filter(
        (order) => order.status === "IN_TRANSIT"
    ).length;

    const attention = orders.filter(
        (order) =>
            order.status === "FROZEN" ||
            order.delayed === true
    ).length;

    const totalEscrow = orders
        .filter((order) =>
            ["FUNDED", "IN_TRANSIT", "FROZEN"].includes(order.status)
        )
        .reduce(
            (sum, order) => sum + Number(order.amount || 0),
            0
        );

    if ($("total-orders")) {
        $("total-orders").textContent = total;
    }

    if ($("in-transit")) {
        $("in-transit").textContent = inTransit;
    }

    if ($("attention-count")) {
        $("attention-count").textContent = attention;
    }

    if ($("escrow-balance")) {
        $("escrow-balance").textContent = formatINR(totalEscrow);
    }
}


/* ---------------- WALLET BALANCES ---------------- */

function renderWallets(wallets) {
    if (!wallets) return;

    if ($("buyer-wallet")) {
        $("buyer-wallet").textContent = formatINR(wallets.buyer);
    }

    if ($("wallet-escrow")) {
        $("wallet-escrow").textContent = formatINR(wallets.escrow);
    }

    if ($("supplier-wallet")) {
        $("supplier-wallet").textContent = formatINR(wallets.supplier);
    }
}


/* ---------------- EVENT TIMELINE ---------------- */

function renderTimeline(events) {
    const container = $("event-timeline");

    if (!container) return;

    container.replaceChildren();

    if (!events || events.length === 0) {
        const empty = document.createElement("p");

        empty.className = "empty-state";
        empty.textContent = "No shipment events recorded yet.";

        container.appendChild(empty);
        return;
    }

    // Display the newest event first.
    [...events].reverse().forEach((event) => {
        const item = document.createElement("div");
        item.className = "timeline-item";

        const title = document.createElement("strong");
        title.className = "timeline-title";
        title.textContent =
            event.event_type || event.type || "Shipment event";

        const time = document.createElement("small");
        time.className = "timeline-time";
        time.textContent = formatDate(event.timestamp);

        item.appendChild(title);
        item.appendChild(time);

        container.appendChild(item);
    });
}


/* ---------------- LOAD DASHBOARD ---------------- */

async function loadDashboard({ silent = false } = {}) {
    if (refreshInProgress) return;

    refreshInProgress = true;

    try {
        const [ordersResult, walletsResult] = await Promise.all([
            apiRequest("/orders"),
            apiRequest("/wallets")
        ]);

        orders = collectionFrom(ordersResult, "orders");

        renderOrderSelector();
        renderStatistics();

        renderWallets(
            walletsResult.wallets || walletsResult
        );

        const order = getSelectedOrder();

        if (order) {
            // Load the latest details for the selected order.
            const detailResult = await apiRequest(
                `/orders/${encodeURIComponent(order.id)}`
            );

            const detailedOrder =
                detailResult.order || detailResult;

            if (detailedOrder?.id) {
                const index = orders.findIndex(
                    (item) => item.id === detailedOrder.id
                );

                if (index !== -1) {
                    orders[index] = detailedOrder;
                }
            }

            renderOrder(detailedOrder);

            // Load the shipment event timeline.
            const eventsResult = await apiRequest(
                `/orders/${encodeURIComponent(order.id)}/events`
            );

            renderTimeline(
                collectionFrom(eventsResult, "events")
            );

            renderStatistics();
        }

        setConnectionStatus(true);

    } catch (error) {
        setConnectionStatus(false);

        if (!silent) {
            showNotice(error.message, "error");
        }

        console.error("Dashboard loading error:", error);

    } finally {
        refreshInProgress = false;
    }
}


/* ---------------- ACTION HELPER ---------------- */

async function runAction(endpoint, options, successMessage) {
    if (actionInProgress) return null;

    actionInProgress = true;

    const buttons = document.querySelectorAll(
        "#fund-btn, #bol-btn, #ship-btn, #audit-btn, #reset-btn"
    );

    buttons.forEach((button) => {
        button.disabled = true;
    });

    try {
        const result = await apiRequest(endpoint, options);

        showNotice(
            successMessage || "Action completed.",
            "success"
        );

        await loadDashboard({ silent: true });

        return result;

    } catch (error) {
        showNotice(error.message, "error");
        console.error("Action error:", error);

        return null;

    } finally {
        actionInProgress = false;

        buttons.forEach((button) => {
            button.disabled = false;
        });
    }
}


/* ---------------- FUND ESCROW ---------------- */

async function fundEscrow() {
    const order = getSelectedOrder();

    if (!order) {
        showNotice("Please select an order first.", "error");
        return;
    }

    if (order.status !== "CREATED") {
        showNotice(
            "Only a CREATED order can be funded.",
            "error"
        );
        return;
    }

    await runAction(
        `/orders/${encodeURIComponent(order.id)}/fund`,
        { method: "POST" },
        "Escrow funding processed."
    );
}


/* ---------------- BILL OF LADING ---------------- */

async function uploadBillOfLading() {
    const order = getSelectedOrder();

    if (!order) {
        showNotice("Please select an order first.", "error");
        return;
    }

    const blNumber = window.prompt(
        "Enter the bill of lading number:",
        "BL-90817"
    );

    if (blNumber === null) return;

    if (!blNumber.trim()) {
        showNotice("The bill number cannot be empty.", "error");
        return;
    }

    const details = window.prompt(
        "Enter the shipment details:",
        order.goods || "Shipment details"
    );

    if (details === null) return;

    await runAction(
        `/orders/${encodeURIComponent(order.id)}/bill-of-lading`,
        {
            method: "POST",
            body: JSON.stringify({
                bl_number: blNumber.trim(),
                details: details.trim()
            })
        },
        "Bill of lading uploaded."
    );
}


/* ---------------- START SHIPMENT ---------------- */

async function startShipment() {
    const order = getSelectedOrder();

    if (!order) {
        showNotice("Please select an order first.", "error");
        return;
    }

    if (order.status !== "FUNDED") {
        showNotice(
            "Fund escrow before starting the shipment.",
            "error"
        );
        return;
    }

    await runAction(
        `/orders/${encodeURIComponent(order.id)}/ship`,
        { method: "POST" },
        "Shipment started."
    );
}


/* ---------------- VERIFY AUDIT ---------------- */

async function verifyAuditLog() {
    const order = getSelectedOrder();

    if (!order) {
        showNotice("Please select an order first.", "error");
        return;
    }

    try {
        const result = await apiRequest(
            `/orders/${encodeURIComponent(order.id)}/audit/verify`
        );

        if (result.valid === true) {
            showNotice(
                "Audit verified: the hash chain is valid.",
                "success"
            );
        } else {
            showNotice(
                `Audit verification FAILED. Broken record: ${
                    result.index ?? "unknown"
                }.`,
                "error"
            );
        }

    } catch (error) {
        showNotice(
            `Audit verification failed: ${error.message}`,
            "error"
        );
    }
}


/* ---------------- RESET DEMO ---------------- */

async function resetDemo() {
    const confirmed = window.confirm(
        "Reset the SealPay demo and load the demo order?"
    );

    if (!confirmed) return;

    const result = await runAction(
        "/demo/reset",
        { method: "POST" },
        "Demo reset completed."
    );

    if (result) {
        selectedOrderId = null;
        await loadDashboard({ silent: true });
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

            const target = document.querySelector(
                sectionMap[view] || `#${view}`
            );

            if (target) {
                target.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                });
            }

            document.querySelectorAll(".nav-item").forEach((item) => {
                item.classList.toggle("active", item === button);
            });
        });
    });
}


/* ---------------- CONNECT BUTTONS ---------------- */

function initializeControls() {
    $("fund-btn")?.addEventListener("click", fundEscrow);

    $("bol-btn")?.addEventListener(
        "click",
        uploadBillOfLading
    );

    $("ship-btn")?.addEventListener(
        "click",
        startShipment
    );

    $("audit-btn")?.addEventListener(
        "click",
        verifyAuditLog
    );

    $("reset-btn")?.addEventListener(
        "click",
        resetDemo
    );

    $("refresh-btn")?.addEventListener(
        "click",
        () => loadDashboard()
    );

    $("order-select")?.addEventListener("change", async (event) => {
        selectedOrderId = event.target.value;

        const order = getSelectedOrder();

        if (!order) return;

        renderOrder(order);

        try {
            const result = await apiRequest(
                `/orders/${encodeURIComponent(order.id)}/events`
            );

            renderTimeline(
                collectionFrom(result, "events")
            );

        } catch (error) {
            showNotice(
                `Could not load shipment events: ${error.message}`,
                "error"
            );
        }
    });
}


/* ---------------- START APPLICATION ---------------- */

function initializeApp() {
    initializeMap();
    initializeNavigation();
    initializeControls();

    loadDashboard();

    // Refresh data every two seconds.
    window.setInterval(() => {
        loadDashboard({ silent: true });
    }, REFRESH_INTERVAL);

    console.log("SealPay frontend initialized.");
    console.log("Backend URL:", API_BASE_URL);
}


document.addEventListener("DOMContentLoaded", initializeApp);
