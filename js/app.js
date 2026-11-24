(() => {
  // Add ?debug=1 to the URL: clicking the panorama logs pitch/yaw to the console for placing hotspots.
  const DEBUG = new URLSearchParams(location.search).has('debug');
  const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
  const AI = window.HeritageAssistant;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const els = {
    title: $('tourTitle'), subtitle: $('tourSubtitle'), menuBtn: $('menuBtn'), sidebar: $('sidebar'),
    modeJourney: $('modeJourney'), modeFree: $('modeFree'), aboutBtn: $('aboutBtn'),
    searchInput: $('searchInput'), groupFilters: $('groupFilters'), categoryFilters: $('categoryFilters'),
    siteList: $('siteList'), siteCount: $('siteCount'),
    mapView: $('mapView'), legendItems: $('legendItems'), coordsNote: $('coordsNote'),
    journeyPanel: $('journeyPanel'), journeyStep: $('journeyStep'), journeyStages: $('journeyStages'),
    journeyCurrent: $('journeyCurrent'), journeyPrev: $('journeyPrev'), journeyNext: $('journeyNext'), journey360: $('journey360'),
    viewerView: $('viewerView'), crumbSite: $('crumbSite'), backToMap: $('backToMap'), backToMap2: $('backToMap2'),
    infoTitle: $('infoTitle'), infoLocation: $('infoLocation'), infoText: $('infoText'),
    audioBtn: $('audioBtn'), viewerPrev: $('viewerPrev'), viewerNext: $('viewerNext'),
    sceneCaption: $('sceneCaption'), sceneStrip: $('sceneStrip'), narration: $('narration'),
    aiFab: $('aiFab'), aiPanel: $('aiPanel'), aiTitle: $('aiTitle'), aiClose: $('aiClose'), aiLog: $('aiLog'),
    aiForm: $('aiForm'), aiInput: $('aiInput'), aiMic: $('aiMic'), aiSpeak: $('aiSpeak'),
    detailDialog: $('detailDialog'), detailBadge: $('detailBadge'), detailTitle: $('detailTitle'),
    detailLocation: $('detailLocation'), detailText: $('detailText'), detail360: $('detail360'),
    detailDirections: $('detailDirections'), detailAsk: $('detailAsk'),
    aboutDialog: $('aboutDialog'), aboutTitle: $('aboutTitle'), aboutHeading: $('aboutHeading'), aboutPoints: $('aboutPoints'),
  };

  const state = {
    tour: null,
    sites: [],
    map: null,
    markers: new Map(), // siteId -> L.Marker
    groups: new Set(),
    categories: new Set(),
    text: '',
    mode: 'free',
    journeyIndex: 0,
    journeyLine: null,
    highlight: new Set(),
    highlightBar: null,
    viewer: null,
    currentSite: null,
    currentSceneId: null,
    openToken: 0,
    view: 'map',
  };

  /* ================= Init ================= */

  async function init() {
    try {
      const res = await fetch('data/tour.json');
      if (!res.ok) throw new Error(res.status);
      state.tour = await res.json();
    } catch (err) {
      els.mapView.innerHTML =
        '<div class="load-error">Không tải được <code>data/tour.json</code>.<br>' +
        'Hãy chạy bằng web server (VS Code Live Server hoặc <code>python -m http.server</code>), ' +
        'không mở trực tiếp file index.html.</div>';
      return;
    }
    const { tour } = state;
    state.sites = [...tour.sites].sort((a, b) => a.order - b.order);
    Object.keys(tour.groups).forEach((g) => state.groups.add(g));
    Object.keys(tour.categories).forEach((c) => state.categories.add(c));

    document.title = tour.shortTitle;
    els.title.textContent = tour.title;
    els.subtitle.textContent = tour.subtitle;
    els.coordsNote.textContent = tour.coordsNote || '';
    if (isMobile()) els.sidebar.classList.add('collapsed');

    buildFilters();
    buildLegend();
    buildAbout();
    buildJourneyStages();
    initMap();
    renderList();
    bindUi();
    aiGreet();
    route();
    window.addEventListener('hashchange', route);
  }

  const findSite = (id) => state.sites.find((s) => s.id === id);
  const groupColor = (site) => state.tour.groups[site.group].color;
  const locationText = (site) =>
    `${site.newArea}${site.oldArea ? ` (trước đây: ${site.oldArea})` : ''}`;

  function bindUi() {
    els.menuBtn.addEventListener('click', () => {
      els.sidebar.classList.toggle('collapsed');
      setTimeout(() => state.map.invalidateSize(), 300);
    });
    els.modeJourney.addEventListener('click', () => setMode('journey'));
    els.modeFree.addEventListener('click', () => setMode('free'));
    els.aboutBtn.addEventListener('click', () => els.aboutDialog.showModal());
    els.searchInput.addEventListener('input', () => {
      state.text = AI.norm(els.searchInput.value).trim();
      applyFilters();
    });

    els.journeyPrev.addEventListener('click', () => goJourney(state.journeyIndex - 1));
    els.journeyNext.addEventListener('click', () => goJourney(state.journeyIndex + 1));
    els.journey360.addEventListener('click', () => open360(state.sites[state.journeyIndex].id));

    [els.backToMap, els.backToMap2].forEach((b) => b.addEventListener('click', () => backToMap()));
    els.viewerPrev.addEventListener('click', () => stepFromViewer(-1));
    els.viewerNext.addEventListener('click', () => stepFromViewer(1));
    els.audioBtn.addEventListener('click', toggleNarration);
    els.narration.addEventListener('play', updateAudioBtn);
    els.narration.addEventListener('pause', updateAudioBtn);
    els.narration.addEventListener('error', () => {
      if (els.narration.getAttribute('src')) speakSite(state.currentSite);
    });

    document.querySelectorAll('dialog [data-close]').forEach((b) =>
      b.addEventListener('click', () => b.closest('dialog').close())
    );
    document.querySelectorAll('dialog').forEach((d) =>
      d.addEventListener('click', (e) => { if (e.target === d) d.close(); })
    );

    bindAi();
  }

  // Hash format: #site-id or #site-id/scene-id opens the 360 viewer.
  function route() {
    const [siteId, sceneId] = decodeURIComponent(location.hash.slice(1)).split('/');
    const site = siteId && findSite(siteId);
    if (site) openSite(site, sceneId);
    else showMap();
  }

  /* ================= Sidebar: filters & list ================= */

  function buildFilters() {
    const { tour } = state;
    const count = (key, val) => state.sites.filter((s) => s[key] === val).length;
    const addCheck = (parent, set, key, label, n, color) => {
      const lab = el('label', 'check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = true;
      input.addEventListener('change', () => {
        input.checked ? set.add(key) : set.delete(key);
        applyFilters();
      });
      lab.append(input);
      if (color) {
        const dot = el('span', 'dot');
        dot.style.background = color;
        lab.append(dot);
      }
      lab.append(el('span', null, label), el('small', null, `(${n})`));
      parent.append(lab);
    };
    Object.entries(tour.groups).forEach(([k, g]) =>
      addCheck(els.groupFilters, state.groups, k, g.label, count('group', k), g.color)
    );
    Object.entries(tour.categories).forEach(([k, label]) =>
      addCheck(els.categoryFilters, state.categories, k, label, count('category', k))
    );
  }

  function siteMatches(site) {
    if (!state.groups.has(site.group) || !state.categories.has(site.category)) return false;
    if (!state.text) return true;
    const hay = AI.norm([site.name, site.newArea, site.oldArea, site.summary, ...site.tags].join(' '));
    return hay.includes(` ${state.text}`) || hay.includes(state.text);
  }

  function applyFilters() {
    renderList();
    refreshMarkers();
  }

  function renderList() {
    const visible = state.sites.filter(siteMatches);
    els.siteCount.textContent = `(${visible.length}/${state.sites.length})`;
    els.siteList.replaceChildren();
    if (!visible.length) {
      els.siteList.append(el('li', 'empty', 'Không có địa điểm phù hợp.'));
      return;
    }
    visible.forEach((site) => {
      const li = el('li');
      const btn = el('button', 'site-item');
      btn.dataset.id = site.id;
      const num = el('span', 'num', site.order);
      num.style.background = groupColor(site);
      const txt = el('span', 'txt');
      txt.append(el('strong', null, site.name), el('span', 'sub', `${site.summary} · ${site.newArea}`));
      btn.append(num, txt);
      if (site.scenes.length) {
        const sample = site.scenes.every((sc) => sc.sample);
        const tag = el('span', sample ? 'has360 sample' : 'has360', '360°');
        tag.title = sample ? 'Ảnh 360° mẫu minh họa' : 'Có ảnh 360° thực tế';
        btn.append(tag);
      }
      btn.addEventListener('click', () => {
        if (isMobile()) els.sidebar.classList.add('collapsed');
        if (state.mode === 'journey') goJourney(state.sites.indexOf(site));
        else focusSite(site);
      });
      li.append(btn);
      els.siteList.append(li);
    });
    markListState();
  }

  function markListState() {
    const active = state.view === 'viewer' && state.currentSite
      ? state.currentSite.id
      : state.mode === 'journey' ? state.sites[state.journeyIndex].id : null;
    els.siteList.querySelectorAll('.site-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === active);
      b.classList.toggle('hit', state.highlight.has(b.dataset.id));
    });
  }

  /* ================= Map ================= */

  function initMap() {
    const { tour } = state;
    const map = L.map('map', { zoomControl: true }).setView(tour.map.center, tour.map.zoom);
    state.map = map;

    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap',
    });
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
    );
    L.control.layers({ 'Bản đồ': osm, 'Địa hình': topo, 'Vệ tinh': satellite }).addTo(map);

    state.sites.forEach((site) => {
      const marker = L.marker([site.lat, site.lng], { icon: makeIcon(site), title: site.name });
      marker.bindTooltip(`${site.order}. ${site.name}`, { direction: 'top', offset: [0, -36] });
      marker.bindPopup(() => buildPopup(site), { minWidth: 260, maxWidth: 320 });
      marker.addTo(map);
      state.markers.set(site.id, marker);
    });
    fitTo(state.sites);

    // Highlight bar ("đang làm nổi bật N điểm ×")
    const Bar = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-bar');
        div.style.cssText = 'display:none;background:#fff;padding:6px 10px;font-weight:600;color:#c0392b;cursor:pointer';
        div.title = 'Bỏ làm nổi bật';
        L.DomEvent.disableClickPropagation(div);
        div.addEventListener('click', () => setHighlight([]));
        return div;
      },
    });
    state.highlightBar = new Bar({ position: 'topright' }).addTo(map).getContainer();
  }

  function fitTo(sites) {
    if (!sites.length) return;
    if (sites.length === 1) {
      state.map.setView([sites[0].lat, sites[0].lng], Math.max(state.map.getZoom(), 14));
      return;
    }
    // Keep results clear of the AI panel when it is open on a wide screen.
    const right = !els.aiPanel.hidden && !isMobile() ? 420 : 50;
    state.map.fitBounds(sites.map((s) => [s.lat, s.lng]), {
      paddingTopLeft: [50, 50], paddingBottomRight: [right, 50], maxZoom: 14,
    });
  }

  function pinSvg(color, withDot) {
    return (
      '<svg viewBox="0 0 30 40" aria-hidden="true"><path d="M15 1C7.3 1 1 7.3 1 15c0 10.5 14 24 14 24s14-13.5 14-24C29 7.3 22.7 1 15 1z" ' +
      `fill="${color}" stroke="#fff" stroke-width="2"/>` +
      (withDot ? '<circle cx="15" cy="15" r="5" fill="#fff"/>' : '') +
      '</svg>'
    );
  }

  function makeIcon(site) {
    const hit = state.highlight.has(site.id);
    const journey = state.mode === 'journey';
    const current = journey && state.sites[state.journeyIndex] === site;
    const color = hit || current ? '#c0392b' : groupColor(site);
    const cls = ['pin', hit && 'hit', current && 'current'].filter(Boolean).join(' ');
    return L.divIcon({
      className: '',
      html: `<div class="${cls}">${pinSvg(color, !journey)}${journey ? `<span class="pin-num">${site.order}</span>` : ''}</div>`,
      iconSize: [30, 40],
      iconAnchor: [15, 40],
      popupAnchor: [0, -36],
    });
  }

  function refreshMarkers() {
    state.sites.forEach((site) => {
      const m = state.markers.get(site.id);
      m.setIcon(makeIcon(site));
      m.setZIndexOffset(state.highlight.has(site.id) ? 1000 : 0);
      const show = state.mode === 'journey' || siteMatches(site) || state.highlight.has(site.id);
      if (show && !state.map.hasLayer(m)) m.addTo(state.map);
      if (!show && state.map.hasLayer(m)) m.remove();
    });
  }

  function buildPopup(site) {
    const div = el('div', 'map-popup');
    div.append(el('h3', null, site.name), el('div', 'muted', locationText(site)), el('p', null, site.summary));
    const row = el('div', 'row');
    const detail = el('button', 'btn btn-primary', 'Xem chi tiết ›');
    detail.addEventListener('click', () => openDetail(site));
    const tour = el('button', 'btn btn-green', '360° Tham quan 360°');
    tour.disabled = !site.scenes.length;
    tour.title = site.scenes.length ? '' : 'Chưa có ảnh 360° cho địa điểm này';
    tour.addEventListener('click', () => open360(site.id));
    row.append(detail, tour);
    div.append(row);
    return div;
  }

  function focusSite(site) {
    showMapView();
    const m = state.markers.get(site.id);
    if (!state.map.hasLayer(m)) m.addTo(state.map);
    state.map.setView([site.lat, site.lng], Math.max(state.map.getZoom(), 13));
    m.openPopup();
  }

  function buildLegend() {
    Object.values(state.tour.groups).forEach((g) => {
      const item = el('div', 'legend-item');
      item.innerHTML = pinSvg(g.color, true);
      const t = el('div');
      t.append(el('span', null, g.legend), el('small', null, g.legendNote));
      item.append(t);
      els.legendItems.append(item);
    });
  }

  /* ================= Highlight (AI results) ================= */

  function setHighlight(ids, fit = true) {
    state.highlight = new Set(ids);
    refreshMarkers();
    markListState();
    const n = state.highlight.size;
    state.highlightBar.style.display = n ? 'block' : 'none';
    state.highlightBar.textContent = `Đang làm nổi bật ${n} điểm  ✕`;
    if (n && fit && state.view === 'map') fitTo(state.sites.filter((s) => state.highlight.has(s.id)));
  }

  /* ================= Modes: free / educational journey ================= */

  function setMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('journey', mode === 'journey');
    els.modeJourney.classList.toggle('active', mode === 'journey');
    els.modeFree.classList.toggle('active', mode === 'free');
    els.journeyPanel.hidden = mode !== 'journey';
    if (state.journeyLine) { state.journeyLine.remove(); state.journeyLine = null; }
    if (mode === 'journey') {
      state.journeyLine = L.polyline(state.sites.map((s) => [s.lat, s.lng]), {
        color: '#a35a24', weight: 3, opacity: 0.85, className: 'journey-line',
      }).addTo(state.map);
      if (state.view !== 'map') backToMap();
      goJourney(state.journeyIndex);
    } else {
      state.map.closePopup();
      refreshMarkers();
      markListState();
    }
  }

  function buildJourneyStages() {
    state.tour.journey.stages.forEach((s) => els.journeyStages.append(el('li', null, s.label)));
  }

  function goJourney(i) {
    const n = state.sites.length;
    state.journeyIndex = Math.max(0, Math.min(n - 1, i));
    const site = state.sites[state.journeyIndex];
    els.journeyStep.textContent = `Điểm ${state.journeyIndex + 1}/${n}`;
    [...els.journeyStages.children].forEach((li, k) => {
      const st = state.tour.journey.stages[k];
      li.classList.toggle('on', site.order >= st.from && site.order <= st.to);
    });
    els.journeyCurrent.replaceChildren(
      el('strong', null, `${site.order}. ${site.name}`),
      el('span', null, `${site.summary} · ${site.newArea}`)
    );
    els.journeyPrev.disabled = state.journeyIndex === 0;
    els.journeyNext.disabled = state.journeyIndex === n - 1;
    els.journey360.disabled = !site.scenes.length;
    els.journey360.title = site.scenes.length ? 'Tham quan 360°' : 'Chưa có ảnh 360°';
    refreshMarkers();
    markListState();
    if (state.view === 'map') {
      state.map.flyTo([site.lat, site.lng], Math.max(state.map.getZoom(), 13), { duration: 0.8 });
      state.map.once('moveend', () => state.markers.get(site.id).openPopup());
    }
  }

  // "Điểm trước / tiếp theo" from inside the 360 viewer follows the journey order.
  function stepFromViewer(delta) {
    const idx = state.sites.indexOf(state.currentSite) + delta;
    if (idx < 0 || idx >= state.sites.length) return;
    state.journeyIndex = idx;
    const site = state.sites[idx];
    if (site.scenes.length) open360(site.id);
    else {
      backToMap();
      if (state.mode === 'journey') goJourney(idx);
      else focusSite(site);
    }
  }

  function nextSite() {
    if (state.view === 'viewer') return stepFromViewer(1);
    if (state.mode !== 'journey') setMode('journey');
    goJourney(state.journeyIndex + 1);
  }

  /* ================= Detail & about dialogs ================= */

  function openDetail(site) {
    const g = state.tour.groups[site.group];
    els.detailBadge.textContent = `${site.order}. ${g.label} · ${state.tour.categories[site.category]}`;
    els.detailBadge.style.background = g.color;
    els.detailTitle.textContent = site.name;
    els.detailLocation.textContent = locationText(site);
    els.detailText.replaceChildren(...site.description.map((p) => el('p', null, p)));
    if (site.approxCoords) els.detailText.append(el('p', 'note', state.tour.coordsNote));
    els.detail360.disabled = !site.scenes.length;
    els.detail360.textContent = site.scenes.length ? '360° Tham quan 360°' : 'Chưa có ảnh 360°';
    els.detail360.onclick = () => { els.detailDialog.close(); open360(site.id); };
    els.detailDirections.href = `https://www.google.com/maps/dir/?api=1&destination=${site.lat},${site.lng}`;
    els.detailAsk.onclick = () => { els.detailDialog.close(); openAi(); ask(`Giới thiệu ${site.name}`); };
    els.detailDialog.showModal();
  }

  function buildAbout() {
    const { about, title } = state.tour;
    els.aboutTitle.textContent = title;
    els.aboutHeading.textContent = about.heading;
    about.points.forEach(([head, body]) => {
      const li = el('li');
      li.append(el('b', null, `${head}: `), document.createTextNode(body));
      els.aboutPoints.append(li);
    });
  }

  /* ================= Views ================= */

  function showMapView() {
    state.view = 'map';
    els.viewerView.classList.remove('active');
    els.mapView.classList.add('active');
    state.map.invalidateSize();
    updateAiContext();
  }

  function showMap() {
    stopNarration();
    showMapView();
    markListState();
  }

  function backToMap() {
    if (location.hash) history.pushState(null, '', location.pathname + location.search);
    showMap();
  }

  function open360(siteId) {
    location.hash = siteId;
  }

  /* ================= 360 viewer ================= */

  async function openSite(site, sceneId) {
    state.view = 'viewer';
    els.mapView.classList.remove('active');
    els.viewerView.classList.add('active');
    state.map.closePopup();
    const idx = state.sites.indexOf(site);
    els.viewerPrev.hidden = idx === 0;
    els.viewerNext.hidden = idx === state.sites.length - 1;

    if (state.currentSite === site && state.viewer) {
      if (sceneId && sceneId !== state.viewer.getScene()) state.viewer.loadScene(sceneId);
      markListState();
      return;
    }

    const token = ++state.openToken;
    stopNarration();
    state.currentSite = site;
    state.currentSceneId = null;
    fillInfo(site);
    setupNarration(site);
    markListState();
    updateAiContext();

    if (state.viewer) { state.viewer.destroy(); state.viewer = null; }
    els.viewerView.querySelector('.no-pano')?.remove();
    els.sceneStrip.replaceChildren();
    els.sceneCaption.textContent = '';

    if (!site.scenes.length) {
      const box = el('div', 'no-pano');
      box.innerHTML = `<div><strong></strong>Chưa có ảnh 360° cho địa điểm này.<br>Đặt ảnh tại <code>panos/${site.id}/</code> và khai báo trong <code>data/tour.json</code>.</div>`;
      box.querySelector('strong').textContent = site.name;
      $('panorama').after(box);
      return;
    }

    const panoramas = await Promise.all(site.scenes.map(resolvePanorama));
    if (token !== state.openToken) return;

    const scenes = {};
    site.scenes.forEach((scene, i) => {
      scenes[scene.id] = {
        title: scene.title,
        type: 'equirectangular',
        panorama: panoramas[i],
        yaw: scene.yaw || 0,
        pitch: scene.pitch || 0,
        hfov: scene.hfov || 110,
        hotSpots: scene.hotSpots || [],
      };
    });
    const firstScene = scenes[sceneId] ? sceneId : site.firstScene || site.scenes[0].id;

    state.viewer = pannellum.viewer('panorama', {
      default: { firstScene, autoLoad: true, sceneFadeDuration: 800, autoRotate: -2, showControls: true, hotSpotDebug: DEBUG },
      scenes,
    });
    state.viewer.on('scenechange', (id) => {
      setScene(site, id);
      history.replaceState(null, '', `#${site.id}/${id}`);
    });

    buildSceneStrip(site);
    setScene(site, firstScene);
  }

  function setScene(site, id) {
    state.currentSceneId = id;
    const scene = site.scenes.find((s) => s.id === id);
    els.sceneCaption.textContent = scene ? `${site.name} – ${scene.title}` : site.name;
    els.sceneCaption.classList.toggle('sample', !!(scene && scene.sample));
    els.sceneStrip.querySelectorAll('.scene-thumb').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  }

  function buildSceneStrip(site) {
    els.sceneStrip.hidden = site.scenes.length < 2;
    site.scenes.forEach((scene) => {
      const btn = el('button', 'scene-thumb');
      btn.dataset.id = scene.id;
      btn.title = scene.title;
      const fallback = el('div', 'no-thumb', '360°');
      if (scene.thumb) {
        const img = el('img');
        img.alt = scene.title;
        img.loading = 'lazy';
        img.src = scene.thumb;
        img.onerror = () => img.replaceWith(fallback);
        btn.append(img);
      } else btn.append(fallback);
      btn.append(el('span', null, scene.title));
      btn.addEventListener('click', () => state.viewer && state.viewer.loadScene(scene.id));
      els.sceneStrip.append(btn);
    });
  }

  function fillInfo(site) {
    els.crumbSite.textContent = site.name;
    els.infoTitle.textContent = site.name;
    els.infoLocation.textContent = locationText(site);
    els.infoText.replaceChildren(
      el('p', null, site.summary + '.'),
      ...site.description.map((p) => el('p', null, p))
    );
  }

  // Falls back to a generated placeholder while a declared 360 photo is missing.
  function resolvePanorama(scene) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(scene.panorama);
      img.onerror = () => resolve(makePlaceholder(scene.title, scene.panorama));
      img.src = scene.panorama;
    });
  }

  function makePlaceholder(title, path) {
    const w = 2048, h = 1024;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const sky = ctx.createLinearGradient(0, 0, 0, h / 2);
    sky.addColorStop(0, '#2b4a6f'); sky.addColorStop(1, '#c9a46a');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h / 2);
    const ground = ctx.createLinearGradient(0, h / 2, 0, h);
    ground.addColorStop(0, '#5a4630'); ground.addColorStop(1, '#1e1710');
    ctx.fillStyle = ground; ctx.fillRect(0, h / 2, w, h / 2);
    ctx.textAlign = 'center';
    [w / 2, 0, w / 4, (3 * w) / 4, w].forEach((x) => {
      ctx.fillStyle = '#f5ede0'; ctx.font = 'bold 56px sans-serif';
      ctx.fillText(title, x, h / 2 - 40);
      ctx.fillStyle = '#e0b354'; ctx.font = '26px sans-serif';
      ctx.fillText('Chưa có ảnh 360 – đặt ảnh tại:', x, h / 2 + 20);
      ctx.fillText(path, x, h / 2 + 56);
    });
    return c.toDataURL('image/jpeg', 0.85);
  }

  /* ================= Narration (mp3, falls back to speech synthesis) ================= */

  let ttsActive = false;

  function setupNarration(site) {
    els.narration.pause();
    if (site.audio) els.narration.src = site.audio;
    else els.narration.removeAttribute('src');
    updateAudioBtn();
  }

  function toggleNarration() {
    if (ttsActive) { stopNarration(); return; }
    if (!els.narration.paused) { els.narration.pause(); return; }
    if (els.narration.getAttribute('src')) els.narration.play().catch(() => speakSite(state.currentSite));
    else speakSite(state.currentSite);
  }

  function speakSite(site) {
    if (!site) return;
    const text = [site.name, site.summary, ...site.description.filter((p) => !p.startsWith('('))].join('. ');
    speak(text, () => { ttsActive = false; updateAudioBtn(); });
    ttsActive = 'speechSynthesis' in window;
    updateAudioBtn();
  }

  function stopNarration() {
    els.narration.pause();
    if (ttsActive) { speechSynthesis.cancel(); ttsActive = false; }
    updateAudioBtn();
  }

  function updateAudioBtn() {
    const playing = ttsActive || !els.narration.paused;
    els.audioBtn.textContent = playing ? '■ Dừng thuyết minh' : '🔊 Nghe thuyết minh';
    els.audioBtn.classList.toggle('active', playing);
  }

  function speak(text, onend) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN';
    const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.toLowerCase().startsWith('vi'));
    if (voice) u.voice = voice;
    if (onend) u.onend = u.onerror = onend;
    speechSynthesis.speak(u);
  }

  /* ================= AI assistant ================= */

  const CHIPS = {
    map: [
      ['🔍 Tìm di tích', 'Tìm các căn cứ của Đề Thám'],
      ['📖 Hỏi lịch sử', 'Kể về khởi nghĩa Yên Thế'],
      ['360° Tham quan', 'Tham quan 360'],
      ['➤ Hành trình', 'Hành trình giáo dục đi như thế nào?'],
    ],
    viewer: [
      ['❓ Đây là khu vực nào?', 'Đây là khu vực nào?'],
      ['ⓘ Giải thích thêm', 'Giải thích thêm'],
      ['📍 Điểm tiếp theo', 'Điểm tiếp theo'],
      ['🗺 Quay lại bản đồ', 'Quay lại bản đồ'],
    ],
  };

  function bindAi() {
    els.aiFab.addEventListener('click', openAi);
    els.aiClose.addEventListener('click', closeAi);
    els.aiForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = els.aiInput.value.trim();
      if (!q) return;
      els.aiInput.value = '';
      ask(q);
    });
    setupMic();
    updateAiContext();
  }

  function openAi() {
    els.aiPanel.hidden = false;
    document.body.classList.add('ai-open');
    if (!isMobile()) els.aiInput.focus();
  }

  function closeAi() {
    els.aiPanel.hidden = true;
    document.body.classList.remove('ai-open');
    if ('speechSynthesis' in window && !ttsActive) speechSynthesis.cancel();
  }

  function updateAiContext() {
    const inViewer = state.view === 'viewer';
    els.aiTitle.textContent = inViewer ? 'AI đồng hành tham quan' : 'Trợ lý AI Di sản Yên Thế';
    const chips = els.aiPanel.querySelector('.ai-chips');
    chips.replaceChildren();
    CHIPS[inViewer ? 'viewer' : 'map'].forEach(([label, q]) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', () => ask(q));
      chips.append(b);
    });
  }

  function aiGreet() {
    addMsg('bot', 'Xin chào! Tôi có thể giúp bạn <b>tìm địa điểm</b>, <b>giải đáp lịch sử</b> và <b>mở tham quan 360°</b>. Hãy gõ hoặc nhấn 🎤 để hỏi, ví dụ: “Hãy tìm cho tôi các căn cứ của Đề Thám”.');
  }

  function addMsg(who, html, actions) {
    const m = el('div', `msg ${who}`);
    if (who === 'user') m.textContent = html;
    else m.innerHTML = html; // bot HTML is built by assistant.js with escaped data
    if (actions && actions.length) {
      const box = el('div', 'msg-actions');
      actions.forEach((a) => {
        const b = el('button', null, a.label);
        b.type = 'button';
        b.addEventListener('click', () => runAction(a));
        box.append(b);
      });
      m.append(box);
    }
    els.aiLog.append(m);
    els.aiLog.scrollTop = els.aiLog.scrollHeight;
  }

  function ask(question) {
    addMsg('user', question);
    const site = state.view === 'viewer' ? state.currentSite : null;
    const scene = site && site.scenes.find((s) => s.id === state.currentSceneId);
    const res = AI.answer(question, {
      sites: state.sites,
      journey: state.tour.journey,
      currentSite: site,
      currentScene: scene,
    });
    addMsg('bot', res.html, res.actions);
    if (res.highlight) {
      if (res.highlight.length > 1 && state.view === 'viewer' && !res.run) {
        // Show search results on the map, as the brief requires.
        backToMap();
        setTimeout(() => setHighlight(res.highlight), 50);
      } else setHighlight(res.highlight);
    }
    if (res.run) runAction(res.run);
    if (els.aiSpeak.checked && res.speech) speak(res.speech);
  }

  function runAction(a) {
    const site = a.siteId && findSite(a.siteId);
    switch (a.type) {
      case 'highlight':
        if (state.view !== 'map') backToMap();
        setTimeout(() => setHighlight([...state.highlight]), 50);
        break;
      case 'detail': if (site) openDetail(site); break;
      case 'focus': if (site) { backToMap(); setTimeout(() => focusSite(site), 50); } break;
      case 'tour360': if (site) open360(site.id); break;
      case 'journey': backToMap(); setTimeout(() => setMode('journey'), 50); break;
      case 'next': nextSite(); break;
      case 'map': backToMap(); break;
      case 'ask': ask(a.text); break;
    }
    if (isMobile() && ['tour360', 'focus', 'journey', 'highlight', 'map'].includes(a.type)) closeAi();
  }

  function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      els.aiMic.disabled = true;
      els.aiMic.title = 'Trình duyệt chưa hỗ trợ nhận dạng giọng nói (hãy dùng Chrome hoặc Edge)';
      return;
    }
    const rec = new SR();
    rec.lang = 'vi-VN';
    rec.interimResults = true;
    let listening = false;
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      els.aiInput.value = r[0].transcript;
      if (r.isFinal) {
        els.aiSpeak.checked = true; // a spoken question gets a spoken answer
        const q = els.aiInput.value.trim();
        els.aiInput.value = '';
        if (q) ask(q);
      }
    };
    rec.onend = () => { listening = false; els.aiMic.classList.remove('listening'); };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') addMsg('bot', 'Không truy cập được micro. Hãy cho phép trình duyệt dùng micro rồi thử lại.');
    };
    els.aiMic.addEventListener('click', () => {
      if (listening) { rec.stop(); return; }
      listening = true;
      els.aiMic.classList.add('listening');
      rec.start();
    });
  }

  init();
})();
