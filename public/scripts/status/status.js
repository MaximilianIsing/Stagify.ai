      import { componentLabel, componentReason, stateLabel, stateClass, bannerClass, bannerText, componentIcon } from './status-components.js';

      (function () {
        'use strict';
        var ENDPOINT = '/api/status';
        var REFRESH_MS = 60000;
        var SVG = 'http://www.w3.org/2000/svg';

        // Manual refresh throttle.
        //
        // Not a cost guard: /api/status is synchronous and never probes (see the comment
        // above the route in routes/public.js), and lib/health/service-health.js caches
        // its section for 30s behind a single-flight refresh. A click buys no new work.
        // This exists so the button cannot be leaned on, and so the request a click does
        // make is one request rather than a queue of overlapping ones.
        //
        // 10s, not 30s: during an incident — the only time anyone touches this button —
        // a half-minute of a dead control feels like a second outage. The data can only
        // move every 30s, so some clicks return identical bytes; that is the right
        // trade for a control that answers when pressed.
        var COOLDOWN_MS = 10000;
        // Two timestamps, and the difference matters. `lastFetchAt` is any fetch — boot,
        // the 60s poll, a tab return — and throttles the visibility handler. `lastManualAt`
        // is clicks only, and is the sole gate on the button.
        //
        // Gating the button on lastFetchAt instead (the first cut) made it silently dead
        // for ten seconds after page load and after every automatic poll: the cooldown
        // had started, but nothing had disabled the button or drawn a countdown, so a
        // click in that window did nothing and said nothing. A control that ignores you
        // is worse than one that is visibly greyed out.
        var lastFetchAt = 0;
        var lastManualAt = 0;
        var inFlight = false;
        var cooldownTimer = null;

        // The icon spins for at least one full turn, even when the response beats it.
        // /api/status is in-memory and answers in tens of milliseconds, so clearing the
        // spin the moment it settles meant the animation was real but never visible —
        // the button looked inert on a click that had in fact worked. Matched to the .6s
        // animation so the icon lands back at 0deg instead of snapping.
        var SPIN_MIN_MS = 600;
        var spinStartedAt = 0;
        var spinTimer = null;
        var manualPending = false;

        function $(sel, root) { return (root || document).querySelector(sel); }
        function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

        // ---- i18n helpers ------------------------------------------------------
        // Resolve a translation key via the shared language runtime, falling back
        // to the built-in English string until languages/<lang>.json has loaded.
        function t(key, fallback) {
          var ls = window.LanguageSystem;
          return (ls && typeof ls.getText === 'function') ? ls.getText(key, fallback) : fallback;
        }
        // Fill {name} placeholders in a template with values from `vars`.
        function interpolate(str, vars) {
          return String(str).replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m;
          });
        }
        // Incident causes are recorded server-side as fixed English strings.
        // Map the known ones to translation keys so they localize; anything
        // unrecognized falls back to the raw cause (or a generic default).
        function translateCause(cause) {
          if (cause === 'downtime detected on restart (missed heartbeats)') {
            return t('status.incidents.causeMissedHeartbeats', cause);
          }
          return cause || t('status.incidents.defaultCause', 'Downtime');
        }
        // Last successful payload / last-load-failed flag, so a mid-session
        // language switch can re-render the JS-injected parts in the new language.
        var lastData = null;
        var loadFailed = false;

        function fmtPct(v) {
          if (v === null || v === undefined) return '—';
          // One decimal place, truncated so uptime is never rounded up (99.375 -> 99.3%).
          return (Math.floor(v * 10 + 1e-6) / 10).toFixed(1) + '%';
        }
        function pctColor(v) {
          if (v === null || v === undefined) return 'var(--muted)';
          if (v >= 99.9) return '#047857';
          if (v >= 99) return '#b45309';
          return '#b91c1c';
        }
        function fmtDuration(ms) {
          if (ms < 1000) return '<1s';
          var s = Math.round(ms / 1000);
          if (s < 60) return s + 's';
          var m = Math.floor(s / 60);
          if (m < 60) return m + 'm ' + (s % 60) + 's';
          var h = Math.floor(m / 60);
          if (h < 24) return h + 'h ' + (m % 60) + 'm';
          var d = Math.floor(h / 24);
          return d + 'd ' + (h % 24) + 'h';
        }
        function fmtAgo(ms) {
          if (ms === null || ms === undefined) return t('status.ago.never', 'never');
          var v;
          if (ms < 60000) v = Math.round(ms / 1000) + 's';
          else if (ms < 3600000) v = Math.round(ms / 60000) + 'm';
          else if (ms < 86400000) v = Math.round(ms / 3600000) + 'h';
          else v = Math.round(ms / 86400000) + 'd';
          return interpolate(t('status.ago.template', '{v} ago'), { v: v });
        }
        function fmtDate(ts) {
          try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
        }
        function fmtTimeRange(start, end) {
          try {
            var opts = /** @type {Intl.DateTimeFormatOptions} */ ({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return new Date(start).toLocaleString([], opts) + ' – ' + new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          } catch (e) { return ''; }
        }

        // ---- Bar hover tooltip -------------------------------------------------
        var tip = $('.st-tip');
        function showTip(bar) {
          tip.textContent = '';
          var val = document.createElement('div'); val.className = 'st-tip__val';
          val.textContent = bar.getAttribute('data-val') || '';
          var time = document.createElement('div'); time.className = 'st-tip__time';
          time.textContent = bar.getAttribute('data-time') || '';
          tip.appendChild(val); tip.appendChild(time);
          tip.style.display = 'block';
        }
        function moveTip(e) {
          if (tip.style.display !== 'block') return;
          var r = tip.getBoundingClientRect();
          var left = e.clientX - r.width / 2;
          left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
          var top = e.clientY - r.height - 14;
          if (top < 8) top = e.clientY + 16;
          tip.style.left = (left + window.pageXOffset) + 'px';
          tip.style.top = (top + window.pageYOffset) + 'px';
        }
        function hideTip() { tip.style.display = 'none'; }
        $all('.st-bars').forEach(function (c) {
          c.addEventListener('mouseover', function (e) {
            var bar = e.target.closest ? e.target.closest('.st-bar') : null;
            if (bar && c.contains(bar)) { showTip(bar); moveTip(e); }
          });
          c.addEventListener('mousemove', moveTip);
          c.addEventListener('mouseleave', hideTip);
        });

        function renderBars(container, buckets) {
          container.textContent = '';
          if (!buckets || !buckets.length) return;
          var frag = document.createDocumentFragment();
          buckets.forEach(function (b) {
            var el = document.createElement('div');
            el.className = 'st-bar ' + (b.state || 'nodata');
            el.setAttribute('data-time', fmtTimeRange(b.start, b.end));
            el.setAttribute('data-val', b.state === 'nodata'
              ? t('status.tooltip.nodata', 'No data')
              : interpolate(t('status.tooltip.uptime', '{pct} uptime'), { pct: fmtPct(b.uptimePct) }));
            frag.appendChild(el);
          });
          container.appendChild(frag);
        }

        function checkIcon() {
          var svg = document.createElementNS(SVG, 'svg');
          svg.setAttribute('width', '26'); svg.setAttribute('height', '26');
          svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
          svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.4');
          svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
          svg.setAttribute('aria-hidden', 'true');
          var p = document.createElementNS(SVG, 'path'); p.setAttribute('d', 'M20 6 9 17l-5-5');
          svg.appendChild(p);
          return svg;
        }

        // Two or fewer entries is not a feed, so it is left to size itself — a scroll
        // viewport around a single row reads as a cropped one.
        var INCIDENT_SCROLL_FROM = 3;

        function renderIncidents(root, incidents) {
          root.textContent = '';
          var many = !!incidents && incidents.length >= INCIDENT_SCROLL_FROM;
          root.className = 'st-incidents__scroll' + (many ? '' : ' is-short');
          if (!incidents || !incidents.length) {
            var wrap = document.createElement('div');
            wrap.className = 'st-empty';
            var icon = document.createElement('span');
            icon.className = 'st-empty__icon';
            icon.appendChild(checkIcon());
            var title = document.createElement('div');
            title.className = 'st-empty__title';
            title.textContent = t('status.incidents.noneTitle', 'No incidents recorded');
            var text = document.createElement('div');
            text.className = 'st-empty__text';
            text.textContent = t('status.incidents.noneText', 'The service has had no detected downtime in the monitored period.');
            wrap.appendChild(icon); wrap.appendChild(title); wrap.appendChild(text);
            root.appendChild(wrap);
            return;
          }
          incidents.forEach(function (inc) {
            var row = document.createElement('div');
            row.className = 'st-incident';

            var sev = document.createElement('span');
            // An unresolved incident is the live news on this page, so it is the one
            // row that gets its own marker rather than reading like history.
            sev.className = 'st-incident__sev' + (inc.ongoing ? ' is-ongoing' : '');

            var main = document.createElement('div');
            main.className = 'st-incident__main';
            var title = document.createElement('div');
            title.className = 'st-incident__title';
            title.textContent = translateCause(inc.cause);
            var meta = document.createElement('div');
            meta.className = 'st-incident__meta';
            // An operator-posted incident may have no end yet. `fmtDate(null)` would
            // print "Invalid Date" against the one entry a reader most wants to trust.
            meta.textContent = fmtDate(inc.start) + ' → '
              + (inc.ongoing ? t('status.incidents.ongoing', 'Ongoing') : fmtDate(inc.end));
            main.appendChild(title);
            main.appendChild(meta);

            var dur = document.createElement('div');
            dur.className = 'st-incident__dur';
            dur.textContent = fmtDuration(inc.durationMs);

            row.appendChild(sev);
            row.appendChild(main);
            row.appendChild(dur);
            root.appendChild(row);
          });
        }

        // ---- Components --------------------------------------------------------
        // One row per subsystem: name, state pill, and the reason in plain language.
        // Built with createElement/textContent rather than innerHTML because `reason`
        // is server copy — and a hand-rolled client could put anything in it, so it is
        // never given a chance to be markup.
        function renderComponents(root, components) {
          if (!root) return;
          root.textContent = '';
          root.className = 'st-tiles';
          if (!components || !components.length) {
            var empty = document.createElement('p');
            empty.className = 'st-empty';
            var emptyText = document.createElement('span');
            emptyText.className = 'st-empty__text';
            emptyText.textContent = t('status.components.loading', 'Loading…');
            empty.appendChild(emptyText);
            // The placeholder is one centred line, not a grid cell.
            root.className = '';
            root.appendChild(empty);
            return;
          }
          // A tile per component rather than a full-width row each: eight rows pushed
          // the uptime graphs off the first screen, and "everything is fine" does not
          // deserve eight lines. The reason sentence is shown only when it says
          // something — a healthy tile is the name and the word Operational — and the
          // full sentence is always on the title attribute for the healthy ones.
          components.forEach(function (c) {
            var ok = c.state === 'operational';
            var reason = componentReason(c, t);

            var tile = document.createElement('div');
            tile.className = 'st-tile ' + stateClass(c.state);
            if (ok && reason) tile.title = reason;

            var head = document.createElement('div');
            head.className = 'st-tile__head';
            var dot = document.createElement('span');
            dot.className = 'st-tile__dot';
            var name = document.createElement('span');
            name.className = 'st-tile__name';
            name.textContent = componentLabel(c.id, t);
            head.appendChild(dot);
            head.appendChild(name);

            // The glyph says WHICH subsystem; the dot beside the name says how it is.
            // Built node by node (never innerHTML) and hidden from assistive tech — it
            // repeats the name, which is right there in text.
            var shapes = componentIcon(c.id);
            if (shapes.length) {
              var icon = document.createElementNS(SVG, 'svg');
              icon.setAttribute('class', 'st-tile__icon');
              icon.setAttribute('viewBox', '0 0 24 24');
              icon.setAttribute('fill', 'none');
              icon.setAttribute('stroke', 'currentColor');
              icon.setAttribute('stroke-width', '1.6');
              icon.setAttribute('stroke-linecap', 'round');
              icon.setAttribute('stroke-linejoin', 'round');
              icon.setAttribute('aria-hidden', 'true');
              shapes.forEach(function (shape) {
                var node = document.createElementNS(SVG, shape[0]);
                Object.keys(shape[1]).forEach(function (attr) {
                  node.setAttribute(attr, shape[1][attr]);
                });
                icon.appendChild(node);
              });
              head.appendChild(icon);
            }

            var state = document.createElement('div');
            state.className = 'st-tile__state';
            state.textContent = stateLabel(c.state, t);

            tile.appendChild(head);
            tile.appendChild(state);
            // Only an unhealthy tile spends a third line on why.
            if (!ok && reason) {
              var why = document.createElement('div');
              why.className = 'st-tile__reason';
              why.textContent = reason;
              tile.appendChild(why);
            }
            root.appendChild(tile);
          });
        }

        function setStatus(data) {
          var pill = $('[data-status]');
          var text = $('.up-status-text', pill);
          pill.classList.remove('is-loading', 'is-up', 'is-degraded', 'is-down');
          // bannerClass prefers `overall` (component-aware) and falls back to
          // `currentState`, so an older cached bundle and an older server both work.
          pill.classList.add(bannerClass(data));
          text.textContent = bannerText(data, t);
        }

        function render(data) {
          lastData = data;
          loadFailed = false;
          setStatus(data);

          // Summary + per-graph percentages.
          $all('[data-pct]').forEach(function (el) {
            var key = el.getAttribute('data-pct');
            var w = data.windows && data.windows[key];
            var v = w ? w.uptimePct : null;
            el.textContent = fmtPct(v);
            if (el.classList.contains('up-card-val') || el.classList.contains('up-block-pct')) {
              el.style.color = pctColor(v);
            }
          });

          if (data.buckets) {
            renderBars($('[data-bars="24h"]'), data.buckets['24h']);
            renderBars($('[data-bars="7d"]'), data.buckets['7d']);
          }

          renderComponents($('[data-components]'), data.components);
          var checked = $('[data-components-checked]');
          if (checked) {
            checked.textContent = data.componentsCheckedAt
              ? interpolate(t('status.components.checked', 'Checked {ago}'),
                { ago: fmtAgo(Math.max(0, Date.now() - data.componentsCheckedAt)) })
              : '';
          }

          renderIncidents($('[data-incidents]'), data.incidents);

          // Monitoring line.
          var mon = $('[data-monitoring]');
          if (data.monitoringSince) {
            mon.textContent = interpolate(
              t('status.monitoring.since', 'Monitoring since {date} · last check {ago}'),
              { date: fmtDate(data.monitoringSince), ago: fmtAgo(data.lastCheckedMsAgo) }
            );
          } else {
            mon.textContent = t('status.monitoring.collecting', 'Collecting data…');
          }

          var foot = $('[data-foot]');
          foot.innerHTML = interpolate(
            t('status.foot', 'Auto-refreshes every 60 seconds · Restarts logged: {count} · Availability is measured from the server’s own heartbeat. For an independent check, <a href="/health">/health</a> returns live status JSON.'),
            { count: (data.bootCount || 0) }
          );
          fitFoot();
        }

        // ---- Footnote fitting --------------------------------------------------
        // The footnote reads as one horizontal row. Its length swings widely by
        // language (Russian runs ~40% wider than English), so shrink the type
        // until the line fits the content column; if even the floor size is too
        // wide, drop back to the normal wrapping note rather than going illegible.
        var FOOT_MAX_PX = 12.5;
        var FOOT_MIN_PX = 10;
        function fitFoot() {
          var foot = $('[data-foot]');
          if (!foot) return;
          foot.style.whiteSpace = 'nowrap';
          foot.style.fontSize = FOOT_MAX_PX + 'px';
          var avail = foot.clientWidth;
          // The line is centred, so it overflows both edges — scrollWidth only
          // sees the right-hand half. Measure the text itself with a Range.
          var range = document.createRange();
          range.selectNodeContents(foot);
          var needed = range.getBoundingClientRect().width;
          if (!avail || !needed || needed <= avail) return;
          var size = Math.floor(FOOT_MAX_PX * (avail / needed) * 10) / 10;
          if (size < FOOT_MIN_PX) {
            foot.style.whiteSpace = '';
            foot.style.fontSize = '';
            return;
          }
          foot.style.fontSize = size + 'px';
        }
        var footFitTimer = 0;
        window.addEventListener('resize', function () {
          clearTimeout(footFitTimer);
          footFitTimer = setTimeout(fitFoot, 120);
        });

        function showError() {
          loadFailed = true;
          var pill = $('[data-status]');
          pill.classList.remove('is-loading', 'is-up');
          pill.classList.add('is-down');
          $('.up-status-text', pill).textContent = t('status.unableToLoad', 'Unable to load status');
          $('[data-monitoring]').textContent = t('status.monitoring.error', 'Could not reach the status API, retrying…');
          var incRoot = $('[data-incidents]');
          incRoot.textContent = '';
          var wrap = document.createElement('div');
          wrap.className = 'st-empty';
          var span = document.createElement('span');
          span.className = 'st-empty__text';
          span.textContent = t('status.incidents.loadError', 'Could not reach the status API. Retrying…');
          wrap.appendChild(span);
          incRoot.appendChild(wrap);
        }

        // A single fetch, guarded so two callers cannot have requests in the air at once.
        // Three things call this — the 60s timer, the visibility handler and the refresh
        // button — and on a slow connection they would otherwise overlap and race to
        // render, with the older response able to win.
        function load() {
          if (inFlight) return;
          inFlight = true;
          var settle = function () {
            inFlight = false;
            lastFetchAt = Date.now();
            stopSpinWhenSeen();
          };
          fetch(ENDPOINT, { headers: { 'Accept': 'application/json' }, cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) { settle(); render(data); })
            .catch(function () { settle(); showError(); });
        }

        // ---- manual refresh ----------------------------------------------------
        function setRefreshSpinning(on) {
          var btn = $('[data-refresh]');
          if (btn) btn.classList.toggle('is-spinning', !!on);
        }

        // End the spin, but not before it has been on screen long enough to read as one.
        // Only a click arms this: an automatic poll settling mid-spin must not cut a
        // manual refresh's animation short, which is what `manualPending` guards.
        function stopSpinWhenSeen() {
          if (!manualPending) return;
          manualPending = false;
          if (spinTimer) clearTimeout(spinTimer);
          var elapsed = Date.now() - spinStartedAt;
          spinTimer = setTimeout(function () {
            spinTimer = null;
            setRefreshSpinning(false);
          }, Math.max(0, SPIN_MIN_MS - elapsed));
        }

        // Count the cooldown down in the button, then hand it back. The numeral goes in
        // its own aria-hidden span so it never collides with the data-lang label.
        function startCooldown() {
          var btn = $('[data-refresh]');
          var count = $('[data-refresh-count]');
          if (!btn || !count) return;
          if (cooldownTimer) clearInterval(cooldownTimer);

          btn.disabled = true;
          var tick = function () {
            var left = Math.ceil((lastManualAt + COOLDOWN_MS - Date.now()) / 1000);
            if (left > 0) {
              // Hold the width with a trailing U+2007 FIGURE SPACE, which is defined to
              // be exactly one digit wide. "10s" to "9s" drops a whole character, so the
              // button narrowed on the second tick; `tabular-nums` cannot fix that, it
              // only equalises digits against each other.
              //
              // The pad goes BEFORE the opening paren, outside it, which pins the group to
              // the right edge of the button. Two placements were wrong for different
              // reasons: inside the brackets ("( 9s)") opens a gap that makes the bracket
              // read as detached, and trailing ("(9s) ") left-anchors the group so it
              // appears to slide left the moment the count drops to one digit. Leading,
              // the "(9s)" stays tight and its right edge never moves.
              count.textContent = ' ' + (left < 10 ? ' ' : '') + '(' + left + 's)';
              return;
            }
            clearInterval(cooldownTimer);
            cooldownTimer = null;
            count.textContent = '';
            btn.disabled = false;
          };
          tick();
          cooldownTimer = setInterval(tick, 1000);
        }

        function onRefresh() {
          if (inFlight || Date.now() < lastManualAt + COOLDOWN_MS) return;
          // Stamped from the CLICK, not from when the request settles: a slow request
          // would otherwise leave the button live and clickable while it was in flight.
          lastManualAt = Date.now();
          spinStartedAt = lastManualAt;
          manualPending = true;
          setRefreshSpinning(true);
          startCooldown();
          load();
        }

        // Translate the initial "Checking status…" banner, and re-render the
        // dynamic (JS-injected) parts whenever the visitor switches language.
        function renderLoading() {
          var pill = $('[data-status]');
          if (pill.classList.contains('is-up') || pill.classList.contains('is-down')) return;
          $('.up-status-text', pill).textContent = t('status.checking', 'Checking status…');
        }
        function rerender() {
          if (loadFailed) showError();
          else if (lastData) render(lastData);
          else renderLoading();
        }
        window.addEventListener('languagechange', rerender);

        rerender();
        load();
        // A hidden tab skips the tick; the visibilitychange handler below catches up on return.
        setInterval(function () {
          if (document.hidden) return;
          load();
        }, REFRESH_MS);

        var refreshBtn = $('[data-refresh]');
        if (refreshBtn) refreshBtn.addEventListener('click', onRefresh);

        // Refresh when the tab regains focus so a returning visitor sees current data.
        // Throttled on the SAME timestamp as the button: this used to fetch on every
        // return, so alt-tabbing twice was an unlimited refresh and the button's cooldown
        // was decorative.
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState !== 'visible') return;
          if (Date.now() < lastFetchAt + COOLDOWN_MS) return;
          load();
        });
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
