
"use strict";

/* =========================================================
   CAREATLAS — HEALTHCARE WEB GIS
   Study area: Islamabad and Rawalpindi, Pakistan
   Map: Leaflet
   Data: OpenStreetMap via Overpass API
   ========================================================= */

// Approximate bounding box covering Islamabad and Rawalpindi.
const STUDY_AREA = {
  south: 33.35,
  west: 72.75,
  north: 33.95,
  east: 73.45
};

const STUDY_CENTER = [33.6844, 73.0479];

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

const CATEGORY_INFO = {
  Hospital: {
    symbol: "✚",
    css: "hospital",
    color: "#26734d"
  },
  Clinic: {
    symbol: "+",
    css: "clinic",
    color: "#3974ae"
  },
  Pharmacy: {
    symbol: "✚",
    css: "pharmacy",
    color: "#ad762b"
  },
  Doctor: {
    symbol: "●",
    css: "doctor",
    color: "#9157a0"
  },
  Dentist: {
    symbol: "✦",
    css: "dentist",
    color: "#b94e5b"
  }
};

const mapElement = document.getElementById("map");
const searchInput = document.getElementById("searchInput");
const clearSearchButton = document.getElementById("clearSearch");
const categoryFilter = document.getElementById("categoryFilter");
const facilityList = document.getElementById("facilityList");
const totalCountElement = document.getElementById("totalCount");
const visibleCountElement = document.getElementById("visibleCount");
const categoryCountElement = document.getElementById("categoryCount");
const directoryCountElement = document.getElementById("directoryCount");
const mapStatusElement = document.getElementById("mapStatus");
const refreshButton = document.getElementById("refreshBtn");
const streetButton = document.getElementById("streetBtn");
const satelliteButton = document.getElementById("satelliteBtn");
const locateButton = document.getElementById("locateBtn");
const coordinatesElement = document.getElementById("mapCoordinates");

let facilities = [];
let facilityMarkers = new Map();
let activeRequestController = null;
let requestNumber = 0;
let selectedFacilityId = null;
let lastSuccessfulFetch = null;

// ---------------------------------------------------------
// 1. INITIALISE THE LEAFLET MAP
// ---------------------------------------------------------

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true
}).setView(STUDY_CENTER, 11);

map.zoomControl.setPosition("topleft");

const streetLayer = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
  }
);

const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  }
);

streetLayer.addTo(map);

// Separate layer for healthcare markers.
const markerLayer = L.layerGroup().addTo(map);

// Show the current map centre in the bottom toolbar.
function updateCoordinates() {
  const center = map.getCenter();
  coordinatesElement.textContent =
    `${Math.abs(center.lat).toFixed(4)}° ${center.lat >= 0 ? "N" : "S"}, ` +
    `${Math.abs(center.lng).toFixed(4)}° ${center.lng >= 0 ? "E" : "W"}`;
}

map.on("moveend", updateCoordinates);
updateCoordinates();

// ---------------------------------------------------------
// 2. SMALL HELPER FUNCTIONS
// ---------------------------------------------------------

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return entities[character];
  });
}

function safeWebsite(value) {
  if (!value) return "";

  let candidate = String(value).trim();

  if (!candidate) return "";

  if (!/^https?:\/\//i.test(candidate)) {
    candidate = "https://" + candidate;
  }

  try {
    const url = new URL(candidate);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    return url.href;
  } catch {
    return "";
  }
}

function getCategory(tags = {}) {
  const amenity = (tags.amenity || "").toLowerCase();
  const healthcare = (tags.healthcare || "").toLowerCase();

  if (amenity === "hospital" || healthcare === "hospital") {
    return "Hospital";
  }

  if (amenity === "pharmacy" || healthcare === "pharmacy") {
    return "Pharmacy";
  }

  if (
    amenity === "dentist" ||
    healthcare === "dentist"
  ) {
    return "Dentist";
  }

  if (
    amenity === "doctors" ||
    healthcare === "doctor"
  ) {
    return "Doctor";
  }

  if (
    amenity === "clinic" ||
    healthcare === "clinic"
  ) {
    return "Clinic";
  }

  return "Clinic";
}

