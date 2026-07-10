      (function () {
        'use strict';
        var ENDPOINT = '/api/status';
        var REFRESH_MS = 60000;
        var SVG = 'http://www.w3.org/2000/svg';

        function $(sel, root) { return (root || document).querySelector(sel); }
        function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

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
          if (ms === null || ms === undefined) return 'never';
          if (ms < 60000) return Math.round(ms / 1000) + 's ago';
          if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
          if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
          return Math.round(ms / 86400000) + 'd ago';
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
            el.setAttribute('data-val', b.state === 'nodata' ? 'No data' : fmtPct(b.uptimePct) + ' uptime');
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

        function renderIncidents(root, incidents) {
          root.textContent = '';
          if (!incidents || !incidents.length) {
            var wrap = document.createElement('div');
            wrap.className = 'st-empty';
            var icon = document.createElement('span');
            icon.className = 'st-empty__icon';
            icon.appendChild(checkIcon());
            var title = document.createElement('div');
            title.className = 'st-empty__title';
            title.textContent = 'No incidents recorded';
            var text = document.createElement('div');
            text.className = 'st-empty__text';
            text.textContent = 'The service has had no detected downtime in the monitored period.';
            wrap.appendChild(icon); wrap.appendChild(title); wrap.appendChild(text);
            root.appendChild(wrap);
            return;
          }
          incidents.forEach(function (inc) {
            var row = document.createElement('div');
            row.className = 'st-incident';

            var sev = document.createElement('span');
            sev.className = 'st-incident__sev';

            var main = document.createElement('div');
            main.className = 'st-incident__main';
            var title = document.createElement('div');
            title.className = 'st-incident__title';
            title.textContent = inc.cause || 'Downtime';
            var meta = document.createElement('div');
            meta.className = 'st-incident__meta';
            meta.textContent = fmtDate(inc.start) + ' → ' + fmtDate(inc.end);
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

        function setStatus(data) {
          var pill = $('[data-status]');
          var text = $('.up-status-text', pill);
          pill.classList.remove('is-loading', 'is-up', 'is-down');
          if (data.currentState === 'up') {
            pill.classList.add('is-up');
            text.textContent = 'All systems operational';
          } else {
            pill.classList.add('is-down');
            text.textContent = 'Service disruption detected';
          }
        }

        function render(data) {
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

          renderIncidents($('[data-incidents]'), data.incidents);

          // Monitoring line.
          var mon = $('[data-monitoring]');
          if (data.monitoringSince) {
            mon.textContent = 'Monitoring since ' + fmtDate(data.monitoringSince) +
              ' · last check ' + fmtAgo(data.lastCheckedMsAgo);
          } else {
            mon.textContent = 'Collecting data…';
          }

          var foot = $('[data-foot]');
          foot.innerHTML = 'Auto-refreshes every 60 seconds · ' + (data.bootCount || 0) +
            ' restart' + (data.bootCount === 1 ? '' : 's') + ' logged · ' +
            'Availability is measured from the server’s own heartbeat. For an independent check, ' +
            '<a href="/health">/health</a> returns live status JSON.';
        }

        function showError() {
          var pill = $('[data-status]');
          pill.classList.remove('is-loading', 'is-up');
          pill.classList.add('is-down');
          $('.up-status-text', pill).textContent = 'Unable to load status';
          $('[data-monitoring]').textContent = 'Could not reach the status API — retrying…';
          $('[data-incidents]').innerHTML = '<div class="st-empty"><span class="st-empty__text">Could not reach the status API. Retrying…</span></div>';
        }

        function load() {
          fetch(ENDPOINT, { headers: { 'Accept': 'application/json' }, cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(render)
            .catch(function () { showError(); });
        }

        load();
        setInterval(load, REFRESH_MS);
        // Refresh when the tab regains focus so a returning visitor sees current data.
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') load();
        });
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
