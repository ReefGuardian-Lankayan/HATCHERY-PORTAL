/* =============================================================
   DIGITAL SIGNATURE & OWNERSHIP WATERMARK
   -------------------------------------------------------------
   Author & Original Developer: Fazree (Vibecoded)
   Project: Reef Guardian Turtle Hatchery Portal
   Repository: HATCHERY-PORTAL
   Creation Date: 2026
   Signature ID: INJ@RG-TURTLE-001-2026

   ⚠️ INTELLECTUAL PROPERTY NOTICE:
   This code and the associated nest database (nests.js) are the 
   exclusive property of the author and Reef Guardian Malaysia. 
   Unauthorized reproduction, distribution, or claiming this 
   work as original research/thesis is strictly prohibited.
   =============================================================  */

/* =============================================================
   script.js — CORE APPLICATION LOGIC
   =============================================================
   Responsibilities:
     1. Decorate raw nest data with live, date-calculated values.
     2. Render tappable nest summary cards.
     3. Handle real-time search + year + status filtering.
     4. Open / close the animated detail modal.
   Nothing in here needs to be edited by hatchery staff.

   -------------------------------------------------------------
   AUTOMATIC STATUS RULES  (the only thing staff need to know)
   -------------------------------------------------------------
   Status is calculated purely from `layDate` and `hatchedDay`:

     RULE 1 — If `hatchedDay` contains a calendar date (any
              "YYYY-MM-DD" string), the status is ALWAYS "Hatched".
              The incubation day is calculated as the difference
              between `layDate` and `hatchedDay`.

     RULE 2 — Otherwise, if incubation days are 0–50 (inclusive),
              the status is "Incubating".

     RULE 3 — Otherwise, if incubation days are 51–60 (inclusive),
              the status is "Expecting Soon".

   So management only needs to enter the `layDate`. When the
   nest hatches, they set `hatchedDay` to the actual calendar
   date it emerged (e.g. "2026-11-05") and everything else
   updates automatically.
   ============================================================= */

