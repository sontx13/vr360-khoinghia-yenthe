(() => {
  // Add ?debug=1 to the URL: clicking the panorama logs pitch/yaw to the console for placing hotspots.
  const DEBUG = new URLSearchParams(location.search).has('debug');
  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $('tourTitle'),
    subtitle: $('tourSubtitle'),
    menuBtn: $('menuBtn'),
    mapBtn: $('mapBtn'),
    sidebar: $('sidebar'),
    siteList: $('siteList'),
    mapView: $('mapView'),
    viewerView: $('viewerView'),
    infoBtn: $('infoBtn'),
    audioBtn: $('audioBtn'),
    infoPanel: $('infoPanel'),
    closeInfo: $('closeInfo'),
    infoTitle: $('infoTitle'),
    infoLocation: $('infoLocation'),
    infoText: $('infoText'),
    sceneStrip: $('sceneStrip'),
    narration: $('narration'),
  };

  let tour = null;
  let map = null;
  let viewer = null;
  let currentSite = null;
  let openToken = 0;

  async function init() {
    try {
      const res = await fetch('data/tour.json');
      if (!res.ok) throw new Error(res.status);
      tour = await res.json();
    } catch (err) {
      els.mapView.innerHTML =
        '<div class="load-error">Không tải được <code>data/tour.json</code>.<br>' +
        'Hãy chạy bằng web server (VS Code Live Server hoặc <code>python -m http.server</code>), ' +
        'không mở trực tiếp file index.html.</div>';
      return;
    }

    document.title = tour.title;
    els.title.textContent = tour.title;
    els.subtitle.textContent = tour.subtitle || '';
    if (isMobile()) els.sidebar.classList.add('collapsed');

    buildSiteList();
    initMap();
    bindUi();
    route();
    window.addEventListener('hashchange', route);
  }

  function findSite(id) {
    return tour.sites.find((s) => s.id === id);
  }

  function bindUi() {
    els.menuBtn.addEventListener('click', () => {
      els.sidebar.classList.toggle('collapsed');
      setTimeout(() => map && map.invalidateSize(), 300);
    });
    els.mapBtn.addEventListener('click', () => { location.hash = ''; });
    els.infoBtn.addEventListener('click', () => { els.infoPanel.hidden = !els.infoPanel.hidden; });
    els.closeInfo.addEventListener('click', () => { els.infoPanel.hidden = true; });
    els.audioBtn.addEventListener('click', toggleAudio);
    els.narration.addEventListener('play', updateAudioBtn);
    els.narration.addEventListener('pause', updateAudioBtn);
    els.narration.addEventListener('error', () => { els.audioBtn.hidden = true; });
  }

  // Hash format: #site-id or #site-id/scene-id
  function route() {
    const [siteId, sceneId] = decodeURIComponent(location.hash.slice(1)).split('/');
    const site = siteId && findSite(siteId);
    if (site) openSite(site, sceneId);
    else showMap();
  }

  /* ---------- Sidebar ---------- */

  function buildSiteList() {
    tour.sites.forEach((site) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'site-item';
      btn.dataset.id = site.id;
      const name = document.createElement('strong');
      name.textContent = site.name;
      const loc = document.createElement('span');
      loc.textContent = site.location || '';
      btn.append(name, loc);
      btn.addEventListener('click', () => {
        location.hash = site.id;
        if (isMobile()) els.sidebar.classList.add('collapsed');
      });
      li.appendChild(btn);
      els.siteList.appendChild(li);
    });
  }

  function highlightSite(id) {
    els.siteList.querySelectorAll('.site-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === id);
    });
  }

  /* ---------- Map ---------- */

  function initMap() {
    map = L.map('map').setView(tour.map.center, tour.map.zoom);

    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
    );
    L.control.layers({ 'Bản đồ': osm, 'Vệ tinh': satellite }).addTo(map);

    const bounds = [];
    tour.sites.forEach((site) => {
      const marker = L.marker([site.lat, site.lng]).addTo(map);
      marker.bindTooltip(site.name);
      marker.bindPopup(buildPopup(site));
      bounds.push([site.lat, site.lng]);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });
  }

  function buildPopup(site) {
    const div = document.createElement('div');
    div.className = 'map-popup';
    const h = document.createElement('h3');
    h.textContent = site.name;
    const p = document.createElement('p');
    p.textContent = site.summary || '';
    const btn = document.createElement('button');
    btn.textContent = 'Tham quan 360°';
    btn.addEventListener('click', () => { location.hash = site.id; });
    div.append(h, p, btn);
    return div;
  }

  function showMap() {
    stopAudio();
    els.viewerView.classList.remove('active');
    els.mapView.classList.add('active');
    els.mapBtn.hidden = true;
    highlightSite(null);
    if (map) map.invalidateSize();
  }

  /* ---------- 360 viewer ---------- */

  async function openSite(site, sceneId) {
    els.mapView.classList.remove('active');
    els.viewerView.classList.add('active');
    els.mapBtn.hidden = false;
    highlightSite(site.id);

    if (currentSite === site && viewer) {
      if (sceneId && sceneId !== viewer.getScene()) viewer.loadScene(sceneId);
      return;
    }

    const token = ++openToken;
    stopAudio();
    currentSite = site;
    fillInfo(site);
    setupAudio(site);

    const panoramas = await Promise.all(site.scenes.map(resolvePanorama));
    if (token !== openToken) return;

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

    if (viewer) viewer.destroy();
    viewer = pannellum.viewer('panorama', {
      default: {
        firstScene,
        autoLoad: true,
        sceneFadeDuration: 800,
        autoRotate: -2,
        showControls: true,
        hotSpotDebug: DEBUG,
      },
      scenes,
    });

    viewer.on('scenechange', (id) => {
      markActiveScene(id);
      history.replaceState(null, '', `#${site.id}/${id}`);
    });

    buildSceneStrip(site);
    markActiveScene(firstScene);
  }

  function buildSceneStrip(site) {
    els.sceneStrip.replaceChildren();
    els.sceneStrip.hidden = site.scenes.length < 2;
    site.scenes.forEach((scene) => {
      const btn = document.createElement('button');
      btn.className = 'scene-thumb';
      btn.dataset.id = scene.id;
      btn.title = scene.title;

      const fallback = document.createElement('div');
      fallback.className = 'no-thumb';
      fallback.textContent = '360°';
      if (scene.thumb) {
        const img = document.createElement('img');
        img.alt = scene.title;
        img.loading = 'lazy';
        img.src = scene.thumb;
        img.onerror = () => img.replaceWith(fallback);
        btn.appendChild(img);
      } else {
        btn.appendChild(fallback);
      }

      const label = document.createElement('span');
      label.textContent = scene.title;
      btn.appendChild(label);
      btn.addEventListener('click', () => viewer && viewer.loadScene(scene.id));
      els.sceneStrip.appendChild(btn);
    });
  }

  function markActiveScene(id) {
    els.sceneStrip.querySelectorAll('.scene-thumb').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === id);
    });
  }

  function fillInfo(site) {
    els.infoTitle.textContent = site.name;
    els.infoLocation.textContent = site.location || '';
    els.infoText.replaceChildren();
    const paragraphs = Array.isArray(site.description) ? site.description : [site.description || ''];
    paragraphs.forEach((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      els.infoText.appendChild(p);
    });
    els.infoPanel.hidden = isMobile();
  }

  // Falls back to a generated placeholder while the real 360 photo is not available yet.
  function resolvePanorama(scene) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(scene.panorama);
      img.onerror = () => resolve(makePlaceholder(scene.title, scene.panorama));
      img.src = scene.panorama;
    });
  }

  function makePlaceholder(title, path) {
    const w = 2048;
    const h = 1024;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');

    const sky = ctx.createLinearGradient(0, 0, 0, h / 2);
    sky.addColorStop(0, '#2b4a6f');
    sky.addColorStop(1, '#c9a46a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h / 2);
    const ground = ctx.createLinearGradient(0, h / 2, 0, h);
    ground.addColorStop(0, '#5a4630');
    ground.addColorStop(1, '#1e1710');
    ctx.fillStyle = ground;
    ctx.fillRect(0, h / 2, w, h / 2);

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= w; x += w / 12) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += h / 12) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    ctx.textAlign = 'center';
    [w / 2, 0, w / 4, (3 * w) / 4, w].forEach((x) => {
      ctx.fillStyle = '#f5ede0';
      ctx.font = 'bold 56px sans-serif';
      ctx.fillText(title, x, h / 2 - 40);
      ctx.fillStyle = '#e0b354';
      ctx.font = '26px sans-serif';
      ctx.fillText('Chưa có ảnh 360 – đặt ảnh tại:', x, h / 2 + 20);
      ctx.fillText(path, x, h / 2 + 56);
    });
    return c.toDataURL('image/jpeg', 0.85);
  }

  /* ---------- Audio ---------- */

  function setupAudio(site) {
    els.narration.pause();
    if (site.audio) {
      els.narration.src = site.audio;
      els.audioBtn.hidden = false;
    } else {
      els.narration.removeAttribute('src');
      els.audioBtn.hidden = true;
    }
    updateAudioBtn();
  }

  function toggleAudio() {
    if (els.narration.paused) els.narration.play().catch(() => { els.audioBtn.hidden = true; });
    else els.narration.pause();
  }

  function stopAudio() {
    els.narration.pause();
  }

  function updateAudioBtn() {
    const playing = !els.narration.paused;
    els.audioBtn.textContent = playing ? 'Dừng thuyết minh' : 'Nghe thuyết minh';
    els.audioBtn.classList.toggle('active', playing);
  }

  init();
})();
