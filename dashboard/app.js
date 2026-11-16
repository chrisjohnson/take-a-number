/* take-a-number dashboard: live feed (NDJSON stream with poll fallback) +
 * keyed card diffing (enter/poof/FLIP) ported from dsh-model-capacity. */
(function () {
  'use strict';

  var BASE = (window.TAN_BASE || '').replace(/\/+$/, '');
  // Optional daemon auth: the page is opened as /?token=… ; remember the token
  // and carry it on every API call. With no token (open daemon) this is a no-op.
  var TOKEN = (function () {
    try {
      var fromUrl = new URLSearchParams(window.location.search).get('token');
      if (fromUrl) {
        try { sessionStorage.setItem('tan-token', fromUrl); } catch (e) { /* private mode */ }
        return fromUrl;
      }
      return sessionStorage.getItem('tan-token') || '';
    } catch (e) { return ''; }
  })();
  function authed(path) {
    return TOKEN ? path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(TOKEN) : path;
  }
  var STALL_MS = 20000;
  var FALLBACK_POLL_MS = 2000;
  var GHOST_TTL_MS = 900;
  var TICK_MS = 500;          // local-clock refresh of the displayed durations
  var SIM_TICK_MS = 1000;     // how often the simulator mints a new frame
  var TONES = ['mc-tone-0', 'mc-tone-1', 'mc-tone-2', 'mc-tone-3'];
  var KPI_TONES = ['mc-tone-blue', 'mc-tone-violet', 'mc-tone-teal', 'mc-tone-amber'];

  var reducedMotion = (function () {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  })();

  var controllers = new Set();

  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  // A frame carries durations as of the instant it was produced. Between frames the
  // page ticks them with its own clock, so the timers move in realtime without a
  // realtime connection. sim.js owns the arithmetic (and its tests); fall back to
  // the same one-liner if the module has not been served.
  function tickValue(baseMs, baseAt, now) {
    if (window.TAN_SIM && typeof window.TAN_SIM.tickValue === 'function') {
      return window.TAN_SIM.tickValue(baseMs, baseAt, now);
    }
    var base = typeof baseMs === 'number' && isFinite(baseMs) ? baseMs : 0;
    var delta = now - baseAt;
    return base + (delta > 0 ? delta : 0);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function shortId(id) {
    return typeof id === 'string' && id.length > 14 ? id.slice(-8) : (id || 'unknown');
  }

  // --- graph -----------------------------------------------------------------

  var GRAPH_POINTS = 60;
  var GRAPH_W = 600;
  var GRAPH_H = 44;
  var GRAPH_PAD = 3;

  function graphPoints(values) {
    var step = GRAPH_W / (GRAPH_POINTS - 1);
    var baseline = GRAPH_H - GRAPH_PAD;
    var span = GRAPH_H - 2 * GRAPH_PAD;
    var max = 1;
    var i;
    for (i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i];
    var pairs = [];
    for (i = 0; i < values.length; i += 1) {
      var value = values[i] > 0 ? values[i] : 0;
      pairs.push({ x: GRAPH_W - (values.length - 1 - i) * step, y: baseline - (value / max) * span });
    }
    if (pairs.length === 1) pairs.unshift({ x: GRAPH_W - step, y: pairs[0].y });
    if (pairs.length === 0) pairs = [{ x: 0, y: baseline }, { x: GRAPH_W, y: baseline }];
    return pairs.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
  }

  function graphHtml(values) {
    return '<div class="mc-graph">' +
      '<svg class="mc-graph-plot" viewBox="0 0 ' + GRAPH_W + ' ' + GRAPH_H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + esc(graphPoints(values)) + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>' +
      '</svg>' +
      '<div class="mc-graph-axis">' +
      '<span class="mc-graph-tick is-start" style="left:0">-60s</span>' +
      '<span class="mc-graph-tick is-middle" style="left:25%;transform:translateX(-50%)">-45s</span>' +
      '<span class="mc-graph-tick is-middle" style="left:50%;transform:translateX(-50%)">-30s</span>' +
      '<span class="mc-graph-tick is-middle" style="left:75%;transform:translateX(-50%)">-15s</span>' +
      '<span class="mc-graph-tick is-end" style="right:0">now</span>' +
      '</div></div>';
  }

  // --- card rendering ----------------------------------------------------------

  function cardTitle(entry) {
    return entry.sessionTitle || entry.identity || 'unknown';
  }

  function cardHtml(entry, state, position) {
    var active = state === 'active';
    var tags =
      '<span class="mc-tag">' + esc(entry.identity || 'unknown') + '</span>' +
      '<span class="mc-tag model">' + esc(entry.model || '?') + '</span>' +
      '<span class="mc-tag">' + esc(entry.kind || 'call') + '</span>' +
      (entry.modality ? '<span class="mc-tag">' + esc(entry.modality) + '</span>' : '');
    var actions = '';
    if (active) {
      actions += '<button class="mc-btn danger" data-action="force" data-id="' + esc(entry.leaseId) + '" type="button">Force release</button>';
    } else {
      actions += '<button class="mc-btn" data-action="cancel" data-id="' + esc(entry.waiterId) + '" type="button">Cancel</button>';
    }
    return (
      '<div class="mc-sc-top">' +
        '<span class="mc-sc-state ' + (active ? 'live' : 'queued') + '"><i></i>' + (active ? 'live' : 'queued #' + position) + '</span>' +
        '<span class="mc-sc-time">' + fmtMs(active ? entry.elapsedMs : entry.waitedMs) + '</span>' +
      '</div>' +
      '<div class="mc-sc-title">' + esc(cardTitle(entry)) + '</div>' +
      (entry.description ? '<div class="mc-sc-desc" title="' + esc(entry.description) + '">“' + esc(entry.description) + '”</div>' : '') +
      '<div class="mc-sc-meta">' + tags + '</div>' +
      (actions ? '<div class="mc-sc-actions">' + actions + '</div>' : '')
    );
  }

  // --- FLIP ----------------------------------------------------------------------

  function flipSection(el, tops, prefix) {
    if (!el || reducedMotion) return;
    var nodes = el.querySelectorAll('[data-flip]');
    var seen = {};
    var moved = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var key = prefix + node.getAttribute('data-flip');
      var top = node.offsetTop;
      seen[key] = top;
      var before = tops[key];
      if (before !== undefined && before !== top) moved.push([node, before - top]);
    }
    Object.keys(tops).forEach(function (key) {
      if (key.indexOf(prefix) === 0 && seen[key] === undefined) delete tops[key];
    });
    Object.assign(tops, seen);
    if (!moved.length) return;
    moved.forEach(function (m) {
      m[0].style.transition = 'none';
      m[0].style.transform = 'translateY(' + m[1] + 'px)';
    });
    void el.offsetHeight;
    window.requestAnimationFrame(function () {
      moved.forEach(function (m) {
        var card = m[0];
        if (!card.isConnected) return;
        card.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1)';
        card.style.transform = '';
        window.setTimeout(function () { card.style.transition = ''; card.style.transform = ''; }, 340);
      });
    });
  }

  // --- queue card lifecycle ------------------------------------------------------

  var queueCards = new Map(); // queue id -> {el, activeEl, queueEl, tops, prevActive, prevWaiters}

  function ensureQueueCard(queue, index) {
    var existing = queueCards.get(queue.id);
    if (existing) return existing;
    var el = document.createElement('section');
    el.className = 'mc-provider ' + TONES[index % TONES.length];
    el.innerHTML =
      '<div class="mc-provider-head">' +
        '<div style="min-width:0">' +
          '<div class="mc-provider-name"></div>' +
          '<div class="mc-provider-sub"></div>' +
        '</div>' +
        '<div class="mc-util"><strong></strong><span></span><small>active + queued</small></div>' +
      '</div>' +
      '<div class="mc-graph-slot"></div>' +
      '<div class="mc-capbar"><span></span></div>' +
      '<div class="mc-section mc-active-section">' +
        '<div class="mc-section-head">Active <span class="mc-count">0</span></div>' +
        '<div class="mc-list mc-active-list"><div class="mc-empty-card">No active calls</div></div>' +
      '</div>' +
      '<div class="mc-section mc-queue-section">' +
        '<div class="mc-section-head">Queue <span class="mc-count">0</span></div>' +
        '<div class="mc-list mc-queue-list"><div class="mc-empty-card">Queue empty</div></div>' +
      '</div>';
    var grid = document.getElementById('mc-queues');
    grid.appendChild(el);
    var card = {
      el: el,
      activeEl: el.querySelector('.mc-active-list'),
      queueEl: el.querySelector('.mc-queue-list'),
      tops: {},
      prevActive: null,
      prevWaiters: null,
    };
    queueCards.set(queue.id, card);
    return card;
  }

  function reconcileList(listEl, items, keyOf, render, card, section, prevList, ghostBag, enteringSet) {
    var prevKeys = prevList ? new Map(prevList.map(function (entry, i) { return [keyOf(entry), i]; })) : new Map();
    var newKeys = new Map(items.map(function (entry, i) { return [keyOf(entry), i]; }));
    var existing = new Map();
    for (var i = 0; i < listEl.children.length; i += 1) {
      var child = listEl.children[i];
      if (child.dataset && child.dataset.flip) existing.set(child.dataset.flip, child);
    }
    // ghosts for entries that left (and did not promote)
    if (!reducedMotion) {
      prevKeys.forEach(function (index, key) {
        if (newKeys.has(key)) return;
        if (enteringSet && enteringSet.has(key)) return; // promoted upstairs, no poof
        var node = existing.get(key);
        if (!node) return;
        var clone = node.cloneNode(true);
        clone.classList.add('mc-ghost');
        clone.removeAttribute('data-flip');
        clone.setAttribute('aria-hidden', 'true');
        clone.addEventListener('animationend', function (event) {
          if (event.animationName === 'mc-poof') clone.remove();
        });
        listEl.insertBefore(clone, listEl.children[Math.min(index, listEl.children.length)]);
        ghostBag.push(clone);
      });
    }
    // build / move / update
    items.forEach(function (entry, index) {
      var key = keyOf(entry);
      var node = existing.get(key);
      if (node) {
        node.innerHTML = render(entry, index);
      } else {
        node = document.createElement('div');
        node.className = 'mc-session-card ' + (section === 'active' ? 'mc-live' : 'mc-queued');
        if (enteringSet && enteringSet.has(key)) node.classList.add('mc-enter');
        node.dataset.flip = key;
        node.innerHTML = render(entry, index);
      }
      listEl.appendChild(node); // appendChild moves it into order
    });
    // drop nodes for entries that are gone (their ghosts took their place)
    existing.forEach(function (node, key) {
      if (!newKeys.has(key)) node.remove();
    });
    // empty state
    var empty = items.length === 0 && (!ghostBag || ghostBag.length === 0);
    var emptyCard = listEl.querySelector(':scope > .mc-empty-card');
    if (empty && !emptyCard) {
      var e = document.createElement('div');
      e.className = 'mc-empty-card';
      e.textContent = section === 'active' ? 'No active calls' : 'Queue empty';
      listEl.appendChild(e);
    } else if (!empty && emptyCard) {
      emptyCard.remove();
    }
  }

  function renderQueue(queue, index) {
    var card = ensureQueueCard(queue, index);
    var demand = queue.active.length + queue.waiters.length;
    var pct = queue.unlimited ? 100 : Math.min(100, Math.round((demand / Math.max(1, queue.limit)) * 100));
    card.el.querySelector('.mc-provider-name').textContent = queue.id;
    card.el.querySelector('.mc-provider-sub').textContent = queue.unlimited
      ? 'unlimited concurrency · never queues'
      : queue.limit + ' concurrent model call' + (queue.limit === 1 ? '' : 's');
    card.el.querySelector('.mc-util strong').textContent = demand;
    card.el.querySelector('.mc-util span').textContent = '/' + (queue.unlimited ? '∞' : queue.limit);
    card.el.classList.toggle('is-waiting', queue.waiters.length > 0);
    card.el.querySelector('.mc-capbar').classList.toggle('is-waiting', queue.waiters.length > 0);
    card.el.querySelector('.mc-capbar > span').style.width = pct + '%';
    card.el.querySelector('.mc-graph-slot').innerHTML = graphHtml(queue.history60 || []);
    card.el.querySelector('.mc-active-section .mc-count').textContent = queue.active.length;
    card.el.querySelector('.mc-queue-section .mc-count').textContent = queue.waiters.length;

    // promotion detection: an active lease whose (identityId+model) matches a waiter that left
    var entering = new Set();
    if (card.prevWaiters) {
      var prevWaiterKeys = new Map(card.prevWaiters.map(function (w) { return [w.identityId + '::' + w.model, w]; }));
      var prevActiveKeys = new Set((card.prevActive || []).map(function (l) { return l.identityId + '::' + l.model; }));
      queue.active.forEach(function (lease) {
        var key = lease.identityId + '::' + lease.model;
        var prev = prevWaiterKeys.get(key);
        if (prev && !prevActiveKeys.has(key)) entering.add(lease.leaseId);
      });
    }

    var ghostBag = [];
    reconcileList(card.activeEl, queue.active, function (e) { return e.leaseId; },
      function (e) { return cardHtml(e, 'active', 0); }, card, 'active', card.prevActive, ghostBag, null);
    reconcileList(card.queueEl, queue.waiters, function (e) { return e.waiterId; },
      function (e) { return cardHtml(e, 'queued', e.position); }, card, 'queue', card.prevWaiters, ghostBag, null);

    flipSection(card.activeEl, card.tops, 'a:');
    flipSection(card.queueEl, card.tops, 'q:');

    card.prevActive = queue.active;
    card.prevWaiters = queue.waiters;
  }

  // --- top-level render ------------------------------------------------------------

  var lastFrame = null;
  var receivedAt = 0; // Date.now() at the instant lastFrame was rendered

  function renderKpis(frame) {
    var kpis = [
      { key: 'active', value: frame.totals.active, label: 'active calls', hint: 'leases held right now', tone: KPI_TONES[0] },
      { key: 'waiting', value: frame.totals.waiting, label: 'waiting', hint: 'in FIFO queues', tone: KPI_TONES[1] },
      { key: 'identities', value: (frame.identities || []).length, label: 'identities', hint: 'connected processes', tone: KPI_TONES[2] },
      { key: 'uptime', value: fmtMs(frame.uptimeMs), label: 'daemon up', hint: 'since last restart', tone: KPI_TONES[3] },
    ];
    document.getElementById('mc-kpis').innerHTML = kpis.map(function (k) {
      return '<div class="mc-kpi ' + k.tone + '"><div class="mc-kpi-value" data-kpi="' + k.key + '">' + esc(k.value) + '</div>' +
        '<div class="mc-kpi-label">' + esc(k.label) + '</div><div class="mc-kpi-hint">' + esc(k.hint) + '</div></div>';
    }).join('');
  }

  function renderIdentities(frame) {
    var section = document.getElementById('mc-identities-section');
    var list = frame.identities || [];
    section.hidden = list.length === 0;
    document.getElementById('mc-identities-count').textContent = list.length;
    document.getElementById('mc-identities').innerHTML = list.map(function (identity) {
      return '<div class="mc-identity-row"><b>' + esc(identity.identity) + '</b>' +
        '<span>' + esc(identity.harness) + ' · pid ' + esc(identity.pid) + ' · ' + esc(identity.host) + '</span>' +
        '<span class="mc-dim">' + identity.leases + ' lease' + (identity.leases === 1 ? '' : 's') + ' · ' + identity.waiters + ' waiting</span></div>';
    }).join('');
  }

  function render(frame, meta) {
    lastFrame = frame;
    receivedAt = Date.now();
    renderKpis(frame);
    renderIdentities(frame);
    var seen = new Set();
    frame.queues.forEach(function (queue, index) {
      seen.add(queue.id);
      renderQueue(queue, index);
    });
    // drop cards for queues that no longer exist
    queueCards.forEach(function (card, id) {
      if (!seen.has(id)) {
        card.el.remove();
        queueCards.delete(id);
      }
    });
    var sub = document.getElementById('mc-sub');
    sub.textContent = 'model-call queue · one FIFO per GPU · ' + frame.queues.length + ' queue' + (frame.queues.length === 1 ? '' : 's') + ' · v' + (frame.version || '?') + ((meta && meta.simulated) ? ' · simulated' : '');
    ensureTick();
  }

  // --- local clock tick ---------------------------------------------------------------
  // Between frames, only the durations change. This rewrites just those text nodes —
  // no reconciliation, no FLIP, no graph rebuild — so the timers move in realtime
  // whether or not a frame arrived in the last second.

  var tickTimer = null;

  function tickList(listEl, items, idField, timeField) {
    if (!listEl || !items) return;
    var byId = Object.create(null);
    for (var i = 0; i < items.length; i += 1) byId[items[i][idField]] = items[i][timeField];
    var children = listEl.children;
    for (var j = 0; j < children.length; j += 1) {
      var node = children[j];
      var key = node.dataset && node.dataset.flip; // ghosts drop theirs, so they freeze
      if (!key || !(key in byId)) continue;
      var span = node.querySelector('.mc-sc-time');
      if (!span) continue;
      var next = fmtMs(tickValue(byId[key], receivedAt, Date.now()));
      if (span.textContent !== next) span.textContent = next;
    }
  }

  function tickTimes() {
    if (!lastFrame) return;
    var now = Date.now();
    var up = document.querySelector('#mc-kpis [data-kpi="uptime"]');
    if (up && typeof lastFrame.uptimeMs === 'number') {
      up.textContent = fmtMs(tickValue(lastFrame.uptimeMs, receivedAt, now));
    }
    lastFrame.queues.forEach(function (queue) {
      var card = queueCards.get(queue.id);
      if (!card) return;
      tickList(card.activeEl, queue.active, 'leaseId', 'elapsedMs');
      tickList(card.queueEl, queue.waiters, 'waiterId', 'waitedMs');
    });
  }

  function ensureTick() {
    if (tickTimer === null && !document.hidden) tickTimer = window.setInterval(tickTimes, TICK_MS);
  }

  function stopTick() {
    if (tickTimer !== null) { window.clearInterval(tickTimer); tickTimer = null; }
  }

  // --- simulated feed ---------------------------------------------------------------
  // sim.js mints daemon-shaped frames locally. Two ways in: the Simulate button
  // (manual — detaches the feed and drives the page from the simulator) and an
  // offline feed (automatic — the simulator covers the gap and steps aside the
  // moment a real frame arrives again).

  var simMode = null; // null | 'manual' | 'auto'
  var simTimer = null;
  var sim = null;
  var simButton = document.getElementById('mc-sim-btn');

  function simReady() {
    return !!(window.TAN_SIM && typeof window.TAN_SIM.createSimulator === 'function');
  }

  function paintSimButton() {
    if (!simButton) return;
    var on = simMode !== null;
    simButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    simButton.classList.toggle('is-on', on);
    simButton.textContent = on ? 'Stop simulating' : 'Simulate';
    simButton.title = on
      ? 'Frames are being generated locally — click to return to the live feed'
      : 'Drive the dashboard from a locally simulated feed (no daemon needed)';
  }

  function paintSim() {
    if (!sim) return;
    render(sim.tick(Date.now()), { simulated: true });
  }

  function startSim(mode) {
    if (simMode !== null || !simReady()) return;
    simMode = mode;
    sim = window.TAN_SIM.createSimulator({ now: Date.now(), seed: (Date.now() % 100000) + 1 });
    if (mode === 'manual') detachFeed();
    paintSimButton();
    paintSim();
    simTimer = window.setInterval(paintSim, SIM_TICK_MS);
    setStatus('simulated');
  }

  function stopSim() {
    if (simTimer !== null) { window.clearInterval(simTimer); simTimer = null; }
    var wasManual = simMode === 'manual';
    simMode = null;
    sim = null;
    paintSimButton();
    return wasManual;
  }

  function toggleSim() {
    if (simMode === 'manual') {
      if (stopSim()) resumeFeed();
    } else if (simMode === 'auto') {
      simMode = 'manual'; // take ownership of a simulator the outage already started
      detachFeed();
      paintSimButton();
    } else {
      startSim('manual');
    }
  }

  function setStatus(mode) {
    if (simMode !== null && mode !== 'simulated') return; // the simulator owns the badge while it runs
    var el = document.getElementById('mc-status');
    var text = document.getElementById('mc-status-text');
    el.classList.remove('off', 'warn', 'sim');
    if (mode === 'stream') text.textContent = 'live';
    else if (mode === 'poll') { el.classList.add('warn'); text.textContent = 'polling'; }
    else if (mode === 'simulated') { el.classList.add('sim'); text.textContent = 'simulated'; }
    else {
      el.classList.add('off');
      text.textContent = 'offline';
      // no daemon, no data: simulate rather than show a dead page
      if (simMode === null && simReady()) startSim('auto');
    }
  }

  // --- feed -------------------------------------------------------------------------

  var stallTimer = null;
  var pollTimer = null;
  var failures = 0;
  var generation = 0;

  function armStall() {
    if (stallTimer !== null) window.clearTimeout(stallTimer);
    var mine = generation;
    stallTimer = window.setTimeout(function () {
      stallTimer = null;
      if (mine === generation) fallBack();
    }, STALL_MS);
  }

  function stopPoll() {
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  // The Simulate toggle takes the page away from the feed entirely: bump the
  // generation so in-flight retries and backoff timers invalidate themselves,
  // abort the stream, and stop polling. resumeFeed() re-opens the stream; the
  // visibility listener registered by start() stays in place.
  function detachFeed() {
    generation += 1;
    controllers.forEach(function (c) { try { c.abort(); } catch (e) { /* closed */ } });
    controllers.clear();
    stopPoll();
    if (stallTimer !== null) { window.clearTimeout(stallTimer); stallTimer = null; }
    failures = 0;
  }

  function resumeFeed() {
    failures = 0;
    openStream();
  }

  // A real frame ends an automatic simulation; the badge hands back before render.
  function noteRealFrame() {
    if (simMode === 'auto') stopSim();
  }

  function fallBack() {
    var mine = generation;
    var controller = null;
    controllers.forEach(function (c) { controller = c; });
    if (controller) { try { controller.abort(); } catch (e) { /* closed */ } }
    failures += 1;
    if (pollTimer === null) {
      setStatus('poll');
      pollOnce();
      pollTimer = window.setInterval(pollOnce, FALLBACK_POLL_MS);
    }
    var delay = Math.min(30000, 2000 * Math.pow(2, Math.min(failures, 5)));
    window.setTimeout(function () {
      if (mine === generation) openStream();
    }, delay);
  }

  function pollOnce() {
    fetch(authed(BASE + '/api/status')).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    }).then(function (frame) {
      if (pollTimer !== null) { stopPoll(); }
      failures = 0;
      noteRealFrame();
      setStatus('poll'); // a recovered feed must not leave a stale badge behind
      render(frame);
    }).catch(function () {
      setStatus('offline');
    });
  }

  function openStream() {
    if (pollTimer !== null) stopPoll();
    var mine = generation;
    var controller = new AbortController();
    controllers.add(controller);
    setStatus('poll');
    armStall();
    fetch(authed(BASE + '/api/events'), { signal: controller.signal }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('stream unavailable');
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (mine !== generation) return undefined;
          if (chunk.done) throw new Error('stream closed');
          armStall();
          buffer += decoder.decode(chunk.value, { stream: true });
          var cut;
          while ((cut = buffer.indexOf('\n')) >= 0) {
            var line = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 1);
            if (line === '') continue;
            var frame;
            try { frame = JSON.parse(line); } catch (e) { continue; }
            if (frame.type === 'keepalive') continue;
            failures = 0;
            noteRealFrame();
            setStatus('stream');
            render(frame);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      controllers.delete(controller);
      if (mine === generation) fallBack();
    });
  }

  function start() {
    openStream();
    document.addEventListener('visibilitychange', function onVis() {
      if (document.hidden) {
        stopTick();
        generation += 1;
        controllers.forEach(function (c) { try { c.abort(); } catch (e) { /* closed */ } });
        controllers.clear();
        stopPoll();
        if (stallTimer !== null) window.clearTimeout(stallTimer);
      } else {
        tickTimes();
        ensureTick();
        if (simMode !== 'manual' && pollTimer === null && controllers.size === 0) start();
      }
    });
  }

  // --- actions ------------------------------------------------------------------------

  document.getElementById('mc-queues').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var action = button.dataset.action;
    var id = button.dataset.id;
    if (action === 'force') {
      if (!window.confirm('Force-release this lease? The underlying model call may still be running; this can exceed the queue limit.')) return;
      fetch(authed(BASE + '/api/force-release'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: id }) }).catch(function () {});
    } else if (action === 'cancel') {
      fetch(authed(BASE + '/api/cancel'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ waiterId: id }) }).catch(function () {});
    }
  });

  // --- limits modal ---------------------------------------------------------------------

  var modal = document.getElementById('mc-modal');

  function openLimits() {
    if (!lastFrame) return;
    var rows = lastFrame.queues.map(function (queue) {
      return '<div class="mc-limit-row">' +
        '<span class="mc-limit-name">' + esc(queue.id) + '</span>' +
        '<label class="mc-limit-unlimited"><input type="checkbox" class="mc-limit-check" data-id="' + esc(queue.id) + '"' + (queue.unlimited ? ' checked' : '') + '> unlimited</label>' +
        '<input class="mc-input mc-limit-number" type="number" min="1" step="1" data-id="' + esc(queue.id) + '" value="' + (queue.unlimited ? 1 : queue.limit) + '"' + (queue.unlimited ? ' disabled' : '') + '>' +
        '<span class="mc-limit-label">calls</span>' +
      '</div>';
    }).join('');
    document.getElementById('mc-limit-rows').innerHTML = rows || '<div class="mc-empty">No queues configured.</div>';
    document.getElementById('mc-queue-limit').value = 1000;
    document.getElementById('mc-unmapped').value = 'unlimited';
    modal.hidden = false;
  }

  document.querySelectorAll('.mc-limit-row .mc-limit-check').forEach(function () {});
  document.getElementById('mc-limit-rows').addEventListener('change', function (event) {
    if (event.target.classList.contains('mc-limit-check')) {
      var input = document.querySelector('.mc-limit-number[data-id="' + event.target.dataset.id + '"]');
      if (input) input.disabled = event.target.checked;
    }
  });

  document.getElementById('mc-limits-btn').addEventListener('click', openLimits);
  document.getElementById('mc-modal-close').addEventListener('click', function () { modal.hidden = true; });
  document.getElementById('mc-modal-cancel').addEventListener('click', function () { modal.hidden = true; });
  document.getElementById('mc-modal-apply').addEventListener('click', function () {
    var queues = Array.from(document.querySelectorAll('.mc-limit-row')).map(function (row) {
      var id = row.querySelector('.mc-limit-name').textContent;
      var unlimited = row.querySelector('.mc-limit-check').checked;
      var limit = Number(row.querySelector('.mc-limit-number').value) || 1;
      return unlimited ? { id: id, limit: null, unlimited: true } : { id: id, limit: limit };
    });
    var payload = {
      queues: queues,
      unmapped: document.getElementById('mc-unmapped').value,
      queueLimit: Number(document.getElementById('mc-queue-limit').value) || 1000,
    };
    fetch(authed(BASE + '/api/set-limits'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) { return res.json(); })
      .then(function () { modal.hidden = true; })
      .catch(function () {});
  });

  // --- simulate toggle ------------------------------------------------------------------

  if (simButton) simButton.addEventListener('click', toggleSim);
  paintSimButton();

  start();
})();