(function () {
  "use strict";

  /* -----------------------------------------------------------
     1. CONFIGURATION
     ----------------------------------------------------------- */

  /* --- Automatic status thresholds (in incubation days) ------ */

  /** Days 0–50 inclusive  → "Incubating"  (Rule 2) */
  var INCUBATING_MAX_DAY = 50;

  /** Days 51–60 inclusive → "Expecting Soon"  (Rule 3) */
  var EXPECTING_SOON_START_DAY = 51;

  /**
   * Day 60 is the end of the normal incubation window.
   * Used ONLY to scale the progress bar on the summary cards.
   * (A nest past day 60 without a recorded hatch date stays
   * "Expecting Soon" until staff record the actual hatch date.)
   */
  var NOMINAL_WINDOW_END_DAY = 60;

  /* --- Misc ------------------------------------------------- */

  var MS_PER_DAY = 86400000;

  var MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  /* -----------------------------------------------------------
     SPECIES LOOKUP TABLE
     -----------------------------------------------------------
     Staff enter a NUMBER in nests.js (species: 1, species: 2),
     which is translated here into the display name and the
     scientific name shown in the detail modal.

     To add a new species in the future, add another entry:

        3: { common: "Olive Ridley Turtle",
             scientific: "Lepidochelys olivacea" },

     (Be sure to update the FIELD GUIDE in nests.js too.)
     ----------------------------------------------------------- */
  var SPECIES_LOOKUP = {
    1: { common: "Green Turtle",     scientific: "Chelonia mydas" },
    2: { common: "Hawksbill Turtle", scientific: "Eretmochelys imbricata" }
  };

  /** Shown if staff enter an unrecognised species code. */
  var SPECIES_FALLBACK = { common: "Unknown species", scientific: "" };

  /* -----------------------------------------------------------
     2. DOM REFERENCES
     ----------------------------------------------------------- */

  var els = {
    grid: document.getElementById("nestGrid"),
    emptyState: document.getElementById("emptyState"),
    clearFiltersBtn: document.getElementById("clearFiltersBtn"),
    resultCount: document.getElementById("resultCount"),
    search: document.getElementById("searchInput"),
    year: document.getElementById("yearFilter"),
    status: document.getElementById("statusFilter"),
    adoption: document.getElementById("adoptionFilter"),
    // NEW PAGINATION ELEMENTS
    pagination: document.getElementById("pagination"),
    prevPageBtn: document.getElementById("prevPageBtn"),
    nextPageBtn: document.getElementById("nextPageBtn"),
    pageInfo: document.getElementById("pageInfo"),
    // MODAL ELEMENTS
    overlay: document.getElementById("modalOverlay"),
    modal: document.getElementById("nestModal"),
    modalClose: document.getElementById("modalClose"),
    modalTitle: document.getElementById("modalTitle"),
    modalBadge: document.getElementById("modalBadge"),
    modalBody: document.getElementById("modalBody"),
    footerYear: document.getElementById("footerYear")
  };

  /* -----------------------------------------------------------
     3. DATE HELPERS
     ----------------------------------------------------------- */

  /**
   * Parse a "YYYY-MM-DD" string into a LOCAL Date at midnight.
   * (Avoids the UTC-parsing pitfall of `new Date("2026-08-15")`,
   * which can shift a day backwards in western time zones.)
   */
  function parseISODate(iso) {
    var parts = String(iso).split("-");
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  /** True only if `d` is a real, valid Date object. */
  function isValidDate(d) {
    return d instanceof Date && !isNaN(d.getTime());
  }

  /**
   * Parse a raw `hatchedDay` value from nests.js.
   * Returns a valid Date object, or null if the value is
   * missing / blank / malformed.
   */
  function parseHatchDate(rawHatchedDay) {
    if (
      rawHatchedDay === null ||
      rawHatchedDay === undefined ||
      rawHatchedDay === ""
    ) {
      return null;
    }

    var parsed = parseISODate(rawHatchedDay);
    return isValidDate(parsed) ? parsed : null;
  }

  /** Today's date, normalised to local midnight. */
  function today() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  /** Whole days between two midnight-normalised dates. */
  function daysBetween(from, to) {
    return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
  }

  /** Returns a new Date offset by `n` days. */
  function addDays(date, n) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  /** "12 August 2026" */
  function formatLongDate(date) {
    return date.getDate() + " " + MONTHS[date.getMonth()] + " " + date.getFullYear();
  }

  /* -----------------------------------------------------------
     4. AUTOMATIC STATUS CALCULATION
     ----------------------------------------------------------- */

  /**
   * THE CORE STATUS ENGINE.
   *
   * Applies the three rules in strict order, so the outcome is
   * fully determined by `layDate` and `hatchedDay` alone.
   *
   * @param  {boolean} hasHatched   True if a valid hatch date exists.
   * @param  {number}  elapsedDays  Whole days since layDate.
   * @return {string} "Hatched" | "Incubating" | "Expecting Soon"
   */
  function resolveStatus(hasHatched, elapsedDays) {
    /* RULE 1 — a recorded hatch date always wins. */
    if (hasHatched) {
      return "Hatched";
    }

    /* RULE 2 — days 0 to 50 inclusive. */
    if (elapsedDays <= INCUBATING_MAX_DAY) {
      return "Incubating";
    }

    /* RULE 3 — days 51 to 60 inclusive.
       Anything beyond day 60 with no recorded hatch date stays
       "Expecting Soon" (i.e. overdue) until staff record it. */
    return "Expecting Soon";
  }

  /* -----------------------------------------------------------
     5. NEST DECORATION (live calculations)
     ----------------------------------------------------------- */

  /**
   * Add computed fields (prefixed with "_") to a raw nest object.
   * These are what the UI actually renders. Everything here is
   * recalculated from scratch on every page load, so the portal
   * updates itself each day without any manual edits.
   */
  function decorateNest(rawNest) {
    var layDate = parseISODate(rawNest.layDate);
    var elapsed = daysBetween(layDate, today());
    if (elapsed < 0) elapsed = 0;

    var hatchDate = parseHatchDate(rawNest.hatchedDay);
    var hasHatched = hatchDate !== null;
    var hatchedDayNumber = null;
    if (hasHatched) {
      hatchedDayNumber = daysBetween(layDate, hatchDate);
      if (hatchedDayNumber < 0) hatchedDayNumber = 0;
    }

    var speciesInfo = getSpeciesInfo(rawNest.species);

    // Extract the display ID (e.g., "2026-Nest #01" becomes "Nest #01")
    // If it's an old format without a year, it keeps it as is.
    var displayId = rawNest.id;
    if (rawNest.id.includes("-")) {
      displayId = rawNest.id.split("-")[1];
    }

    return {
      id: rawNest.id,                   // Keep the unique ID for the system
      displayId: displayId,             // Use this for the cards and search
      year: rawNest.year,
      species: speciesInfo.common,
      _speciesCode: rawNest.species,
      eggCount: rawNest.eggCount,
      adopter: rawNest.adopter || null,

      _layDate: layDate,
      _days: elapsed,
      _hatchDate: hatchDate,
      _hatchedDay: hatchedDayNumber,
      _status: resolveStatus(hasHatched, elapsed),
      _windowStart: addDays(layDate, EXPECTING_SOON_START_DAY),
      _windowEnd: addDays(layDate, NOMINAL_WINDOW_END_DAY)
    };
  }

  /* -----------------------------------------------------------
     6. SMALL UTILITIES
     ----------------------------------------------------------- */

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(
      /[&<>"']/g,
      function (char) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        }[char];
      }
    );
  }

  /** Lowercase and strip spaces / hashes so "Nest #1" === "nest1". */
  function normalize(str) {
    return String(str === null || str === undefined ? "" : str)
      .toLowerCase()
      .replace(/[#\s]/g, "");
  }

  function statusClass(status) {
    if (status === "Hatched") return "badge--hatched";
    if (status === "Expecting Soon") return "badge--expecting";
    return "badge--incubating";
  }

  /** "Day 42" for active nests, or "Hatched at Day 54". */
  function incubationLabel(nest) {
    if (nest._status === "Hatched") {
      var day = nest._hatchedDay !== null ? nest._hatchedDay : nest._days;
      return "Hatched at Day " + day;
    }
    return "Day " + nest._days;
  }

  /**
   * Translate a numeric species code from nests.js into the
   * full species object used by the UI.
   *
   *   1 → Green Turtle (Chelonia mydas)
   *   2 → Hawksbill Turtle (Eretmochelys imbricata)
   *
   * Anything unrecognised returns a safe fallback instead of
   * throwing, so a typo in nests.js can never break the page.
   */
  function getSpeciesInfo(code) {
    return SPECIES_LOOKUP[code] || SPECIES_FALLBACK;
  }

  /* -----------------------------------------------------------
     7. BUILD THE DATASET
     ----------------------------------------------------------- */

  var allNests = [];

    /* --- PAGINATION STATE (NEW) --- */
  var currentPage = 1;
  var itemsPerPage = 100;
  var currentFilteredNests = []; // Holds the full list of filtered items before slicing

  function buildDataset() {
    if (typeof nestsData === "undefined" || !Array.isArray(nestsData)) {
      els.grid.innerHTML =
        '<p class="empty-state is-visible">Nest data could not be loaded. ' +
        "Please check that <strong>nests.js</strong> is present.</p>";
      return;
    }

    allNests = nestsData.map(decorateNest);

    // Sort strictly by Nest Number (highest to lowest) so they are in perfect sequence
    allNests.sort(function (a, b) {
      // 1. Extract just the numbers from the IDs (e.g., "Nest #394" becomes 394)
      var numA = parseInt(a.id.replace(/\D/g, ''), 10) || 0;
      var numB = parseInt(b.id.replace(/\D/g, ''), 10) || 0;
      
      // 2. Sort descending (394 down to 01)
      return numB - numA;
    });
  }
  /** Fast lookup by nest id for modal opening. */
  function findNestById(id) {
    for (var i = 0; i < allNests.length; i++) {
      if (allNests[i].id === id) return allNests[i];
    }
    return null;
  }

  /* -----------------------------------------------------------
     8. YEAR FILTER POPULATION
     ----------------------------------------------------------- */

  function populateYearFilter() {
    var seen = {};
    var years = [];

    allNests.forEach(function (nest) {
      if (!seen[nest.year]) {
        seen[nest.year] = true;
        years.push(nest.year);
      }
    });

    years.sort(function (a, b) {
      return b - a;
    });

    // Keep the existing "All Years" option, rebuild the rest.
    els.year.innerHTML = '<option value="all">All Years</option>';

    years.forEach(function (year) {
      var option = document.createElement("option");
      option.value = String(year);
      option.textContent = String(year);
      els.year.appendChild(option);
    });
  }

  /* -----------------------------------------------------------
     9. CARD RENDERING
     ----------------------------------------------------------- */

  function cardHTML(nest) {
    var percent =
      nest._status === "Hatched"
        ? 100
        : Math.min(
            100,
            Math.round((nest._days / NOMINAL_WINDOW_END_DAY) * 100)
          );

    var adopterText = nest.adopter
      ? "Adopted by " + escapeHtml(nest.adopter)
      : "Available for adoption";

    return (
      '<article class="nest-card" ' +
      'data-nest-id="' + escapeHtml(nest.id) + '" ' +
      'data-status="' + escapeHtml(nest._status) + '" ' +
      'tabindex="0" role="button" ' +
      'aria-label="' + escapeHtml(nest.displayId) + ", " + escapeHtml(nest.species) +
      ", " + escapeHtml(nest._status) + ". Tap for details." + '">' +

        '<div class="nest-card__top">' +
          '<h3 class="nest-card__id">' + escapeHtml(nest.displayId) + "</h3>" +
          
          '<div class="nest-card__status-block">' +
            '<span class="badge ' + statusClass(nest._status) + '">' +
              escapeHtml(nest._status) +
            "</span>" +
            // Show eggs if not hatched, show turtles if hatched
            (nest._status === "Hatched" 
              ? '<div class="egg-tray hatchling-tray">' +
                  '<div class="egg-row"><span class="hatchling">🐢</span></div>' +
                '</div>'
              : '<div class="egg-tray">' +
                  '<div class="egg-row"><span class="egg"></span></div>' +
                  '<div class="egg-row"><span class="egg"></span><span class="egg"></span></div>' +
                '</div>'
            ) +
          '</div>' +
          
        "</div>" +

        // The Species text now has its own line below
        '<p class="nest-card__species">' + escapeHtml(nest.species) + "</p>" +

        '<div class="nest-card__meta">' +
          '<span class="nest-card__days">' + escapeHtml(incubationLabel(nest)) + "</span>" +
          '<span class="nest-card__sep" aria-hidden="true">•</span>' +
          "<span>" + escapeHtml(nest.eggCount) + " eggs</span>" +
        "</div>" +

        '<div class="progress" aria-hidden="true">' +
          '<span class="progress__bar" style="width:' + percent + '%"></span>' +
        "</div>" +

        '<div class="nest-card__footer">' +
          '<span class="nest-card__adopter">' + adopterText + "</span>" +
          '<span class="nest-card__hint">Tap for details ' +
            '<span aria-hidden="true">›</span></span>' +
        "</div>" +

      "</article>"
    );
  }

  function renderGrid(nests) {
    if (!nests.length) {
      els.grid.innerHTML = "";
      els.grid.hidden = true;
      els.emptyState.classList.add("is-visible");
      return;
    }

    els.grid.hidden = false;
    els.emptyState.classList.remove("is-visible");

    var html = "";
    for (var i = 0; i < nests.length; i++) {
      html += cardHTML(nests[i]);
    }
    els.grid.innerHTML = html;
  }

  function updateResultCount(start, end, total) {
    if (!total) {
      els.resultCount.textContent = "";
      return;
    }
    
    if (total === 1) {
      els.resultCount.textContent = "Showing 1 nest";
    } else {
      els.resultCount.textContent = "Showing " + start + "–" + end + " of " + total + " nests";
    }
  }

  /* -----------------------------------------------------------
     10. FILTERING
     ----------------------------------------------------------- */

  /**
   * A nest matches the query if the normalised query appears in
   * any of its searchable tokens. Extra tokens such as "nest 1"
   * make zero-padded IDs searchable as "Nest #1" or "nest 1".
   */
  function matchesQuery(nest, normalizedQuery) {
    // Use displayId (e.g. "Nest #01") instead of the full system ID
    var digits = String(nest.displayId).replace(/\D/g, ""); 
    var numeric = digits ? String(Number(digits)) : "";

    var tokens = [
      nest.displayId,                 // "Nest #01"
      digits,                         // "01"
      numeric,                        // "1"
      "nest " + numeric,              // "nest 1"
      nest.adopter || "",             
      nest.species || "",             
      String(nest.year)               
    ];

    for (var i = 0; i < tokens.length; i++) {
      if (normalize(tokens[i]).indexOf(normalizedQuery) !== -1) {
        return true;
      }
    }
    return false;
  }

  function applyFilters() {
    var query = normalize(els.search.value);
    var yearValue = els.year.value;
    var statusValue = els.status.value;
    var adoptionValue = els.adoption.value;

    currentFilteredNests = allNests.filter(function (nest) {
      if (yearValue !== "all" && String(nest.year) !== yearValue) return false;
      if (statusValue !== "all" && nest._status !== statusValue) return false;
      if (adoptionValue === "available" && nest.adopter) return false;
      if (adoptionValue === "adopted" && !nest.adopter) return false;
      if (query && !matchesQuery(nest, query)) return false;
      return true;
    });

    // NEW: Reset to page 1 whenever filters change
    currentPage = 1;
    
    // NEW: Trigger the pagination render instead of direct render
    renderPaginatedGrid();
  }

  function clearFilters() {
    els.search.value = "";
    els.year.value = "all";
    els.status.value = "all";
    els.adoption.value = "all";   // ← NEW
    applyFilters();
    els.search.focus();
  }
    /* -----------------------------------------------------------
     10b. PAGINATION LOGIC (NEW)
     ----------------------------------------------------------- */

  function renderPaginatedGrid() {
    var totalItems = currentFilteredNests.length;
    var totalPages = Math.ceil(totalItems / itemsPerPage);

    // If no items, hide grid and pagination, show empty state
    if (totalItems === 0) {
      els.grid.innerHTML = "";
      els.grid.hidden = true;
      els.emptyState.classList.add("is-visible");
      els.pagination.classList.remove("is-visible");
      updateResultCount(0, 0);
      return;
    }

    els.grid.hidden = false;
    els.emptyState.classList.remove("is-visible");

    // Calculate slice boundaries
    var startIndex = (currentPage - 1) * itemsPerPage;
    var endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    
    // Get only the 100 items for the current page
    var pageNests = currentFilteredNests.slice(startIndex, endIndex);

    // Render the 100 cards
    renderGrid(pageNests);
    
    // Update the "Showing X of Y" text
    updateResultCount(startIndex + 1, endIndex, totalItems);

    // Update pagination buttons
    if (totalPages > 1) {
      els.pagination.classList.add("is-visible");
      els.pageInfo.textContent = "Page " + currentPage + " of " + totalPages;
      
      els.prevPageBtn.disabled = (currentPage === 1);
      els.nextPageBtn.disabled = (currentPage === totalPages);
    } else {
      els.pagination.classList.remove("is-visible");
    }
  }

  function goToPage(pageNumber) {
    currentPage = pageNumber;
    renderPaginatedGrid();
    
    // Smooth scroll back to the top of the main content so the user sees the new cards
    var mainContent = document.querySelector(".main");
    if (mainContent) {
      mainContent.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* -----------------------------------------------------------
     11. DETAIL MODAL
     ----------------------------------------------------------- */

  var lastFocusedElement = null;

  function detailRow(label, valueHtml, modifier) {
    return (
      '<div class="detail-row' + (modifier ? " " + modifier : "") + '">' +
        "<dt>" + label + "</dt>" +
        "<dd>" + valueHtml + "</dd>" +
      "</div>"
    );
  }

  function buildModalBody(nest) {
    /* Translate the numeric species code stored on the raw nest
       into the full species object for display. */
    var species = getSpeciesInfo(nest._speciesCode);
    var rows = "";

    // --- Headline: days in incubation -------------------------
    rows += detailRow(
      "Days in Incubation",
      escapeHtml(incubationLabel(nest)),
      "detail-row--highlight"
    );

    // --- Identity ---------------------------------------------
    rows += detailRow("Nest ID / Number", escapeHtml(nest.id));

    var speciesHtml =
      escapeHtml(species.common) +
      (species.scientific
        ? '<span class="sci">(' + escapeHtml(species.scientific) + ")</span>"
        : "");
    rows += detailRow("Turtle Species", speciesHtml);

    // --- Dates ------------------------------------------------
    rows += detailRow(
      "Date Laid (Start of Incubation)",
      escapeHtml(formatLongDate(nest._layDate))
    );

    if (nest._status === "Hatched" && nest._hatchDate) {
      rows += detailRow(
        "Hatch Date",
        escapeHtml(formatLongDate(nest._hatchDate))
      );
      rows += detailRow(
        "Incubation Day at Hatch",
        "Day " + escapeHtml(nest._hatchedDay)
      );
    } else {
      rows += detailRow(
        "Estimated Hatch Window",
        escapeHtml(
          formatLongDate(nest._windowStart) +
            " – " +
            formatLongDate(nest._windowEnd)
        )
      );
    }

    // --- Clutch & status --------------------------------------
    rows += detailRow(
      "Total Eggs Incubated",
      escapeHtml(nest.eggCount) + " pieces"
    );

    rows += detailRow(
      "Nest Status",
      '<span class="badge ' + statusClass(nest._status) + '">' +
        escapeHtml(nest._status) +
      "</span>"
    );

    // --- Adoption ---------------------------------------------
    rows += detailRow(
      "Adopted By",
      nest.adopter
        ? "Adopted by " + escapeHtml(nest.adopter)
        : '<span class="muted">Available for Adoption</span>'
    );

    return '<dl class="detail-list">' + rows + "</dl>";
  }

  function openModal(nest) {
    lastFocusedElement = document.activeElement;

    els.modalTitle.textContent = nest.id;
    els.modalBadge.textContent = nest._status;
    els.modalBadge.className = "badge " + statusClass(nest._status);
    els.modalBody.innerHTML = buildModalBody(nest);

    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    // Focus the close button so keyboard / screen-reader users land inside.
    window.requestAnimationFrame(function () {
      els.modalClose.focus();
    });
  }

  function closeModal() {
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");

    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  }

  function isModalOpen() {
    return els.overlay.classList.contains("is-open");
  }

  /* -----------------------------------------------------------
     12. EVENT WIRING
     ----------------------------------------------------------- */

  function bindEvents() {
    // --- Live filtering ---------------------------------------
    els.search.addEventListener("input", applyFilters);
    els.year.addEventListener("change", applyFilters);
    els.status.addEventListener("change", applyFilters);
    els.adoption.addEventListener("change", applyFilters);
    els.clearFiltersBtn.addEventListener("click", clearFilters);

    // --- Pagination (NEW) -------------------------------------
    els.prevPageBtn.addEventListener("click", function () {
      if (currentPage > 1) goToPage(currentPage - 1);
    });

    els.nextPageBtn.addEventListener("click", function () {
      var totalPages = Math.ceil(currentFilteredNests.length / itemsPerPage);
      if (currentPage < totalPages) goToPage(currentPage + 1);
    });

    // ... rest of your existing card and modal event listeners below ...
    // --- Card interaction (event delegation) -------------------
    els.grid.addEventListener("click", function (event) {
      var card = event.target.closest(".nest-card");
      if (!card) return;
      var nest = findNestById(card.getAttribute("data-nest-id"));
      if (nest) openModal(nest);
    });

    els.grid.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
        return;
      }
      var card = event.target.closest(".nest-card");
      if (!card) return;
      event.preventDefault();
      var nest = findNestById(card.getAttribute("data-nest-id"));
      if (nest) openModal(nest);
    });

    // --- Modal closing ----------------------------------------
    els.modalClose.addEventListener("click", closeModal);

    // Tap outside the card to close
    els.overlay.addEventListener("click", function (event) {
      if (event.target === els.overlay) closeModal();
    });

    // Escape key
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && isModalOpen()) closeModal();
    });

    // Simple focus trap while the modal is open
    els.overlay.addEventListener("keydown", function (event) {
      if (event.key !== "Tab" || !isModalOpen()) return;

      var focusables = els.modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;

      var first = focusables[0];
      var last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  /* -----------------------------------------------------------
     13. INITIALISE
     ----------------------------------------------------------- */

  function init() {
    if (els.footerYear) {
      els.footerYear.textContent = String(new Date().getFullYear());
    }

    buildDataset();
    populateYearFilter();
    bindEvents();
    applyFilters();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  /* -----------------------------------------------------------
     14. UI INTERACTIONS (Coral Button & Scroll to Top)
     ----------------------------------------------------------- */

  // --- Coral Widget Logic ---
  var coralWidget = document.getElementById("coralWidget");
  var coralBtn = document.getElementById("coralBtn");
  
  if (coralBtn && coralWidget) {
    // 1. Open/Close when clicking the button
    coralBtn.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation(); // Stops the page from thinking we clicked elsewhere
      coralWidget.classList.toggle("is-open");
    });

    // 2. Close if clicking anywhere else on the screen
    document.addEventListener("click", function(e) {
      if (coralWidget.classList.contains("is-open")) {
        if (!coralWidget.contains(e.target)) {
          coralWidget.classList.remove("is-open");
        }
      }
    });

    // 3. Close automatically if they click the Instagram link inside the card
    var coralLink = coralWidget.querySelector('a');
    if (coralLink) {
      coralLink.addEventListener("click", function() {
        coralWidget.classList.remove("is-open");
      });
    }
  }

  // --- Scroll to Top Logic ---
  var scrollTopBtn = document.getElementById("scrollTopBtn");

  if (scrollTopBtn) {
    // Listen to scrolling to show/hide the button
    window.addEventListener("scroll", function() {
      // If user scrolls down more than 300px, show the button
      if (window.scrollY > 300) {
        scrollTopBtn.classList.add("is-visible");
      } else {
        scrollTopBtn.classList.remove("is-visible");
      }
    });

    // Scroll back to top when clicked
    scrollTopBtn.addEventListener("click", function() {
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });
  }

  /* -----------------------------------------------------------
     15. ADMIN EDITOR (GITHUB API INTEGRATION)
     ----------------------------------------------------------- */
     
  var isAdminMode = window.location.search.includes("admin=true");
  
  if (isAdminMode) {
    console.log("Admin mode activated. Loading editor...");
    
    // 1. GRAB ELEMENTS
    var adminOverlay = document.getElementById("adminOverlay");
    var floatingBtn = document.getElementById("floatingAdminBtn");
    var adminLoginView = document.getElementById("adminLoginView");
    var adminEditorView = document.getElementById("adminEditorView");
    var adminTokenInput = document.getElementById("adminTokenInput");
    var adminStatus = document.getElementById("adminStatus");
    
    var tabEditBtn = document.getElementById("tabEditBtn");
    var tabAddBtn = document.getElementById("tabAddBtn");
    var formEdit = document.getElementById("formEdit");
    var formAdd = document.getElementById("formAdd");
    var adminModalTitle = document.getElementById("adminModalTitle");

    var adminNestSelect = document.getElementById("adminNestSelect");
    var adminYearFilter = document.getElementById("adminYearFilter");
    var adminHatchDate = document.getElementById("adminHatchDate");
    var adminAdopter = document.getElementById("adminAdopter");
    
    var addNestId = document.getElementById("addNestId");
    var addSpecies = document.getElementById("addSpecies");
    var addEggCount = document.getElementById("addEggCount");
    var addLayDate = document.getElementById("addLayDate");
    var addAdopter = document.getElementById("addAdopter");
    
    var repoUrl = "https://api.github.com/repos/ReefGuardian-Lankayan/HATCHERY-PORTAL/contents/nests.js"; // UPDATE THIS LATER

    // 2. IMMEDIATELY ATTACH CLICK LISTENER TO FLOATING BUTTON
    if (floatingBtn && adminOverlay) {
      floatingBtn.style.display = "block";
      floatingBtn.addEventListener("click", function(e) {
        e.preventDefault();
        adminOverlay.classList.add("is-open");
      });
      document.getElementById("adminClose").addEventListener("click", function() {
        adminOverlay.classList.remove("is-open");
      });
    } else {
      console.error("Could not find the admin HTML elements. Check index.html.");
    }

    // 3. LOGIN LOGIC
    var savedToken = localStorage.getItem("gh_token");
    if (savedToken && adminTokenInput) {
      adminTokenInput.value = savedToken;
      showEditor();
    }

    if (document.getElementById("adminLoginBtn")) {
      document.getElementById("adminLoginBtn").addEventListener("click", function() {
        var token = adminTokenInput.value.trim();
        if (!token) return alert("Please enter a token.");
        localStorage.setItem("gh_token", token);
        showEditor();
      });
    }

      function showEditor() {
      adminLoginView.style.display = "none";
      adminEditorView.style.display = "block";
      
      // 1. Populate the Year Filter Dropdown
      var uniqueYears = [];
      allNests.forEach(function(nest) {
        if (!uniqueYears.includes(nest.year)) uniqueYears.push(nest.year);
      });
      
      // Sort years descending
      uniqueYears.sort((a, b) => b - a); 
      
      adminYearFilter.innerHTML = '<option value="all">All Years</option>';
      uniqueYears.forEach(function(yr) {
        var opt = document.createElement("option");
        opt.value = yr;
        opt.textContent = yr;
        adminYearFilter.appendChild(opt);
      });

      // 2. Trigger the nest list population
      populateAdminNestList();
    }

    // 3. New function to populate the Nest list based on the Year filter
    function populateAdminNestList() {
      var selectedYear = adminYearFilter.value;
      adminNestSelect.innerHTML = "";
      
      // Filter the nests
      var filteredNests = allNests.filter(function(nest) {
        if (selectedYear === "all") return true;
        return String(nest.year) === selectedYear;
      });
      
      // Sort strictly by numerical Nest number
      filteredNests.sort(function(a, b) {
        var numA = parseInt(a.displayId.replace(/\D/g, ''), 10) || 0;
        var numB = parseInt(b.displayId.replace(/\D/g, ''), 10) || 0;
        return numA - numB; // Ascending order (1, 2, 3...)
      });

      // Populate the dropdown
      if (filteredNests.length === 0) {
        var opt = document.createElement("option");
        opt.textContent = "No nests found for this year";
        adminNestSelect.appendChild(opt);
        adminHatchDate.value = "";
        adminAdopter.value = "";
      } else {
        filteredNests.forEach(function(nest) {
          var opt = document.createElement("option");
          opt.value = nest.id; // The hidden system ID (e.g., "2026-Nest #01")
          opt.textContent = nest.displayId; // The clean ID (e.g., "Nest #01")
          adminNestSelect.appendChild(opt);
        });
        
        // Trigger change to fill the form with the first nest
        adminNestSelect.dispatchEvent(new Event('change'));
      }
    }

    // 4a. TAB SWITCHING
    if (tabEditBtn && tabAddBtn) {
      tabEditBtn.addEventListener("click", function() {
        tabEditBtn.style.background = "var(--slate-200)"; tabEditBtn.style.color = "var(--slate-900)";
        tabAddBtn.style.background = "var(--slate-100)"; tabAddBtn.style.color = "var(--slate-500)";
        formEdit.style.display = "block"; formAdd.style.display = "none";
        adminModalTitle.textContent = "Update Nest Record";
        adminStatus.textContent = "";
      });

      tabAddBtn.addEventListener("click", function() {
        tabAddBtn.style.background = "var(--slate-200)"; tabAddBtn.style.color = "var(--slate-900)";
        tabEditBtn.style.background = "var(--slate-100)"; tabEditBtn.style.color = "var(--slate-500)";
        formAdd.style.display = "block"; formEdit.style.display = "none";
        adminModalTitle.textContent = "Add New Nest";
        adminStatus.textContent = "";
      });
    }

    // 4b. Listen for changes on the Year Filter
    if (adminYearFilter) {
      adminYearFilter.addEventListener("change", function() {
        populateAdminNestList();
      });
    }

    // 5. EDIT FORM LOGIC
    if (adminNestSelect) {
      adminNestSelect.addEventListener("change", function() {
        var nestId = this.value;
        var rawNest = nestsData.find(function(n) { return n.id === nestId; });
        if (!rawNest) return;
        
        adminHatchDate.value = rawNest.hatchedDay || "";
        adminAdopter.value = rawNest.adopter || "";
        adminStatus.textContent = "";
      });
    }

    // 6. GITHUB API PUSH HELPER
    async function pushToGitHub(newContent, commitMessage) {
      var token = localStorage.getItem("gh_token");
      if (!token) throw new Error("No token found.");
      
      var getRes = await fetch(repoUrl, { headers: { "Authorization": "token " + token } });
      if (!getRes.ok) throw new Error("Could not read file. Check token.");
      var fileData = await getRes.json();
      
      var putRes = await fetch(repoUrl, {
        method: "PUT",
        headers: { "Authorization": "token " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: commitMessage,
          content: btoa(newContent), 
          sha: fileData.sha
        })
      });
      
      if (!putRes.ok) throw new Error("Failed to save. Check token permissions.");
    }

    // 7. SAVE EDIT (UPDATE)
    if (document.getElementById("adminSaveBtn")) {
          document.getElementById("adminSaveBtn").addEventListener("click", async function() {
      // 1. Remove focus from the dropdown so the browser registers the typed data
      if (document.activeElement) {
        document.activeElement.blur();
      }
      
      // 2. Small delay to let the browser catch up
      await new Promise(r => setTimeout(r, 100));

      var nestId = adminNestSelect.value;
      // ... (the rest of your code stays exactly the same) ...
              // Force a string, trim whitespace, and ensure it's formatted
      var rawDate = adminHatchDate.value;
      var newHatch = rawDate ? rawDate.trim() : null;
        var newAdopter = adminAdopter.value.trim() || null;
        
        this.disabled = true;
        adminStatus.textContent = "Updating GitHub...";
        adminStatus.style.color = "var(--slate-700)";
        
        try {
          var getRes = await fetch(repoUrl, { headers: { "Authorization": "token " + localStorage.getItem("gh_token") } });
          var fileData = await getRes.json();
          var currentContent = atob(fileData.content); 
          
                         // Find the specific nest block
                // 1. Extract just the "Nest #01" part (ignore the year prefix for matching)
        var cleanId = nestId.includes("-") ? nestId.split("-")[1] : nestId;
        
        // 2. Make the year prefix optional in the regex: (?:\d{4}-)?
        // This ensures it matches BOTH "Nest #01" and "2026-Nest #01"
        var nestRegex = new RegExp('(id:\\s*"(?:\\d{4}-)?' + cleanId + '"[\\s\\S]*?hatchedDay:\\s*)(null|"[^"]*")([\\s\\S]*?adopter:\\s*)(null|"[^"]*")');
        
        var newContent = currentContent.replace(nestRegex, function(match, p1, p2, p3, p4) {
          // Format the new hatch date
          var hatchString = (newHatch && newHatch.trim() !== "") ? '"' + newHatch.trim() + '"' : 'null';
          
          // Format the new adopter
          var adopterString = 'null';
          if (newAdopter && newAdopter.trim() !== "") {
            var safeAdopter = newAdopter.trim().replace(/"/g, '\\"');
            adopterString = '"' + safeAdopter + '"';
          }
          
          // Return the newly formatted block
          return p1 + hatchString + p3 + adopterString;
        });
        
        // 3. Final safety check
        if (newContent === currentContent) {
          throw new Error("No changes made. (Data is identical or regex failed).");
        }
        
        var newContent = currentContent.replace(nestRegex, function(match, p1, p2, p3, p4) {
          // Format the new hatch date
          var hatchString = (newHatch && newHatch.trim() !== "") ? '"' + newHatch.trim() + '"' : 'null';
          
          // Format the new adopter (Handle empty strings, extra spaces, and quotes)
          var adopterString = 'null';
          if (newAdopter && newAdopter.trim() !== "") {
            // We escape any double quotes the user might have typed in the name
            var safeAdopter = newAdopter.trim().replace(/"/g, '\\"');
            adopterString = '"' + safeAdopter + '"';
          }
          
          return p1 + hatchString + p3 + adopterString;
        });
        
        if (newContent === currentContent) {
          console.warn("--- BLOCKED: NO CHANGES DETECTED ---");
          throw new Error("No changes made. Check console for debug info.");
        }
        console.log("--- DEBUG END: SUCCESS ---");
          
          await pushToGitHub(newContent, "Admin update: " + nestId);
          
          adminStatus.textContent = "✅ Updated! GitHub Pages is deploying. Please wait 15 seconds...";
          adminStatus.style.color = "var(--emerald-600)";
          
          setTimeout(function() { window.location.reload(); }, 15000);

        } catch (err) {
          adminStatus.textContent = "❌ Error: " + err.message;
          adminStatus.style.color = "red";
          this.disabled = false;
        }
      });
          // 7b. DELETE NEST
    if (document.getElementById("adminDeleteBtn")) {
      document.getElementById("adminDeleteBtn").addEventListener("click", async function() {
        var nestId = adminNestSelect.value;
        
        // Extract the clean ID (e.g., "Nest #01") for the confirmation message
        var cleanId = nestId.includes("-") ? nestId.split("-")[1] : nestId;
        
        // Ask for confirmation
        var confirmDelete = confirm("⚠️ WARNING: Are you sure you want to permanently DELETE " + cleanId + "?\n\nThis action cannot be undone.");
        if (!confirmDelete) return;

        this.disabled = true;
        adminStatus.textContent = "Deleting from GitHub...";
        adminStatus.style.color = "#dc2626";
        
        try {
          // 1. Fetch current file from GitHub
          var getRes = await fetch(repoUrl, { headers: { "Authorization": "token " + localStorage.getItem("gh_token") } });
          var fileData = await getRes.json();
          var currentContent = atob(fileData.content); 
          
          // 2. Regex to find the ENTIRE nest block (from opening { to closing },)
          // We look for the exact ID, capture everything until the closing brace and comma.
          var deleteRegex = new RegExp('\\s*\\{\\s*id:\\s*"' + nestId + '"[\\s\\S]*?\\},?', 'g');
          
          var newContent = currentContent.replace(deleteRegex, '');
          
          // 3. Safety check
          if (newContent === currentContent) {
            throw new Error("Could not find the nest block to delete. Regex failed.");
          }
          
          // 4. Push to GitHub
          await pushToGitHub(newContent, "Admin deleted: " + nestId);
          
          adminStatus.textContent = "✅ Deleted! GitHub is updating. Refreshing in 15 seconds...";
          adminStatus.style.color = "var(--emerald-600)";
          
          setTimeout(function() { window.location.reload(); }, 15000);

        } catch (err) {
          adminStatus.textContent = "❌ Error: " + err.message;
          adminStatus.style.color = "red";
          this.disabled = false;
        }
      });
    }
    }

     // 8. ADD NEW (CREATE)
    if (document.getElementById("adminAddBtn")) {
      document.getElementById("adminAddBtn").addEventListener("click", async function() {
        var rawId = addNestId.value.trim();
        var yearValue = document.getElementById("addYear").value.trim();
        var newSpecies = addSpecies.value;
        var newEggs = addEggCount.value;
        var newLayDate = addLayDate.value;
        var newAdopterName = addAdopter.value.trim();
        
        if (!rawId || !yearValue || !newEggs || !newLayDate) {
          return alert("Please fill in Nest ID, Year, Egg Count, and Lay Date.");
        }

        // Format the ID nicely: pad with zero if needed (e.g., "5" becomes "Nest #05")
        var paddedId = rawId.toString().padStart(2, '0');
        var finalId = yearValue + "-Nest #" + paddedId;
        
        // Check for duplicates across the entire dataset
        var isDuplicate = allNests.some(function(nest) {
          return nest.id.toLowerCase() === finalId.toLowerCase();
        });

        if (isDuplicate) {
          alert("❌ Error: " + finalId + " already exists in the database!\n\nPlease check the existing nests and try a different number or year.");
          adminStatus.textContent = "❌ Error: " + finalId + " already exists.";
          adminStatus.style.color = "red";
          return; 
        }
        
        this.disabled = true;
        adminStatus.textContent = "Publishing to GitHub...";
        adminStatus.style.color = "var(--slate-700)";
        
        try {
          var getRes = await fetch(repoUrl, { headers: { "Authorization": "token " + localStorage.getItem("gh_token") } });
          var fileData = await getRes.json();
          var currentContent = atob(fileData.content); 
          
          var adopterString = newAdopterName ? '"' + newAdopterName + '"' : 'null';
          
          // We build the new entry using the generated ID
          var newEntry = `  { id: "${finalId}", year: ${yearValue}, species: ${newSpecies}, layDate: "${newLayDate}", eggCount: ${newEggs}, hatchedDay: null, adopter: ${adopterString} },\n`;
          
          var newContent = currentContent.replace("const nestsData = [\n", "const nestsData = [\n" + newEntry);
          
          await pushToGitHub(newContent, "Admin added: " + finalId);
          
          adminStatus.textContent = "✅ Added! GitHub Pages is deploying. Please wait 15 seconds...";
          adminStatus.style.color = "var(--emerald-600)";
          
          setTimeout(function() { window.location.reload(); }, 15000);

        } catch (err) {
          adminStatus.textContent = "❌ Error: " + err.message;
          adminStatus.style.color = "red";
          this.disabled = false;
        }
      });
    }
  }

})(); // <-- This is the very last line of the file. Make sure it's there!