function getFacilityName(tags = {}) {
  return (
    tags.name ||
    tags["name:en"] ||
    tags.brand ||
    tags.operator ||
    `${getCategory(tags)} — unnamed facility`
  );
}

function getAddress(tags = {}) {
  const parts = [];

  const street = tags["addr:street"];
  const houseNumber = tags["addr:housenumber"];
  const neighbourhood =
    tags["addr:suburb"] ||
    tags["addr:neighbourhood"] ||
    tags["addr:quarter"];
  const city = tags["addr:city"] || tags["addr:town"];

  if (houseNumber && street) {
    parts.push(`${houseNumber} ${street}`);
  } else if (street) {
    parts.push(street);
  } else if (houseNumber) {
    parts.push(houseNumber);
  }

  if (neighbourhood) parts.push(neighbourhood);
  if (city) parts.push(city);

  return parts.length ? parts.join(", ") : "";
}

function getAreaLabel(tags = {}) {
  return (
    tags["addr:suburb"] ||
    tags["addr:neighbourhood"] ||
    tags["addr:city"] ||
    tags["addr:town"] ||
    tags["addr:district"] ||
    tags["addr:street"] ||
    tags["is_in"] ||
    "Islamabad–Rawalpindi region"
  );
}

function getPhone(tags = {}) {
  return tags.phone || tags["contact:phone"] || "";
}

function getWebsite(tags = {}) {
  return safeWebsite(
    tags.website ||
    tags["contact:website"] ||
    tags.url ||
    ""
  );
}

function getOpeningHours(tags = {}) {
  return tags.opening_hours || "";
}

function getOperator(tags = {}) {
  return tags.operator || tags.brand || "";
}

function getEmergencyInfo(tags = {}) {
  return tags.emergency || "";
}

function getCoordinates(element) {
  if (
    Number.isFinite(element.lat) &&
    Number.isFinite(element.lon)
  ) {
    return [element.lat, element.lon];
  }

  if (
    element.center &&
    Number.isFinite(element.center.lat) &&
    Number.isFinite(element.center.lon)
  ) {
    return [element.center.lat, element.center.lon];
  }

  return null;
}

// A stable ID is important for linking directory items to markers.
function getElementId(element) {
  return `${element.type || "element"}/${element.id}`;
}

function normalizeFacility(element) {
  const tags = element.tags || {};
  const coordinates = getCoordinates(element);

  if (!coordinates) return null;

  const category = getCategory(tags);
  const id = getElementId(element);

  return {
    id,
    name: getFacilityName(tags),
    category,
    lat: coordinates[0],
    lng: coordinates[1],
    area: getAreaLabel(tags),
    address: getAddress(tags),
    phone: getPhone(tags),
    website: getWebsite(tags),
    openingHours: getOpeningHours(tags),
    operator: getOperator(tags),
    emergency: getEmergencyInfo(tags),
    tags,
    marker: null
  };
}

// ---------------------------------------------------------
// 3. BUILD THE OVERPASS API QUERY
// ---------------------------------------------------------

function buildOverpassQuery() {
  const { south, west, north, east } = STUDY_AREA;
  const bbox = `${south},${west},${north},${east}`;

  return `
    [out:json][timeout:45];
    (
      nwr["amenity"~"^(hospital|clinic|pharmacy|doctors|dentist)$"](${bbox});
      nwr["healthcare"~"^(hospital|clinic|pharmacy|doctor|dentist)$"](${bbox});
    );
    out center tags;
  `;
}

// ---------------------------------------------------------
// 4. FETCH REAL DATA FROM THE API
// ---------------------------------------------------------

