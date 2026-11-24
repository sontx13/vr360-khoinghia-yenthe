/*
 * Trợ lý AI Di sản Yên Thế – bộ hiểu câu hỏi chạy hoàn toàn trên trình duyệt.
 * Nhận câu hỏi tự nhiên (gõ hoặc nói), tìm địa điểm trong data/tour.json và trả về:
 *   { html, speech, highlight: [siteId], actions: [{label, type, siteId}] }
 * app.js hiển thị câu trả lời, làm nổi bật điểm trên bản đồ và thực hiện các action.
 * Muốn nối với một mô hình ngôn ngữ thật thì thay hàm answer() bằng lời gọi tới máy chủ riêng.
 */
window.HeritageAssistant = (() => {
  const norm = (s) =>
    ' ' +
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() +
    ' ';
  const has = (q, ...words) => words.some((w) => q.includes(norm(w)));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const GENERIC = /^ (chua|dinh|den|don|dong|ao|khu|cum|nghia dia|den tho) /;

  const TOPICS = [
    { words: ['de tham', 'hoang hoa tham', 'ong de', 'hum xam'], tag: 'hoang-hoa-tham' },
    { words: ['bac ho', 'cong an', 'cand', '6 dieu', 'sau dieu'], tag: 'bac-ho' },
    { words: ['phap', 'thuc dan'], tag: 'phap' },
  ];
  const CATEGORY_WORDS = {
    don: ['can cu', 'don', 'dong', 'hang', 'thanh luy'],
    den: ['den', 'dinh', 'mieu'],
    chua: ['chua', 'ton giao'],
  };

  const HISTORY =
    'Khởi nghĩa Yên Thế (1884–1913) là cuộc khởi nghĩa nông dân tiêu biểu chống thực dân Pháp, kéo dài gần 30 năm, ' +
    'gắn với thủ lĩnh Hoàng Hoa Thám (Đề Thám) – người được nhân dân gọi là “Hùm xám Yên Thế”. ' +
    'Bản đồ giới thiệu 23 địa điểm thuộc Di tích quốc gia đặc biệt “Những địa điểm Khởi nghĩa Yên Thế” ' +
    'và 3 điểm mở rộng trong hành trình kết nối giá trị di sản.';
  const SIX_RULES = [
    'Đối với tự mình, phải cần, kiệm, liêm, chính.',
    'Đối với đồng sự, phải thân ái giúp đỡ.',
    'Đối với Chính phủ, phải tuyệt đối trung thành.',
    'Đối với nhân dân, phải kính trọng, lễ phép.',
    'Đối với công việc, phải tận tụy.',
    'Đối với địch, phải cương quyết, khôn khéo.',
  ];

  function siteLine(site) {
    return `<b>${esc(site.name)}</b> – ${esc(site.newArea)}`;
  }

  // Scores sites against the question: name > area > topic/category.
  function matchSites(q, sites) {
    const byName = [];
    sites.forEach((s) => {
      const n = norm(s.name.replace(/\(.*\)/, ''));
      const core = n.replace(GENERIC, ' ');
      if (q.includes(n) || (core.trim().length > 3 && q.includes(core))) byName.push(s);
    });
    if (byName.length) return { sites: byName, how: 'name' };

    let pool = sites;
    let filtered = false;

    const topic = TOPICS.find((t) => has(q, ...t.words));
    if (topic) {
      pool = pool.filter((s) => s.tags.includes(topic.tag));
      filtered = true;
    }

    const cats = Object.keys(CATEGORY_WORDS).filter((c) =>
      CATEGORY_WORDS[c].some((w) => new RegExp(`(cac|nhung|ngoi|tim|liet ke|nao|la) ${w} `).test(q) || (w.includes(' ') && q.includes(norm(w))))
    );
    if (cats.length) {
      pool = pool.filter((s) => cats.includes(s.category));
      filtered = true;
    }

    if (has(q, 'mo rong')) { pool = pool.filter((s) => s.group === 'extended'); filtered = true; }
    else if (has(q, 'quoc gia dac biet', '23 diem', '23 dia diem')) { pool = pool.filter((s) => s.group === 'core'); filtered = true; }

    // "khởi nghĩa Yên Thế" names the uprising, not the commune.
    const qArea = q.replace(/ (khoi nghia|di san|hum xam) yen the /g, ' ');
    const areas = [...new Set(sites.flatMap((s) => [s.newArea, s.oldArea]).filter(Boolean))]
      .map((a) => ({ a, n: norm(a.replace(/^(Xã|TT|Phường)\s/, '')) }))
      .filter(({ n }) => n.trim().length > 3 && qArea.includes(n));
    if (areas.length) {
      const names = areas.map((x) => x.a);
      pool = pool.filter((s) => names.includes(s.newArea) || names.includes(s.oldArea));
      filtered = true;
    }

    return filtered ? { sites: pool, how: 'filter' } : { sites: [], how: 'none' };
  }

  function listReply(found, intro) {
    const list = found.slice(0, 12).map((s) => `<li>${siteLine(s)}</li>`).join('');
    const more = found.length > 12 ? `<li>… và ${found.length - 12} địa điểm khác</li>` : '';
    const with360 = found.find((s) => s.scenes.length);
    const actions = [{ label: '📍 Làm nổi bật trên bản đồ', type: 'highlight' }];
    actions.push({ label: `📁 Mở hồ sơ: ${found[0].name}`, type: 'detail', siteId: found[0].id });
    if (with360) actions.push({ label: `360° Bắt đầu tham quan 360°: ${with360.name}`, type: 'tour360', siteId: with360.id });
    return {
      html: `${intro}<ul>${list}${more}</ul>`,
      speech: `${intro.replace(/<[^>]+>/g, '')} ${found.slice(0, 6).map((s) => s.name).join(', ')}.`,
      highlight: found.map((s) => s.id),
      actions,
    };
  }

  function describe(site, scene) {
    const paras = site.description.filter((p) => !p.startsWith('(Bổ sung'));
    const where = scene && scene.info ? `<p>${esc(scene.info)}</p>` : '';
    const actions = [];
    if (site.scenes.length) actions.push({ label: '360° Tham quan 360°', type: 'tour360', siteId: site.id });
    actions.push({ label: '📁 Mở hồ sơ di tích', type: 'detail', siteId: site.id });
    actions.push({ label: '📍 Xem trên bản đồ', type: 'focus', siteId: site.id });
    return {
      html: `${where}<p><b>${esc(site.name)}</b> (${esc(site.newArea)}${site.oldArea ? `, trước đây ${esc(site.oldArea)}` : ''}): ${esc(site.summary)}.</p>` +
        paras.map((p) => `<p>${esc(p)}</p>`).join(''),
      speech: `${scene && scene.info ? scene.info + ' ' : ''}${site.name}. ${site.summary}. ${paras.join(' ')}`,
      highlight: [site.id],
      actions,
    };
  }

  function hhtReply(sites) {
    const rel = sites.filter((s) => s.tags.includes('hoang-hoa-tham'));
    return listReply(rel, '<p>Hoàng Hoa Thám (Đề Thám) là thủ lĩnh tiêu biểu nhất của khởi nghĩa Yên Thế, được nhân dân gọi là “Hùm xám Yên Thế”.</p>Các địa điểm gắn với ông:');
  }

  function answer(question, ctx) {
    const q = norm(question);
    const { sites } = ctx;
    const here = ctx.currentSite;

    if (/^ (xin chao|chao|hello|hi|alo) /.test(q) && q.trim().split(' ').length <= 4) {
      return {
        html: 'Xin chào! Tôi có thể giúp bạn <b>tìm địa điểm</b>, <b>giải đáp lịch sử</b>, <b>mở tham quan 360°</b> hoặc <b>dẫn hành trình giáo dục</b>. Ví dụ: “Tìm các căn cứ của Đề Thám”.',
        speech: 'Xin chào! Tôi có thể giúp bạn tìm địa điểm, giải đáp lịch sử, mở tham quan 360 độ hoặc dẫn hành trình giáo dục.',
      };
    }

    // Context questions while viewing a 360 scene.
    if (here && has(q, 'day la', 'o day', 'khu vuc nao', 'canh nay', 'dang xem', 'cho nay', 'noi nay')) {
      const r = describe(here, ctx.currentScene);
      r.html = `Bạn đang xem ${ctx.currentScene ? `<b>${esc(ctx.currentScene.title)}</b> của ` : ''}<b>${esc(here.name)}</b>.` + r.html;
      r.actions = [
        { label: 'ⓘ Giải thích thêm', type: 'ask', text: `Giới thiệu ${here.name}` },
        { label: '📍 Xem điểm tiếp theo', type: 'next' },
        { label: '🗺 Quay lại bản đồ', type: 'map' },
      ];
      return r;
    }
    if (here && has(q, 'giai thich them', 'noi them', 'chi tiet hon')) return describe(here);

    if (has(q, 'hanh trinh', 'lo trinh', 'giao duc', 'theo thu tu')) {
      return {
        html: 'Hành trình giáo dục đi theo thứ tự:<ul>' +
          ctx.journey.stages.map((s) => `<li>${esc(s.label)}</li>`).join('') +
          '</ul>Bản đồ sẽ đánh số và nối các điểm theo đúng thứ tự tham quan.',
        speech: 'Hành trình giáo dục đi qua 23 địa điểm khởi nghĩa Yên Thế, rồi Chùa Tứ Giáp, Khu lưu niệm Sáu điều Bác Hồ dạy Công an nhân dân và kết thúc tại Chùa Phúc Sơn.',
        actions: [{ label: '➤ Bắt đầu hành trình', type: 'journey' }],
      };
    }
    if (has(q, 'tiep theo', 'diem sau', 'ke tiep')) {
      return { html: 'Đang chuyển tới điểm tiếp theo của hành trình…', speech: 'Đang chuyển tới điểm tiếp theo.', run: { type: 'next' } };
    }
    if (has(q, 'quay lai ban do', 've ban do', 'mo ban do')) {
      return { html: 'Đã quay lại bản đồ.', speech: 'Đã quay lại bản đồ.', run: { type: 'map' } };
    }

    if (has(q, '6 dieu', 'sau dieu') && !has(q, 'tim', 'o dau', 'dia diem', 'khu luu niem', 'chua')) {
      const ext = sites.filter((s) => s.tags.includes('bac-ho'));
      return {
        html: '<p><b>Sáu điều Bác Hồ dạy Công an nhân dân</b> (thư ngày 11/3/1948):</p><ul>' +
          SIX_RULES.map((r) => `<li>${esc(r)}</li>`).join('') +
          '</ul><p>Các địa điểm liên quan trên bản đồ: ' + ext.map((s) => `<b>${esc(s.name)}</b>`).join(', ') + '.</p>',
        speech: 'Sáu điều Bác Hồ dạy Công an nhân dân: ' + SIX_RULES.join(' '),
        highlight: ext.map((s) => s.id),
        actions: ext.map((s) => ({ label: `📁 ${s.name}`, type: 'detail', siteId: s.id })),
      };
    }

    if (has(q, 'bao nhieu', 'may diem', 'may dia diem')) {
      const core = sites.filter((s) => s.group === 'core').length;
      return {
        html: `Bản đồ có <b>${sites.length} địa điểm</b>: <b>${core}</b> điểm thuộc Di tích quốc gia đặc biệt “Những địa điểm Khởi nghĩa Yên Thế” và <b>${sites.length - core}</b> điểm mở rộng. Hiện có <b>${sites.filter((s) => s.scenes.some((sc) => !sc.sample)).length}</b> điểm có ảnh 360° chụp thực tế, các điểm còn lại đang dùng ảnh 360° mẫu minh họa.`,
        speech: `Bản đồ có ${sites.length} địa điểm, gồm ${core} điểm khởi nghĩa Yên Thế và ${sites.length - core} điểm mở rộng.`,
      };
    }

    if (has(q, 'hoang hoa tham', 'de tham') && has(q, 'la ai', 'tieu su', 'cuoc doi')) return hhtReply(sites);

    const { sites: found, how } = matchSites(q, sites);
    const wants360 = has(q, '360', 'thuc te ao', 'vr', 'tham quan ao');

    if (wants360) {
      const target = found.find((s) => s.scenes.length);
      if (target) {
        return { html: `Đang mở tham quan 360° <b>${esc(target.name)}</b>…`, speech: `Đang mở tham quan 360 độ ${target.name}.`, highlight: [target.id], run: { type: 'tour360', siteId: target.id } };
      }
      const avail = sites.filter((s) => s.scenes.length);
      const r = listReply(avail, found.length
        ? `<b>${esc(found[0].name)}</b> chưa có ảnh 360°. Các địa điểm đã có tham quan 360°:`
        : 'Các địa điểm đã có tham quan 360°:');
      return r;
    }

    if (how === 'name' && found.length === 1) return describe(found[0]);
    if (found.length) {
      const intro = how === 'name' ? 'Các địa điểm khớp với câu hỏi:' : `Tôi đã tìm thấy <b>${found.length}</b> địa điểm liên quan:`;
      return listReply(found, intro);
    }
    if (how === 'filter') {
      return { html: 'Không có địa điểm nào khớp với tất cả điều kiện. Hãy thử hỏi rộng hơn, ví dụ “Tìm các đền, đình ở Nhã Nam”.', speech: 'Không có địa điểm nào khớp.' };
    }

    if (has(q, 'khoi nghia', 'lich su', 'yen the', 'gioi thieu')) {
      return { html: `<p>${esc(HISTORY)}</p>`, speech: HISTORY, actions: [{ label: '➤ Bắt đầu hành trình giáo dục', type: 'journey' }] };
    }

    return {
      html: 'Tôi chưa hiểu câu hỏi. Bạn có thể thử:<ul><li>“Tìm các căn cứ của Đề Thám”</li><li>“Các đình ở Nhã Nam”</li><li>“Kể về Đền Thề”</li><li>“Tham quan 360 Chùa Lèo”</li><li>“Sáu điều Bác Hồ dạy CAND”</li></ul>',
      speech: 'Tôi chưa hiểu câu hỏi. Bạn hãy thử hỏi, ví dụ: tìm các căn cứ của Đề Thám.',
    };
  }

  return { answer, norm };
})();
