// background.js — Page Harvester v2
// Multi-page recording: survives navigation by re-enabling CDP on every page load
// Folder-aware export: data structured per-page for the recreation UI

const sessions = {}; // tabId → session

// Per-asset body cap so large bundles/images don't blow up the ZIP.
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB

// ─── CDP Helper ────────────────────────────────────────────────────────────
function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// ─── Enable CDP domains (called on attach AND after every navigation) ───────
async function enableCDPDomains(tabId) {
  await cdpSend(tabId, "Network.enable", {
    maxResourceBufferSize: 10 * 1024 * 1024,
    maxTotalBufferSize: 50 * 1024 * 1024,
  });
  await cdpSend(tabId, "Page.enable");
  await cdpSend(tabId, "Runtime.enable");
  await cdpSend(tabId, "Log.enable");
}

// ─── Start Capture ──────────────────────────────────────────────────────────
async function startCapture(tabId) {
  if (sessions[tabId]) return { error: "Already capturing" };

  const tab = await chrome.tabs.get(tabId);

  sessions[tabId] = {
    tabId,
    startTime: Date.now(),
    sessionId: `session_${Date.now()}`,
    startUrl: tab.url,

    // Per-page buckets — each navigation creates a new page entry
    pages: [], // completed page snapshots
    currentPage: newPageBucket(tab.url, tab.title),

    // Global across all pages
    allCookies: {}, // deduplicated by name+domain
    consoleMessages: [],
    status: "capturing",
    reattaching: false,
  };

  await attachDebugger(tabId);
  // Snapshot the page recording STARTED on (e.g. the login page). The debugger
  // attaches after this page already loaded, so loadEventFired won't fire for
  // it — capture it now or it's lost.
  try {
    sessions[tabId].currentPage.domSnapshot = await snapshotDOM(tabId);
    if (sessions[tabId].currentPage.domSnapshot?.localStorage) {
      sessions[tabId].currentPage.localStorage =
        sessions[tabId].currentPage.domSnapshot.localStorage;
      sessions[tabId].currentPage.sessionStorage =
        sessions[tabId].currentPage.domSnapshot.sessionStorage;
    }
  } catch (e) {}
  updateBadge(tabId, "REC");
  return { success: true, sessionId: sessions[tabId].sessionId };
}

async function attachDebugger(tabId) {
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  await enableCDPDomains(tabId);
}

// ─── Page bucket factory ────────────────────────────────────────────────────
function newPageBucket(url, title = "") {
  return {
    url,
    title,
    startTime: Date.now(),
    endTime: null,
    requests: {}, // requestId → request data
    webSockets: {},
    domSnapshot: null,
    interactionLog: [],
    localStorage: {},
    sessionStorage: {},
  };
}

