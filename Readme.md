# 🌾 Page Harvester

A Chrome extension that performs deep captures of any website - HTML, network requests, timing, cookies, WebSockets, and user interactions - and exports everything as a structured ZIP ready for offline analysis or site recreation.

## Installation

```bash
# 1. Download and unzip page-harvester.zip
# 2. Open Chrome → chrome://extensions/
# 3. Enable Developer Mode (top right)
# 4. Click "Load Unpacked" → select the page-harvester/ folder
# 5. Pin the 🌾 icon to your toolbar
```

> **Note:** Do not open Chrome DevTools while recording - it detaches the debugger.

## Usage

1. Navigate to and log into the target site
2. Click 🌾 → **Start Recording** (badge turns red)
3. Browse the site freely - navigate across pages, click buttons, fill forms
4. Click **Stop & Process** → **Export ZIP**

For SPA sites where the URL never changes (e.g. dashboards, portals), press **Alt+Shift+P** to manually mark a new virtual page, or let the extension auto-detect content changes.

## What Gets Captured

| Data             | Details                                                          |
| ---------------- | ---------------------------------------------------------------- |
| HTML snapshot    | Full live DOM per page with inline styles                        |
| Network requests | Every request - headers, POST body, response body, status        |
| Timing           | Per-phase breakdown: DNS, TCP, TLS, wait (TTFB), receive         |
| WebSockets       | All frames sent and received                                     |
| Cookies          | All cookies with flags (httpOnly, sameSite, etc.)                |
| Interactions     | Every click, form submit, and input change with timestamps       |
| Storage          | localStorage and sessionStorage per page                         |
| SPA pages        | Virtual page detection via DOM mutation + network burst analysis |

## Export Structure

```
harvest__example.com__2026-06-08/
├── README.md
├── index.json               # Session manifest
├── api_catalogue.json       # All API endpoints, deduplicated
├── cookies.json
├── bot_guide.json           # LLM-ready automation guide
└── pages/
    ├── 001--page-name/
    │   ├── snapshot.html    # Open in browser for visual reference
    │   ├── network.json     # Full request timeline + timing
    │   ├── dom.json         # Forms, buttons, stylesheets
    │   └── interactions.json
    └── 002--another-page/
        └── ...
```

## Privacy

All data is captured locally in your browser and exported to your machine. Nothing is sent to any server. Exported files contain session cookies and auth tokens - treat them as sensitive.

---

## AI Disclosure

This project was built with the assistance of [Claude](https://claude.ai) by Anthropic.
