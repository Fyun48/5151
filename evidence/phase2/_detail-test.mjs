async (page) => {
  const ROOT = '/workspace/repos/5151';
  const OUT = ROOT + '/evidence/phase2';
  const results = [];

  const photo = (label, bg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="100%" height="100%" fill="' + bg + '"/><text x="400" y="300" font-size="46" text-anchor="middle" fill="#0b5551" font-family="sans-serif">' + label + '</text></svg>'
  );
  const photos = ['#e7f1ef', '#f3f6f5', '#f7f1f0', '#eceaf4', '#e4dfd6', '#faf8f4'].map((bg, i) => photo('照片 ' + (i + 1), bg));

  const fullDetail = {
    listingId: 5001, source: '591',
    title: '大安區整層住家 3房2廳2衛 近捷運 可養寵物',
    rent: 27000, rentIncludes: ['管理費', '水費'], extraMonthlyFee: 800,
    deposit: '2 個月', areaPing: 38.6, floor: 2, floorsTotal: 7,
    layout: { rooms: 3, halls: 2, baths: 2 },
    address: '台北市大安區仁愛路四段 12 巷 3 弄 5 號 2F',
    district: '大安區', community: '仁愛經典',
    mrt: { station: '捷運忠孝復興站', walkMinutes: 6 },
    photos: photos.map((u) => ({ url: u })),
    tags: ['整層住家', '3房2廳2衛', '2F/7F', '大安區'],
    equipment: ['電梯', '陽台', '可養寵物', '天然瓦斯', '冷氣', '冰箱', '洗衣機', '熱水器', '床', '桌子', '椅子', '網路'],
    description: '近捷運、生活機能佳，走路 6 分鐘到捷運忠孝復興站。整層住家，三面採光，前後陽台，通風良好。\n社區有管理員，垃圾集中處理，可代收包裹。租金已含管理費與水費，電費、瓦斯費依帳單自付。',
    status: '刊登中', updatedAt: '2026-10-03T10:00:00.000Z',
    contact: { masked: false, phone: '0912345678', line: 'jibby', lineUrl: 'https://line.me/R/ti/p/example', ownerNick: '王小姐' },
    share: { enabled: true }
  };

  const nullDetail = {
    listingId: 5002, source: '591',
    title: '整層住家出租',
    rent: 18000, rentIncludes: null, extraMonthlyFee: null, deposit: null,
    areaPing: null, floor: null, floorsTotal: null,
    layout: { rooms: 2, halls: null, baths: 1 },
    address: '新北市板橋區文化路一段 100 號', district: '板橋區', community: null,
    mrt: null, photos: [], tags: [], equipment: [], description: null,
    status: null, updatedAt: null,
    contact: { masked: true, phone: null, line: null, lineUrl: null, hint: '登入後可查看屋主完整聯絡方式。', ownerNick: null },
    share: { enabled: true }
  };

  const similarItems = [
    { listingId: 5011, title: '大安區 2房1廳1衛 整層住家', rent: 25000, district: '大安區', layoutLabel: '2房1廳1衛', photoUrl: photo('相似1', '#e7f1ef') },
    { listingId: 5012, title: '中正區 3房2廳2衛 整層住家', rent: 29000, district: '中正區', layoutLabel: '3房2廳2衛', photoUrl: photo('相似2', '#f3f6f5') },
    { listingId: 5013, title: '大安區 1房1廳1衛 電梯大樓', rent: 19500, district: '大安區', layoutLabel: '1房1廳1衛', photoUrl: photo('相似3', '#f7f1f0') },
    { listingId: 5014, title: '松山區 2房2廳1衛 公寓', rent: 22000, district: '松山區', layoutLabel: '2房2廳1衛', photoUrl: photo('相似4', '#eceaf4') }
  ];

  const mock = {
    detail: fullDetail,
    similar: { items: similarItems },
    me: { ok: true, nickname: '測試會員', email: 'demo@example.com' },
    shareLink: { status: 200, body: { shareToken: 'tok123', url: 'http://127.0.0.1:8903/p/5001?ref=tok123', dailyUsed: 3, dailyLimit: 20 } }
  };

  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    if (p === '/p/5001') return route.fulfill({ path: ROOT + '/v3/public/detail.html', contentType: 'text/html' });
    if (p === '/tokens.css') return route.fulfill({ path: ROOT + '/v3/public/tokens.css', contentType: 'text/css' });
    if (p.startsWith('/api/public/listings/') && p.endsWith('/detail')) {
      if (mock.detail === '404') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'listing_not_found' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock.detail) });
    }
    if (p.startsWith('/api/public/listings/') && p.endsWith('/similar')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock.similar) });
    }
    if (p === '/api/me') {
      if (mock.me === 'guest') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock.me) });
    }
    if (p.endsWith('/share-link')) {
      return route.fulfill({ status: mock.shareLink.status, contentType: 'application/json', body: JSON.stringify(mock.shareLink.body) });
    }
    if (p.endsWith('/share-events')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recorded: true, is_bot: false }) });
    }
    return route.continue();
  });

  const BASE = 'http://127.0.0.1:8903/p/5001';

  async function load(width, height) {
    await page.setViewportSize({ width, height });
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const g = document.getElementById('detailGrid');
      const e = document.getElementById('errorState');
      return (g && !g.hidden) || (e && !e.hidden);
    }, { timeout: 5000 });
    await page.waitForTimeout(300);
  }

  async function metrics() {
    return page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('*').forEach((el) => {
        const o = getComputedStyle(el).order;
        if (o !== '0') bad.push({ tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : ''), order: o });
      });
      return {
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        vw: window.innerWidth,
        badOrder: bad,
        bodyHasNull: /\bnull\b/.test(document.body.innerText)
      };
    });
  }

  // Scenario 1: full fields + member — screenshots at 375/768/1440
  mock.detail = fullDetail; mock.similar = { items: similarItems }; mock.me = { ok: true, nickname: '測試會員' };
  for (const [w, h, name] of [[375, 812, 'detail-375.png'], [768, 1024, 'detail-768.png'], [1440, 900, 'detail-1440.png']]) {
    await load(w, h);
    await page.screenshot({ path: OUT + '/' + name, fullPage: true });
    const m = await metrics();
    results.push({ scenario: name, sw: m.sw, cw: m.cw, vw: m.vw, badOrderCount: m.badOrder.length, badOrder: m.badOrder.slice(0, 3), bodyHasNull: m.bodyHasNull });
  }

  // Lightbox at 1440
  await load(1440, 900);
  await page.click('.main-photo');
  await page.waitForFunction(() => { const lb = document.getElementById('lightbox'); return lb && !lb.hidden; }, { timeout: 3000 });
  const lbInfo = await page.evaluate(() => ({ imgAlt: document.getElementById('lbImg').alt, count: document.getElementById('lbCount').textContent }));
  await page.screenshot({ path: OUT + '/detail-lightbox-1440.png' });
  results.push({ scenario: 'lightbox', open: true, imgAlt: lbInfo.imgAlt, count: lbInfo.count });
  await page.keyboard.press('Escape');

  // Guest contact at 375
  mock.detail = Object.assign({}, fullDetail, { contact: { masked: true, phone: null, line: null, lineUrl: null, hint: '登入後可查看屋主完整聯絡方式。', ownerNick: null } });
  mock.me = 'guest';
  await load(375, 812);
  await page.screenshot({ path: OUT + '/detail-guest-contact-375.png', fullPage: true });
  const gc = await page.evaluate(() => ({
    hasLoginLink: !!document.querySelector('#contact a[href="/login.html"]'),
    hasPhone: /tel:/.test(document.getElementById('contact').innerHTML),
    hasLine: /line\.me/.test(document.getElementById('contact').innerHTML)
  }));
  results.push({ scenario: 'guest-contact', hasLoginLink: gc.hasLoginLink, hasPhone: gc.hasPhone, hasLine: gc.hasLine });

  // Multi-null fields + similar empty
  mock.detail = nullDetail; mock.similar = { items: [] }; mock.me = 'guest';
  await load(375, 812);
  const nm = await metrics();
  const nullState = await page.evaluate(() => ({
    basicText: (document.getElementById('basic') || {}).innerText || '',
    similarText: (document.getElementById('similar') || {}).innerText || '',
    galleryText: (document.querySelector('.gallery-panel') || {}).innerText || ''
  }));
  results.push({ scenario: 'multi-null', bodyHasNull: nm.bodyHasNull, basicText: nullState.basicText, similarText: nullState.similarText, galleryText: nullState.galleryText });

  // 404
  mock.detail = '404'; mock.similar = { items: [] }; mock.me = 'guest';
  await load(375, 812);
  await page.screenshot({ path: OUT + '/detail-404-375.png' });
  const e404 = await page.evaluate(() => (document.getElementById('errorState') || {}).innerText || '');
  results.push({ scenario: '404', errorText: e404 });

  // Share branches (member)
  mock.detail = fullDetail; mock.similar = { items: similarItems }; mock.me = { ok: true, nickname: '測試會員' };

  // 401 -> login dialog
  mock.shareLink = { status: 401, body: { error: '請先登入', code: 'AUTH_REQUIRED' } };
  await load(375, 812);
  await page.click('[data-share-trigger]');
  await page.waitForFunction(() => { const d = document.getElementById('shareLogin'); return d && !d.hidden; }, { timeout: 3000 });
  results.push({ scenario: 'share-401', shareLoginOpen: true });
  await page.keyboard.press('Escape');

  // 429 -> limit message
  mock.shareLink = { status: 429, body: { error: '今日分享連結已達上限', code: 'SHARE_LINK_LIMIT' } };
  await load(375, 812);
  await page.click('[data-share-trigger]');
  await page.waitForFunction(() => { const d = document.getElementById('sharePanel'); return d && !d.hidden; }, { timeout: 3000 });
  const lim = await page.evaluate(() => !document.getElementById('shareLimitMsg').hidden);
  results.push({ scenario: 'share-429', limitVisible: lim });
  await page.keyboard.press('Escape');

  // 409 -> hide share buttons
  mock.shareLink = { status: 409, body: { error: '分享功能已停用', code: 'SHARE_DISABLED' } };
  await load(375, 812);
  await page.click('[data-share-trigger]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-share-trigger]')].every((b) => b.hidden), { timeout: 3000 });
  results.push({ scenario: 'share-409', shareButtonsHidden: true });

  return results;
}