// ─── Snapshot current page DOM via CDP ─────────────────────────────────────
async function snapshotDOM(tabId) {
  try {
    const result = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(function() {
        // Stamp rendered sizes so the remaker's placeholders keep their box.
        document.querySelectorAll('img,video,iframe,canvas,embed,object').forEach(function(el){
          try {
            var r = el.getBoundingClientRect();
            if (r.width)  el.setAttribute('data-harvest-w', Math.round(r.width));
            if (r.height) el.setAttribute('data-harvest-h', Math.round(r.height));
          } catch(e) {}
        });
        const html = document.documentElement.outerHTML;
        const styles = [];
        for (const sheet of document.styleSheets) {
          try {
            const rules = [];
            for (const rule of sheet.cssRules) rules.push(rule.cssText);
            styles.push({ href: sheet.href, rules, inline: !sheet.href });
          } catch(e) { styles.push({ href: sheet.href, error: 'CORS' }); }
        }
        const forms = [];
        for (const form of document.forms) {
          const fields = [];
          for (const el of form.elements) {
            fields.push({
              tag: el.tagName, type: el.type || null,
              name: el.name || null, id: el.id || null,
              classes: el.className || null,
              value: el.type === 'password' ? '[REDACTED]' : (el.value || null),
              options: el.tagName === 'SELECT' ? [...el.options].map(o => ({value: o.value, text: o.text})) : null,
              required: el.required || false, disabled: el.disabled || false,
              placeholder: el.placeholder || null
            });
          }
          forms.push({ id: form.id, name: form.name, action: form.action, method: form.method, fields });
        }
        const buttons = [];
        for (const btn of document.querySelectorAll('button,input[type=submit],input[type=button],[role=button],a[href]')) {
          buttons.push({
            tag: btn.tagName, id: btn.id || null, classes: btn.className || null,
            text: btn.innerText?.trim().slice(0,100) || null,
            href: btn.href || null, type: btn.type || null,
            selector: btn.id ? '#'+btn.id : btn.tagName.toLowerCase()+(btn.className ? '.'+btn.className.trim().split(/\s+/).slice(0,3).join('.') : '')
          });
        }
        // Capture localStorage & sessionStorage
        const ls = {}, ss = {};
        try { for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);ls[k]=localStorage.getItem(k);} } catch(e){}
        try { for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);ss[k]=sessionStorage.getItem(k);} } catch(e){}

        // Meta tags
        const meta = {};
        for (const m of document.querySelectorAll('meta')) {
          const k = m.name || m.property || m.httpEquiv;
          if (k) meta[k] = m.content;
        }

        return JSON.stringify({ html, styles, forms, buttons, localStorage: ls, sessionStorage: ss, meta, title: document.title });
      })()`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Wait until loading overlays clear before snapshotting ─────────────────
async function waitForSettle(tabId, tries = 8) {
  const expr = `(function(){
    var sels=['#loading','.loading','.loader','.spinner','#pleaseWait','.blockUI','.modal-backdrop','.preloader','[aria-busy="true"]'];
    for (var i=0;i<sels.length;i++){ var el=document.querySelector(sels[i]); if(el && el.offsetParent!==null) return true; }
    var t=(document.body&&document.body.innerText||'').slice(0,400);
    return /loading\\s*\\.*\\s*please\\s*wait/i.test(t);
  })()`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await cdpSend(tabId, "Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      if (!r?.result?.value) return;
    } catch (e) {
      return;
    }
    await new Promise((res) => setTimeout(res, 400));
  }
}

// ─── Finalise current page (called before navigation or on stop) ────────────
async function finaliseCurrentPage(tabId, snapshotNow = true) {
  const session = sessions[tabId];
  if (!session?.currentPage) return;

  const page = session.currentPage;
  page.endTime = Date.now();
  page.duration_ms = page.endTime - page.startTime;

  // DOM snapshot
  if (snapshotNow) {
    page.domSnapshot = await snapshotDOM(tabId);
    if (page.domSnapshot?.localStorage) {
      page.localStorage = page.domSnapshot.localStorage;
      page.sessionStorage = page.domSnapshot.sessionStorage;
    }
  }

  // Fetch response bodies for captured resources (APIs + CSS/JS/images/fonts)
  for (const [reqId, req] of Object.entries(page.requests)) {
    if (
      req.responseReceived &&
      !req.responseBody &&
      req.canFetchBody &&
      (req.encodedDataLength || 0) < MAX_BODY_BYTES
    ) {
      try {
        const body = await cdpSend(tabId, "Network.getResponseBody", {
          requestId: reqId,
        });
        req.responseBody = body.body;
        req.responseBodyBase64 = body.base64Encoded;
      } catch (e) {
        req.responseBodyError = "unavailable";
      }
    }
  }

  // Collect cookies for this page's domain
  try {
    const url = new URL(page.url);
    const cookies = await chrome.cookies.getAll({ domain: url.hostname });
    for (const c of cookies) {
      session.allCookies[`${c.name}@${c.domain}`] = c;
    }
  } catch (e) {}

  session.pages.push(page);
  session.currentPage = null;
}

// ─── Stop Capture ───────────────────────────────────────────────────────────
async function stopCapture(tabId) {
  const session = sessions[tabId];
  if (!session) return { error: "No active session" };

  session.status = "processing";

  try {
    // Finalise the current (last) page
    await finaliseCurrentPage(tabId, true);

    // Get virtual pages + interaction log from content script
    let virtualPages = [];
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "GET_INTERACTION_MAP",
      });
      if (resp) {
        virtualPages = [...(resp.virtualPages || [])];
        if (resp.currentPage)
          virtualPages.push({ ...resp.currentPage, endTime: Date.now() });
      }
    } catch (e) {}

    // SPA mode: the content script subdivided the CURRENT (last) document into
    // virtual pages. Keep all PRIOR real navigations (e.g. the login page) and
    // only replace the last real page with its SPA sub-pages.
    if (virtualPages.length > 1) {
      const priorPages = session.pages.slice(0, -1); // login, etc.
      const lastPage = session.pages[session.pages.length - 1] || null;
      const lastRequests = Object.values(lastPage?.requests || {});
      const spaPages = virtualPages.map((vp, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === virtualPages.length - 1;
        // First sub-page inherits the document's start so early asset requests
        // (CSS/JS that loaded before the content script initialised) aren't lost.
        const startSec =
          (isFirst ? lastPage?.startTime || vp.startTime : vp.startTime) / 1000;
        const nextStart = virtualPages[idx + 1]?.startTime;
        const endSec = isLast
          ? Infinity
          : (nextStart || vp.endTime || Date.now()) / 1000;
        const vpRequests = {};
        for (const r of lastRequests) {
          if (r.wallTime >= startSec && r.wallTime < endSec)
            vpRequests[r.requestId] = r;
        }
        return {
          pageId: "spa_" + String(idx + 1).padStart(3, "0"),
          slug: slugify(vp.name || "page-" + (idx + 1)),
          url: vp.url,
          title: vp.name,
          visitedAt: new Date(vp.startTime).toISOString(),
          duration_ms: (vp.endTime || Date.now()) - vp.startTime,
          detectedBy: vp.detectedBy,
          isSPAPage: true,
          requests: vpRequests,
          webSockets: {},
          domSnapshot: vp.domSnapshot || null,
          interactionLog: vp.interactionLog || [],
          localStorage: vp.storageSnapshot?.localStorage || {},
          sessionStorage: vp.storageSnapshot?.sessionStorage || {},
        };
      });
      session.pages = [...priorPages, ...spaPages];
    } else if (session.pages.length > 0 && virtualPages[0]) {
      const last = session.pages[session.pages.length - 1];
      last.interactionLog = virtualPages[0].interactionLog || [];
      last.localStorage = virtualPages[0].storageSnapshot?.localStorage || {};
      last.sessionStorage =
        virtualPages[0].storageSnapshot?.sessionStorage || {};
    }

    // Detach debugger
    await new Promise((resolve) =>
      chrome.debugger.detach({ tabId }, () => resolve()),
    );

    const exportData = buildFullExport(session);
    delete sessions[tabId];
    updateBadge(tabId, "DONE");
    setTimeout(() => updateBadge(tabId, ""), 3000);

    return { success: true, data: exportData };
  } catch (err) {
    updateBadge(tabId, "ERR");
    return { error: err.message };
  }
}

// ─── Build Full Multi-Page Export ───────────────────────────────────────────
function buildFullExport(session) {
  const allRequests = session.pages.flatMap((p) => Object.values(p.requests));
  const allApiCalls = allRequests.filter(
    (r) => r.resourceType === "XHR" || r.resourceType === "Fetch",
  );
  const avgLatency = allApiCalls.length
    ? Math.round(
        allApiCalls.reduce((s, r) => {
          const t = r.timing || {};
          const wait =
            t.receiveHeadersEnd != null && t.sendEnd != null
              ? t.receiveHeadersEnd - t.sendEnd
              : 0;
          return s + wait;
        }, 0) / allApiCalls.length,
      )
    : null;

  // Build per-page structured data (handles URL-change pages AND SPA virtual pages)
  const pages = session.pages.map((page, idx) => {
    const pageId = page.pageId || `page_${String(idx + 1).padStart(3, "0")}`;
    const slug = page.slug || slugify(page.url);
    const title = page.title || page.domSnapshot?.title || "";
    const visitedAt =
      page.visitedAt || new Date(page.startTime || Date.now()).toISOString();

    const timeline = buildTimeline(page.requests, session.startTime);
    const apiCalls = timeline.filter(
      (r) => r.resourceType === "XHR" || r.resourceType === "Fetch",
    );
    const wsessions = Object.values(page.webSockets || {});

    // DOM: SPA pages have domSnapshot directly; URL-change pages have it nested
    const snap = page.domSnapshot || {};

    return {
      pageId,
      slug,
      isSPAPage: page.isSPAPage || false,
      detectedBy: page.detectedBy || "url-change",
      url: page.url,
      title,
      visitedAt,
      duration_ms: page.duration_ms,

      dom: {
        html: snap.html || null,
        stylesheets: snap.styles || snap.stylesheets || [],
        forms: snap.forms || [],
        interactiveElements: snap.buttons || snap.interactiveElements || [],
        meta: snap.meta || {},
      },

      network: {
        timeline,
        webSockets: wsessions,
        summary: {
          total: timeline.length,
          apiCalls: apiCalls.length,
          webSockets: wsessions.length,
          byType: timeline.reduce((a, r) => {
            a[r.resourceType] = (a[r.resourceType] || 0) + 1;
            return a;
          }, {}),
          byHost: timeline.reduce((a, r) => {
            try {
              const h = new URL(r.url).hostname;
              a[h] = (a[h] || 0) + 1;
            } catch {}
            return a;
          }, {}),
          avgApiLatency_ms: apiCalls.length
            ? Math.round(
                apiCalls.reduce((s, r) => s + (r.timing.wait || 0), 0) /
                  apiCalls.length,
              )
            : null,
        },
      },

      storage: {
        localStorage: page.localStorage || {},
        sessionStorage: page.sessionStorage || {},
      },

      interactionLog: page.interactionLog || [],
    };
  });

  // Deduplicated API endpoint catalogue across ALL pages
  const endpointMap = {};
  for (const page of pages) {
    for (const req of page.network.timeline.filter(
      (r) => r.resourceType === "XHR" || r.resourceType === "Fetch",
    )) {
      const key = `${req.method} ${req.url}`;
      if (!endpointMap[key]) {
        endpointMap[key] = {
          method: req.method,
          url: req.url,
          calls: 0,
          seenOnPages: [],
          latencies: [],
          sampleRequestHeaders: req.requestHeaders,
          sampleRequestBody: req.requestPostData,
          sampleResponseStatus: req.status,
          sampleResponseHeaders: req.responseHeaders,
          sampleResponseBody: req.responseBody?.slice(0, 3000) || null,
        };
      }
      endpointMap[key].calls++;
      endpointMap[key].seenOnPages.push(page.pageId);
      if (req.timing.wait != null)
        endpointMap[key].latencies.push(req.timing.wait);
    }
  }
  const endpoints = Object.values(endpointMap).map((e) => {
    const avg = e.latencies.length
      ? Math.round(e.latencies.reduce((a, b) => a + b, 0) / e.latencies.length)
      : null;
    const { latencies, ...rest } = e;
    return { ...rest, avgLatency_ms: avg };
  });

  // Navigation flow
  const navigationFlow = pages.map((p) => ({
    pageId: p.pageId,
    url: p.url,
    title: p.title,
    visitedAt: p.visitedAt,
    duration_ms: p.duration_ms,
  }));

  return {
    // ── index.json (root manifest) ──
    manifest: {
      version: "2.0.0",
      sessionId: session.sessionId,
      capturedAt: new Date(session.startTime).toISOString(),
      startUrl: session.startUrl,
      totalPages: pages.length,
      totalRequests: allRequests.length,
      totalApiCalls: allApiCalls.length,
      avgApiLatency_ms: avgLatency,
      navigationFlow,

      // folder layout for recreation UI
      folderStructure: {
        "index.json": "This manifest",
        "navigation_flow.json": "Full page-by-page journey with timing",
        "api_catalogue.json": "All API endpoints deduplicated across all pages",
        "cookies.json": "All cookies collected",
        "bot_guide.json": "LLM-ready automation guide",
        "pages/": "Per-page captures",
        "pages/pageNNN_slug/": "One folder per visited URL",
        "pages/.../snapshot.html": "Full DOM snapshot",
        "pages/.../network.json": "All requests for this page",
        "pages/.../dom.json": "Forms, buttons, stylesheets",
        "pages/.../interactions.json": "Clicks, form submits, storage",
      },
    },

    pages,

    // ── api_catalogue.json ──
    apiCatalogue: endpoints,

    // ── cookies.json ──
    cookies: Object.values(session.allCookies).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    })),

    // ── bot_guide.json ──
    botGuide: {
      _description:
        "Feed this file to an LLM (e.g. Claude) to generate automation/bot code.",
      sessionSummary: {
        pagesVisited: pages.length,
        totalApiCalls: allApiCalls.length,
        avgApiLatency_ms: avgLatency,
        navigationFlow,
      },
      authContext: {
        cookieNames: Object.values(session.allCookies).map((c) => c.name),
        httpOnlyCookies: Object.values(session.allCookies)
          .filter((c) => c.httpOnly)
          .map((c) => c.name),
        authHeadersFound: [
          ...new Set(
            allRequests.flatMap((r) =>
              Object.keys(r.requestHeaders || {}).filter((h) =>
                /auth|token|bearer|csrf|x-api/i.test(h),
              ),
            ),
          ),
        ],
      },
      formsAcrossAllPages: pages.flatMap((p) =>
        p.dom.forms.map((f) => ({ pageId: p.pageId, pageUrl: p.url, ...f })),
      ),
      apiEndpoints: endpoints,
      timingGuide: {
        avgApiLatency_ms: avgLatency,
        recommendation: avgLatency
          ? `Wait at least ${avgLatency + 200}ms between API calls to mimic real timing`
          : "No timing data",
        perPageTimings: pages.map((p) => ({
          pageId: p.pageId,
          url: p.url,
          loadTime_ms: p.duration_ms,
          avgApiLatency_ms: p.network.summary.avgApiLatency_ms,
        })),
      },
    },

    console: session.consoleMessages,
  };
}

// ─── Build timeline from requests map ──────────────────────────────────────
function buildTimeline(requestsMap, sessionStartTime) {
  return Object.values(requestsMap)
    .filter((r) => r.wallTime)
    .sort((a, b) => a.wallTime - b.wallTime)
    .map((r) => {
      const t = r.timing || {};
      const wait =
        t.receiveHeadersEnd != null && t.sendEnd != null
          ? Math.round(t.receiveHeadersEnd - t.sendEnd)
          : null;
      return {
        requestId: r.requestId,
        wallTime: r.wallTime,
        relativeMs: Math.round((r.wallTime - sessionStartTime / 1000) * 1000),
        url: r.url,
        method: r.method,
        resourceType: r.resourceType,
        requestHeaders: r.requestHeaders || {},
        requestPostData: r.postData || null,
        status: r.status || null,
        statusText: r.statusText || null,
        responseHeaders: r.responseHeaders || {},
        mimeType: r.mimeType || null,
        responseBody: r.responseBody || null,
        responseBodyBase64: r.responseBodyBase64 || false,
        encodedDataLength: r.encodedDataLength || 0,
        timing: {
          dns:
            t.dnsStart >= 0 && t.dnsEnd >= 0
              ? Math.round(t.dnsEnd - t.dnsStart)
              : null,
          connect:
            t.connectStart >= 0 && t.connectEnd >= 0
              ? Math.round(t.connectEnd - t.connectStart)
              : null,
          ssl:
            t.sslStart >= 0 && t.sslEnd >= 0
              ? Math.round(t.sslEnd - t.sslStart)
              : null,
          send:
            t.sendStart >= 0 && t.sendEnd >= 0
              ? Math.round(t.sendEnd - t.sendStart)
              : null,
          wait,
          total:
            t.receiveHeadersEnd != null && t.dnsStart >= 0
              ? Math.round(t.receiveHeadersEnd - t.dnsStart)
              : null,
          raw: t,
        },
        initiator: r.initiator || null,
        fromCache: r.fromCache || false,
        error: r.error || null,
      };
    });
}

// ─── CDP Event Listeners ────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const session = sessions[source.tabId];
  if (!session) return;
  const page = session.currentPage;
  const now = Date.now();

  switch (method) {
    // ─ Navigation: freeze current page, start fresh bucket ─
    case "Page.frameNavigated": {
      if (params.frame.parentId) break; // ignore iframes
      const newUrl = params.frame.url;
      if (!newUrl || newUrl === "about:blank") break;

      // Don't double-count if same URL
      if (page && page.url === newUrl) break;

      // Snapshot & archive current page (no DOM snapshot yet — page is gone)
      if (page) {
        page.endTime = now;
        page.duration_ms = now - page.startTime;
        // Fetch bodies for what we have so far
        for (const [reqId, req] of Object.entries(page.requests)) {
          if (
            req.responseReceived &&
            !req.responseBody &&
            req.canFetchBody &&
            (req.encodedDataLength || 0) < MAX_BODY_BYTES
          ) {
            try {
              const body = await cdpSend(
                source.tabId,
                "Network.getResponseBody",
                { requestId: reqId },
              );
              req.responseBody = body.body;
              req.responseBodyBase64 = body.base64Encoded;
            } catch (e) {}
          }
        }
        session.pages.push(page);
      }

      // Start new page bucket
      session.currentPage = newPageBucket(newUrl, "");
      updateBadge(source.tabId, "REC");
      break;
    }

    // ─ Page fully loaded: grab title + DOM snapshot ─
    case "Page.loadEventFired": {
      if (!session.currentPage) break;
      try {
        const tab = await chrome.tabs.get(source.tabId);
        session.currentPage.title = tab.title || "";
        // Snapshot once the page has settled (loading overlays cleared)
        setTimeout(async () => {
          if (session.currentPage) {
            await waitForSettle(source.tabId);
            session.currentPage.domSnapshot = await snapshotDOM(source.tabId);
          }
        }, 600);
      } catch (e) {}
      break;
    }

    // ─ Network ─
    case "Network.requestWillBeSent": {
      if (!page) break;
      page.requests[params.requestId] = {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        requestHeaders: params.request.headers,
        postData: params.request.postData || null,
        resourceType: params.type,
        wallTime: params.wallTime,
        timestamp: params.timestamp,
        initiator: params.initiator,
        responseReceived: false,
        canFetchBody: false,
      };
      break;
    }

    case "Network.requestWillBeSentExtraInfo": {
      if (!page) break;
      const req = page.requests[params.requestId];
      if (req) {
        req.requestHeadersExtra = params.headers;
        req.associatedCookies = params.associatedCookies;
      }
      break;
    }

    case "Network.responseReceived": {
      if (!page) break;
      const req = page.requests[params.requestId];
      if (req) {
        req.responseReceived = true;
        req.status = params.response.status;
        req.statusText = params.response.statusText;
        req.responseHeaders = params.response.headers;
        req.mimeType = params.response.mimeType;
        req.timing = params.response.timing;
        req.fromCache =
          params.response.fromDiskCache ||
          params.response.fromServiceWorker ||
          false;
        req.canFetchBody = [
          "XHR",
          "Fetch",
          "Document",
          "Stylesheet",
          "Script",
          "Image",
          "Font",
        ].includes(params.type);
        // Media (video/audio) intentionally skipped — too large; the remaker shows a placeholder.
      }
      break;
    }

    case "Network.loadingFinished": {
      if (!page) break;
      const req = page.requests[params.requestId];
      if (req) req.encodedDataLength = params.encodedDataLength;
      break;
    }

    case "Network.loadingFailed": {
      if (!page) break;
      const req = page.requests[params.requestId];
      if (req) {
        req.error = params.errorText;
        req.canceled = params.canceled;
      }
      break;
    }

    // ─ WebSockets ─
    case "Network.webSocketCreated": {
      if (!page) break;
      page.webSockets[params.requestId] = {
        requestId: params.requestId,
        url: params.url,
        initiator: params.initiator,
        createdAt: now,
        messages: [],
        closed: false,
      };
      break;
    }
    case "Network.webSocketFrameSent": {
      if (!page) break;
      const ws = page.webSockets[params.requestId];
      if (ws)
        ws.messages.push({
          direction: "sent",
          timestamp: params.timestamp,
          opcode: params.response?.opcode,
          payload: params.response?.payloadData,
        });
      break;
    }
    case "Network.webSocketFrameReceived": {
      if (!page) break;
      const ws = page.webSockets[params.requestId];
      if (ws)
        ws.messages.push({
          direction: "received",
          timestamp: params.timestamp,
          opcode: params.response?.opcode,
          payload: params.response?.payloadData,
        });
      break;
    }
    case "Network.webSocketClosed": {
      if (!page) break;
      const ws = page.webSockets[params.requestId];
      if (ws) {
        ws.closed = true;
        ws.closedAt = now;
        ws.duration_ms = now - ws.createdAt;
      }
      break;
    }

    // ─ Console ─
    case "Runtime.consoleAPICalled": {
      session.consoleMessages.push({
        type: params.type,
        timestamp: params.timestamp,
        args: params.args.map((a) => a.value || a.description || a.type),
        pageUrl: page?.url || "unknown",
      });
      break;
    }
  }
});

// Handle unexpected debugger detach (e.g. user opens DevTools)
chrome.debugger.onDetach.addListener((source, reason) => {
  const session = sessions[source.tabId];
  if (!session) return;
  // If still recording, don't kill the session — just mark debugger as detached
  // Chrome auto-detaches when DevTools opens; we can't re-attach until DevTools closes
  if (session.status === "capturing") {
    updateBadge(source.tabId, "WARN");
    // Try to re-attach after a delay
    setTimeout(async () => {
      if (!sessions[source.tabId]) return;
      try {
        await attachDebugger(source.tabId);
        updateBadge(source.tabId, "REC");
      } catch (e) {
        // DevTools still open — badge stays WARN
      }
    }, 2000);
  }
});

// ─── Utils ─────────────────────────────────────────────────────────────────
function slugify(url) {
  try {
    const u = new URL(url);
    const path = (u.hostname + u.pathname)
      .replace(/[^a-zA-Z0-9]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 40);
    return path.replace(/^_|_$/g, "") || "root";
  } catch {
    return "page";
  }
}

function updateBadge(tabId, text) {
  const colors = {
    REC: "#ef4444",
    ERR: "#f97316",
    WARN: "#eab308",
    DONE: "#22c55e",
  };
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: colors[text] || "#6b7280",
  });
}

// ─── Message Handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_CAPTURE") {
    startCapture(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "STOP_CAPTURE") {
    stopCapture(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "GET_STATUS") {
    const session = sessions[msg.tabId];
    const pageCount = session
      ? session.pages.length + (session.currentPage ? 1 : 0)
      : 0;
    const reqCount = session
      ? session.pages.reduce((s, p) => s + Object.keys(p.requests).length, 0) +
        (session.currentPage
          ? Object.keys(session.currentPage.requests).length
          : 0)
      : 0;
    const wsCount = session
      ? session.pages.reduce(
          (s, p) => s + Object.keys(p.webSockets).length,
          0,
        ) +
        (session.currentPage
          ? Object.keys(session.currentPage.webSockets).length
          : 0)
      : 0;
    // Also poll virtual page count from content script asynchronously
    chrome.tabs
      .sendMessage(msg.tabId, { type: "GET_VIRTUAL_PAGE_COUNT" })
      .then((vpResp) => {
        sendResponse({
          active: !!session,
          status: session?.status || "idle",
          pageCount,
          virtualPageCount: vpResp?.count || pageCount,
          currentVirtualPage: vpResp?.currentName || null,
          requestCount: reqCount,
          wsCount,
          startTime: session?.startTime || null,
          currentUrl: session?.currentPage?.url || null,
        });
      })
      .catch(() => {
        sendResponse({
          active: !!session,
          status: session?.status || "idle",
          pageCount,
          virtualPageCount: pageCount,
          requestCount: reqCount,
          wsCount,
          startTime: session?.startTime || null,
          currentUrl: session?.currentPage?.url || null,
        });
      });
    return true; // keep channel open for async response
    return true;
  }
});

// ─── SPA Virtual Page Change (from content script) ─────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "SPA_PAGE_CHANGE") return;
  const tabId = sender.tab?.id;
  const session = sessions[tabId];
  if (!session || session.status !== "capturing") return;

  // Mark the timestamp so we can split network requests into virtual pages
  if (!session.spaPageBoundaries) session.spaPageBoundaries = [];
  session.spaPageBoundaries.push({
    time: Date.now(),
    wallTime: Date.now() / 1000,
    reason: msg.reason,
    name: msg.name,
    url: msg.url,
  });
});
