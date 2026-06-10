// content.js v3 — SPA-aware page detection + interaction tracking
// Works on sites like VTOP where URL never changes

(function () {
  if (window.__pageHarvesterActive) return;
  window.__pageHarvesterActive = true;

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    pages: [],           // completed virtual pages
    currentPage: null,   // active virtual page bucket
    pageCounter: 0,
    lastNetworkBurst: 0,
    pendingBurstReqs: 0,
    burstTimer: null,
    mutationDebounce: null,
    lastHeading: "",
    lastContentHash: ""
  };

  // ── Start first virtual page ─────────────────────────────────────────────
  function startPage(reason, name = null) {
    if (state.currentPage) finalisePage();

    state.pageCounter++;
    const heading = getPageHeading();
    state.currentPage = {
      virtualPageId: state.pageCounter,
      name:          name || heading || `page-${state.pageCounter}`,
      detectedBy:    reason,
      url:           location.href,
      startTime:     Date.now(),
      endTime:       null,
      domSnapshot:   null,
      interactionLog: [],
      storageSnapshot: {}
    };
    state.lastHeading = heading;
    state.lastContentHash = getContentHash();

    // Schedule a DOM snapshot 600ms after detection (content has settled)
    setTimeout(() => {
      if (state.currentPage && state.currentPage.virtualPageId === state.pageCounter) {
        state.currentPage.domSnapshot   = captureDOMSnapshot();
        state.currentPage.storageSnapshot = captureStorage();
        // Update name from actual DOM if we had a placeholder
        if (!name) state.currentPage.name = getPageHeading() || state.currentPage.name;
      }
    }, 600);
  }

  function finalisePage() {
    if (!state.currentPage) return;
    state.currentPage.endTime = Date.now();
    state.currentPage.duration_ms = state.currentPage.endTime - state.currentPage.startTime;
    // Final snapshot if not taken yet
    if (!state.currentPage.domSnapshot) {
      state.currentPage.domSnapshot    = captureDOMSnapshot();
      state.currentPage.storageSnapshot = captureStorage();
    }
    state.pages.push(state.currentPage);
    state.currentPage = null;
  }

  // ── Page heading detector ────────────────────────────────────────────────
  function getPageHeading() {
    // Try common patterns: <h1>, page title elements, breadcrumbs, panel headers
    const selectors = [
      "h1", "h2.page-title", ".page-header h1", ".panel-title",
      ".content-header h1", "#pageTitle", ".breadcrumb li:last-child",
      ".card-title", "[class*='title'] h1", "[class*='heading']",
      // VTOP-specific
      ".studentLabel", ".tt-head", "td.menu_title"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.innerText?.trim().slice(0, 60);
        if (text && text.length > 2) return slugify(text);
      }
    }
    return "";
  }

  // ── Content hash — detects structural DOM changes ────────────────────────
  function getContentHash() {
    // Hash based on: tag names + ids + text of first 30 visible elements in main content
    const main = document.querySelector(
      "main, #main, .main-content, #content, .content, #pageContent, body"
    ) || document.body;
    const els = [...main.querySelectorAll("h1,h2,h3,table,form,.panel,.card,section")]
      .slice(0, 30)
      .map(el => `${el.tagName}|${el.id}|${(el.innerText||"").slice(0,40)}`)
      .join(";");
    return els;
  }

  function contentChangedSignificantly() {
    const hash = getContentHash();
    if (hash === state.lastContentHash) return false;
    // Measure how much changed (rough %)
    const prev = state.lastContentHash.split(";");
    const curr = hash.split(";");
    const same = curr.filter(c => prev.includes(c)).length;
    const changeRatio = 1 - (same / Math.max(prev.length, curr.length, 1));
    return changeRatio > 0.4; // >40% of elements changed = new page
  }

  // ── MutationObserver — watches for large DOM swaps ───────────────────────
  const observer = new MutationObserver((mutations) => {
    // Count significant mutations (added nodes with real content)
    let significantChanges = 0;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) { // Element node
          const size = (node.innerHTML || "").length;
          if (size > 200) significantChanges++;
        }
      }
    }
    if (significantChanges < 2) return;

    clearTimeout(state.mutationDebounce);
    state.mutationDebounce = setTimeout(() => {
      const headingChanged = getPageHeading() !== state.lastHeading;
      const contentChanged = contentChangedSignificantly();

      if (headingChanged || contentChanged) {
        notifyBackground("mutation", getPageHeading());
        startPage("dom-mutation");
      }
    }, 300);
  });

  observer.observe(document.body, {
    childList:  true,
    subtree:    true,
    attributes: false
  });

  // ── Network burst detector — intercept XHR & fetch ───────────────────────
  // XHR intercept
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    xhr.addEventListener("loadstart", onNetworkActivity);
    return xhr;
  };

  // Fetch intercept
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    onNetworkActivity();
    return origFetch.apply(this, args);
  };

  function onNetworkActivity() {
    const now = Date.now();
    // Reset burst counter if last activity was >2s ago
    if (now - state.lastNetworkBurst > 2000) state.pendingBurstReqs = 0;
    state.lastNetworkBurst = now;
    state.pendingBurstReqs++;

    clearTimeout(state.burstTimer);
    state.burstTimer = setTimeout(() => {
      if (state.pendingBurstReqs >= 3) {
        // Only trigger if DOM also changed
        if (contentChangedSignificantly()) {
          notifyBackground("network-burst", getPageHeading());
          startPage("network-burst");
        }
      }
      state.pendingBurstReqs = 0;
    }, 600);
  }

  // ── History API intercept (handles hash changes + pushState) ────────────
  const origPush    = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...a) {
    origPush(...a);
    onHistoryChange("pushState");
  };
  history.replaceState = function (...a) {
    origReplace(...a);
    onHistoryChange("replaceState");
  };
  window.addEventListener("popstate", () => onHistoryChange("popstate"));
  window.addEventListener("hashchange", () => onHistoryChange("hashchange"));

  function onHistoryChange(type) {
    setTimeout(() => {
      notifyBackground(type, getPageHeading());
      startPage(type);
    }, 400); // wait for content to render
  }

  // ── DOM Snapshot ─────────────────────────────────────────────────────────
  function captureDOMSnapshot() {
    try {
      const html = document.documentElement.outerHTML;
      const styles = [];
      for (const sheet of document.styleSheets) {
        try {
          const rules = [];
          for (const rule of sheet.cssRules) rules.push(rule.cssText);
          styles.push({ href: sheet.href, rules, inline: !sheet.href });
        } catch (e) { styles.push({ href: sheet.href, error: "CORS" }); }
      }
      const forms = [];
      for (const form of document.forms) {
        const fields = [];
        for (const el of form.elements) {
          fields.push({
            tag: el.tagName, type: el.type || null,
            name: el.name || null, id: el.id || null,
            value: el.type === "password" ? "[REDACTED]" : (el.value || null),
            options: el.tagName === "SELECT"
              ? [...el.options].map(o => ({ value: o.value, text: o.text }))
              : null,
            required: el.required || false,
            placeholder: el.placeholder || null
          });
        }
        forms.push({ id: form.id, name: form.name, action: form.action, method: form.method, fields });
      }
      const buttons = [];
      for (const btn of document.querySelectorAll(
        "button, input[type=submit], input[type=button], [role=button], a[href], select, .menu-item, [onclick]"
      )) {
        buttons.push({
          tag: btn.tagName, id: btn.id || null,
          classes: btn.className?.slice?.(0, 80) || null,
          text: btn.innerText?.trim().slice(0, 100) || null,
          href: btn.href || null, type: btn.type || null,
          selector: btn.id
            ? "#" + btn.id
            : btn.tagName.toLowerCase() + (btn.className ? "." + btn.className.trim().split(/\s+/).slice(0,3).join(".") : ""),
          onclick: btn.getAttribute("onclick")?.slice(0, 200) || null
        });
      }
      const meta = {};
      for (const m of document.querySelectorAll("meta")) {
        const k = m.name || m.property || m.httpEquiv;
        if (k) meta[k] = m.content;
      }
      return { html, styles, forms, buttons, meta, title: document.title, capturedAt: Date.now() };
    } catch (e) {
      return { error: e.message };
    }
  }

  function captureStorage() {
    const ls = {}, ss = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); } } catch(e){}
    try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); } } catch(e){}
    return { localStorage: ls, sessionStorage: ss };
  }

  // ── Interaction tracking ──────────────────────────────────────────────────
  document.addEventListener("click", (e) => {
    const el = e.target;
    const entry = {
      time: Date.now(), type: "click",
      selector: getSelector(el), tag: el.tagName,
      id: el.id || null, text: el.innerText?.trim().slice(0, 150) || null,
      href: el.href || null,
      x: e.clientX, y: e.clientY
    };
    if (state.currentPage) state.currentPage.interactionLog.push(entry);
  }, true);

  document.addEventListener("submit", (e) => {
    const form = e.target;
    const fields = {};
    for (const el of form.elements) {
      if (el.name) fields[el.name] = el.type === "password" ? "[REDACTED]" : el.value;
    }
    if (state.currentPage) state.currentPage.interactionLog.push({
      time: Date.now(), type: "form_submit",
      selector: getSelector(form), action: form.action,
      method: form.method, fields
    });
  }, true);

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!["INPUT","SELECT","TEXTAREA"].includes(el.tagName)) return;
    if (state.currentPage) state.currentPage.interactionLog.push({
      time: Date.now(), type: "input_change",
      selector: getSelector(el), name: el.name || null,
      value: el.type === "password" ? "[REDACTED]" : el.value
    });
  }, true);

  // ── Manual checkpoint (keyboard shortcut: Alt+Shift+P) ───────────────────
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.key === "P") {
      const name = prompt("📸 Mark new page — enter a name (or leave blank for auto-detect):");
      if (name === null) return; // cancelled
      notifyBackground("manual-checkpoint", name || getPageHeading());
      startPage("manual", name || null);
      showToast(`📸 Page checkpoint: "${state.currentPage?.name}"`);
    }
  });

  // ── Toast notification ────────────────────────────────────────────────────
  function showToast(msg) {
    const el = document.createElement("div");
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed", bottom: "20px", right: "20px", zIndex: "999999",
      background: "#7c3aed", color: "white", padding: "10px 18px",
      borderRadius: "8px", fontFamily: "monospace", fontSize: "13px",
      boxShadow: "0 4px 20px rgba(0,0,0,.3)", transition: "opacity .3s"
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 3000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getSelector(el) {
    if (!el || el.nodeType !== 1) return "unknown";
    if (el.id) return "#" + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift("#" + cur.id); break; }
      if (cur.className) part += "." + [...cur.classList].slice(0,2).join(".");
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  }

  function notifyBackground(reason, name) {
    try {
      chrome.runtime.sendMessage({ type: "SPA_PAGE_CHANGE", reason, name, url: location.href });
    } catch(e) {}
  }

  // ── Message handler ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_INTERACTION_MAP") {
      finalisePage(); // seal the current page before export
      sendResponse({
        virtualPages: [...state.pages],
        currentPage:  state.currentPage,
        storageSnapshot: captureStorage()
      });
      return true;
    }
    if (msg.type === "MANUAL_CHECKPOINT") {
      startPage("manual", msg.name || null);
      showToast(`📸 Checkpoint: "${state.currentPage?.name}"`);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "GET_VIRTUAL_PAGE_COUNT") {
      sendResponse({
        count: state.pages.length + (state.currentPage ? 1 : 0),
        currentName: state.currentPage?.name || null
      });
      return true;
    }
  });

  // ── Init: start the first virtual page ───────────────────────────────────
  startPage("initial-load");

})();
