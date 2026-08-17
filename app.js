/* ============================================================
 * 反诈信息日报 · 应用逻辑
 * hash 路由 + 双端渲染（桌面时间线 / 移动列表）
 * ============================================================ */
(function () {
  'use strict';

  var D = window.FZ_DATA;

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    var m = d.getMonth() + 1, day = d.getDate();
    return m + '月' + day + '日 · ' + wd;
  }
  function fmtDateShort(iso) {
    var d = new Date(iso + 'T00:00:00');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function riskLabel(r) { return { high: '高危', medium: '中危', low: '低危' }[r] || r; }
  function riskClass(r) { return 'risk-' + r; }
  function starIcon(starred) {
    return starred
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';
  }

  /* ---------- 收藏 ---------- */
  var STORE_KEY = 'fz-starred';
  function getStarred() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; }
  }
  function isStarred(id) { return getStarred().indexOf(id) !== -1; }
  function toggleStar(id) {
    var s = getStarred();
    var i = s.indexOf(id);
    if (i === -1) { s.push(id); } else { s.splice(i, 1); }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
    return i === -1;
  }

  /* ---------- 导航 / 路由 ---------- */
  var ROUTES = {
    '':      { nav: 'feed', title: '精选' },
    'feed':  { nav: 'feed', title: '精选' },
    'all':   { nav: 'all', title: '全部动态' },
    'hot':   { nav: 'hot', title: '热点榜' },
    'alerts':{ nav: 'alerts', title: '风险预警' },
    'daily': { nav: 'daily', title: '反诈日报' },
    'types': { nav: 'types', title: '诈骗类型' },
    'guides':{ nav: 'guides', title: '防护指南' },
    'starred':{ nav: 'starred', title: '收藏' }
  };
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('?');
    var route = parts[0] || '';
    var q = {};
    if (parts[1]) {
      parts[1].split('&').forEach(function (kv) {
        var p = kv.split('=');
        q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    }
    /* 归一化：空字符串 / 未知路由 → feed；其余必须存在于 ROUTES */
    if (route === '') return { route: 'feed', query: q };
    return { route: ROUTES[route] ? route : 'feed', query: q };
  }
  function setActiveNav(nav) {
    document.querySelectorAll('[data-nav]').forEach(function (el) {
      var active = el.getAttribute('data-nav') === nav;
      el.classList.toggle('side-link-active', active && el.classList.contains('side-link'));
      el.classList.toggle('m-tab-active', active && el.classList.contains('m-tab'));
      if (active && el.hasAttribute('aria-current')) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    document.title = (ROUTES[nav] ? ROUTES[nav].title : '反诈信息日报') + ' — 反诈信息日报';
  }

  /* ---------- 通用片段 ---------- */
  function itemHead(item, opts) {
    opts = opts || {};
    var star = isStarred(item.id);
    var typeBadge = item.type ? '<span class="timeline-type-badge">' + esc(item.type) + '</span>' : '';
    var selBadge = item.selected ? '<span class="timeline-selected-badge" title="编辑精选">精选</span>' : '';
    var riskBadge = '<span class="timeline-risk-badge ' + riskClass(item.risk) + '">' + riskLabel(item.risk) + '</span>';
    var starBtn = opts.star !== false
      ? '<button type="button" class="timeline-star' + (star ? ' is-starred' : '') + '" aria-label="收藏" aria-pressed="' + star + '" title="' + (star ? '取消收藏' : '收藏') + '" data-star="' + item.id + '">' + starIcon(star) + '</button>'
      : '';
    return '<div class="timeline-card-head">' +
      '<div class="timeline-head-left"><span class="timeline-source">' + esc(item.source) + '</span>' + typeBadge + selBadge + '</div>' +
      '<div class="timeline-head-right">' + riskBadge + starBtn + '</div>' +
      '</div>';
  }
  function itemReason(item) {
    if (!item.reason) return '';
    return '<hr class="timeline-divider"><div class="timeline-reason"><span class="timeline-reason-label">警示要点：</span>' + esc(item.reason) + '</div>';
  }
  function itemDups(item) {
    if (!item.dups || !item.dups.length) return '';
    var items = item.dups.map(function (d) { return '<span class="dup-tooltip-item">' + esc(d) + '</span>'; }).join('');
    return '<span class="timeline-dup-count">另有 ' + item.dups.length + ' 家信源报道<span class="dup-tooltip"><span class="dup-tooltip-title">其他报道</span>' + items + '</span></span>';
  }
  function itemCard(item, opts) {
    opts = opts || {};
    var url = item.url ? esc(item.url) : '#';
    var target = item.url ? ' target="_blank" rel="noopener noreferrer"' : '';
    var titleTag = item.url ? '<a class="timeline-title" href="' + url + '"' + target + '>' + esc(item.title) + '</a>'
      : '<span class="timeline-title">' + esc(item.title) + '</span>';
    return '<article class="timeline-card" data-id="' + item.id + '">' +
      itemHead(item, opts) +
      titleTag +
      '<p class="timeline-summary">' + esc(item.summary) + '</p>' +
      (opts.dups !== false ? itemDups(item) : '') +
      itemReason(item) +
      '</article>';
  }
  function timelineHTML(items) {
    if (!items.length) {
      return '<div class="empty-state"><div class="empty-icon">🛡️</div><p>暂无相关条目</p><span class="empty-sub">试试切换筛选条件，或明天再来看看</span></div>';
    }
    var byDay = {};
    items.forEach(function (it) { (byDay[it.date] = byDay[it.date] || []).push(it); });
    var days = Object.keys(byDay).sort().reverse();
    var today = todayISO();
    return '<section class="timeline">' + days.map(function (day) {
      var list = byDay[day].slice().sort(function (a, b) { return a.time < b.time ? 1 : -1; });
      var isToday = day === today;
      return '<div class="timeline-day">' +
        '<div class="timeline-day-head"><h2 class="timeline-date">' + fmtDateShort(day) + '</h2>' +
        '<button type="button" class="timeline-day-toggle" aria-expanded="true" aria-label="收起 ' + fmtDateShort(day) + '" title="收起">' +
        '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 5.25L7 8.75l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>' +
        '<div class="timeline-day-meta">' + (isToday ? '今天 · ' : '') + list.length + ' 条</div></div>' +
        '<div class="timeline-day-items">' + list.map(function (it) {
          return '<div class="timeline-item timeline-item-' + it.risk + '">' +
            '<div class="timeline-time">' + esc(it.time) + '</div>' +
            '<div class="timeline-rail" aria-hidden="true"><span class="timeline-dot"></span></div>' +
            itemCard(it) +
            '</div>';
        }).join('') + '</div></div>';
    }).join('') + '</section>';
  }
  function pageHeaderHTML(title, desc, metaHTML) {
    return '<header class="page-header"><h1>' + esc(title) + '</h1>' +
      (desc ? '<p class="page-header-desc">' + desc + '</p>' : '') +
      (metaHTML ? '<div class="page-header-meta">' + metaHTML + '</div>' : '') +
      '</header>';
  }

  /* ---------- 各视图 ---------- */
  function viewFeed() {
    var items = D.items.filter(function (it) { return it.selected; });
    var count = D.items.length;
    return pageHeaderHTML('精选',
      D.meta.slogan,
      '<span class="pill pill-rose">高危案例 ' + D.items.filter(function (i) { return i.risk === 'high'; }).length + '</span>' +
      '<span class="pill pill-cyan">今日更新</span>' +
      '<span>共收录 ' + count + ' 条动态</span>') +
      '<div class="notice-banner"><span class="notice-icon">⚠️</span><div><strong>反诈提醒：</strong>凡电话、网络中以任何理由要求转账、验资、提供验证码的，一律先挂断并拨打 <strong>96110</strong> 咨询。96110 来电请务必接听。</div></div>' +
      timelineHTML(items);
  }

  function viewAll(query) {
    var q = query || {};
    var kw = (q.q || '').toLowerCase();
    var type = q.type || '';
    var items = D.items.filter(function (it) {
      if (type && it.type !== type) return false;
      if (kw) {
        var hay = (it.title + it.summary + it.source + (it.type || '') + (it.reason || '')).toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }
      return true;
    });
    var types = [];
    D.items.forEach(function (it) { if (it.type && types.indexOf(it.type) === -1) types.push(it.type); });
    var chips = '<div class="toolbar"><div class="chips-row">' +
      '<button class="chip' + (!type ? ' chip-active' : '') + '" data-chip-type="">全部</button>' +
      types.map(function (t) {
        return '<button class="chip' + (type === t ? ' chip-active' : '') + '" data-chip-type="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') + '</div>' +
      '<div class="toolbar-spacer"></div>' +
      '<div class="search-box"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.35-4.35"></path></svg>' +
      '<input type="search" id="all-search" placeholder="搜索标题 / 摘要 / 来源" value="' + esc(kw) + '"></div></div>';
    return pageHeaderHTML('全部动态',
      '反诈资讯、风险案例、政策动态的完整时间线，支持按类型筛选与关键词搜索。',
      '<span>共 ' + items.length + ' 条</span>') +
      chips + timelineHTML(items);
  }

  function viewHot() {
    var ranked = D.types.slice().sort(function (a, b) { return parseFloat(b.share) - parseFloat(a.share); });
    var rankCls = ['r1', 'r2', 'r3'];
    var typeList = ranked.map(function (t, i) {
      return '<a class="hot-item" href="#/types">' +
        '<span class="hot-rank ' + (rankCls[i] || '') + '">' + (i + 1) + '</span>' +
        '<span class="hot-body"><span class="hot-title">' + esc(t.name) + '</span>' +
        '<span class="hot-meta"><span class="hot-share">发案占比 ' + esc(t.share) + '</span><span>风险等级：' + riskLabel(t.risk) + '</span></span></span></a>';
    }).join('');
    var hotCases = D.items.filter(function (it) { return it.risk === 'high'; }).slice(0, 6).map(function (it) {
      return '<a class="hot-item" href="' + (it.url ? esc(it.url) : '#') + '"' + (it.url ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' +
        '<span class="hot-body"><span class="hot-title">' + esc(it.title) + '</span>' +
        '<span class="hot-meta"><span>' + esc(it.source) + '</span><span>' + fmtDateShort(it.date) + '</span></span></span></a>';
    }).join('');
    return pageHeaderHTML('热点榜',
      '公安部公布的高发诈骗类型排行与近期高危风险案例，先看排名，再防身。',
      '<span class="pill pill-rose">刷单返利居首</span><span class="pill pill-amber">占电诈总量 85%</span>') +
      '<div class="hot-board">' +
      '<section class="hot-section"><h2><span class="hot-sec-icon">🔥</span>十类高发诈骗类型排行</h2><div class="hot-list">' + typeList + '</div></section>' +
      '<section class="hot-section"><h2><span class="hot-sec-icon">🚨</span>近期高危风险案例</h2><div class="hot-list">' + (hotCases.length ? hotCases : '<div class="empty-state"><p>暂无</p></div>') + '</div></section>' +
      '</div>';
  }

  function viewAlerts() {
    var alerts = D.alerts.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var list = alerts.map(function (a) {
      var lvl = a.level === 'high' ? '高危' : (a.level === 'medium' ? '中危' : '提示');
      var url = a.url ? ' href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer"' : '';
      var titleTag = a.url ? '<a class="alert-title"' + url + '>' + esc(a.title) + '</a>' : '<span class="alert-title">' + esc(a.title) + '</span>';
      return '<div class="alert-card level-' + a.level + '">' +
        '<div class="alert-head"><span class="timeline-risk-badge ' + riskClass(a.level) + '">' + lvl + '</span>' +
        '<span class="alert-date">' + fmtDate(a.date) + '</span></div>' +
        titleTag +
        '<p class="alert-content">' + esc(a.content) + '</p>' +
        '<span class="alert-source">来源：' + esc(a.source) + '</span></div>';
    }).join('');
    return pageHeaderHTML('风险预警',
      '来自公安机关、权威媒体的紧急风险提示与高发骗局预警，第一时间了解最新诈骗手法。',
      '<span class="pill pill-rose">高危 ' + D.alerts.filter(function (a) { return a.level === 'high'; }).length + '</span>' +
      '<span class="pill pill-amber">中危 ' + D.alerts.filter(function (a) { return a.level === 'medium'; }).length + '</span>') +
      '<div class="notice-banner"><span class="notice-icon">📢</span><div>收到预警信息后，请第一时间提醒家人，尤其是独居老人与在校学生——他们是骗子最优先的目标。</div></div>' +
      '<div>' + list + '</div>';
  }

  function viewDaily() {
    var dailies = D.dailies.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var list = dailies.map(function (d) {
      return '<div class="daily-card">' +
        '<div class="daily-head"><h2 class="daily-title">' + esc(d.title) + '</h2>' +
        '<span class="daily-date">' + fmtDate(d.date) + '</span></div>' +
        '<div class="daily-stats">' + esc(d.stats) + '</div>' +
        '<ul class="daily-content">' + d.content.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>' +
        '</div>';
    }).join('');
    return pageHeaderHTML('反诈日报',
      '每日反诈信息汇总：今天有哪些新案例、新预警、新防骗要点，一篇看完。每天 8 时更新。',
      '<span class="pill pill-cyan">每日更新</span><span>最近日报：' + (dailies[0] ? fmtDateShort(dailies[0].date) : '—') + '</span>') +
      '<div>' + list + '</div>';
  }

  function viewTypes() {
    var cards = D.types.map(function (t, i) {
      return '<article class="type-card">' +
        '<div class="type-card-head"><span class="type-index">' + (i + 1) + '</span>' +
        '<span class="type-name">' + esc(t.name) + '</span>' +
        '<span class="type-share">占比 ' + esc(t.share) + '</span></div>' +
        '<p class="type-desc">' + esc(t.desc) + '</p>' +
        '<ul class="type-signs">' + t.signs.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
        '<p class="type-counter">🛡️ ' + esc(t.counter) + '</p>' +
        '<span class="type-source">来源：' + esc(t.source) + '</span>' +
        '</article>';
    }).join('');
    return pageHeaderHTML('诈骗类型',
      '公安部公布的十类高发电信网络诈骗，逐类拆解手法、识别特征与应对口诀。',
      '<span class="pill pill-rose">十类手法占电诈案件 85%</span>') +
      '<div class="type-grid">' + cards + '</div>';
  }

  function viewGuides() {
    var cats = [];
    D.guides.forEach(function (g) { if (cats.indexOf(g.category) === -1) cats.push(g.category); });
    var cards = D.guides.map(function (g) {
      return '<div class="guide-card">' +
        '<div class="guide-head"><span class="guide-cat">' + esc(g.category) + '</span>' +
        '<h3 class="guide-title">' + esc(g.title) + '</h3></div>' +
        '<ul class="guide-content">' + g.content.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>' +
        '</div>';
    }).join('');
    return pageHeaderHTML('防护指南',
      '从核心号码、必备工具到受骗处置，一套完整的反诈防护手册，转给家人朋友。',
      '<span class="pill pill-green">' + D.guides.length + ' 篇指南</span><span class="pill pill-cyan">' + cats.length + ' 个主题</span>') +
      '<div class="guide-list">' + cards + '</div>';
  }

  function viewStarred() {
    var items = D.items.filter(function (it) { return isStarred(it.id); });
    return pageHeaderHTML('收藏',
      '你收藏的反诈资讯，方便随时回顾与转发给家人。',
      '<span>' + items.length + ' 条已收藏</span>') +
      (items.length ? '<div class="star-hint">点击星标可取消收藏。</div>' + timelineHTML(items)
        : '<div class="empty-state"><div class="empty-icon">⭐</div><p>还没有收藏任何条目</p><span class="empty-sub">在资讯卡片右上角点击星标即可收藏</span></div>');
  }

  var VIEWS = {
    feed: viewFeed, all: viewAll, hot: viewHot,
    alerts: viewAlerts, daily: viewDaily, types: viewTypes,
    guides: viewGuides, starred: viewStarred
  };

  /* ---------- 移动端渲染 ---------- */
  function mPageHead(route) {
    var r = ROUTES[route];
    var descMap = {
      feed: D.meta.slogan,
      all: '反诈资讯与风险案例完整时间线，可搜索、可按类型筛选。',
      hot: '高发诈骗类型排行与近期高危案例。',
      alerts: '紧急风险提示与高发骗局预警。',
      daily: '每日反诈信息汇总，每天 8 时更新。',
      types: '公安部公布的十类高发电诈手法全拆解。',
      guides: '核心号码、必备工具、防骗口诀与受骗处置。',
      starred: '你收藏的反诈资讯。'
    };
    return '<div class="m-page-head"><h1>' + esc(r.title) + '</h1>' +
      '<p class="m-page-desc">' + esc(descMap[route] || '') + '</p>' +
      '<div class="m-page-meta">数据更新：' + esc(D.updatedAt) + '</div></div>';
  }
  function mItemRow(item) {
    var star = isStarred(item.id);
    var url = item.url ? esc(item.url) : '#';
    var target = item.url ? ' target="_blank" rel="noopener noreferrer"' : '';
    return '<div class="m-row-wrap" data-item-id="' + item.id + '">' +
      '<a class="m-row" href="' + url + '"' + target + '>' +
      '<span class="m-row-time">' + fmtDateShort(item.date) + ' ' + esc(item.time) + '</span>' +
      '<span class="m-row-meta"><span class="m-row-src">' + esc(item.source) + '</span>' +
      '<span class="m-score ' + riskClass(item.risk) + '">' + riskLabel(item.risk) + '</span>' +
      (item.selected ? '<span class="m-score risk-medium" style="background:transparent;border:1px solid currentColor">精选</span>' : '') +
      '</span>' +
      '<span class="m-row-title">' + esc(item.title) + '</span>' +
      '<span class="m-row-summary">' + esc(item.summary) + '</span>' +
      (item.reason ? '<span class="m-row-reason-block"><span class="m-row-reason-clamp"><span class="m-row-reason-label">警示要点：</span>' + esc(item.reason) + '</span></span>' : '') +
      '<span class="m-row-foot"><span class="timeline-risk-badge ' + riskClass(item.risk) + '">' + riskLabel(item.risk) + '</span>' +
      (item.type ? '<span class="timeline-type-badge">' + esc(item.type) + '</span>' : '') +
      '</span></a></div>';
  }
  function mTimelineHTML(items) {
    if (!items.length) {
      return '<div class="empty-state"><div class="empty-icon">🛡️</div><p>暂无相关条目</p><span class="empty-sub">试试切换筛选，或明天再来看看</span></div>';
    }
    var byDay = {};
    items.forEach(function (it) { (byDay[it.date] = byDay[it.date] || []).push(it); });
    var days = Object.keys(byDay).sort().reverse();
    var today = todayISO();
    return days.map(function (day) {
      var list = byDay[day].slice().sort(function (a, b) { return a.time < b.time ? 1 : -1; });
      var isToday = day === today;
      return '<div class="m-daygroup"><h2 class="m-daybar"><span class="m-daybar-main">' + fmtDateShort(day) + '</span>' +
        '<span class="m-daybar-sub">' + (isToday ? '今天 · ' : '') + list.length + ' 条</span></h2>' +
        '<div class="m-rows">' + list.map(mItemRow).join('') + '</div></div>';
    }).join('');
  }
  function renderMobile(route, query) {
    var content = document.getElementById('m-content');
    var chipsRow = document.getElementById('m-chips-row');
    var chips = document.getElementById('m-chips');
    document.getElementById('m-today').textContent = fmtDate(todayISO());

    if (route === 'all') {
      chipsRow.hidden = false;
      var types = [];
      D.items.forEach(function (it) { if (it.type && types.indexOf(it.type) === -1) types.push(it.type); });
      chips.innerHTML = '<button class="m-chip' + (!query.type ? ' is-active' : '') + '" data-mchip-type="">全部</button>' +
        types.map(function (t) {
          return '<button class="m-chip' + (query.type === t ? ' is-active' : '') + '" data-mchip-type="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('');
      var kw = (query.q || '').toLowerCase();
      var items = D.items.filter(function (it) {
        if (query.type && it.type !== query.type) return false;
        if (kw) {
          var hay = (it.title + it.summary + it.source + (it.type || '')).toLowerCase();
          if (hay.indexOf(kw) === -1) return false;
        }
        return true;
      });
      content.innerHTML = mPageHead('all') + '<div class="m-search-bar"><input type="search" id="m-all-search" placeholder="搜索标题 / 摘要 / 来源" value="' + esc(kw) + '"></div>' +
        '<div class="m-panel">' + mTimelineHTML(items) + '</div>';
    } else if (route === 'feed') {
      chipsRow.hidden = true;
      content.innerHTML = mPageHead('feed') +
        '<div class="notice-banner" style="margin:10px 18px 16px"><span class="notice-icon">⚠️</span><div>凡要求转账、验资、提供验证码的，一律先挂断并拨打 <strong>96110</strong>。</div></div>' +
        '<div class="m-panel">' + mTimelineHTML(D.items.filter(function (it) { return it.selected; })) + '</div>';
    } else if (route === 'alerts') {
      chipsRow.hidden = true;
      var list = D.alerts.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (a) {
        var lvl = a.level === 'high' ? '高危' : (a.level === 'medium' ? '中危' : '提示');
        return '<div class="m-alert-card alert-card level-' + a.level + '">' +
          '<div class="alert-head"><span class="timeline-risk-badge ' + riskClass(a.level) + '">' + lvl + '</span>' +
          '<span class="alert-date">' + fmtDate(a.date) + '</span></div>' +
          '<span class="alert-title">' + esc(a.title) + '</span>' +
          '<p class="alert-content">' + esc(a.content) + '</p>' +
          '<span class="alert-source">来源：' + esc(a.source) + '</span></div>';
      }).join('');
      content.innerHTML = mPageHead('alerts') + '<div class="m-panel">' + list + '</div>';
    } else if (route === 'daily') {
      chipsRow.hidden = true;
      var dls = D.dailies.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (d) {
        return '<div class="m-daily-card daily-card">' +
          '<div class="daily-head"><h2 class="daily-title">' + esc(d.title) + '</h2><span class="daily-date">' + fmtDate(d.date) + '</span></div>' +
          '<div class="daily-stats">' + esc(d.stats) + '</div>' +
          '<ul class="daily-content">' + d.content.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>';
      }).join('');
      content.innerHTML = mPageHead('daily') + '<div class="m-panel">' + dls + '</div>';
    } else if (route === 'types') {
      chipsRow.hidden = true;
      var cards = D.types.map(function (t, i) {
        return '<div class="m-type-card type-card">' +
          '<div class="type-card-head"><span class="type-index">' + (i + 1) + '</span><span class="type-name">' + esc(t.name) + '</span><span class="type-share">' + esc(t.share) + '</span></div>' +
          '<p class="type-desc">' + esc(t.desc) + '</p>' +
          '<ul class="type-signs">' + t.signs.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
          '<p class="type-counter">🛡️ ' + esc(t.counter) + '</p></div>';
      }).join('');
      content.innerHTML = mPageHead('types') + '<div class="m-panel">' + cards + '</div>';
    } else if (route === 'guides') {
      chipsRow.hidden = true;
      var gs = D.guides.map(function (g) {
        return '<div class="m-guide-card guide-card">' +
          '<div class="guide-head"><span class="guide-cat">' + esc(g.category) + '</span><h3 class="guide-title">' + esc(g.title) + '</h3></div>' +
          '<ul class="guide-content">' + g.content.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>';
      }).join('');
      content.innerHTML = mPageHead('guides') + '<div class="m-panel">' + gs + '</div>';
    } else if (route === 'starred') {
      chipsRow.hidden = true;
      var st = D.items.filter(function (it) { return isStarred(it.id); });
      content.innerHTML = mPageHead('starred') + '<div class="m-panel">' + mTimelineHTML(st) + '</div>';
    } else {
      chipsRow.hidden = true;
      var ranked = D.types.slice().sort(function (a, b) { return parseFloat(b.share) - parseFloat(a.share); });
      var rankCls = ['r1', 'r2', 'r3'];
      var tl = ranked.map(function (t, i) {
        return '<a class="hot-item" href="#/types"><span class="hot-rank ' + (rankCls[i] || '') + '">' + (i + 1) + '</span>' +
          '<span class="hot-body"><span class="hot-title">' + esc(t.name) + '</span><span class="hot-meta"><span class="hot-share">' + esc(t.share) + '</span></span></span></a>';
      }).join('');
      content.innerHTML = mPageHead('hot') + '<div class="m-panel"><div class="hot-list">' + tl + '</div></div>';
    }
  }

  /* ---------- 渲染入口 ---------- */
  function render() {
    var r = parseHash();
    var viewFn = VIEWS[r.route];
    var html = viewFn(r.query);
    var main = document.getElementById('app-main');
    if (main) main.innerHTML = html + '<footer class="site-footer"><strong>免责声明：</strong>' + esc(D.meta.warning) + '<br>本站数据来源为公开报道，仅供反诈宣传参考；具体案件信息以公安机关通报为准。</footer>';
    renderMobile(r.route, r.query);
    setActiveNav(ROUTES[r.route].nav);
    document.getElementById('side-updated').textContent = D.updatedAt;
    var ac = document.getElementById('alert-count');
    if (ac) ac.textContent = D.alerts.filter(function (a) { return a.level === 'high'; }).length;

    /* 事件绑定（仅动态元素：搜索框） */
    bindEvents(r);
  }

  function bindEvents(r) {
    /* 搜索（回车 / 输入防抖） */
    var dSearch = document.getElementById('all-search');
    if (dSearch) {
      dSearch.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var type = r.query.type || '';
          location.hash = '#/all?q=' + encodeURIComponent(dSearch.value.trim()) + (type ? '&type=' + encodeURIComponent(type) : '');
        }
      });
    }
    var mSearch = document.getElementById('m-all-search');
    if (mSearch) {
      mSearch.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var type = r.query.type || '';
          location.hash = '#/all?q=' + encodeURIComponent(mSearch.value.trim()) + (type ? '&type=' + encodeURIComponent(type) : '');
        }
      });
    }
  }

  /* ---------- 全局事件委托（仅绑定一次，避免重复） ---------- */
  document.body.addEventListener('click', function (e) {
    var star = e.target.closest('[data-star]');
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      toggleStar(star.getAttribute('data-star'));
      render();
      return;
    }
    /* 类型筛选 chip（桌面） */
    var chip = e.target.closest('[data-chip-type]');
    if (chip) {
      var type = chip.getAttribute('data-chip-type');
      var q = { type: type };
      var kw = document.getElementById('all-search');
      if (kw && kw.value.trim()) q.q = kw.value.trim();
      location.hash = '#/all?' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
      return;
    }
    /* 类型筛选 chip（移动） */
    var mchip = e.target.closest('[data-mchip-type]');
    if (mchip) {
      var mt = mchip.getAttribute('data-mchip-type');
      var mq = { type: mt };
      var mkw = document.getElementById('m-all-search');
      if (mkw && mkw.value.trim()) mq.q = mkw.value.trim();
      location.hash = '#/all?' + Object.keys(mq).map(function (k) { return k + '=' + encodeURIComponent(mq[k]); }).join('&');
      return;
    }
    /* 日期折叠 */
    var toggle = e.target.closest('.timeline-day-toggle');
    if (toggle) {
      var head = toggle.closest('.timeline-day-head');
      var items = head.nextElementSibling;
      var collapsed = toggle.classList.toggle('is-collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      items.style.display = collapsed ? 'none' : '';
      return;
    }
  });

  /* matchMedia 兜底（兼容 jsdom 等无此 API 的环境） */
  if (!window.matchMedia) {
    window.matchMedia = function () {
      return { matches: false, addEventListener: function () {}, removeEventListener: function () {} };
    };
  }

  /* ---------- 主题切换 ---------- */
  function applyTheme(mode) {
    var root = document.documentElement;
    var actual = mode;
    if (mode === 'auto') {
      actual = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    root.setAttribute('data-theme', actual);
    root.setAttribute('data-theme-mode', mode);
    try { localStorage.setItem('fz-theme', mode); } catch (e) {}
    document.querySelectorAll('[data-theme-opt]').forEach(function (btn) {
      var on = btn.getAttribute('data-theme-opt') === mode;
      btn.classList.toggle('theme-toggle-opt-active', on);
      btn.setAttribute('aria-checked', String(on));
    });
  }
  document.querySelectorAll('[data-theme-opt]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyTheme(btn.getAttribute('data-theme-opt'));
    });
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    var mode = document.documentElement.getAttribute('data-theme-mode');
    if (mode === 'auto') applyTheme('auto');
  });
  window.addEventListener('hashchange', render);
  render();
})();
