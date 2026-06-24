/**
 * byelogs SDK v4.0.0 — Unified
 * "Bye logs. Hello clarity."
 * https://byelogs.dev
 * 
 * One line of code. Full product intelligence.
 * 
 * CAPTURES:
 * ─── Browser & Device ───
 * • Browser name, version, OS, viewport, pixel ratio, language, timezone
 * • Touch support, cookies, DNT, screen resolution
 * 
 * ─── Network & Performance ───
 * • Network type (4G/3G/2G), speed, RTT, data saver, online status
 * • DNS, TCP, TLS, TTFB, DOM interactive, full page load
 * • Memory pressure (used/total/limit heap)
 * • Slow resource detection
 * • Web Vitals (LCP, FID, CLS, INP, TTFB)
 * 
 * ─── User Identity ───
 * • User ID, session ID, visit count, returning/ new visitor
 * • User segments (tier, plan, region, value/impact score)
 * • Feature flags active at error time
 * • A/B experiment group
 * 
 * ─── Full User Journey ───
 * • Every page load, click, input, scroll, network request
 * • Custom breadcrumbs (developer-defined context)
 * • Console breadcrumbs (auto-captured)
 * 
 * ─── Error Detection ───
 * • Network errors (4xx, 5xx) via fetch & XHR wrapping
 * • Unhandled JS errors & promise rejections
 * • Stack traces with full frame parsing
 * 
 * ─── Sensitivity Signals ───
 * • Rage clicks (3+ clicks on same element in 2s)
 * • Dead clicks (clicked element with no handler)
 * • Silent failures (API 200 but no visible UI change)
 * • Form abandonment (started filling, left without submitting)
 * • Unfruitful clicks (same button 3x without result)
 * • Mouse exit immediately after error
 * • Scroll jitter (rapid direction changes = frustration)
 * • Composite frustration score (0-10)
 * 
 * ─── Advanced ───
 * • Pre-error request capture (last N successful requests before error)
 * • Offline queue with IndexedDB (don't lose events when offline)
 * • DOM snapshots for silent failure detection
 * • Custom context (developer-defined metadata)
 * • Pre-deploy health check
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════
  // 1. CONFIGURATION
  // ═══════════════════════════════════════════

  var scriptTag = document.currentScript;
  var scriptUrl = scriptTag ? scriptTag.src : '';
  var urlParams = new URLSearchParams((scriptUrl.split('?')[1] || ''));
  var API_KEY = urlParams.get('key') || window.BYELOGS_API_KEY || null;

  var CONFIG = {
    apiKey: API_KEY,
    endpoint: window.BYELOGS_ENDPOINT || 'https://byelogs.onrender.com/api/v1/events',
    debug: window.BYELOGS_DEBUG || false,
    ignoreUrls: window.BYELOGS_IGNORE_URLS || [],
    ignoreStatusCodes: window.BYELOGS_IGNORE_STATUS_CODES || [],
    maxJourneySteps: 100,
    sampleRate: window.BYELOGS_SAMPLE_RATE || 1.0,
    rageClickThreshold: 3,
    rageClickWindow: 2000,
    deadClickCheck: true,
    silentFailureCheck: true,
    formAbandonmentTimeout: 30000,
    unfruitfulClickThreshold: 3,
    slowRequestThreshold: 3000,
    captureWebVitals: true,
    capturePreErrorRequests: true,
    preErrorRequestCount: 5,
    offlineQueueEnabled: true,
    maxOfflineQueue: 100,
  };

  // ═══════════════════════════════════════════
  // 2. STATE
  // ═══════════════════════════════════════════

  var sessionId = generateId('sess');
  var sessionStart = Date.now();
  var journey = [];
  var currentPage = null;
  var currentPageLoadTime = null;
  var lastIntent = null;
  var manualIntent = null;
  var manualIntentExpiresAt = 0;
  var pendingRequests = {};
  var retryCounters = {};
  var clickHistory = [];
  var consoleBreadcrumbs = [];
  var customBreadcrumbsList = [];
  var initialized = false;
  var domSnapshots = {};
  var formEngagement = {};
  var clickMap = {};
  var unfruitfulClicks = {};
  var lastScrollTop = 0;
  var lastScrollDirection = null;
  var scrollDirectionChanges = 0;
  var pageCount = 0;
  var customContext = window.BYELOGS_CONTEXT || null;
  var featureFlags = {};
  var experiments = {};
  var userSegment = { tier: null, plan: null, region: null, value: null };
  var preErrorRequests = [];
  var webVitals = {};
  var dbReady = false;
  var traceId = null;

  var sessionMetrics = {
    errors: 0, rageClicks: 0, deadClicks: 0, retries: 0,
    slowRequests: 0, silentFailures: 0, abandonedForms: 0,
    unfruitfulClicks: 0, rapidPageChanges: 0, scrollJitter: 0,
    exitedAfterError: false,
  };

  // ═══════════════════════════════════════════
  // 3. INDEXEDDB OFFLINE QUEUE
  // ═══════════════════════════════════════════

  function openDB() {
    return new Promise(function (resolve) {
      if (!window.indexedDB || !CONFIG.offlineQueueEnabled) { dbReady = true; resolve(null); return; }
      try {
        var req = indexedDB.open('__byelogs_queue', 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = function (e) { dbReady = true; resolve(e.target.result); };
        req.onerror = function () { dbReady = true; resolve(null); };
      } catch (e) { dbReady = true; resolve(null); }
    });
  }

  function queueOffline(report) {
    if (!dbReady || !CONFIG.offlineQueueEnabled) return;
    openDB().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction('events', 'readwrite');
        var store = tx.objectStore('events');
        store.add({ report: report, timestamp: Date.now() });
        store.count().onsuccess = function (e) {
          if (e.target.result > CONFIG.maxOfflineQueue) store.clear();
        };
      } catch (e) {}
    }).catch(function () {});
  }

  function flushOfflineQueue() {
    if (!dbReady || !CONFIG.apiKey) return;
    openDB().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction('events', 'readwrite');
        var store = tx.objectStore('events');
        var req = store.getAll();
        req.onsuccess = function (e) {
          var events = e.target.result || [];
          events.forEach(function (ev) { sendReport(ev.report, true); });
          store.clear();
        };
      } catch (e) {}
    }).catch(function () {});
  }

  // ═══════════════════════════════════════════
  // 4. UTILITIES
  // ═══════════════════════════════════════════

  function generateId(prefix) {
    return (prefix || 'x') + '_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (e) {
      if (CONFIG.debug) console.error('[byelogs]', e.message);
      return fallback;
    }
  }

  function log() { if (CONFIG.debug) console.log.apply(console, ['[byelogs]'].concat(Array.prototype.slice.call(arguments))); }
  function warn() { if (CONFIG.debug) console.warn.apply(console, ['[byelogs]'].concat(Array.prototype.slice.call(arguments))); }

  // ─── Getters ───
  function getPageUrl() { return safe(function () { return window.location.pathname + window.location.search; }, ''); }
  function getFullUrl() { return safe(function () { return window.location.href; }, ''); }
  function getHostname() { return safe(function () { return window.location.hostname; }, ''); }
  function getReferrer() { return safe(function () { return document.referrer || null; }, null); }
  function getTitle() { return safe(function () { return document.title || null; }, null); }

  function getBrowser() {
    return safe(function () {
      var ua = navigator.userAgent;
      if (ua.indexOf('Firefox') > -1) return 'Firefox';
      if (ua.indexOf('Edg') > -1) return 'Edge';
      if (ua.indexOf('Chrome') > -1) return 'Chrome';
      if (ua.indexOf('Safari') > -1) return 'Safari';
      return 'Unknown';
    }, 'Unknown');
  }

  function getBrowserVersion() {
    return safe(function () {
      var m = navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg|Opera)\/([0-9.]+)/);
      return m ? m[2] : null;
    }, null);
  }

  function getDevice() {
    return safe(function () {
      var ua = navigator.userAgent;
      if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return 'Tablet';
      if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated/i.test(ua)) return 'Mobile';
      return 'Desktop';
    }, 'Desktop');
  }

  function getOS() {
    return safe(function () {
      var ua = navigator.userAgent;
      if (ua.indexOf('Mac') > -1) return 'macOS';
      if (ua.indexOf('Win') > -1) return 'Windows';
      if (ua.indexOf('Linux') > -1) return 'Linux';
      if (ua.indexOf('Android') > -1) return 'Android';
      if (ua.indexOf('iOS') > -1 || ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1) return 'iOS';
      return 'Unknown';
    }, 'Unknown');
  }

  function getOSVersion() {
    return safe(function () {
      var m = navigator.userAgent.match(/(Mac OS X|Windows NT|Android|iOS) ([0-9_.]+)/);
      return m ? m[2].replace(/_/g, '.') : null;
    }, null);
  }

  function getScreenResolution() { return safe(function () { return screen.width + 'x' + screen.height; }, null); }
  function getPixelRatio() { return safe(function () { return window.devicePixelRatio || 1; }, 1); }
  function getColorDepth() { return safe(function () { return screen.colorDepth; }, null); }
  function getLanguage() { return safe(function () { return navigator.language || navigator.userLanguage || null; }, null); }
  function getLanguages() { return safe(function () { return navigator.languages || []; }, []); }
  function getTimezone() { return safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }, null); }
  function getTimezoneOffset() { return safe(function () { return new Date().getTimezoneOffset(); }, null); }
  function getCookiesEnabled() { return safe(function () { return navigator.cookieEnabled; }, null); }
  function getDoNotTrack() { return safe(function () { return navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack || null; }, null); }
  function getTouchSupport() { return safe(function () { return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0); }, false); }
  function getMaxTouchPoints() { return safe(function () { return navigator.maxTouchPoints || 0; }, 0); }
  function getUserId() { return safe(function () { return window.BYELOGS_USER_ID || null; }, null); }
  function getDOMNodeCount() { return safe(function () { return document.getElementsByTagName('*').length; }, null); }

  function getRelease() {
    return safe(function () {
      return window.BYELOGS_RELEASE || (document.querySelector('meta[name="byelogs-release"]') || {}).content || (document.querySelector('meta[name="version"]') || {}).content || null;
    }, null);
  }

  function getEnvironment() {
    return safe(function () {
      return window.BYELOGS_ENVIRONMENT || (document.querySelector('meta[name="byelogs-environment"]') || {}).content || (window.location.hostname === 'localhost' ? 'development' : 'production');
    }, 'production');
  }

  function getCommitSha() {
    return safe(function () { return window.BYELOGS_COMMIT_SHA || (document.querySelector('meta[name="byelogs-commit"]') || {}).content || null; }, null);
  }

  function getNetworkQuality() {
    return safe(function () {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return { online: navigator.onLine };
      return { effectiveType: c.effectiveType || 'unknown', downlink: c.downlink, downlinkMax: c.downlinkMax, rtt: c.rtt, saveData: c.saveData || false, type: c.type || 'unknown', online: navigator.onLine };
    }, { online: navigator.onLine });
  }

  function getMemoryPressure() {
    return safe(function () {
      var m = performance.memory || {};
      var used = m.usedJSHeapSize, limit = m.jsHeapSizeLimit;
      return { usedJSHeapSize: used, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: limit, pressurePercent: used && limit ? Math.round((used / limit) * 100) : null };
    }, null);
  }

  function getPerformanceTiming() {
    return safe(function () {
      var t = performance.timing || performance.getEntriesByType('navigation')[0];
      if (!t) return null;
      return { dnsTime: t.domainLookupEnd - t.domainLookupStart || 0, tcpTime: t.connectEnd - t.connectStart || 0, tlsTime: t.secureConnectionStart ? (t.connectEnd - t.secureConnectionStart) : 0, requestTime: t.responseStart - t.requestStart || 0, responseTime: t.responseEnd - t.responseStart || 0, domInteractive: t.domInteractive - t.navigationStart || 0, domComplete: t.domComplete - t.navigationStart || 0, fullLoadTime: t.loadEventEnd - t.navigationStart || 0 };
    }, null);
  }

  function getPageLoadTime() {
    return safe(function () { var t = performance.timing; return t ? (t.domContentLoadedEventEnd - t.navigationStart) : null; }, null);
  }

  function getSlowResources() {
    return safe(function () {
      return performance.getEntriesByType('resource').filter(function (r) { return r.duration > 100; }).sort(function (a, b) { return b.duration - a.duration; }).slice(0, 10).map(function (r) { return { name: r.name, type: r.initiatorType, duration: Math.round(r.duration), size: r.transferSize || 0 }; });
    }, []);
  }

  function shouldIgnoreUrl(url) {
    if (!url) return false;
    return CONFIG.ignoreUrls.some(function (p) { return typeof p === 'string' ? url.indexOf(p) > -1 : p instanceof RegExp ? p.test(url) : false; });
  }

  function shouldIgnoreStatusCode(code) { return CONFIG.ignoreStatusCodes.indexOf(code) > -1; }

  function getFormContext(el) {
    return safe(function () { var f = el.closest('form'); return f ? (f.getAttribute('name') || f.getAttribute('id') || f.getAttribute('aria-label') || null) : null; }, null);
  }

  function getElementText(el) {
    if (!el) return null;
    var t = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '').trim();
    return t ? (t.length > 200 ? t.substring(0, 197) + '...' : t) : null;
  }

  function getElementIdentifier(el) { return el.id || el.getAttribute('name') || getElementText(el) || el.tagName; }
  function shouldSample() { return Math.random() <= CONFIG.sampleRate; }

  // ═══════════════════════════════════════════
  // 5. VISITOR TRACKING
  // ═══════════════════════════════════════════

  function getVisitorInfo() {
    return safe(function () {
      try {
        var key = '__byelogs_visitor', data = localStorage.getItem(key), now = Date.now();
        var visitor = data ? JSON.parse(data) : { firstVisit: now, visitCount: 0 };
        visitor.visitCount++; visitor.lastVisit = visitor.lastVisit || now;
        localStorage.setItem(key, JSON.stringify({ firstVisit: visitor.firstVisit, visitCount: visitor.visitCount, lastVisit: now }));
        return { isReturningUser: visitor.visitCount > 1, visitCount: visitor.visitCount, firstVisit: new Date(visitor.firstVisit).toISOString(), lastVisit: new Date(visitor.lastVisit).toISOString() };
      } catch (e) { return null; }
    }, null);
  }

  // ═══════════════════════════════════════════
  // 6. WEB VITALS
  // ═══════════════════════════════════════════

  function captureWebVitals() {
    if (!CONFIG.captureWebVitals) return;
    try {
      // LCP
      var lcpObserver = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        if (entries.length > 0) webVitals.LCP = Math.round(entries[entries.length - 1].startTime);
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

      // FID / INP
      var fidObserver = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          webVitals.FID = Math.round(entry.processingStart - entry.startTime);
        });
      });
      fidObserver.observe({ type: 'first-input', buffered: true });

      // CLS
      var clsValue = 0;
      var clsObserver = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) { if (!entry.hadRecentInput) { clsValue += entry.value; webVitals.CLS = Math.round(clsValue * 1000) / 1000; } });
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });

      // TTFB
      var navEntry = performance.getEntriesByType('navigation')[0];
      if (navEntry) webVitals.TTFB = Math.round(navEntry.responseStart);

      // INP (Interaction to Next Paint) — newer replacement for FID
      var inpObserver = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) { webVitals.INP = Math.round(entry.duration); });
      });
      inpObserver.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch (e) {}
  }

  // ═══════════════════════════════════════════
  // 7. DOM SNAPSHOT
  // ═══════════════════════════════════════════

  function captureDOMSnapshot() {
    return { bodyLength: document.body.innerHTML.length, visibleButtons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length, visibleToasts: document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="alert"], [class*="snackbar"], [class*="message"]').length, formCount: document.querySelectorAll('form').length, timestamp: Date.now() };
  }

  function detectDOMChange(before, after) {
    if (!before || !after) return false;
    return before.bodyLength !== after.bodyLength || before.visibleButtons !== after.visibleButtons || before.visibleToasts !== after.visibleToasts || before.formCount !== after.formCount;
  }

  // ═══════════════════════════════════════════
  // 8. SENSITIVITY DETECTORS
  // ═══════════════════════════════════════════

  function detectRageClick(element) {
    var key = getElementIdentifier(element), now = Date.now();
    if (!clickMap[key]) clickMap[key] = [];
    clickMap[key].push(now);
    clickMap[key] = clickMap[key].filter(function (t) { return now - t < CONFIG.rageClickWindow; });
    if (clickMap[key].length >= CONFIG.rageClickThreshold) { clickMap[key] = []; sessionMetrics.rageClicks++; return { type: 'rage_click', element: key, clickCount: CONFIG.rageClickThreshold, windowMs: CONFIG.rageClickWindow, severity: 'high', timestamp: now }; }
    return null;
  }

  function detectDeadClick(element) {
    if (!CONFIG.deadClickCheck) return null;
    var interactive = element.tagName === 'A' || element.tagName === 'BUTTON' || element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA' || element.hasAttribute('onclick') || element.hasAttribute('role') || element.getAttribute('tabindex') !== null || element.getAttribute('href');
    if (!interactive) { sessionMetrics.deadClicks++; return { type: 'dead_click', element: element.tagName, text: getElementText(element), className: element.className?.toString() || null, timestamp: Date.now() }; }
    return null;
  }

  function detectUnfruitfulClicks(element) {
    var key = getElementIdentifier(element);
    unfruitfulClicks[key] = (unfruitfulClicks[key] || 0) + 1;
    if (unfruitfulClicks[key] >= CONFIG.unfruitfulClickThreshold) { unfruitfulClicks[key] = 0; sessionMetrics.unfruitfulClicks++; return { type: 'unfruitful_clicks', element: key, count: CONFIG.unfruitfulClickThreshold, message: 'User clicked "' + key + '" ' + CONFIG.unfruitfulClickThreshold + ' times without result', timestamp: Date.now() }; }
    return null;
  }

  function detectSilentFailure(requestData, responseData) {
    if (!CONFIG.silentFailureCheck || requestData.method === 'GET') return null;
    var after = captureDOMSnapshot(), before = domSnapshots[requestData.requestId];
    if (before && !detectDOMChange(before, after)) { sessionMetrics.silentFailures++; return { type: 'silent_failure', message: 'API returned ' + responseData.statusCode + ' but no visible UI change', method: requestData.method, url: requestData.url, statusCode: responseData.statusCode, timestamp: Date.now() }; }
    return null;
  }

  function detectFormAbandonment(formId) {
    var eng = formEngagement[formId]; if (!eng) return null;
    if (Date.now() - eng.lastActivity > CONFIG.formAbandonmentTimeout && eng.fieldsTouched > 0 && !eng.submitted) { sessionMetrics.abandonedForms++; delete formEngagement[formId]; return { type: 'form_abandonment', formId: formId, timeSpent: Date.now() - eng.started, fieldsTouched: eng.fieldsTouched, fieldsCompleted: eng.fieldsCompleted, completionRate: Math.round((eng.fieldsCompleted / Math.max(eng.fieldsTouched, 1)) * 100), timestamp: Date.now() }; }
    return null;
  }

  // ═══════════════════════════════════════════
  // 9. JOURNEY RECORDER
  // ═══════════════════════════════════════════

  var STEP_TYPES = {
    PAGE_LOAD: 'page_load', CLICK: 'click', INPUT: 'input', SCROLL: 'scroll',
    REQUEST_START: 'request_start', REQUEST_COMPLETE: 'request_complete',
    REQUEST_ERROR: 'request_error', MOUSE_EXIT: 'mouse_exit',
    RAGE_CLICK: 'rage_click', DEAD_CLICK: 'dead_click',
    SILENT_FAILURE: 'silent_failure', FORM_ABANDONMENT: 'form_abandonment',
    UNFRUITFUL_CLICKS: 'unfruitful_clicks', CUSTOM_BREADCRUMB: 'custom_breadcrumb',
    SESSION_END: 'session_end',
  };

  function recordStep(type, data) {
    if (journey.length >= CONFIG.maxJourneySteps) journey.shift();
    var step = { id: generateId('step'), type: type, timestamp: Date.now(), timeSinceStart: Date.now() - sessionStart, pageUrl: getPageUrl() };
    for (var k in data) { if (data.hasOwnProperty(k)) step[k] = data[k]; }
    journey.push(step);
    return step;
  }

  // ═══════════════════════════════════════════
  // 10. PAGE TRACKING
  // ═══════════════════════════════════════════

  function trackPageLoad() {
    pageCount++; currentPage = getPageUrl(); currentPageLoadTime = Date.now();
    recordStep(STEP_TYPES.PAGE_LOAD, { pageUrl: currentPage, fullUrl: getFullUrl(), referrer: getReferrer(), title: getTitle(), loadTimeMs: getPageLoadTime() });
    for (var fid in formEngagement) { var a = detectFormAbandonment(fid); if (a) recordStep(STEP_TYPES.FORM_ABANDONMENT, a); }
  }

  function trackPageChanges() {
    var ops = history.pushState; history.pushState = function () { ops.apply(this, arguments); safe(trackPageLoad); };
    var ors = history.replaceState; history.replaceState = function () { ors.apply(this, arguments); safe(trackPageLoad); };
    window.addEventListener('popstate', function () { safe(trackPageLoad); });
  }

  // ═══════════════════════════════════════════
  // 11. CLICK TRACKING
  // ═══════════════════════════════════════════

  function trackClicks() {
    document.addEventListener('click', function (event) {
      safe(function () {
        var el = event.target;
        var target = el;
        if (!target.matches('button, a, input, [role="button"], [role="link"], [onclick]'))
          target = target.closest('button, a, input, [role="button"], [role="link"], [onclick]') || target;
        var cd = { text: getElementText(target), tag: target.tagName, id: target.id || null, ariaLabel: target.getAttribute('aria-label') || null, href: target.getAttribute('href') || null, formId: getFormContext(target), position: { x: event.clientX, y: event.clientY }, viewport: { width: window.innerWidth, height: window.innerHeight } };
        var rc = detectRageClick(target); if (rc) { cd.rageClick = true; recordStep(STEP_TYPES.RAGE_CLICK, rc); }
        var dc = detectDeadClick(target); if (dc) { cd.deadClick = true; recordStep(STEP_TYPES.DEAD_CLICK, dc); }
        var uc = detectUnfruitfulClicks(target); if (uc) recordStep(STEP_TYPES.UNFRUITFUL_CLICKS, uc);
        lastIntent = { text: cd.text, type: cd.tag, ariaLabel: cd.ariaLabel, formId: cd.formId, timestamp: Date.now() };
        recordStep(STEP_TYPES.CLICK, cd);
      });
    }, true);
  }

  // ═══════════════════════════════════════════
  // 12. FORM TRACKING
  // ═══════════════════════════════════════════

  function trackForms() {
    document.addEventListener('focusin', function (e) { safe(function () { var el = e.target; if (!el.matches('input, textarea, select')) return; var fid = getFormContext(el); if (!fid) return; if (!formEngagement[fid]) formEngagement[fid] = { started: Date.now(), lastActivity: Date.now(), fieldsTouched: 0, fieldsCompleted: 0, submitted: false }; formEngagement[fid].lastActivity = Date.now(); }); }, true);
    document.addEventListener('change', function (e) { safe(function () { var el = e.target; if (!el.matches('input, textarea, select')) return; var fid = getFormContext(el); if (!fid || !formEngagement[fid]) return; formEngagement[fid].fieldsCompleted++; formEngagement[fid].lastActivity = Date.now(); }); }, true);
    document.addEventListener('input', function (e) { safe(function () { var el = e.target; if (!el.matches('input, textarea, select')) return; var fid = getFormContext(el); if (!fid || !formEngagement[fid]) return; formEngagement[fid].fieldsTouched++; formEngagement[fid].lastActivity = Date.now(); var id = { fieldName: el.getAttribute('name') || el.getAttribute('id') || null, fieldType: el.type || el.tagName, autofilled: el.matches(':-webkit-autofill'), hasValue: !!el.value, valueLength: el.value ? el.value.length : 0, formId: fid }; var li = journey.filter(function (s) { return s.type === STEP_TYPES.INPUT; }); var last = li[li.length - 1]; if (!last || last.fieldName !== id.fieldName || Date.now() - last.timestamp > 2000) recordStep(STEP_TYPES.INPUT, id); }); }, true);
    document.addEventListener('submit', function (e) { safe(function () { var fid = getFormContext(e.target); if (fid && formEngagement[fid]) { formEngagement[fid].submitted = true; formEngagement[fid].lastActivity = Date.now(); } }); }, true);
  }

  // ═══════════════════════════════════════════
  // 13. SCROLL TRACKING
  // ═══════════════════════════════════════════

  function trackScroll() {
    var maxDepth = 0, timer = null;
    window.addEventListener('scroll', function () { safe(function () { var st = window.scrollY || window.pageYOffset; var dir = st > lastScrollTop ? 'down' : 'up'; if (lastScrollDirection && lastScrollDirection !== dir) { scrollDirectionChanges++; if (scrollDirectionChanges > 5) sessionMetrics.scrollJitter = 1; } lastScrollDirection = dir; lastScrollTop = st; clearTimeout(timer); timer = setTimeout(function () { var dh = (document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight; var depth = dh > 0 ? Math.round((st / dh) * 100) : 0; if (depth > maxDepth + 10) { maxDepth = depth; recordStep(STEP_TYPES.SCROLL, { depthPercent: depth, scrollTop: st }); } }, 300); }); }, { passive: true });
  }

  // ═══════════════════════════════════════════
  // 14. MOUSE EXIT
  // ═══════════════════════════════════════════

  function trackMouseExit() {
    document.addEventListener('mouseleave', function (e) { safe(function () { if (e.clientY <= 0 || e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) { var ls = journey[journey.length - 1]; var ae = ls && (ls.type === STEP_TYPES.REQUEST_ERROR) && Date.now() - ls.timestamp < 5000; if (ae) sessionMetrics.exitedAfterError = true; recordStep(STEP_TYPES.MOUSE_EXIT, { exitedAfterError: !!ae, timeOnPage: Date.now() - currentPageLoadTime }); } }); });
  }

  // ═══════════════════════════════════════════
  // 15. CONSOLE BREADCRUMBS
  // ═══════════════════════════════════════════

  function captureConsole() {
    ['log', 'warn', 'error', 'info', 'debug'].forEach(function (lv) { var orig = console[lv]; console[lv] = function () { var args = Array.prototype.slice.call(arguments); consoleBreadcrumbs.push({ level: lv, message: args.map(function (a) { try { if (typeof a === 'string') return a.substring(0, 200); if (a instanceof Error) return a.message; return JSON.stringify(a).substring(0, 200); } catch (e) { return '[Object]'; } }).join(' '), timestamp: Date.now() }); if (consoleBreadcrumbs.length > 50) consoleBreadcrumbs.shift(); orig.apply(console, args); }; });
  }

  // ═══════════════════════════════════════════
  // 16. UNHANDLED ERRORS
  // ═══════════════════════════════════════════

  function captureUnhandledErrors() {
    window.addEventListener('error', function (e) { safe(function () { var err = e.error || e; sessionMetrics.errors++; sendReport(buildReport({ errorType: 'unhandled_error', message: err.message || e.message || 'Unknown error', stackTrace: captureStackTrace(err), sourceFile: e.filename, lineNumber: e.lineno, columnNumber: e.colno })); }); });
    window.addEventListener('unhandledrejection', function (e) { safe(function () { var err = e.reason; sessionMetrics.errors++; sendReport(buildReport({ errorType: 'unhandled_rejection', message: (err && err.message) || String(err), stackTrace: captureStackTrace(err) })); }); });
  }

  function captureStackTrace(error) {
    if (!error || !error.stack) return null;
    var frames = error.stack.split('\n').map(function (line) { var m = line.trim().match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/); if (m) return { function: m[1], file: m[2], line: parseInt(m[3]), column: parseInt(m[4]) }; var sm = line.trim().match(/at\s+(.+?):(\d+):(\d+)/); if (sm) return { function: '<anonymous>', file: sm[1], line: parseInt(sm[2]), column: parseInt(sm[3]) }; return { raw: line }; });
    return { raw: error.stack, frames: frames, message: error.message, name: error.name };
  }

  // ═══════════════════════════════════════════
  // 17. NETWORK WRAPPING
  // ═══════════════════════════════════════════

  function wrapFetch() {
    if (typeof window.fetch === 'undefined') return;
    var orig = window.fetch;
    window.fetch = function (input, init) { init = init || {}; var url = typeof input === 'string' ? input : (input.url || ''); var method = (init.method || 'GET').toUpperCase(); var rid = generateId('req'), st = Date.now(); recordStep(STEP_TYPES.REQUEST_START, { requestId: rid, method: method, url: url }); pendingRequests[rid] = { url: url, method: method, startTime: st }; if (method !== 'GET' && CONFIG.silentFailureCheck) domSnapshots[rid] = captureDOMSnapshot(); return orig.call(this, input, init).then(function (res) { var dur = Date.now() - st; delete pendingRequests[rid]; if (res.status >= 400) processError(rid, url, method, res.status, res.statusText, dur); else { recordStep(STEP_TYPES.REQUEST_COMPLETE, { requestId: rid, method: method, url: url, statusCode: res.status, duration: dur, slow: dur > CONFIG.slowRequestThreshold }); if (dur > CONFIG.slowRequestThreshold) sessionMetrics.slowRequests++; if (CONFIG.capturePreErrorRequests) { preErrorRequests.push({ method: method, url: url, statusCode: res.status, duration: dur, timestamp: Date.now() }); if (preErrorRequests.length > CONFIG.preErrorRequestCount) preErrorRequests.shift(); } if (method !== 'GET') { var sf = detectSilentFailure({ requestId: rid, method: method, url: url }, { statusCode: res.status }); if (sf) { recordStep(STEP_TYPES.SILENT_FAILURE, sf); sendReport(buildReport({ errorType: 'silent_failure', message: sf.message, method: method, url: url, statusCode: res.status })); } } } delete domSnapshots[rid]; return res; }).catch(function (err) { var dur = Date.now() - st; delete pendingRequests[rid]; delete domSnapshots[rid]; processNetworkErr(rid, url, method, err, dur); throw err; }); };
  }

  function wrapXHR() {
    if (typeof window.XMLHttpRequest === 'undefined') return;
    var OXHR = window.XMLHttpRequest;
    function WXHR() { var x = new OXHR(), url = '', method = 'GET', rid = generateId('req'), st; var oo = x.open; x.open = function (m, u) { method = m.toUpperCase(); url = typeof u === 'string' ? u : u.toString(); return oo.apply(x, arguments); }; var os = x.send; x.send = function () { st = Date.now(); recordStep(STEP_TYPES.REQUEST_START, { requestId: rid, method: method, url: url }); if (method !== 'GET' && CONFIG.silentFailureCheck) domSnapshots[rid] = captureDOMSnapshot(); x.addEventListener('loadend', function () { var dur = Date.now() - st, sc = x.status; if (sc === 0 || sc >= 400) processError(rid, url, method, sc || 0, x.statusText, dur); else { recordStep(STEP_TYPES.REQUEST_COMPLETE, { requestId: rid, method: method, url: url, statusCode: sc, duration: dur, slow: dur > CONFIG.slowRequestThreshold }); if (dur > CONFIG.slowRequestThreshold) sessionMetrics.slowRequests++; if (CONFIG.capturePreErrorRequests) { preErrorRequests.push({ method: method, url: url, statusCode: sc, duration: dur, timestamp: Date.now() }); if (preErrorRequests.length > CONFIG.preErrorRequestCount) preErrorRequests.shift(); } if (method !== 'GET') { var sf = detectSilentFailure({ requestId: rid, method: method, url: url }, { statusCode: sc }); if (sf) { recordStep(STEP_TYPES.SILENT_FAILURE, sf); sendReport(buildReport({ errorType: 'silent_failure', message: sf.message, method: method, url: url, statusCode: sc })); } } } delete domSnapshots[rid]; }); return os.apply(x, arguments); }; return x; }
    WXHR.prototype = OXHR.prototype; ['UNSENT','OPENED','HEADERS_RECEIVED','LOADING','DONE'].forEach(function (k) { WXHR[k] = OXHR[k]; });
    window.XMLHttpRequest = WXHR;
  }

  function processError(rid, url, method, sc, stxt, dur) { if (shouldIgnoreUrl(url) || shouldIgnoreStatusCode(sc)) return; var rc = countRetries(url, method); sessionMetrics.errors++; if (rc > 0) sessionMetrics.retries++; recordStep(STEP_TYPES.REQUEST_ERROR, { requestId: rid, method: method, url: url, statusCode: sc, statusText: stxt || '', duration: dur, isRetry: rc > 0, retryCount: rc }); sendReport(buildReport({ errorType: 'network_error', requestId: rid, method: method, url: url, statusCode: sc, statusText: stxt || '', duration: dur, isRetry: rc > 0, retryCount: rc })); }
  function processNetworkErr(rid, url, method, err, dur) { if (shouldIgnoreUrl(url)) return; var rc = countRetries(url, method); sessionMetrics.errors++; recordStep(STEP_TYPES.REQUEST_ERROR, { requestId: rid, method: method, url: url, statusCode: 0, statusText: err.message || 'Network Error', duration: dur, isNetworkError: true, isRetry: rc > 0, retryCount: rc }); sendReport(buildReport({ errorType: 'network_error', requestId: rid, method: method, url: url, statusCode: 0, statusText: err.message || 'Network Error', duration: dur, isNetworkError: true, isRetry: rc > 0, retryCount: rc })); }
  function countRetries(url, method) { var k = method + ':' + url; retryCounters[k] = (retryCounters[k] || 0) + 1; return retryCounters[k] - 1; }

  // ═══════════════════════════════════════════
  // 18. REPORT BUILDER
  // ═══════════════════════════════════════════

  function buildReport(errorData) {
    return {
      session: { id: sessionId, startTime: new Date(sessionStart).toISOString(), duration: Date.now() - sessionStart, frustrationScore: calculateFrustrationScore(), metrics: sessionMetrics, pageCount: pageCount },
      visitor: getVisitorInfo(),
      intent: getFullIntent(),
      error: errorData,
      sensitivity: { rageClicks: sessionMetrics.rageClicks, deadClicks: sessionMetrics.deadClicks, silentFailures: sessionMetrics.silentFailures, abandonedForms: sessionMetrics.abandonedForms, unfruitfulClicks: sessionMetrics.unfruitfulClicks, frustrationScore: calculateFrustrationScore() },
      journey: { summary: buildJourneySummary(), stepCount: journey.length, pagesVisited: getUniquePages(), fullTimeline: journey.slice(-50) },
      network: getNetworkQuality(),
      memory: getMemoryPressure(),
      performance: getPerformanceTiming(),
      webVitals: webVitals,
      preErrorRequests: preErrorRequests.slice(-CONFIG.preErrorRequestCount),
      breadcrumbs: { console: consoleBreadcrumbs.slice(-30), custom: customBreadcrumbsList.slice(-20) },
      context: buildContext(),
      customContext: customContext,
      featureFlags: featureFlags,
      experiments: experiments,
      userSegment: userSegment,
      traceId: traceId,
    };
  }

  function getFullIntent() {
    return safe(function () { if (manualIntent && Date.now() < manualIntentExpiresAt) return { manual: manualIntent, inferred: lastIntent ? (lastIntent.text || lastIntent.ariaLabel) : null, confidence: 'high' }; if (lastIntent && Date.now() - lastIntent.timestamp < 5000) return { manual: null, inferred: lastIntent.text || lastIntent.ariaLabel, confidence: 'medium' }; return { manual: null, inferred: null, confidence: 'none' }; }, { manual: null, inferred: null, confidence: 'none' });
  }

  function buildJourneySummary() { var p = getUniquePages(); return { pagesVisited: p, pageCount: p.length, totalClicks: journey.filter(function (s) { return s.type === STEP_TYPES.CLICK; }).length, totalInputs: journey.filter(function (s) { return s.type === STEP_TYPES.INPUT; }).length, totalErrors: sessionMetrics.errors, retryClicks: sessionMetrics.retries, entryPage: (journey.find(function (s) { return s.type === STEP_TYPES.PAGE_LOAD; }) || {}).pageUrl || null, exitPage: p[p.length - 1] || null }; }
  function getUniquePages() { var p = [], s = {}; journey.forEach(function (x) { if (x.type === STEP_TYPES.PAGE_LOAD && x.pageUrl && !s[x.pageUrl]) { s[x.pageUrl] = true; p.push(x.pageUrl); } }); return p; }

  function calculateFrustrationScore() { var s = 0; s += Math.min(sessionMetrics.errors, 3); s += sessionMetrics.rageClicks * 2; s += sessionMetrics.deadClicks; s += sessionMetrics.retries; s += sessionMetrics.slowRequests; s += sessionMetrics.silentFailures * 3; s += sessionMetrics.abandonedForms * 2; s += sessionMetrics.unfruitfulClicks; if (sessionMetrics.exitedAfterError) s += 2; if (sessionMetrics.scrollJitter) s += 1; return Math.min(s, 10); }

  function buildContext() {
    return { pageUrl: getPageUrl(), fullUrl: getFullUrl(), hostname: getHostname(), referrer: getReferrer(), title: getTitle(), browser: getBrowser(), browserVersion: getBrowserVersion(), device: getDevice(), os: getOS(), osVersion: getOSVersion(), viewport: window.innerWidth + 'x' + window.innerHeight, screenResolution: getScreenResolution(), pixelRatio: getPixelRatio(), colorDepth: getColorDepth(), language: getLanguage(), languages: getLanguages(), timezone: getTimezone(), timezoneOffset: getTimezoneOffset(), cookiesEnabled: getCookiesEnabled(), doNotTrack: getDoNotTrack(), touchSupport: getTouchSupport(), maxTouchPoints: getMaxTouchPoints(), domNodeCount: getDOMNodeCount(), pageLoadTime: getPageLoadTime(), userId: getUserId(), release: getRelease(), environment: getEnvironment(), commitSha: getCommitSha(), timestamp: new Date().toISOString(), sessionId: sessionId };
  }

  // ═══════════════════════════════════════════
  // 19. REPORT SENDER
  // ═══════════════════════════════════════════

  function sendReport(report, isRetry) { if (!CONFIG.apiKey) { warn('No API key'); return; } if (!shouldSample() && !isRetry) return; var url = CONFIG.endpoint + '?key=' + encodeURIComponent(CONFIG.apiKey); if (navigator.sendBeacon) { var blob = new Blob([JSON.stringify(report)], { type: 'application/json' }); if (navigator.sendBeacon(url, blob)) { log('Sent via beacon'); return; } } if (window.fetch) { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), keepalive: true, credentials: 'omit' }).then(function () { log('Sent via fetch'); }).catch(function () { if (!isRetry) queueOffline(report); }); } }

  function sendOnUnload() { var hasIssues = sessionMetrics.errors > 0 || sessionMetrics.silentFailures > 0 || sessionMetrics.rageClicks > 0; if (!hasIssues || !CONFIG.apiKey) return; if (navigator.sendBeacon) { var url = CONFIG.endpoint + '?key=' + encodeURIComponent(CONFIG.apiKey); var blob = new Blob([JSON.stringify({ session: { id: sessionId, startTime: new Date(sessionStart).toISOString(), duration: Date.now() - sessionStart, frustrationScore: calculateFrustrationScore(), metrics: sessionMetrics, pageCount: pageCount, sessionEnd: true }, journey: { summary: buildJourneySummary(), stepCount: journey.length, pagesVisited: getUniquePages(), fullTimeline: journey }, context: buildContext() })], { type: 'application/json' }); navigator.sendBeacon(url, blob); } }

  // ═══════════════════════════════════════════
  // 20. PUBLIC API
  // ═══════════════════════════════════════════

  var publicAPI = {
    // ─── Intent ───
    intent: function (label, dur) { dur = dur || 10000; if (typeof label !== 'string' || !label.trim()) { warn('intent() needs a string'); return; } manualIntent = label.trim(); manualIntentExpiresAt = Date.now() + dur; log('Intent:', manualIntent); },
    clearIntent: function () { manualIntent = null; manualIntentExpiresAt = 0; },

    // ─── User ───
    setUser: function (uid) { window.BYELOGS_USER_ID = uid; log('User:', uid); },
    clearUser: function () { window.BYELOGS_USER_ID = null; },
    setUserTier: function (tier) { userSegment.tier = tier; },
    setUserPlan: function (plan) { userSegment.plan = plan; },
    setUserRegion: function (region) { userSegment.region = region; },
    setUserValue: function (value) { userSegment.value = value; },

    // ─── Context ───
    setContext: function (ctx) { customContext = ctx; },
    setTraceId: function (id) { traceId = id; },

    // ─── Feature Flags ───
    setFeatureFlags: function (flags) { for (var k in flags) { if (flags.hasOwnProperty(k)) featureFlags[k] = flags[k]; } log('Feature flags:', featureFlags); },
    setFeatureFlag: function (key, value) { featureFlags[key] = value; },
    getFeatureFlags: function () { return featureFlags; },

    // ─── Experiments / A/B Tests ───
    setExperiment: function (name, group) { experiments[name] = group; log('Experiment:', name, '=', group); },
    getExperiments: function () { return experiments; },

    // ─── Breadcrumbs ───
    breadcrumb: function (message, data) { customBreadcrumbsList.push({ message: message, data: data || null, timestamp: Date.now() }); if (customBreadcrumbsList.length > 50) customBreadcrumbsList.shift(); recordStep(STEP_TYPES.CUSTOM_BREADCRUMB, { message: message, data: data || null }); },
    getBreadcrumbs: function () { return customBreadcrumbsList; },

    // ─── Debug ───
    debug: function () { window.BYELOGS_DEBUG = true; CONFIG.debug = true; log('Debug enabled'); },

    // ─── Getters ───
    getJourney: function () { return journey; },
    getSessionId: function () { return sessionId; },
    getMetrics: function () { return sessionMetrics; },
    getFrustrationScore: function () { return calculateFrustrationScore(); },
    getWebVitals: function () { return webVitals; },

    // ─── Pre-Deploy Check ───
    preDeployCheck: function (options) { var issues = []; if (sessionMetrics.errors > (options.maxErrors || 0)) issues.push('Errors: ' + sessionMetrics.errors); if (sessionMetrics.silentFailures > 0) issues.push('Silent failures: ' + sessionMetrics.silentFailures); if (sessionMetrics.rageClicks > 0) issues.push('Rage clicks: ' + sessionMetrics.rageClicks); return { passed: issues.length === 0, issues: issues, metrics: sessionMetrics }; },

    version: '4.0.0',
  };

  // ═══════════════════════════════════════════
  // 21. INITIALIZATION
  // ═══════════════════════════════════════════

  function init() {
    if (initialized) return; initialized = true;
    safe(function () {
      log('byelogs SDK v' + publicAPI.version);
      openDB();
      trackPageLoad(); trackPageChanges(); trackClicks(); trackForms();
      trackScroll(); trackMouseExit(); wrapFetch(); wrapXHR();
      captureConsole(); captureUnhandledErrors(); captureWebVitals();
      window.addEventListener('beforeunload', sendOnUnload);
      window.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') sendOnUnload(); });
      window.addEventListener('online', function () { flushOfflineQueue(); });
      window.byelogs = publicAPI;
      log('Ready. Session:', sessionId);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();