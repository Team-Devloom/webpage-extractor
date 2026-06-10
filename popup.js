// popup.js — v3 (ZIP export with clean folder structure)

let currentTabId = null;
let captureData  = null;
let pollInterval = null;
let elapsedInterval = null;
let startTime    = null;
let feedItems    = [];

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;

  const pageInfo = document.getElementById("pageInfo");
  const favicon  = tab.favIconUrl
    ? `<img class="page-favicon" src="${esc(tab.favIconUrl)}">`
    : "🌐";
  pageInfo.innerHTML = `${favicon}<div class="page-title"><span>${esc((tab.title || tab.url).slice(0, 55))}</span></div>`;

  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS", tabId: currentTabId });
  if (status.active) setRecordingState(true, status.startTime);

  document.getElementById("btnStart").addEventListener("click", startRecording);
  document.getElementById("btnStop").addEventListener("click",  stopRecording);
  document.getElementById("btnExport").addEventListener("click", exportCapture);
  document.getElementById("btnClear").addEventListener("click", clearCapture);
  document.getElementById("btnCheckpoint").addEventListener("click", manualCheckpoint);
  document.getElementById("btnHelp").addEventListener("click",
    () => chrome.tabs.create({ url: chrome.runtime.getURL("help.html") }));
});

// ─── Recording ───────────────────────────────────────────────────────────────
async function startRecording() {
  const btn = document.getElementById("btnStart");
  btn.disabled = true;
  btn.textContent = "Attaching…";

  const result = await chrome.runtime.sendMessage({ type: "START_CAPTURE", tabId: currentTabId });
  if (result.error) {
    alert("Error: " + result.error);
    btn.disabled = false;
    btn.textContent = "⏺ Start Recording";
    return;
  }

  captureData = null;
  startTime   = Date.now();
  clearFeed();
  addFeedItem("▶", "START", "Recording started — navigate freely");
  setRecordingState(true, startTime);
}

async function stopRecording() {
  const btn = document.getElementById("btnStop");
  btn.disabled = true;
  btn.textContent = "Processing…";
  stopPolling(); stopElapsed();
  showProcessing("Snapshotting pages & fetching response bodies…");

  const result = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE", tabId: currentTabId });
  hideProcessing();

  if (result.error) {
    alert("Error: " + result.error);
    setRecordingState(false);
    return;
  }

  captureData = result.data;
  setRecordingState(false);
  updateStatsFromData(captureData);
  document.getElementById("btnExport").disabled = false;

  const m = captureData.manifest;
  addFeedItem("✅", "DONE",
    `${m.totalPages} pages · ${m.totalRequests} requests · ${m.totalApiCalls} API calls`);
}

