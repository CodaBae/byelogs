/**
 * byelogs SDK v2.0.0
 * "Bye logs. Hello clarity."
 * 
 * One line of code. Plain English when your product breaks.
 * https://byelogs.dev
 * 
 * Features:
 * - Auto-wraps fetch & XHR to capture network errors
 * - Captures full user journey (clicks, inputs, scrolls, page loads)
 * - AI-powered intent detection
 * - Frustration detection (retries, rage clicks, exit after error)
 * - Technical capture (stack traces, breadcrumbs, request/response)
 * - Zero dependencies, zero impact on host app
 * - ~5KB minified + gzipped
 */

(function () {
    'use strict';
  
    // ═══════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════
  
    var scriptTag = document.currentScript;
    var scriptUrl = scriptTag ? scriptTag.src : '';
    var urlParams = new URLSearchParams((scriptUrl.split('?')[1] || ''));
    var API_KEY = urlParams.get('key') || window.BYELOGS_API_KEY || null;
  
    var CONFIG = {
      apiKey: API_KEY,
      endpoint: window.BYELOGS_ENDPOINT || 'https://server.fractnai.com/api/v1/events',
      debug: window.BYELOGS_DEBUG || false,
      ignoreUrls: window.BYELOGS_IGNORE_URLS || [],
      ignoreStatusCodes: window.BYELOGS_IGNORE_STATUS_CODES || [],
      maxJourneySteps: 100,
      captureInputs: false,
      captureScrollDepth: true,
      captureMouseExits: true,
      frustrationThreshold: 3,
      slowRequestThreshold: 3000,
      sampleRate: window.BYELOGS_SAMPLE_RATE || 1.0,
    };
  
    // ═══════════════════════════════════════════
    // STATE
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
    var initialized = false;
    var eventQueue = [];
  
    // ═══════════════════════════════════════════
    // UTILITIES
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
  
    function log() {
      if (CONFIG.debug) console.log.apply(console, ['[byelogs]'].concat(Array.prototype.slice.call(arguments)));
    }
  
    function warn() {
      if (CONFIG.debug) console.warn.apply(console, ['[byelogs]'].concat(Array.prototype.slice.call(arguments)));
    }
  
    function getPageUrl() {
      return safe(function () {
        return window.location.pathname + window.location.search;
      }, '');
    }
  
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
  
    function getUserId() {
      return safe(function () { return window.BYELOGS_USER_ID || null; }, null);
    }
  
    function getRelease() {
      return safe(function () {
        return window.BYELOGS_RELEASE ||
          (document.querySelector('meta[name="byelogs-release"]') || {}).content ||
          (document.querySelector('meta[name="version"]') || {}).content ||
          null;
      }, null);
    }
  
    function getEnvironment() {
      return safe(function () {
        return window.BYELOGS_ENVIRONMENT ||
          (document.querySelector('meta[name="byelogs-environment"]') || {}).content ||
          (window.location.hostname === 'localhost' ? 'development' : 'production');
      }, 'production');
    }
  
    function getCommitSha() {
      return safe(function () {
        return window.BYELOGS_COMMIT_SHA ||
          (document.querySelector('meta[name="byelogs-commit"]') || {}).content ||
          null;
      }, null);
    }
  
    function shouldIgnoreUrl(url) {
      if (!url) return false;
      return CONFIG.ignoreUrls.some(function (pattern) {
        if (typeof pattern === 'string') return url.indexOf(pattern) > -1;
        if (pattern instanceof RegExp) return pattern.test(url);
        return false;
      });
    }
  
    function shouldIgnoreStatusCode(code) {
      return CONFIG.ignoreStatusCodes.indexOf(code) > -1;
    }
  
    function getFormContext(element) {
      return safe(function () {
        var form = element.closest('form');
        if (!form) return null;
        return form.getAttribute('name') || form.getAttribute('id') || form.getAttribute('aria-label') || null;
      }, null);
    }
  
    function getElementText(element) {
      if (!element) return null;
      var text = (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('value') || '').trim();
      if (!text) return null;
      if (text.length > 200) text = text.substring(0, 197) + '...';
      return text;
    }
  
    function getElementClasses(element) {
      if (!element || !element.className) return null;
      if (typeof element.className === 'string') return element.className.split(' ').filter(Boolean).slice(0, 5).join(' ');
      return null;
    }
  
    // ═══════════════════════════════════════════
    // SAMPLING
    // ═══════════════════════════════════════════
  
    function shouldSample() {
      return Math.random() <= CONFIG.sampleRate;
    }
  
    // ═══════════════════════════════════════════
    // JOURNEY RECORDER
    // ═══════════════════════════════════════════
  
    var STEP_TYPES = {
      PAGE_LOAD: 'page_load',
      CLICK: 'click',
      INPUT: 'input',
      SCROLL: 'scroll',
      REQUEST_START: 'request_start',
      REQUEST_COMPLETE: 'request_complete',
      REQUEST_ERROR: 'request_error',
      MOUSE_EXIT: 'mouse_exit',
      SESSION_END: 'session_end',
    };
  
    function recordStep(type, data) {
      if (journey.length >= CONFIG.maxJourneySteps) journey.shift();
      var step = {
        id: generateId('step'),
        type: type,
        timestamp: Date.now(),
        timeSinceStart: Date.now() - sessionStart,
        pageUrl: getPageUrl(),
      };
      for (var key in data) {
        if (data.hasOwnProperty(key)) step[key] = data[key];
      }
      journey.push(step);
      return step;
    }
  
    // ═══════════════════════════════════════════
    // PAGE TRACKING
    // ═══════════════════════════════════════════
  
    function trackPageLoad() {
      var url = getPageUrl();
      var referrer = safe(function () { return document.referrer || null; }, null);
      var title = safe(function () { return document.title || null; }, null);
      var loadTime = safe(function () {
        var t = performance.timing;
        return t ? t.domContentLoadedEventEnd - t.navigationStart : null;
      }, null);
  
      currentPage = url;
      currentPageLoadTime = Date.now();
  
      recordStep(STEP_TYPES.PAGE_LOAD, {
        pageUrl: url,
        referrer: referrer,
        title: title,
        loadTimeMs: loadTime,
      });
    }
  
    function trackPageChanges() {
      var originalPush = history.pushState;
      history.pushState = function () {
        originalPush.apply(this, arguments);
        safe(function () { trackPageLoad(); });
      };
  
      var originalReplace = history.replaceState;
      history.replaceState = function () {
        originalReplace.apply(this, arguments);
        safe(function () { trackPageLoad(); });
      };
  
      window.addEventListener('popstate', function () {
        safe(function () { trackPageLoad(); });
      });
    }
  
    // ═══════════════════════════════════════════
    // CLICK TRACKING
    // ═══════════════════════════════════════════
  
    function trackClicks() {
      document.addEventListener('click', function (event) {
        safe(function () {
          var element = event.target;
          var target = element;
  
          if (!target.matches('button, a, input, [role="button"], [role="link"], [onclick]')) {
            target = target.closest('button, a, input, [role="button"], [role="link"], [onclick]') || target;
          }
  
          var clickData = {
            text: getElementText(target),
            tag: target.tagName,
            id: target.id || null,
            className: getElementClasses(target),
            ariaLabel: target.getAttribute('aria-label') || null,
            href: target.getAttribute('href') || null,
            formId: getFormContext(target),
            position: { x: event.clientX, y: event.clientY },
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
  
          // Frustration detection
          var fingerprint = (clickData.text || '') + '|' + (clickData.id || '') + '|' + (clickData.formId || '');
          var recent = clickHistory.filter(function (c) {
            return c.fingerprint === fingerprint && Date.now() - c.timestamp < 10000;
          });
  
          if (recent.length >= CONFIG.frustrationThreshold) {
            clickData.isRetry = true;
            clickData.retryCount = recent.length + 1;
            clickData.frustrationSignal = true;
          }
  
          clickHistory.push({ fingerprint: fingerprint, timestamp: Date.now() });
          if (clickHistory.length > 30) clickHistory.shift();
  
          lastIntent = {
            text: clickData.text,
            type: clickData.tag,
            ariaLabel: clickData.ariaLabel,
            formId: clickData.formId,
            timestamp: Date.now(),
          };
  
          recordStep(STEP_TYPES.CLICK, clickData);
        });
      }, true);
    }
  
    // ═══════════════════════════════════════════
    // INPUT TRACKING (privacy-first)
    // ═══════════════════════════════════════════
  
    function trackInputs() {
      document.addEventListener('input', function (event) {
        safe(function () {
          var element = event.target;
          if (!element.matches('input, textarea, select')) return;
  
          var inputData = {
            fieldName: element.getAttribute('name') || element.getAttribute('id') || null,
            fieldType: element.type || element.tagName,
            autofilled: element.matches(':-webkit-autofill'),
            hasValue: !!element.value,
            valueLength: element.value ? element.value.length : 0,
            formId: getFormContext(element),
          };
  
          // Debounce rapid keystrokes
          var inputKey = inputData.fieldName + '-' + inputData.formId;
          var lastInputs = journey.filter(function (s) { return s.type === STEP_TYPES.INPUT; });
          var lastInput = lastInputs[lastInputs.length - 1];
          if (lastInput && lastInput.fieldName === inputData.fieldName && Date.now() - lastInput.timestamp < 2000) {
            return;
          }
  
          recordStep(STEP_TYPES.INPUT, inputData);
        });
      }, true);
    }
  
    // ═══════════════════════════════════════════
    // SCROLL TRACKING
    // ═══════════════════════════════════════════
  
    function trackScrollDepth() {
      if (!CONFIG.captureScrollDepth) return;
  
      var maxDepth = 0;
      var scrollTimer = null;
  
      window.addEventListener('scroll', function () {
        safe(function () {
          clearTimeout(scrollTimer);
          scrollTimer = setTimeout(function () {
            var scrollTop = window.scrollY || window.pageYOffset;
            var docHeight = (document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight;
            var depth = docHeight > 0 ? Math.round((scrollTop / docHeight) * 100) : 0;
  
            if (depth > maxDepth + 10) {
              maxDepth = depth;
              recordStep(STEP_TYPES.SCROLL, {
                depthPercent: depth,
                scrollTop: scrollTop,
                totalHeight: docHeight,
              });
            }
          }, 300);
        });
      }, { passive: true });
    }
  
    // ═══════════════════════════════════════════
    // MOUSE EXIT TRACKING
    // ═══════════════════════════════════════════
  
    function trackMouseExit() {
      if (!CONFIG.captureMouseExits) return;
  
      document.addEventListener('mouseleave', function (event) {
        safe(function () {
          if (event.clientY <= 0 || event.clientX <= 0 ||
              event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) {
  
            var lastStep = journey[journey.length - 1];
            var exitedAfterError = lastStep &&
              (lastStep.type === STEP_TYPES.REQUEST_ERROR) &&
              Date.now() - lastStep.timestamp < 5000;
  
            recordStep(STEP_TYPES.MOUSE_EXIT, {
              exitedAfterError: !!exitedAfterError,
              timeOnPage: Date.now() - currentPageLoadTime,
            });
          }
        });
      });
    }
  
    // ═══════════════════════════════════════════
    // CONSOLE BREADCRUMBS
    // ═══════════════════════════════════════════
  
    function captureConsole() {
      var levels = ['log', 'warn', 'error', 'info', 'debug'];
      levels.forEach(function (level) {
        var original = console[level];
        console[level] = function () {
          var args = Array.prototype.slice.call(arguments);
          consoleBreadcrumbs.push({
            level: level,
            message: args.map(function (a) {
              try {
                if (typeof a === 'string') return a.substring(0, 200);
                if (a instanceof Error) return a.message;
                return JSON.stringify(a).substring(0, 200);
              } catch (e) { return '[Object]'; }
            }).join(' '),
            timestamp: Date.now(),
          });
          if (consoleBreadcrumbs.length > 50) consoleBreadcrumbs.shift();
          original.apply(console, args);
        };
      });
    }
  
    // ═══════════════════════════════════════════
    // UNHANDLED ERROR CAPTURE
    // ═══════════════════════════════════════════
  
    function captureUnhandledErrors() {
      window.addEventListener('error', function (event) {
        safe(function () {
          var error = event.error || event;
          var stackTrace = captureStackTrace(error);
  
          var report = {
            session: {
              id: sessionId,
              startTime: new Date(sessionStart).toISOString(),
              duration: Date.now() - sessionStart,
              frustrationScore: calculateFrustrationScore(),
            },
            intent: getFullIntent(),
            error: {
              type: 'unhandled_error',
              message: error.message || event.message || 'Unknown error',
              stackTrace: stackTrace,
              sourceFile: event.filename || null,
              lineNumber: event.lineno || null,
              columnNumber: event.colno || null,
            },
            journey: {
              summary: buildJourneySummary(),
              stepCount: journey.length,
              pagesVisited: getUniquePages(),
              fullTimeline: journey.slice(-50),
            },
            breadcrumbs: consoleBreadcrumbs.slice(-30),
            context: buildContext(),
          };
  
          sendReport(report);
        });
      });
  
      window.addEventListener('unhandledrejection', function (event) {
        safe(function () {
          var error = event.reason;
          var stackTrace = captureStackTrace(error);
  
          var report = {
            session: {
              id: sessionId,
              startTime: new Date(sessionStart).toISOString(),
              duration: Date.now() - sessionStart,
              frustrationScore: calculateFrustrationScore(),
            },
            intent: getFullIntent(),
            error: {
              type: 'unhandled_rejection',
              message: (error && error.message) || String(error),
              stackTrace: stackTrace,
            },
            journey: {
              summary: buildJourneySummary(),
              stepCount: journey.length,
              pagesVisited: getUniquePages(),
              fullTimeline: journey.slice(-50),
            },
            breadcrumbs: consoleBreadcrumbs.slice(-30),
            context: buildContext(),
          };
  
          sendReport(report);
        });
      });
    }
  
    // ═══════════════════════════════════════════
    // STACK TRACE PARSER
    // ═══════════════════════════════════════════
  
    function captureStackTrace(error) {
      if (!error || !error.stack) return null;
  
      var stack = error.stack;
      var lines = stack.split('\n');
      var frames = [];
  
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
  
        var match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
        if (match) {
          frames.push({
            function: match[1],
            file: match[2],
            line: parseInt(match[3]),
            column: parseInt(match[4]),
          });
          continue;
        }
  
        var simpleMatch = line.match(/at\s+(.+?):(\d+):(\d+)/);
        if (simpleMatch) {
          frames.push({
            function: '<anonymous>',
            file: simpleMatch[1],
            line: parseInt(simpleMatch[2]),
            column: parseInt(simpleMatch[3]),
          });
          continue;
        }
  
        frames.push({ raw: line });
      }
  
      return {
        raw: stack,
        frames: frames,
        message: error.message || null,
        name: error.name || null,
      };
    }
  
    // ═══════════════════════════════════════════
    // NETWORK WRAPPING
    // ═══════════════════════════════════════════
  
    function wrapFetch() {
      if (typeof window.fetch === 'undefined') return;
  
      var originalFetch = window.fetch;
  
      window.fetch = function (input, init) {
        init = init || {};
        var requestUrl = typeof input === 'string' ? input : (input.url || '');
        var requestMethod = (init.method || 'GET').toUpperCase();
        var requestId = generateId('req');
        var startTime = Date.now();
  
        recordStep(STEP_TYPES.REQUEST_START, {
          requestId: requestId,
          method: requestMethod,
          url: requestUrl,
        });
  
        pendingRequests[requestId] = { url: requestUrl, method: requestMethod, startTime: startTime };
  
        return originalFetch.call(this, input, init)
          .then(function (response) {
            var duration = Date.now() - startTime;
            delete pendingRequests[requestId];
  
            if (response.status >= 400) {
              processErrorResponse(requestId, requestUrl, requestMethod, response.status, response.statusText, duration);
            } else {
              recordStep(STEP_TYPES.REQUEST_COMPLETE, {
                requestId: requestId,
                method: requestMethod,
                url: requestUrl,
                statusCode: response.status,
                duration: duration,
                slow: duration > CONFIG.slowRequestThreshold,
              });
            }
  
            return response;
          })
          .catch(function (err) {
            var duration = Date.now() - startTime;
            delete pendingRequests[requestId];
            processNetworkError(requestId, requestUrl, requestMethod, err, duration);
            throw err;
          });
      };
  
      log('fetch wrapped');
    }
  
    function wrapXHR() {
      if (typeof window.XMLHttpRequest === 'undefined') return;
  
      var OriginalXHR = window.XMLHttpRequest;
  
      function XHRWrapper() {
        var xhr = new OriginalXHR();
        var requestUrl = '';
        var requestMethod = 'GET';
        var requestId = generateId('req');
        var startTime;
  
        var originalOpen = xhr.open;
        xhr.open = function (method, url) {
          requestMethod = method.toUpperCase();
          requestUrl = typeof url === 'string' ? url : url.toString();
          return originalOpen.apply(xhr, arguments);
        };
  
        var originalSend = xhr.send;
        xhr.send = function () {
          startTime = Date.now();
  
          recordStep(STEP_TYPES.REQUEST_START, {
            requestId: requestId,
            method: requestMethod,
            url: requestUrl,
          });
  
          xhr.addEventListener('loadend', function () {
            var duration = Date.now() - startTime;
            var statusCode = xhr.status;
  
            if (statusCode === 0 || statusCode >= 400) {
              processErrorResponse(requestId, requestUrl, requestMethod, statusCode || 0, xhr.statusText, duration);
            } else {
              recordStep(STEP_TYPES.REQUEST_COMPLETE, {
                requestId: requestId,
                method: requestMethod,
                url: requestUrl,
                statusCode: statusCode,
                duration: duration,
                slow: duration > CONFIG.slowRequestThreshold,
              });
            }
          });
  
          return originalSend.apply(xhr, arguments);
        };
  
        return xhr;
      }
  
      XHRWrapper.prototype = OriginalXHR.prototype;
      XHRWrapper.UNSENT = OriginalXHR.UNSENT;
      XHRWrapper.OPENED = OriginalXHR.OPENED;
      XHRWrapper.HEADERS_RECEIVED = OriginalXHR.HEADERS_RECEIVED;
      XHRWrapper.LOADING = OriginalXHR.LOADING;
      XHRWrapper.DONE = OriginalXHR.DONE;
  
      window.XMLHttpRequest = XHRWrapper;
      log('XHR wrapped');
    }
  
    function processErrorResponse(requestId, url, method, statusCode, statusText, duration) {
      if (shouldIgnoreUrl(url)) return;
      if (shouldIgnoreStatusCode(statusCode)) return;
  
      var retryCount = countRetries(url, method);
  
      recordStep(STEP_TYPES.REQUEST_ERROR, {
        requestId: requestId,
        method: method,
        url: url,
        statusCode: statusCode,
        statusText: statusText || '',
        duration: duration,
        isRetry: retryCount > 0,
        retryCount: retryCount,
      });
  
      // Build and send error report
      var intent = getFullIntent();
  
      var report = {
        session: {
          id: sessionId,
          startTime: new Date(sessionStart).toISOString(),
          duration: Date.now() - sessionStart,
          frustrationScore: calculateFrustrationScore(),
        },
        intent: intent,
        error: {
          type: 'network_error',
          requestId: requestId,
          method: method,
          url: url,
          statusCode: statusCode,
          statusText: statusText || '',
          duration: duration,
          isRetry: retryCount > 0,
          retryCount: retryCount,
        },
        journey: {
          summary: buildJourneySummary(),
          stepCount: journey.length,
          pagesVisited: getUniquePages(),
          fullTimeline: journey.slice(-50),
        },
        breadcrumbs: consoleBreadcrumbs.slice(-30),
        context: buildContext(),
      };
  
      sendReport(report);
    }
  
    function processNetworkError(requestId, url, method, err, duration) {
      if (shouldIgnoreUrl(url)) return;
  
      var retryCount = countRetries(url, method);
  
      recordStep(STEP_TYPES.REQUEST_ERROR, {
        requestId: requestId,
        method: method,
        url: url,
        statusCode: 0,
        statusText: err.message || 'Network Error',
        duration: duration,
        isNetworkError: true,
        isRetry: retryCount > 0,
        retryCount: retryCount,
      });
  
      var intent = getFullIntent();
  
      var report = {
        session: {
          id: sessionId,
          startTime: new Date(sessionStart).toISOString(),
          duration: Date.now() - sessionStart,
          frustrationScore: calculateFrustrationScore(),
        },
        intent: intent,
        error: {
          type: 'network_error',
          requestId: requestId,
          method: method,
          url: url,
          statusCode: 0,
          statusText: err.message || 'Network Error',
          duration: duration,
          isNetworkError: true,
          isRetry: retryCount > 0,
          retryCount: retryCount,
        },
        journey: {
          summary: buildJourneySummary(),
          stepCount: journey.length,
          pagesVisited: getUniquePages(),
          fullTimeline: journey.slice(-50),
        },
        breadcrumbs: consoleBreadcrumbs.slice(-30),
        context: buildContext(),
      };
  
      sendReport(report);
    }
  
    function countRetries(url, method) {
      var key = method + ':' + url;
      retryCounters[key] = (retryCounters[key] || 0) + 1;
      return retryCounters[key] - 1;
    }
  
    // ═══════════════════════════════════════════
    // INTENT DETECTION
    // ═══════════════════════════════════════════
  
    function getFullIntent() {
      return safe(function () {
        // Priority 1: Manual intent
        if (manualIntent && Date.now() < manualIntentExpiresAt) {
          return {
            manual: manualIntent,
            inferred: lastIntent ? (lastIntent.text || lastIntent.ariaLabel) : null,
            confidence: 'high',
          };
        }
  
        // Priority 2: Recent click context
        if (lastIntent && Date.now() - lastIntent.timestamp < 5000) {
          return {
            manual: null,
            inferred: lastIntent.text || lastIntent.ariaLabel || null,
            confidence: 'medium',
          };
        }
  
        // Priority 3: Journey-based inference
        var recentClicks = journey.filter(function (s) { return s.type === STEP_TYPES.CLICK; }).slice(-3);
        if (recentClicks.length > 0) {
          var lastClick = recentClicks[recentClicks.length - 1];
          return {
            manual: null,
            inferred: lastClick.text || lastClick.ariaLabel || null,
            confidence: 'low',
          };
        }
  
        return { manual: null, inferred: null, confidence: 'none' };
      }, { manual: null, inferred: null, confidence: 'none' });
    }
  
    // ═══════════════════════════════════════════
    // JOURNEY SUMMARY
    // ═══════════════════════════════════════════
  
    function buildJourneySummary() {
      var pages = getUniquePages();
      var clicks = journey.filter(function (s) { return s.type === STEP_TYPES.CLICK; });
      var inputs = journey.filter(function (s) { return s.type === STEP_TYPES.INPUT; });
      var errors = journey.filter(function (s) { return s.type === STEP_TYPES.REQUEST_ERROR; });
      var retries = clicks.filter(function (s) { return s.isRetry; });
      var scrollDepths = journey.filter(function (s) { return s.type === STEP_TYPES.SCROLL; });
  
      return {
        pagesVisited: pages,
        pageCount: pages.length,
        totalClicks: clicks.length,
        totalInputs: inputs.length,
        totalErrors: errors.length,
        retryClicks: retries.length,
        maxScrollDepth: scrollDepths.length > 0
          ? Math.max.apply(null, scrollDepths.map(function (s) { return s.depthPercent; }))
          : 0,
        entryPage: journey.length > 0 ? (journey.find(function (s) { return s.type === STEP_TYPES.PAGE_LOAD; }) || {}).pageUrl || null : null,
        exitPage: pages.length > 0 ? pages[pages.length - 1] : null,
      };
    }
  
    function getUniquePages() {
      var pages = [];
      var seen = {};
      journey.forEach(function (s) {
        if (s.type === STEP_TYPES.PAGE_LOAD && s.pageUrl && !seen[s.pageUrl]) {
          seen[s.pageUrl] = true;
          pages.push(s.pageUrl);
        }
      });
      return pages;
    }
  
    function calculateFrustrationScore() {
      var score = 0;
      score += journey.filter(function (s) { return s.type === STEP_TYPES.REQUEST_ERROR; }).length;
      score += journey.filter(function (s) { return s.type === STEP_TYPES.CLICK && s.isRetry; }).length * 2;
      score += journey.filter(function (s) { return s.type === STEP_TYPES.REQUEST_COMPLETE && s.slow; }).length;
      var lastSteps = journey.slice(-3);
      if (lastSteps.some(function (s) { return s.type === STEP_TYPES.MOUSE_EXIT && s.exitedAfterError; })) {
        score += 3;
      }
      return Math.min(score, 10);
    }
  
    // ═══════════════════════════════════════════
    // CONTEXT BUILDER
    // ═══════════════════════════════════════════
  
    function buildContext() {
      return {
        pageUrl: getPageUrl(),
        browser: getBrowser(),
        device: getDevice(),
        os: getOS(),
        viewport: window.innerWidth + 'x' + window.innerHeight,
        userId: getUserId(),
        release: getRelease(),
        environment: getEnvironment(),
        commitSha: getCommitSha(),
        timestamp: new Date().toISOString(),
        sessionId: sessionId,
      };
    }
  
    // ═══════════════════════════════════════════
    // REPORT SENDER
    // ═══════════════════════════════════════════
  
    function sendReport(report) {
      if (!CONFIG.apiKey) {
        warn('No API key configured. Error not sent.');
        return;
      }
  
      if (!shouldSample()) return;
  
      var url = CONFIG.endpoint + '?key=' + encodeURIComponent(CONFIG.apiKey);
  
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(report)], { type: 'application/json' });
        var sent = navigator.sendBeacon(url, blob);
        if (sent) {
          log('Report sent via sendBeacon');
          return;
        }
      }
  
      // Fallback: fetch with keepalive
      if (window.fetch) {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(report),
          keepalive: true,
          credentials: 'omit',
          cache: 'no-store',
        }).then(function () {
          log('Report sent via fetch');
        }).catch(function (err) {
          warn('Failed to send report:', err.message);
        });
      }
    }
  
    function sendOnUnload() {
      var hasErrors = journey.some(function (s) { return s.type === STEP_TYPES.REQUEST_ERROR; });
      if (!hasErrors) return;
  
      var intent = getFullIntent();
  
      var report = {
        session: {
          id: sessionId,
          startTime: new Date(sessionStart).toISOString(),
          duration: Date.now() - sessionStart,
          frustrationScore: calculateFrustrationScore(),
          sessionEnd: true,
        },
        intent: intent,
        journey: {
          summary: buildJourneySummary(),
          stepCount: journey.length,
          pagesVisited: getUniquePages(),
          fullTimeline: journey,
        },
        breadcrumbs: consoleBreadcrumbs,
        context: buildContext(),
      };
  
      if (navigator.sendBeacon) {
        var url = CONFIG.endpoint + '?key=' + encodeURIComponent(CONFIG.apiKey);
        var blob = new Blob([JSON.stringify(report)], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
      }
    }
  
    // ═══════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════
  
    var publicAPI = {
      /**
       * Set a manual intent label for high-accuracy tracking.
       * @param {string} label - e.g., "upload_profile_picture"
       * @param {number} durationMs - How long this intent stays active (default: 10000ms)
       */
      intent: function (label, durationMs) {
        durationMs = durationMs || 10000;
        if (typeof label !== 'string' || !label.trim()) {
          warn('intent() requires a non-empty string');
          return;
        }
        manualIntent = label.trim();
        manualIntentExpiresAt = Date.now() + durationMs;
        log('Manual intent set:', manualIntent, 'for', durationMs, 'ms');
      },
  
      /**
       * Clear the current manual intent.
       */
      clearIntent: function () {
        manualIntent = null;
        manualIntentExpiresAt = 0;
        log('Manual intent cleared');
      },
  
      /**
       * Set the user ID for associating errors with specific users.
       * @param {string} userId
       */
      setUser: function (userId) {
        window.BYELOGS_USER_ID = userId;
        log('User set:', userId);
      },
  
      /**
       * Clear the current user ID.
       */
      clearUser: function () {
        window.BYELOGS_USER_ID = null;
        log('User cleared');
      },
  
      /**
       * Enable debug logging.
       */
      debug: function () {
        window.BYELOGS_DEBUG = true;
        CONFIG.debug = true;
        log('Debug mode enabled');
      },
  
      /**
       * Get the current journey (for debugging).
       */
      getJourney: function () {
        return journey;
      },
  
      /**
       * Get the current session ID.
       */
      getSessionId: function () {
        return sessionId;
      },
  
      /**
       * Get SDK version.
       */
      version: '2.0.0',
    };
  
    // ═══════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════
  
    function init() {
      if (initialized) return;
      initialized = true;
  
      safe(function () {
        log('byelogs SDK v' + publicAPI.version + ' initializing...');
  
        if (!CONFIG.apiKey) {
          warn('No API key found. Set data-key on script tag or window.BYELOGS_API_KEY.');
          warn('SDK loaded but errors will not be reported.');
        }
  
        // Track page load
        trackPageLoad();
        trackPageChanges();
  
        // Track interactions
        trackClicks();
        trackInputs();
        trackScrollDepth();
        trackMouseExit();
  
        // Wrap network
        wrapFetch();
        wrapXHR();
  
        // Capture console
        captureConsole();
  
        // Capture unhandled errors
        captureUnhandledErrors();
  
        // Send data on unload
        window.addEventListener('beforeunload', sendOnUnload);
        window.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') sendOnUnload();
        });
  
        // Expose public API
        window.byelogs = publicAPI;
  
        log('SDK initialized. Session:', sessionId);
        log('API key:', CONFIG.apiKey ? 'present' : 'missing');
        log('Endpoint:', CONFIG.endpoint);
      });
    }
  
    // Start when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  
  })();