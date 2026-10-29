// ==UserScript==
// @name         Travian Elephant Finder (userscript)
// @namespace    travian-elephant-finder
// @version      0.3.5
// @description  Recherche les oasis gardées par des éléphants autour de votre village, depuis votre session de jeu déjà ouverte.
// @match        https://*.travian.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Fonctionnement :
 *  1. Phase "carte" : interroge l'API que la carte du jeu utilise elle-même quand on la fait
 *     défiler (api/v1/map/position). Chaque réponse couvre un bloc de cases : on repère ainsi
 *     les oasis libres avec très peu de requêtes.
 *  2. Phase "détails" : pour chaque oasis libre dont la carte n'a pas donné les animaux,
 *     ouvre le détail de la case (api/v1/map/tile-details), comme un clic sur la carte,
 *     avec une pause aléatoire de plusieurs secondes entre chaque.
 *  3. Affiche les oasis avec éléphants dans un panneau, triées par distance, et garde le
 *     résultat en mémoire locale (localStorage) pour le retrouver après un rechargement.
 *
 * Aucun identifiant n'est lu ni stocké : les requêtes partent de votre onglet connecté.
 */

(() => {
  'use strict';

  const ORIGIN = window.location.origin;
  const STORE_KEY = 'tef:state';

  const ANIMALS = {
    u31: 'Rats', u32: 'Araignées', u33: 'Serpents', u34: 'Chauves-souris', u35: 'Sangliers',
    u36: 'Loups', u37: 'Ours', u38: 'Crocodiles', u39: 'Tigres', u40: 'Éléphants',
  };
  const ELEPHANT = 'u40';

  // ---------- réglages (modifiables dans le panneau) ----------
  const defaults = {
    distance: 15,
    delayMin: 3000, // ms entre deux requêtes de détail
    delayMax: 8000,
    // ms entre deux blocs de carte. Le jeu lui-même enchaîne ces requêtes plusieurs fois
    // par seconde quand on fait défiler la carte : inutile d'attendre des secondes.
    mapPauseMin: 500,
    mapPauseMax: 1500,
  };
  // Niveau de zoom de la carte. Zoom 2 : blocs de 21 x 17 cases, c'est ce qu'utilise le
  // crop finder de ResourceBarPlus. Au zoom 3 ce serveur (à régions) renvoie une vue par
  // région sans le type des cases ; si le zoom 2 fait pareil, on retombe sur le zoom 1
  // (blocs de 11 x 9).
  const ZOOM_PREFERRED = 2;
  const ZOOM_FALLBACK = 1;

  // ---------- état ----------
  const state = loadState();
  let running = false;
  let abort = false;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { results: [], oases: [], log: '', ...parsed, settings: { ...defaults, ...(parsed.settings || {}) } };
      }
    } catch (_) { /* ignore */ }
    return { settings: { ...defaults }, results: [], oases: [], log: '' };
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  // ---------- utilitaires ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const key = (x, y) => `${x},${y}`;
  const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);

  function gameVersion() {
    try {
      if (window.Travian && window.Travian.applicationVersion) return String(window.Travian.applicationVersion);
    } catch (_) { /* ignore */ }
    const s = [...document.scripts].map((el) => el.src).find((src) => /\?[0-9a-f.]+$/i.test(src));
    return s ? s.split('?').pop() : '';
  }

  async function apiPost(path, body) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const v = gameVersion();
    if (v) headers['X-Version'] = v;
    const res = await fetch(`${ORIGIN}/api/v1/${path}`, {
      method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Session expirée ou refusée (HTTP ${res.status}). Rechargez la page du jeu.`);
    if (!res.ok) { const err = new Error(`HTTP ${res.status} sur ${path}`); err.status = res.status; throw err; }
    return res.json();
  }

  // Coordonnées du village actif, lues dans la page (le jeu rend le moins en U+2212).
  function ownCoordinates() {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const n = el.textContent.replace(/−/g, '-').replace(/[^0-9-]/g, '');
      return n === '' || n === '-' ? null : parseInt(n, 10);
    };
    const x = read('.coordinateX');
    const y = read('.coordinateY');
    return x === null || y === null ? null : { x, y };
  }

  // Lit "<i class="unit u40"></i> 3" ou variantes dans un fragment HTML/texte.
  function parseUnitsFromText(text) {
    if (!text) return null;
    const troops = [];
    const re = /unit u(\d{2})[^>]*>(?:<\/i>)?[^\d<]*(?:<[^>]*>[^\d<]*)*?(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const u = `u${m[1]}`;
      if (ANIMALS[u]) troops.push({ u, n: parseInt(m[2], 10), name: ANIMALS[u] });
    }
    return troops.length ? troops : null;
  }

  // Parse la réponse de tile-details (même logique que le script Node d'origine).
  function parseTileDetails(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const details = doc.querySelector('#tileDetails');
    const cls = details ? details.className : '';
    const isOasis = /\boasis\b/.test(cls);
    const occupied = /\boasis-3\b/.test(cls);
    const troops = [];
    doc.querySelectorAll('#troop_info tr').forEach((tr) => {
      const img = tr.querySelector('img.unit, i.unit');
      const u = img ? [...img.classList].find((c) => /^u\d+$/.test(c)) : null;
      const n = parseInt((tr.querySelector('.val') || {}).textContent, 10);
      if (!u || !Number.isFinite(n)) return;
      troops.push({ u, n, name: ANIMALS[u] || (tr.querySelector('.desc') || {}).textContent || u });
    });
    return { isOasis, occupied, troops };
  }

  // Garde quelques tuiles de formes différentes pour le diagnostic (bouton du panneau).
  function collectSamples(data, tiles) {
    state.samples = state.samples || {};
    if (!state.samples.__keys) state.samples.__keys = Object.keys(data || {});
    for (const t of tiles) {
      const shape = [(t.title || '').replace(/\{k\.regionTooltip\}.*/, '{k.regionTooltip}'), (t.text || '').replace(/-?\d+/g, '#').replace(/<span class="coordinates[\s\S]*$/, '').slice(0, 80), t.did > 0 ? 'did+' : t.did < 0 ? 'did-' : 'did0', t.uid ? 'uid' : '', Object.keys(t).sort().join('|')].join(' / ');
      if (!state.samples[shape] && Object.keys(state.samples).length < 20) state.samples[shape] = t;
    }
    saveState();
  }

  // ---------- scan ----------
  // La carte est un tore : au-delà de +R on revient en -R (R = 200 sur un monde standard).
  // Le rayon R est déduit de la première réponse de la carte si un bloc chevauche le bord.
  async function scan(center, settings, ui) {
    const r = settings.distance;
    let mapR = 200;
    const width = () => 2 * mapR + 1;
    const wrap = (v) => { const w = width(); return ((((v + mapR) % w) + w) % w) - mapR; };
    const wdist = (x1, y1, x2, y2) => Math.hypot(wrap(x1 - x2), wrap(y1 - y2));

    const needed = new Map(); // positions (repliées) à couvrir
    const buildNeeded = () => {
      needed.clear();
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.hypot(dx, dy) <= r) {
            const x = wrap(center.x + dx); const y = wrap(center.y + dy);
            needed.set(key(x, y), { x, y });
          }
        }
      }
    };
    buildNeeded();

    const covered = new Set();
    const candidates = new Map(); // oasis libres repérées sur la carte
    let mapRequests = 0;
    let sampleLogged = false;
    let halfW = 0; let halfH = 0; let mapFailed = false;
    let zoom = ZOOM_PREFERRED;
    const hasTileTypes = (tiles) => tiles.some((t) => /\{k\.(fo|bt|dt|vt)\}/.test(t?.title || ''));

    ui.log(`Centre (${center.x}|${center.y}), rayon ${r} : ${needed.size} cases à couvrir.`);

    const processTiles = (tiles) => {
      for (const t of tiles) {
        const px = t?.position?.x; const py = t?.position?.y;
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        covered.add(key(px, py));
        if (!needed.has(key(px, py))) continue;
        // Oasis libre : titre "{k.fo}" (did = -1). Son texte contient "{k.animals}" suivi des
        // gardiens sous la forme <i class="unit u40"></i><span class="value">3</span>.
        // "{k.bt}" est une oasis occupée, "{k.dt}" un village, "{k.vt} {k.fN}" une case libre.
        const title = t.title || '';
        const text = t.text || '';
        const freeOasis = /\{k\.fo\}/.test(title) || (!(t.did > 0) && /\{k\.animals\}/.test(text));
        if (freeOasis) {
          let troops = parseUnitsFromText(text);
          if (!troops && !/\{k\.animals\}/.test(text)) troops = []; // oasis sans animaux
          candidates.set(key(px, py), { x: px, y: py, troops });
          // Affichage immédiat, bloc par bloc, sans attendre la fin de la phase carte.
          if (troops) record(px, py, troops, wdist(px, py, center.x, center.y), ui);
        }
      }
    };

    // Taille d'un bloc à partir des coordonnées distinctes renvoyées. Si elles ne sont pas
    // contiguës, le bloc chevauche le bord du monde : l'écart donne le rayon du monde.
    const measure = (values) => {
      const v = [...new Set(values)].sort((a, b) => a - b);
      if (v.length < 2) return { size: v.length, wrapRadius: null };
      const contiguous = v[v.length - 1] - v[0] + 1 === v.length;
      return { size: v.length, wrapRadius: contiguous ? null : (v[v.length - 1] - v[0]) / 2 };
    };

    const fetchBlock = async (rawX, rawY) => {
      const cx = wrap(rawX); const cy = wrap(rawY);
      mapRequests++;
      ui.status(`Carte : bloc ${mapRequests} autour de (${cx}|${cy})…`);
      let data;
      try {
        data = await apiPost('map/position', { data: { x: cx, y: cy, zoomLevel: zoom, ignorePositions: [] } });
      } catch (e) {
        if (e.status === 400) {
          // Bloc refusé (hors carte ?) : on le note et on continue avec les autres.
          ui.log(`Bloc (${cx}|${cy}) refusé par le serveur (HTTP 400), ignoré.`);
          covered.add(key(cx, cy));
          return false;
        }
        ui.log(`Carte indisponible (${e.message}).`);
        mapFailed = true;
        return false;
      }
      let tiles = Array.isArray(data?.tiles) ? data.tiles : [];
      if (!halfW && zoom !== ZOOM_FALLBACK && tiles.length && !hasTileTypes(tiles)) {
        // Vue par région sans type de case : on refait ce bloc au zoom rapproché.
        ui.log(`Le zoom ${zoom} ne détaille pas les cases sur ce serveur, passage au zoom ${ZOOM_FALLBACK}.`);
        zoom = ZOOM_FALLBACK;
        await sleep(rand(settings.mapPauseMin, settings.mapPauseMax));
        return fetchBlock(cx, cy);
      }
      if (!sampleLogged && tiles.length) {
        sampleLogged = true;
        console.log('[ElephantFinder] clés de la réponse carte :', Object.keys(data), '— exemple :', tiles[0]);
      }
      collectSamples(data, tiles);
      covered.add(key(cx, cy)); // évite une boucle infinie si le bloc ne renvoie rien
      if (!halfW && tiles.length > 1) {
        const mx = measure(tiles.map((t) => t?.position?.x).filter(Number.isFinite));
        const my = measure(tiles.map((t) => t?.position?.y).filter(Number.isFinite));
        const wrapRadius = mx.wrapRadius || my.wrapRadius;
        if (wrapRadius && wrapRadius !== mapR) { mapR = wrapRadius; buildNeeded(); }
        else {
          const maxAbs = Math.max(...tiles.map((t) => Math.max(Math.abs(t.position.x), Math.abs(t.position.y))));
          if (maxAbs > mapR) { mapR = maxAbs > 200 ? 400 : mapR; buildNeeded(); }
        }
        halfW = Math.max(0, Math.floor((mx.size - 1) / 2));
        halfH = Math.max(0, Math.floor((my.size - 1) / 2));
        console.log(`[ElephantFinder] zoom ${zoom}, bloc ${mx.size} x ${my.size} cases, rayon du monde ${mapR}`);
      }
      processTiles(tiles);
      ui.progress([...needed.keys()].filter((k) => covered.has(k)).length / needed.size, 'carte');
      await sleep(rand(settings.mapPauseMin, settings.mapPauseMax));
      return true;
    };

    const hasUncovered = (cx, cy, hw, hh) => {
      for (let x = cx - hw; x <= cx + hw; x++) {
        for (let y = cy - hh; y <= cy + hh; y++) {
          const k = key(wrap(x), wrap(y));
          if (needed.has(k) && !covered.has(k)) return true;
        }
      }
      return false;
    };

    // Phase 1 : blocs de carte. Le premier, centré sur le centre de recherche, sert à
    // mesurer la taille d'un bloc ; les suivants sont posés en grille pour couvrir la zone
    // sans recouvrement. Un dernier passage rattrape les cases qui resteraient découvertes.
    await fetchBlock(center.x, center.y);
    if (!mapFailed && !abort && halfW) {
      const bw = 2 * halfW + 1; const bh = 2 * halfH + 1;
      for (let cx = center.x - r + halfW; cx - halfW <= center.x + r && !abort && !mapFailed; cx += bw) {
        for (let cy = center.y - r + halfH; cy - halfH <= center.y + r && !abort && !mapFailed; cy += bh) {
          if (hasUncovered(cx, cy, halfW, halfH)) await fetchBlock(cx, cy);
        }
      }
    }
    let guard = 0;
    while (!abort && !mapFailed && guard++ < 50) {
      const next = [...needed.values()].find((p) => !covered.has(key(p.x, p.y)));
      if (!next) break;
      const ok = await fetchBlock(next.x + halfW, next.y + halfH);
      if (!ok) covered.add(key(next.x, next.y));
    }
    if (abort) return;

    // Si aucune oasis n'a de gardiens lisibles à ce zoom, c'est que la carte ne les donne
    // pas : on les demandera en détail plutôt que de les croire vides.
    if (candidates.size && ![...candidates.values()].some((c) => c.troops && c.troops.length)) {
      for (const c of candidates.values()) c.troops = null;
    }
    const uncovered = [...needed.values()].filter((p) => !covered.has(key(p.x, p.y)));
    const fromMap = [...candidates.values()].filter((c) => c.troops).length;
    ui.log(`${mapRequests} blocs de carte, ${candidates.size} oasis libres repérées (${fromMap} avec gardiens déjà connus), ${uncovered.length} cases non couvertes.`);

    // Phase 2 : détails des oasis sans gardiens connus, puis des cases non couvertes.
    // Les cases non couvertes ne sont ouvertes que si elles sont peu nombreuses : sinon
    // c'est que la carte a échoué, et 600 requêtes de détail seraient bien plus voyantes.
    const MAX_UNCOVERED_DETAILS = 40;
    if (uncovered.length > MAX_UNCOVERED_DETAILS) {
      ui.log(`${uncovered.length} cases non couvertes par la carte : trop pour les ouvrir une par une, relancez le scan plus tard.`);
    }
    const toCheck = [
      ...[...candidates.values()].filter((c) => !c.troops),
      ...(uncovered.length <= MAX_UNCOVERED_DETAILS ? uncovered.map((p) => ({ x: p.x, y: p.y })) : []),
    ].map((p) => ({ ...p, d: wdist(p.x, p.y, center.x, center.y) })).sort((a, b) => a.d - b.d);

    const totalDelay = toCheck.length * (settings.delayMin + settings.delayMax) / 2;
    if (toCheck.length) ui.log(`${toCheck.length} cases à ouvrir en détail (~${Math.ceil(totalDelay / 60000)} min).`);

    for (let i = 0; i < toCheck.length && !abort; i++) {
      const { x, y, d } = toCheck[i];
      ui.status(`Détails ${i + 1}/${toCheck.length} : (${x}|${y})`);
      ui.progress((i + 1) / toCheck.length, 'détails');
      try {
        const data = await apiPost('map/tile-details', { x, y });
        const { isOasis, occupied, troops } = parseTileDetails(data?.html || '');
        if (isOasis && !occupied) record(x, y, troops, d, ui);
      } catch (e) {
        ui.log(`(${x}|${y}) : ${e.message}`);
        if (/Session/.test(e.message)) break;
      }
      // Pause aléatoire ; une pause plus longue de temps en temps, comme un joueur distrait.
      let pause = rand(settings.delayMin, settings.delayMax);
      if (Math.random() < 0.08) pause += rand(10000, 25000);
      await sleep(pause);
    }

    const inRadius = state.results.filter((o) => wdist(o.x, o.y, center.x, center.y) <= r).length;
    const totals = {};
    for (const o of state.oases || []) {
      if (wdist(o.x, o.y, center.x, center.y) > r) continue;
      for (const t of o.troops) totals[t.name] = (totals[t.name] || 0) + t.n;
    }
    const summary = Object.entries(totals).map(([n, c]) => `${c} ${n}`).join(', ') || 'aucun animal';
    ui.log(abort ? 'Scan interrompu.' : `Scan terminé : ${inRadius} oasis avec éléphants dans le rayon. Animaux vus : ${summary}.`);
  }

  function record(x, y, troops, distance, ui) {
    const list = troops || [];
    const elephants = list.find((t) => t.u === ELEPHANT)?.n || 0;
    const row = {
      x, y, elephants,
      total: list.reduce((s, t) => s + t.n, 0),
      troops: list,
      distance,
      seen: new Date().toISOString(),
    };
    const upsert = (arr) => {
      const idx = arr.findIndex((r) => r.x === x && r.y === y);
      if (idx >= 0) arr[idx] = row; else arr.push(row);
      arr.sort((a, b) => a.distance - b.distance);
    };
    state.oases = state.oases || [];
    upsert(state.oases);
    if (elephants) upsert(state.results);
    else state.results = state.results.filter((r) => !(r.x === x && r.y === y));
    saveState();
    ui.render();
  }

  // ---------- interface ----------
  const css = `
    #tef-btn{position:fixed;right:12px;bottom:12px;z-index:99999;background:#1e293b;color:#fff;border:1px solid #475569;border-radius:20px;padding:6px 12px;cursor:pointer;font:13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)}
    #tef{position:fixed;right:12px;bottom:52px;z-index:99999;width:560px;max-width:95vw;max-height:80vh;overflow:auto;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:10px;padding:12px;font:13px system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.5)}
    #tef h3{margin:0 0 8px;font-size:15px}
    #tef .row{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-bottom:8px}
    #tef label{display:flex;align-items:center;gap:4px;color:#94a3b8}
    #tef input{width:64px;background:#1e293b;color:#e2e8f0;border:1px solid #475569;border-radius:4px;padding:2px 4px}
    #tef button{background:#334155;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}
    #tef button.primary{background:#ea580c}
    #tef button:disabled{opacity:.5;cursor:default}
    #tef .bar{height:6px;background:#1e293b;border-radius:3px;overflow:hidden;margin:4px 0}
    #tef .bar>div{height:100%;background:#38bdf8;width:0}
    #tef .status{color:#94a3b8;min-height:16px}
    #tef table{width:100%;border-collapse:collapse;margin-top:8px}
    #tef th,#tef td{padding:4px 6px;border-bottom:1px solid #1e293b;text-align:left;white-space:nowrap}
    #tef th{color:#94a3b8;font-size:11px;text-transform:uppercase}
    #tef td.n{text-align:right}
    #tef a{color:#38bdf8;font-weight:600;text-decoration:none}
    #tef .ele{color:#f97316;font-weight:800}
    #tef pre{background:#020617;color:#94a3b8;padding:6px;border-radius:4px;max-height:110px;overflow:auto;white-space:pre-wrap;font-size:11px;margin:6px 0 0}
  `;

  function buildUI() {
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    const btn = document.createElement('button'); btn.id = 'tef-btn'; btn.textContent = '🐘 Éléphants'; document.body.appendChild(btn);
    const panel = document.createElement('div'); panel.id = 'tef'; panel.style.display = 'none'; document.body.appendChild(panel);
    btn.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; };

    const own = ownCoordinates();
    const s = state.settings;
    // Coordonnées saisies la dernière fois, sinon celles du village actif.
    const startX = Number.isFinite(s.centerX) ? s.centerX : (own ? own.x : '');
    const startY = Number.isFinite(s.centerY) ? s.centerY : (own ? own.y : '');
    panel.innerHTML = `
      <h3>🐘 Elephant Finder <span style="color:#64748b;font-weight:400">· ${ORIGIN.replace('https://', '')}</span></h3>
      <div class="row">
        <label>Centre X <input id="tef-x" value="${startX}"></label>
        <label>Y <input id="tef-y" value="${startY}"></label>
        <button id="tef-own" title="Reprendre les coordonnées du village actif">Mon village</button>
        <label>Rayon <input id="tef-r" value="${s.distance}"></label>
      </div>
      <div class="row">
        <label>Pause carte (ms) <input id="tef-mmin" value="${s.mapPauseMin}"> à <input id="tef-mmax" value="${s.mapPauseMax}"></label>
        <label>Pause détails (ms) <input id="tef-dmin" value="${s.delayMin}"> à <input id="tef-dmax" value="${s.delayMax}"></label>
      </div>
      <div class="row">
        <button id="tef-start" class="primary">Lancer le scan</button>
        <button id="tef-stop" disabled>Stop</button>
        <button id="tef-csv">Exporter CSV</button>
        <button id="tef-clear">Effacer les résultats</button>
        <button id="tef-clearlog">Effacer le journal</button>
        <label><input type="checkbox" id="tef-all" style="width:auto"> Toutes les oasis</label>
        <button id="tef-diag" title="Copie dans le presse-papiers un échantillon des cases renvoyées par la carte">Diagnostic</button>
      </div>
      <div class="bar"><div id="tef-bar"></div></div>
      <div class="status" id="tef-status"></div>
      <table><thead><tr><th>Oasis</th><th>Éléphants</th><th>Gardiens</th><th>Distance</th></tr></thead><tbody id="tef-rows"></tbody></table>
      <pre id="tef-log">${state.log || ''}</pre>
    `;

    const $ = (id) => panel.querySelector(`#${id}`);
    const ui = {
      status: (t) => { $('tef-status').textContent = t; },
      progress: (f, phase) => { $('tef-bar').style.width = `${Math.round(f * 100)}%`; $('tef-bar').title = phase; },
      log: (t) => {
        const line = `${new Date().toLocaleTimeString()}  ${t}`;
        state.log = `${(state.log || '').split('\n').slice(-30).join('\n')}\n${line}`.trim();
        $('tef-log').textContent = state.log; $('tef-log').scrollTop = 1e9; saveState();
      },
      render: () => {
        const all = $('tef-all').checked;
        const rows = all ? (state.oases || []) : state.results;
        $('tef-rows').innerHTML = rows.map((r) => `
          <tr>
            <td><a href="${ORIGIN}/karte.php?x=${r.x}&y=${r.y}" target="_blank">(${r.x}|${r.y})</a></td>
            <td class="n ${r.elephants ? 'ele' : ''}">${r.elephants}</td>
            <td>${r.troops.length ? r.troops.map((t) => `${t.n} ${t.name}`).join(', ') : '<span style="color:#64748b">aucun</span>'}</td>
            <td class="n">${r.distance.toFixed(1)}</td>
          </tr>`).join('') || '<tr><td colspan="4" style="color:#64748b">Aucun résultat pour le moment.</td></tr>';
      },
    };
    $('tef-all').addEventListener('change', ui.render);
    ui.render();

    // Mémorise chaque champ dès qu'il change, pour ne pas avoir à le ressaisir.
    const remember = () => {
      const x = parseInt($('tef-x').value, 10); const y = parseInt($('tef-y').value, 10);
      s.centerX = Number.isFinite(x) ? x : undefined;
      s.centerY = Number.isFinite(y) ? y : undefined;
      const r = parseInt($('tef-r').value, 10); if (Number.isFinite(r)) s.distance = r;
      const dmin = parseInt($('tef-dmin').value, 10); if (Number.isFinite(dmin)) s.delayMin = dmin;
      const dmax = parseInt($('tef-dmax').value, 10); if (Number.isFinite(dmax)) s.delayMax = dmax;
      const mmin = parseInt($('tef-mmin').value, 10); if (Number.isFinite(mmin)) s.mapPauseMin = Math.max(0, mmin);
      const mmax = parseInt($('tef-mmax').value, 10); if (Number.isFinite(mmax)) s.mapPauseMax = Math.max(s.mapPauseMin, mmax);
      saveState();
    };
    ['tef-x', 'tef-y', 'tef-r', 'tef-dmin', 'tef-dmax', 'tef-mmin', 'tef-mmax'].forEach((id) => { $(id).addEventListener('change', remember); });
    $('tef-own').onclick = () => {
      const o = ownCoordinates();
      if (!o) { ui.log('Coordonnées du village introuvables sur cette page.'); return; }
      $('tef-x').value = o.x; $('tef-y').value = o.y; remember();
    };

    $('tef-start').onclick = async () => {
      if (running) return;
      const center = { x: parseInt($('tef-x').value, 10), y: parseInt($('tef-y').value, 10) };
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) { ui.log('Centre invalide : indiquez X et Y.'); return; }
      remember();
      Object.assign(s, {
        distance: Math.max(1, parseInt($('tef-r').value, 10) || defaults.distance),
        delayMin: Math.max(500, parseInt($('tef-dmin').value, 10) || defaults.delayMin),
        delayMax: Math.max(500, parseInt($('tef-dmax').value, 10) || defaults.delayMax),
      });
      if (s.delayMax < s.delayMin) s.delayMax = s.delayMin;
      saveState();
      running = true; abort = false;
      // Journal et résultats repartent de zéro à chaque scan.
      state.log = ''; $('tef-log').textContent = '';
      state.results = []; state.oases = []; saveState(); ui.render();
      $('tef-start').disabled = true; $('tef-stop').disabled = false;
      try { await scan(center, s, ui); } catch (e) { ui.log(`Erreur : ${e.message}`); console.error(e); }
      running = false; ui.status(''); ui.progress(0, '');
      $('tef-start').disabled = false; $('tef-stop').disabled = true;
    };
    $('tef-stop').onclick = () => { abort = true; ui.status('Arrêt en cours…'); };
    $('tef-clear').onclick = () => { state.results = []; state.oases = []; saveState(); ui.render(); };
    $('tef-clearlog').onclick = () => { state.log = ''; $('tef-log').textContent = ''; saveState(); };
    $('tef-diag').onclick = async () => {
      {
        state.samples = {};
        const cx = parseInt($('tef-x').value, 10); const cy = parseInt($('tef-y').value, 10);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) { ui.log('Centre invalide : indiquez X et Y.'); return; }
        ui.status('Diagnostic : une requête carte…');
        try {
          const data = await apiPost('map/position', { data: { x: cx, y: cy, zoomLevel: ZOOM_PREFERRED, ignorePositions: [] } });
          const tiles = Array.isArray(data?.tiles) ? data.tiles : [];
          collectSamples(data, tiles);
          state.samples.__count = tiles.length;
          if (!tiles.length) state.samples.__raw = JSON.stringify(data).slice(0, 1500);
          saveState();
        } catch (e) { ui.log(`Diagnostic : ${e.message}`); }
        ui.status('');
      }
      const txt = JSON.stringify(state.samples || {}, null, 1);
      console.log('[ElephantFinder] diagnostic :', state.samples);
      try { await navigator.clipboard.writeText(txt); ui.log('Diagnostic copié dans le presse-papiers : collez-le à Claude.'); }
      catch (_) { $('tef-log').textContent = txt; ui.status('Copie impossible : sélectionnez le texte ci-dessous.'); }
    };
    $('tef-csv').onclick = () => {
      const lines = ['x,y,distance,elephants,totalAnimals,guards',
        ...state.results.map((r) => `${r.x},${r.y},${r.distance.toFixed(2)},${r.elephants},${r.total},"${r.troops.map((t) => `${t.n} ${t.name}`).join('; ')}"`)];
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `elephants_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    };
  }

  // N'apparaît que sur une page de jeu (barre de ressources présente), pas sur le lobby.
  const isGamePage = () => !!document.querySelector('#stockBar, #resourceFieldContainer, .coordinateX');
  if (document.body && isGamePage()) buildUI();
})();