// ─── ZIP Export ───────────────────────────────────────────────────────────────
async function exportCapture() {
  if (!captureData) return;

  const btn = document.getElementById("btnExport");
  btn.disabled = true;
  btn.textContent = "Building ZIP…";

  // Load JSZip from CDN via a dynamic import trick (injected script tag)
  const JSZip = await loadJSZip();
  const zip   = new JSZip();

  const m    = captureData.manifest;
  const host = (() => {
    try { return new URL(m.startUrl).hostname; } catch { return "capture"; }
  })();
  const ts   = new Date(m.capturedAt).toISOString().slice(0, 19).replace(/[T:]/g, "-");

  // Root folder name — this is what the user will upload to the portal
  const ROOT = `harvest__${host}__${ts}`;

  // ── ROOT level files ──────────────────────────────────────────────────────

  // 1. README.md — human-readable guide at the top
  zip.file(`${ROOT}/README.md`, buildReadme(captureData, host, ts));

  // 2. index.json — machine-readable manifest for the portal
  zip.file(`${ROOT}/index.json`, json({
    _description: "Page Harvester session manifest. Upload this folder to the recreation portal.",
    version:      "3.0.0",
    sessionId:    m.sessionId,
    capturedAt:   m.capturedAt,
    startUrl:     m.startUrl,
    host,
    totalPages:   m.totalPages,
    totalRequests: m.totalRequests,
    totalApiCalls: m.totalApiCalls,
    avgApiLatency_ms: m.avgApiLatency_ms,
    navigationFlow: m.navigationFlow,
    folderStructure: {
      "README.md":                "Human-readable guide",
      "index.json":               "This file — session manifest",
      "api_catalogue.json":       "All API endpoints, deduplicated across all pages",
      "cookies.json":             "All collected cookies with metadata",
      "bot_guide.json":           "LLM-ready automation guide — paste into Claude",
      "pages/NNN-page-name/":     "One sub-folder per visited page",
      "pages/.../snapshot.html":  "Full DOM snapshot, openable in browser",
      "pages/.../network.json":   "All requests with full timing (DNS/TCP/TLS/wait/receive)",
      "pages/.../dom.json":       "Forms, buttons, stylesheets, meta tags",
      "pages/.../interactions.json": "Click log, localStorage, sessionStorage"
    }
  }));

  // 3. api_catalogue.json
  zip.file(`${ROOT}/api_catalogue.json`, json({
    _description: "Every API endpoint called across the entire session, deduplicated.",
    capturedAt:   m.capturedAt,
    totalEndpoints: captureData.apiCatalogue.length,
    endpoints:    captureData.apiCatalogue
  }));

  // 4. cookies.json
  zip.file(`${ROOT}/cookies.json`, json({
    _description: "All cookies collected during the session.",
    capturedAt:   m.capturedAt,
    host,
    cookies:      captureData.cookies
  }));

  // 5. bot_guide.json
  zip.file(`${ROOT}/bot_guide.json`, json(captureData.botGuide));

  // ── pages/ sub-folders ────────────────────────────────────────────────────
  const pagesFolder = zip.folder(`${ROOT}/pages`);

  for (let i = 0; i < captureData.pages.length; i++) {
    const page   = captureData.pages[i];
    const num    = String(i + 1).padStart(3, "0");

    // Clean slug from URL path
    const slug   = urlToSlug(page.url);
    const dirName = `${num}--${slug}`;
    const dir    = pagesFolder.folder(dirName);

    // page-info.json — quick summary at the top of the folder
    dir.file("page-info.json", json({
      pageNumber:  i + 1,
      pageId:      page.pageId,
      url:         page.url,
      title:       page.title,
      visitedAt:   page.visitedAt,
      duration_ms: page.duration_ms,
      requestCount:    page.network.summary.total,
      apiCallCount:    page.network.summary.apiCalls,
      webSocketCount:  page.network.summary.webSockets,
      avgApiLatency_ms: page.network.summary.avgApiLatency_ms,
      files: {
        "snapshot.html":   "Full DOM — open in browser",
        "network.json":    "All requests + timing",
        "dom.json":        "Forms, buttons, stylesheets",
        "interactions.json": "Click log + storage"
      }
    }));

    // snapshot.html
    dir.file("snapshot.html", buildHtmlSnapshot(page));

    // network.json
    dir.file("network.json", json({
      _description: `Network capture for: ${page.url}`,
      pageNumber:   i + 1,
      url:          page.url,
      title:        page.title,
      capturedAt:   page.visitedAt,
      duration_ms:  page.duration_ms,
      summary:      page.network.summary,
      timeline:     page.network.timeline,
      webSockets:   page.network.webSockets
    }));

    // dom.json
    dir.file("dom.json", json({
      _description: `DOM structure for: ${page.url}`,
      pageNumber:   i + 1,
      url:          page.url,
      title:        page.title,
      meta:         page.dom.meta,
      forms:        page.dom.forms,
      interactiveElements: page.dom.interactiveElements,
      stylesheets:  page.dom.stylesheets
    }));

    // interactions.json
    dir.file("interactions.json", json({
      _description: `User interactions recorded on: ${page.url}`,
      pageNumber:   i + 1,
      url:          page.url,
      interactionLog: page.interactionLog,
      storage: page.storage
    }));
  }

  // ── Generate & download ZIP ───────────────────────────────────────────────
  btn.textContent = "Compressing…";
  const blob = await zip.generateAsync({
    type:               "blob",
    compression:        "DEFLATE",
    compressionOptions: { level: 6 }
  });

  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${ROOT}.zip`;
  a.click();
  URL.revokeObjectURL(url);

  const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
  const fileCount = 1 + 5 + captureData.pages.length * 5; // readme + root files + per-page files
  btn.textContent = `✅ ${fileCount} files · ${sizeMB} MB`;
  setTimeout(() => { btn.textContent = "⬇ Export ZIP"; btn.disabled = false; }, 5000);
}

// ─── Build HTML snapshot ──────────────────────────────────────────────────────
function buildHtmlSnapshot(page) {
  const banner = `
<!-- ════════════════════════════════════════════════════════════
     PAGE HARVESTER SNAPSHOT
     URL      : ${page.url}
     Title    : ${page.title}
     Captured : ${page.visitedAt}
     Requests : ${page.network.summary.total} total · ${page.network.summary.apiCalls} API calls
════════════════════════════════════════════════════════════ -->
<div id="__harvest_banner__" style="position:fixed;top:0;left:0;right:0;z-index:999999;
  background:#7c3aed;color:#fff;font:600 11px/1 'JetBrains Mono',monospace;
  padding:6px 14px;display:flex;align-items:center;gap:10px;
  box-shadow:0 2px 12px rgba(0,0,0,.4)">
  🌾&nbsp;<b>Page Harvester</b>
  &nbsp;·&nbsp;<span style="opacity:.8;font-weight:400">${esc(page.url)}</span>
  &nbsp;·&nbsp;<span style="opacity:.7;font-weight:400">${page.visitedAt}</span>
  &nbsp;·&nbsp;<span style="color:#86efac">${page.network.summary.total} requests</span>
  <button onclick="document.getElementById('__harvest_banner__').remove()"
    style="margin-left:auto;background:rgba(255,255,255,.15);border:none;color:#fff;
    cursor:pointer;padding:2px 9px;border-radius:3px;font:11px monospace">✕</button>
</div>
<style>body{margin-top:30px!important}</style>`;

  let html = page.dom.html || "<!-- No HTML captured -->";
  html = html.replace(/<body([^>]*)>/i, `<body$1>\n${banner}`);

  const inlineStyles = (page.dom.stylesheets || [])
    .filter(s => s.rules && !s.href)
    .map(s => `<style>\n${s.rules.join("\n")}\n</style>`)
    .join("\n");
  if (inlineStyles) html = html.replace(/<\/head>/i, `${inlineStyles}\n</head>`);

  return html;
}

// ─── Build README ─────────────────────────────────────────────────────────────
function buildReadme(data, host, ts) {
  const m     = data.manifest;
  const pages = data.pages
    .map((p, i) => `  ${String(i+1).padStart(3,'0')}. ${p.url}  (${p.network.summary.total} requests · ${p.duration_ms}ms)`)
    .join("\n");

  return `# 🌾 Page Harvester — Session Capture

## Session Info
- **Host:**       ${host}
- **Captured:**   ${m.capturedAt}
- **Start URL:**  ${m.startUrl}
- **Pages:**      ${m.totalPages}
- **Requests:**   ${m.totalRequests} total · ${m.totalApiCalls} API calls
- **Avg Latency:** ${m.avgApiLatency_ms ?? "n/a"} ms

## Pages Captured
${pages}

## Folder Structure
\`\`\`
${host}__${ts}/
├── README.md                ← this file
├── index.json               ← session manifest (read by the portal)
├── api_catalogue.json       ← all API endpoints, deduplicated
├── cookies.json             ← session cookies
├── bot_guide.json           ← paste into Claude to generate a bot
└── pages/
    ├── 001--page-name/
    │   ├── page-info.json   ← quick summary
    │   ├── snapshot.html    ← full DOM (open in browser)
    │   ├── network.json     ← all requests + per-phase timing
    │   ├── dom.json         ← forms, buttons, stylesheets
    │   └── interactions.json ← click log, localStorage
    ├── 002--another-page/
    │   └── ...
    └── NNN--...
\`\`\`

## How to use with the Recreation Portal
1. Upload this entire ZIP (or the extracted folder) to the portal
2. The portal reads \`index.json\` to discover all pages
3. For each page it reads \`network.json\` to replay API responses with exact timing
4. \`snapshot.html\` provides the UI shell
5. \`dom.json\` wires up forms and interactions

## How to build a bot
Paste \`bot_guide.json\` into Claude with a prompt like:
> "Here is a full capture of ${host}. Write a Playwright script that logs in and
> registers for [course]. Use the exact endpoints, headers, cookies, and POST bodies
> from this capture. Add realistic delays based on the timing data."

---
*Generated by Page Harvester v3*
`;
}