async function requestOverpassData(endpoint, query, signal) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: new URLSearchParams({ data: query }),
    signal
  });

  if (!response.ok) {
    throw new Error(`API responded with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("json")) {
    throw new Error("The API did not return JSON data.");
  }

  const data = await response.json();

  if (!data || !Array.isArray(data.elements)) {
    throw new Error("The API response has an unexpected format.");
  }

  return data.elements;
}

async function fetchHealthcareData() {
  // Stop an earlier request when the user refreshes the data.
  if (activeRequestController) {
    activeRequestController.abort();
  }

  const controller = new AbortController();
  activeRequestController = controller;

  const thisRequest = ++requestNumber;

  // Safety timeout for a slow or unresponsive API.
  const timeoutId = setTimeout(() => controller.abort(), 65000);

  setLoadingState(true);
  setMapStatus("Loading healthcare facilities from OpenStreetMap...");

  try {
    const query = buildOverpassQuery();
    let rawElements = null;
    let lastError = null;

    // Try the first endpoint, then the backup endpoint.
    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (controller.signal.aborted) {
        throw new Error("The request was cancelled or timed out.");
      }

      try {
        rawElements = await requestOverpassData(
          endpoint,
          query,
          controller.signal
        );
        break;
      } catch (error) {
        lastError = error;

        if (controller.signal.aborted) {
          throw error;
        }
      }
    }

    if (!rawElements) {
      throw lastError || new Error("No API endpoint responded.");
    }

    // Ignore outdated results from a previous request.
    if (thisRequest !== requestNumber) return;

    const uniqueFacilities = new Map();

    for (const element of rawElements) {
      const facility = normalizeFacility(element);

      if (facility && !uniqueFacilities.has(facility.id)) {
        uniqueFacilities.set(facility.id, facility);
      }
    }

    facilities = Array.from(uniqueFacilities.values())
      .sort((a, b) => a.name.localeCompare(b.name));

    lastSuccessfulFetch = new Date();

    selectedFacilityId = null;
    renderAllFacilities();

    if (facilities.length === 0) {
      setMapStatus(
        "The API responded, but no matching facilities were found in the study area.",
        "error"
      );
    } else {
      setMapStatus(
        `Successfully loaded ${facilities.length.toLocaleString()} mapped facilities.`,
        "success"
      );
    }
  } catch (error) {
    if (thisRequest !== requestNumber) return;

    console.error("Healthcare API error:", error);

    if (facilities.length > 0) {
      // Keep existing data if a refresh fails.
      setMapStatus(
        "Refresh failed. Showing the previously loaded data.",
        "error"
      );
      renderAllFacilities();
    } else {
      renderErrorState(
        controller.signal.aborted
          ? "The request timed out. The open-data service may be busy. Please try again."
          : "Healthcare data could not be loaded. Check your internet connection and try again."
      );

      setMapStatus("Unable to load API data.", "error");
    }
  } finally {
    clearTimeout(timeoutId);

    if (thisRequest === requestNumber) {
      setLoadingState(false);
      activeRequestController = null;
    }
  }
}

// ---------------------------------------------------------
// 5. CREATE CUSTOM HEALTHCARE MARKERS
// ---------------------------------------------------------

function createFacilityIcon(category) {
  const info = CATEGORY_INFO[category] || CATEGORY_INFO.Clinic;

  return L.divIcon({
    className: "",
    html: `
      <div class="custom-pin">
        <div class="pin-shape">
          <div class="pin-symbol ${info.css}">
            ${info.symbol}
          </div>
        </div>
      </div>
    `,
    iconSize: [34, 40],
    iconAnchor: [17, 35],
    popupAnchor: [0, -33]
  });
}

function buildPopupHTML(facility) {
  const name = escapeHTML(facility.name);
  const category = escapeHTML(facility.category);
  const area = escapeHTML(facility.area);
  const address = escapeHTML(facility.address);
  const phone = escapeHTML(facility.phone);
  const openingHours = escapeHTML(facility.openingHours);
  const operator = escapeHTML(facility.operator);
  const emergency = escapeHTML(facility.emergency);

  const website = safeWebsite(facility.website);

  let html = `
    <div class="popup-content">
      <h3 class="popup-title">${name}</h3>
      <span class="popup-category">${category}</span>
  `;

  if (address) {
    html += `<div class="popup-row"><strong>Address:</strong> ${address}</div>`;
  }

  if (area) {
    html += `<div class="popup-row"><strong>Area:</strong> ${area}</div>`;
  }

  if (phone) {
    html += `<div class="popup-row"><strong>Phone:</strong> ${phone}</div>`;
  }

  if (openingHours) {
    html += `<div class="popup-row"><strong>Hours:</strong> ${openingHours}</div>`;
  }

  if (operator) {
    html += `<div class="popup-row"><strong>Operator:</strong> ${operator}</div>`;
  }

  if (emergency) {
    html += `<div class="popup-row"><strong>Emergency:</strong> ${emergency}</div>`;
  }

  if (website) {
    html += `
      <a class="popup-link"
         href="${escapeHTML(website)}"
         target="_blank"
         rel="noopener noreferrer">Visit website ↗</a>
    `;
  }

  html += `
      <div class="popup-row">
        <strong>Coordinates:</strong>
        ${facility.lat.toFixed(5)}, ${facility.lng.toFixed(5)}
      </div>
      <div class="popup-row">
        <strong>Source:</strong> OpenStreetMap
      </div>
    </div>
  `;

  return html;
}

function createMarker(facility) {
  const marker = L.marker(
    [facility.lat, facility.lng],
    {
      icon: createFacilityIcon(facility.category),
      title: facility.name,
      alt: `${facility.category}: ${facility.name}`,
      keyboard: true
    }
  );

  marker.bindPopup(() => buildPopupHTML(facility), {
    maxWidth: 290,
    minWidth: 210
  });

  marker.on("click", () => {
    selectedFacilityId = facility.id;
    renderDirectory();
  });

  facility.marker = marker;

  return marker;
}

// ---------------------------------------------------------
// 6. SEARCH AND CATEGORY FILTERING
// ---------------------------------------------------------

function getFilteredFacilities() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const selectedCategory = categoryFilter.value;

  return facilities.filter(facility => {
    const matchesCategory =
      selectedCategory === "all" ||
      facility.category === selectedCategory;

    const searchableText = [
      facility.name,
      facility.category,
      facility.area,
      facility.address,
      facility.operator,
      facility.phone
    ].join(" ").toLowerCase();

    const matchesSearch =
      !searchTerm || searchableText.includes(searchTerm);

    return matchesCategory && matchesSearch;
  });
}

// ---------------------------------------------------------
// 7. RENDER THE MAP AND DIRECTORY
// ---------------------------------------------------------

function renderMap(filteredFacilities) {
  markerLayer.clearLayers();
  facilityMarkers.clear();

  filteredFacilities.forEach(facility => {
    const marker = createMarker(facility);

    markerLayer.addLayer(marker);
    facilityMarkers.set(facility.id, marker);
  });
}

function getFacilitySymbol(category) {
  const info = CATEGORY_INFO[category] || CATEGORY_INFO.Clinic;
  return info.symbol;
}

function renderDirectory() {
  const filteredFacilities = getFilteredFacilities();

  directoryCountElement.textContent =
    filteredFacilities.length.toLocaleString();

  visibleCountElement.textContent =
    filteredFacilities.length.toLocaleString();

  clearSearchButton.style.display =
    searchInput.value ? "block" : "none";

  if (filteredFacilities.length === 0) {
    facilityList.innerHTML = `
      <div class="list-message">
        <span style="font-size:28px;color:#b5c2b5">⌕</span>
        <p>No matching facilities found. Try another search or category.</p>
      </div>
    `;
    return;
  }

  const fragment = document.createDocumentFragment();

  filteredFacilities.forEach(facility => {
    const info =
      CATEGORY_INFO[facility.category] || CATEGORY_INFO.Clinic;

    const button = document.createElement("button");
    button.type = "button";

    button.className = "facility-card";
    button.dataset.facilityId = facility.id;

    if (facility.id === selectedFacilityId) {
      button.classList.add("selected");
    }

    button.innerHTML = `
      <span class="facility-icon ${info.css}" aria-hidden="true">
        ${getFacilitySymbol(facility.category)}
      </span>
      <span class="facility-copy">
        <span class="facility-name">${escapeHTML(facility.name)}</span>
        <span class="facility-category">${escapeHTML(facility.category)}</span>
        <span class="facility-area">${escapeHTML(facility.area)}</span>
      </span>
    `;

    button.addEventListener("click", () => {
      selectFacility(facility.id);
    });

    fragment.appendChild(button);
  });

  facilityList.replaceChildren(fragment);
}

function updateStatistics() {
  totalCountElement.textContent =
    facilities.length.toLocaleString();

  const categoriesPresent = new Set(
    facilities.map(facility => facility.category)
  );

  categoryCountElement.textContent = categoriesPresent.size;

  visibleCountElement.textContent =
    getFilteredFacilities().length.toLocaleString();
}

function renderAllFacilities() {
  const filteredFacilities = getFilteredFacilities();

  renderMap(filteredFacilities);
  renderDirectory();
  updateStatistics();
}

// ---------------------------------------------------------
// 8. SELECT A FACILITY FROM THE DIRECTORY
// ---------------------------------------------------------

function selectFacility(facilityId) {
  const facility = facilities.find(item => item.id === facilityId);

  if (!facility) return;

  selectedFacilityId = facilityId;

  const marker = facilityMarkers.get(facilityId);

  if (marker) {
    map.flyTo(
      [facility.lat, facility.lng],
      Math.max(map.getZoom(), 15),
      { duration: 0.8 }
    );

    marker.openPopup();
  }

  renderDirectory();
}

// ---------------------------------------------------------
// 9. LOADING, ERROR AND STATUS MESSAGES
// ---------------------------------------------------------

function setLoadingState(isLoading) {
  refreshButton.disabled = isLoading;
  refreshButton.style.opacity = isLoading ? "0.65" : "1";
  refreshButton.style.cursor = isLoading ? "wait" : "pointer";

  refreshButton.innerHTML = isLoading
    ? '<span aria-hidden="true">↻</span> Loading...'
    : '<span aria-hidden="true">↻</span> Refresh';
}

function setMapStatus(message, type = "") {
  mapStatusElement.className = "map-status";

  if (type) {
    mapStatusElement.classList.add(type);
  }

  mapStatusElement.replaceChildren();

  const text = document.createElement("span");
  text.textContent = message;

  mapStatusElement.appendChild(text);
}

function renderErrorState(message) {
  totalCountElement.textContent = "—";
  visibleCountElement.textContent = "—";
  directoryCountElement.textContent = "0";

  facilityList.innerHTML = `
    <div class="list-message">
      <span style="font-size:28px;color:#b94e4e">!</span>
      <p>${escapeHTML(message)}</p>
      <button id="retryButton" type="button">Try again</button>
    </div>
  `;

  document.getElementById("retryButton")
    ?.addEventListener("click", fetchHealthcareData);
}

// ---------------------------------------------------------
// 10. USER CONTROLS
// ---------------------------------------------------------

searchInput.addEventListener("input", () => {
  renderAllFacilities();
});

clearSearchButton.addEventListener("click", () => {
  searchInput.value = "";
  searchInput.focus();
  renderAllFacilities();
});

categoryFilter.addEventListener("change", () => {
  selectedFacilityId = null;
  renderAllFacilities();
});

refreshButton.addEventListener("click", fetchHealthcareData);

streetButton.addEventListener("click", () => {
  if (!map.hasLayer(streetLayer)) {
    map.removeLayer(satelliteLayer);
    streetLayer.addTo(map);
  }

  streetButton.classList.add("selected");
  satelliteButton.classList.remove("selected");
});

satelliteButton.addEventListener("click", () => {
  if (!map.hasLayer(satelliteLayer)) {
    map.removeLayer(streetLayer);
    satelliteLayer.addTo(map);
  }

  satelliteButton.classList.add("selected");
  streetButton.classList.remove("selected");
});

locateButton.addEventListener("click", () => {
  map.flyTo(STUDY_CENTER, 11, { duration: 0.8 });
});

// ---------------------------------------------------------
// 11. START THE APPLICATION
// ---------------------------------------------------------

window.addEventListener("load", () => {
  // Helps Leaflet calculate its correct size after layout.
  setTimeout(() => map.invalidateSize(), 100);
  fetchHealthcareData();
});