// ─── Load JSZip dynamically ───────────────────────────────────────────────────
function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) { resolve(window.JSZip); return; }
    const s = document.createElement("script");
    s.src = "jszip.min.js";
    s.onload  = () => resolve(window.JSZip);
    s.onerror = () => reject(new Error("JSZip failed to load"));
    document.head.appendChild(s);
  });
}

// ─── URL → clean folder slug ──────────────────────────────────────────────────
function urlToSlug(url) {
  try {
    const u    = new URL(url);
    const path = (u.pathname + u.search)
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "root";
    return path;
  } catch { return "page"; }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setRecordingState(isRecording, startTimeMs = null) {
  const dot      = document.getElementById("statusDot");
  const label    = document.getElementById("statusLabel");
  const btnStart = document.getElementById("btnStart");
  const btnStop  = document.getElementById("btnStop");

  if (isRecording) {
    dot.className   = "status-dot recording";
    label.className = "status-label recording";
    label.innerHTML = `Status: <span>Recording</span>`;
    btnStart.classList.add("hidden");
    btnStop.classList.remove("hidden");
    btnStop.disabled    = false;
    btnStop.textContent = "⏹ Stop & Process";
    document.getElementById("btnExport").disabled = true;
    document.getElementById("btnCheckpoint").disabled = false;
    startPolling();
    startElapsed(startTimeMs || Date.now());
  } else {
    dot.className   = "status-dot done";
    label.className = "status-label";
    label.innerHTML = `Status: <span style="color:var(--green)">Complete</span>`;
    btnStart.classList.remove("hidden");
    btnStart.disabled    = false;
    btnStart.textContent = "⏺ Start Recording";
    btnStop.classList.add("hidden");
    document.getElementById("btnCheckpoint").disabled = true;
    stopPolling(); stopElapsed();
  }
}

function startPolling() {
  pollInterval = setInterval(async () => {
    const s = await chrome.runtime.sendMessage({ type: "GET_STATUS", tabId: currentTabId });
    if (!s.active) return;
    document.getElementById("statReqs").textContent  = s.requestCount;
    document.getElementById("statPages").textContent = s.virtualPageCount || s.pageCount;
    document.getElementById("statWs").textContent    = s.wsCount;
    if (s.currentUrl) {
      document.querySelector("#pageInfo .page-title").innerHTML =
        `<span>${esc(s.currentUrl.slice(0, 55))}</span>`;
    }
  }, 800);
}

function stopPolling()  { if (pollInterval)   { clearInterval(pollInterval);   pollInterval   = null; } }
function stopElapsed()  { if (elapsedInterval){ clearInterval(elapsedInterval); elapsedInterval = null; } }

function startElapsed(from) {
  startTime = from;
  elapsedInterval = setInterval(() => {
    const s   = Math.floor((Date.now() - startTime) / 1000);
    const str = s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
    document.getElementById("statTime").textContent = str;
    document.getElementById("elapsed").textContent  = str;
  }, 1000);
}

function updateStatsFromData(data) {
  const m = data.manifest;
  document.getElementById("statReqs").textContent  = m.totalRequests;
  document.getElementById("statPages").textContent = m.totalPages;
  document.getElementById("statWs").textContent    =
    data.pages.reduce((s, p) => s + p.network.webSockets.length, 0);
}

function addFeedItem(icon, method, text) {
  const feed = document.getElementById("feed");
  if (feedItems.length === 0) feed.innerHTML = "";

  const cls     = { GET:"method-get", POST:"method-post", PUT:"method-put",
                    DELETE:"method-delete", WS:"method-ws",
                    START:"method-ws", DONE:"method-get" }[method] || "method-other";
  const elapsed = startTime ? `+${((Date.now()-startTime)/1000).toFixed(1)}s` : "";

  const item = document.createElement("div");
  item.className = "feed-item";
  item.innerHTML = `
    <span class="feed-time">${elapsed}</span>
    <span class="feed-method ${cls}">${method.slice(0,6)}</span>
    <span class="feed-url" title="${esc(text)}">${esc(text)}</span>`;

  feed.appendChild(item);
  feed.scrollTop = feed.scrollHeight;
  feedItems.push(item);
  if (feedItems.length > 60) { feedItems[0].remove(); feedItems.shift(); }
}

function clearFeed() {
  feedItems = [];
  document.getElementById("feed").innerHTML = `
    <div style="padding:8px 0;color:var(--muted);font-family:var(--mono);font-size:11px">
      Recording… navigate freely across the site.</div>`;
}

function showProcessing(text) {
  document.getElementById("controls").classList.add("hidden");
  document.getElementById("processing").classList.add("visible");
  document.getElementById("processingText").textContent = text;
}
function hideProcessing() {
  document.getElementById("processing").classList.remove("visible");
  document.getElementById("controls").classList.remove("hidden");
}

function clearCapture() {
  captureData = null;
  feedItems   = [];
  clearFeed();
  document.getElementById("btnExport").disabled = true;
  ["statReqs","statPages","statWs"].forEach(id =>
    document.getElementById(id).textContent = "0");
  document.getElementById("statTime").textContent = "—";
  document.getElementById("statusLabel").innerHTML = `Status: <span>Idle</span>`;
  document.getElementById("statusLabel").className = "status-label";
  document.getElementById("statusDot").className   = "status-dot";
  document.getElementById("elapsed").textContent   = "";
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────
function json(obj)  { return JSON.stringify(obj, null, 2); }
function esc(str)   { return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
