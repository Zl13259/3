/* ============================================================
 * 自选股量化监控台 v1.0 · 2026-10-21
 * ------------------------------------------------------------
 * 版权与合规说明：
 *   本项目所有代码均为原创实现。量化思路（均线系统、MACD、RSI、
 *   量比、板块联动打分）属于公开的经典技术分析思想，仅作借鉴，
 *   未复制任何开源项目的代码。若后续参考了具体开源项目的实现思路，
 *   会在对应位置注释署名致谢（仓库协议以不侵权为第一原则）。
 * 数据来源：
 *   腾讯财经公开行情接口（qt.gtimg.cn / web.ifzq.gtimg.cn），
 *   仅由浏览器本机直连，不经任何第三方服务器，不上传任何个人数据。
 * 免责声明：仅供个人学习研究，不构成投资建议。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 基础配置（读取 list.js） ---------- */
  var INDEX_CODES = ['sh000001', 'sz399006', 'usIXIC', 'usINX', 'usDJI', 'sh512480'];
  var STOCK_LIST = (window.STOCK_LIST || []).filter(function (x) { return INDEX_CODES.indexOf(x[0]) < 0; });
  var ALL_CODES  = (window.STOCK_LIST || []).map(function (x) { return x[0]; });
  var NAMES      = {}; (window.STOCK_LIST || []).forEach(function (x) { NAMES[x[0]] = x[1]; });
  var HOLDS      = {}; (window.HOLD_CODES || []).forEach(function (c) { HOLDS[c] = true; });
  var PROFILE    = window.PROFILE_OF || {};
  var SECTORS    = window.SECTORS || {};
  var THERMOS    = window.THERMOMETER || [];

  var REFRESH_SEC = 60;        // 实时行情刷新间隔
  var KLINE_TTL   = 10 * 60e3; // K线缓存 10 分钟

  /* ---------- 状态 ---------- */
  var quotes = {};      // 实时行情
  var kindata = {};     // 日K
  var kcache = {};      // K线缓存时间戳
  var scoreMap = {};    // 评分结果
  var sectorStat = {};  // 板块统计
  var sortKey = 'score', sortDir = -1;
  var timer = null;

  function $(s) { return document.querySelector(s); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function fmt(n, d) { return (n == null || !isFinite(n)) ? '-' : n.toFixed(d == null ? 2 : d); }
  function chgCls(v) { return v == null ? 'flat' : (v > 0 ? 'up' : (v < 0 ? 'down' : 'flat')); }
  function chgTxt(v) { if (v == null || !isFinite(v)) return '-'; return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

  /* ---------- 数据获取 ---------- */
  function fetchGBK(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) { return new TextDecoder('gbk').decode(b); });
  }

  /* 腾讯实时行情：批量（v_code="..." 格式，GBK 编码） */
  function loadQuotes() {
    var BATCH = 40, chain = Promise.resolve();
    for (var i = 0; i < ALL_CODES.length; i += BATCH) {
      (function (cs) {
        chain = chain.then(function () {
          return fetchGBK('https://qt.gtimg.cn/q=' + cs.join(',')).then(function (txt) {
            var re = /v_([a-z]{2}[0-9A-Za-z.]+)="([^"]*)"/g, m;
            while ((m = re.exec(txt))) {
              var f = m[2].split('~');
              var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : null; };
              var price = num(f[3]), pre = num(f[4]);
              var chg = (price && pre) ? (price - pre) / pre * 100 : null;
              quotes[m[1]] = {
                name: f[1] || NAMES[m[1]] || m[1],
                price: price, pre: pre, chg: chg,
                vol: num(f[36]), amt: num(f[37]), turn: num(f[38])
              };
            }
          });
        }).then(function () { return new Promise(function (r) { setTimeout(r, 150); }); });
      })(ALL_CODES.slice(i, i + BATCH));
    }
    return chain;
  }

  /* 腾讯日K线：并发受限 + 缓存 */
  function loadKlines(force) {
    var now = Date.now();
    var need = ALL_CODES.filter(function (c) {
      return force || !kcache[c] || (now - kcache[c]) > KLINE_TTL;
    });
    var idx = 0;
    function worker() {
      var steps = [];
      while (idx < need.length) {
        (function (c) {
          steps.push((function () {
            var t = c.indexOf('us') === 0 ? c + '.OQ' : c;
            var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + t + ',day,,,130,qfq';
            return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
              var d = (j.data && (j.data[t] || j.data[c])) || {};
              var arr = d.qfqday || d.day || [];
              kindata[c] = arr.map(function (k) {
                return { date: k[0], open: +k[1], close: +k[2], high: +k[3], low: +k[4], vol: +k[5] };
              });
              kcache[c] = now;
            }).catch(function () { kindata[c] = kindata[c] || []; })
              .then(function () { return new Promise(function (r) { setTimeout(r, 120); }); });
          })());
        })(need[idx++]);
      }
      return Promise.all(steps);
    }
    var workers = [];
    for (var w = 0; w < 5; w++) workers.push(worker());
    return Promise.all(workers);
  }

  /* ---------- 指标计算（原创实现） ---------- */
  function ema(arr, p) {
    var k = 2 / (p + 1), e = arr[0], out = [e];
    for (var i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
    return out;
  }
  function maArr(arr, n) {
    return arr.map(function (_, i) {
      if (i < n - 1) return null;
      var s = 0; for (var j = i - n + 1; j <= i; j++) s += arr[j];
      return s / n;
    });
  }
  function calcInd(k) {
    var closes = k.map(function (x) { return x.close; });
    var vols = k.map(function (x) { return x.vol; });
    var e12 = ema(closes, 12), e26 = ema(closes, 26);
    var dif = e12.map(function (v, i) { return v - e26[i]; });
    var dea = ema(dif, 9);
    var macd = dif.map(function (v, i) { return 2 * (v - dea[i]); });
    var rsi = closes.map(function (_, i) {
      if (i < 14) return null;
      var g = 0, l = 0;
      for (var j = i - 13; j <= i; j++) {
        var d = closes[j] - closes[j - 1];
        if (d > 0) g += d; else l -= d;
      }
      if (l === 0) return 100;
      return 100 - 100 / (1 + g / l);
    });
    return {
      ma5: maArr(closes, 5), ma10: maArr(closes, 10),
      ma20: maArr(closes, 20), ma60: maArr(closes, 60),
      dif: dif, dea: dea, macd: macd, rsi: rsi,
      volma20: maArr(vols, 20)
    };
  }

  /* ---------- 五因子评分（0-100，原创权重） ---------- */
  function scoreStock(c) {
    var k = kindata[c];
    if (!k || k.length < 30) return { score: null, sig: [], rsi: null, vr: null, trend: '数据不足' };
    var ind = calcInd(k), i = k.length - 1, p = k[i - 1];
    var close = k[i].close, q = quotes[c] || {};
    var prof = PROFILE[c] || 'growth';
    var sec = SECTORS[c] ? sectorStat[SECTORS[c]] : null;
    var s = 0, sig = [];

    /* 1. 趋势（35）：均线多头排列 + 关键均线位置 + 长期方向 */
    if (ind.ma20[i] && close > ind.ma20[i]) s += 10;
    if (ind.ma5[i] && ind.ma10[i] && ind.ma20[i] &&
        ind.ma5[i] > ind.ma10[i] && ind.ma10[i] > ind.ma20[i]) { s += 10; sig.push('多头排列'); }
    if (ind.ma60[i] && close > ind.ma60[i]) s += 10;
    if (ind.ma60[i] && ind.ma60[i - 1] && ind.ma60[i] > ind.ma60[i - 1]) s += 5;

    var trend = (close > ind.ma60[i] && ind.ma5[i] > ind.ma20[i]) ? '强势' :
                (close > ind.ma20[i]) ? '上升' :
                (close < ind.ma20[i] && close < ind.ma60[i]) ? '走弱' : '震荡';
    if (!ind.ma60[i]) trend = close > ind.ma20[i] ? '上升' : '震荡';

    /* 2. MACD（20） */
    if (ind.dif[i] > ind.dea[i]) {
      s += 8;
      if (p && ind.dif[i - 1] <= ind.dea[i - 1]) sig.push('金叉');
    } else if (p && ind.dif[i - 1] >= ind.dea[i - 1]) {
      sig.push('死叉');
    }
    if (ind.macd[i] > 0) s += 6;
    if (ind.dif[i] > 0) s += 6;

    /* 3. RSI（15）：健康区间加分，超买/超卖处理按板块画像区分 */
    var r = ind.rsi[i], rsiScore = 0;
    if (r != null) {
      if (r >= 45 && r <= 65) rsiScore = 8;
      else if (r > 65 && r <= 80) rsiScore = 4;
      else if (r > 80) { rsiScore = -5; sig.push('过热'); }
      else if (r < 30) {
        rsiScore = 6; sig.push('超卖');
        if (prof === 'value' || prof === 'cyclical') rsiScore = 10; /* 慢票超卖=机会 */
      }
    }
    s += Math.max(-5, Math.min(10, rsiScore));

    /* 4. 量比（15）：放量方向性；value 类量能权重减半（弱化噪音） */
    var vr = (ind.volma20[i] && k[i].vol) ? k[i].vol / ind.volma20[i] : 1;
    var vw = (prof === 'value') ? 0.5 : 1;
    var chg = q.chg == null ? 0 : q.chg;
    if (vr > 1.8 && chg > 0) {
      s += 10 * vw;
      var hi20 = Math.max.apply(null, k.slice(-20).map(function (x) { return x.high; }));
      if (vr > 2 && close >= hi20) sig.push('放量突破');
    } else if (vr > 1.2 && chg > 0) s += 6 * vw;
    else if (vr > 1.5 && chg < 0) { s -= 8 * vw; sig.push('放量下跌'); }

    /* 5. 板块联动（15）：同板块涨跌家数与平均涨幅 */
    if (sec && sec.n > 0) {
      if (sec.upRatio >= 0.7) s += 10;
      else if (sec.upRatio >= 0.5) s += 6;
      else if (sec.upRatio < 0.3) s -= 4;
      if (sec.avgChg > 1.5) s += 5;
      else if (sec.avgChg > 0.3) s += 3;
    }

    s = Math.max(0, Math.min(100, Math.round(s)));
    return { score: s, sig: sig, rsi: r, vr: vr, trend: trend };
  }

  /* ---------- 板块统计 ---------- */
  function calcSectors() {
    sectorStat = {};
    STOCK_LIST.forEach(function (x) {
      var c = x[0], sc = SECTORS[c];
      if (!sc) return;
      var q = quotes[c]; if (!q) return;
      if (!sectorStat[sc]) sectorStat[sc] = { name: sc, up: 0, n: 0, sum: 0 };
      var st = sectorStat[sc];
      if (q.chg != null) { st.n++; st.sum += q.chg; if (q.chg > 0) st.up++; }
    });
    Object.keys(sectorStat).forEach(function (k) {
      var st = sectorStat[k];
      st.avgChg = st.n ? st.sum / st.n : 0;
      st.upRatio = st.n ? st.up / st.n : 0;
    });
  }

  function badge(s) {
    if (s == null) return ['-', 'b-mid'];
    if (s >= 75) return ['强多', 'b-strong'];
    if (s >= 60) return ['关注', 'b-watch'];
    if (s >= 40) return ['中性', 'b-mid'];
    return ['回避', 'b-avoid'];
  }

  /* ---------- 渲染 ---------- */
  function renderThermo() {
    var bar = $('#tempbar'); bar.innerHTML = '';
    INDEX_CODES.forEach(function (c) {
      var q = quotes[c]; if (!q) return;
      var chip = el('span', 'chip', NAMES[c] + ' ');
      var b = el('b', chgCls(q.chg), chgTxt(q.chg));
      chip.appendChild(b); bar.appendChild(chip);
    });
    var th = THERMOS.map(function (c) { return quotes[c] && quotes[c].chg != null ? quotes[c].chg : null; })
                     .filter(function (v) { return v != null; });
    var avg = th.length ? th.reduce(function (a, b) { return a + b; }, 0) / th.length : 0;
    var lv = avg > 1.2 ? '🔥 热' : avg > 0.2 ? '☀️ 温' : avg > -0.8 ? '🌥 偏冷' : '❄️ 寒';
    var t = el('span', 'chip', '风向标均涨 ');
    t.appendChild(el('b', chgCls(avg), (avg > 0 ? '+' : '') + avg.toFixed(2) + '%'));
    t.appendChild(el('b', '', ' ' + lv));
    bar.appendChild(t);

    var box = $('#thermo'); box.innerHTML = '';
    THERMOS.forEach(function (c) {
      var q = quotes[c]; if (!q) return;
      var card = el('div', 'card');
      card.appendChild(el('div', 'nm', q.name || NAMES[c]));
      var px = el('div', 'px ' + chgCls(q.chg), fmt(q.price));
      var sub = el('div', 'sub', chgTxt(q.chg) + ' · 风向标');
      card.appendChild(px); card.appendChild(sub);
      box.appendChild(card);
    });
  }

  function renderHold() {
    var box = $('#hold'); box.innerHTML = '';
    var keys = Object.keys(HOLDS);
    if (!keys.length) { box.appendChild(el('div', 'chip', '暂无持仓')); return; }
    keys.forEach(function (c) {
      var q = quotes[c], sc = scoreMap[c];
      var card = el('div', 'card hold');
      var nm = el('div', 'nm');
      nm.appendChild(el('span', '', (q && q.name) || NAMES[c] || c));
      nm.appendChild(el('span', 'flag', '★持仓'));
      card.appendChild(nm);
      card.appendChild(el('div', 'px ' + chgCls(q && q.chg), fmt(q && q.price)));
      var sub = el('div', 'sub', '评分 ' + (sc && sc.score != null ? sc.score : '-') + ' · ' +
        ((sc && sc.trend) || '-'));
      card.appendChild(sub);
      if (sc && sc.sig.length) {
        var sigBox = el('div');
        sc.sig.forEach(function (t) {
          var cls = (t === '死叉' || t === '放量下跌' || t === '过热') ? 'tag warn'
                  : (t === '金叉' || t === '放量突破' || t === '超卖') ? 'tag good' : 'tag';
          sigBox.appendChild(el('span', cls, t));
        });
        card.appendChild(sigBox);
      }
      box.appendChild(card);
    });
  }

  function renderSectors() {
    var box = $('#sectors'); box.innerHTML = '';
    var keys = Object.keys(sectorStat).sort(function (a, b) {
      return sectorStat[b].avgChg - sectorStat[a].avgChg;
    });
    keys.forEach(function (k) {
      var st = sectorStat[k];
      var card = el('div', 'scard');
      var t = el('div', 't');
      t.appendChild(el('span', '', k));
      t.appendChild(el('span', chgCls(st.avgChg), (st.avgChg > 0 ? '+' : '') + st.avgChg.toFixed(2) + '%'));
      card.appendChild(t);
      card.appendChild(el('div', 'd', '上涨 ' + st.up + '/' + st.n +
        ' · 上涨占比 ' + Math.round(st.upRatio * 100) + '%'));
      box.appendChild(card);
    });
  }

  function rows() {
    return STOCK_LIST.map(function (x) {
      var c = x[0], q = quotes[c] || {}, sc = scoreMap[c] || {};
      return {
        code: c, name: q.name || NAMES[c] || c, hold: !!HOLDS[c],
        price: q.price, chg: q.chg, amt: q.amt, turn: q.turn,
        rsi: sc.rsi, vr: sc.vr, trend: sc.trend, score: sc.score,
        sig: sc.sig || [], sector: SECTORS[c] || ''
      };
    });
  }

  function renderTable() {
    var f = $('#selHold').value, sec = $('#selSector').value, kw = $('#kw').value.trim().toLowerCase();
    var data = rows().filter(function (r) {
      if (f === 'hold' && !r.hold) return false;
      if (f === 'strong' && !(r.score != null && r.score >= 75)) return false;
      if (f === 'watch' && !(r.score != null && r.score >= 60 && r.score < 75)) return false;
      if (f === 'avoid' && !(r.score != null && r.score < 40)) return false;
      if (sec && r.sector !== sec) return false;
      if (kw && r.name.toLowerCase().indexOf(kw) < 0 && r.code.toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
    data.sort(function (a, b) {
      var va = a[sortKey], vb = b[sortKey];
      if (va == null) return 1; if (vb == null) return -1;
      if (typeof va === 'string') return sortDir * va.localeCompare(vb, 'zh');
      return sortDir * (va - vb);
    });
    var tb = $('#tbody'); tb.innerHTML = '';
    data.forEach(function (r) {
      var tr = el('tr');
      if (r.hold) tr.style.background = 'rgba(232,177,63,.06)';
      var nm = el('td');
      nm.appendChild(el('span', '', (r.hold ? '★ ' : '') + r.name));
      var b = badge(r.score);
      tr.appendChild(nm);
      tr.appendChild(el('td', chgCls(r.chg), fmt(r.price)));
      tr.appendChild(el('td', chgCls(r.chg), chgTxt(r.chg)));
      tr.appendChild(el('td', 'dim', r.amt == null ? '-' : Math.round(r.amt).toLocaleString()));
      tr.appendChild(el('td', 'dim', fmt(r.turn)));
      tr.appendChild(el('td', r.rsi != null && r.rsi > 80 ? 'up' : (r.rsi != null && r.rsi < 30 ? 'down' : 'dim'), fmt(r.rsi, 1)));
      tr.appendChild(el('td', r.vr != null && r.vr > 1.8 ? 'up' : 'dim', fmt(r.vr, 2)));
      tr.appendChild(el('td', 'dim', r.trend || '-'));
      var scTd = el('td');
      var bEl = el('span', 'sc ' + b[1].replace('b-', ''), r.score == null ? '-' : r.score + ' ' + b[0]);
      scTd.appendChild(bEl);
      var bar = el('div', 'bar'); var iEl = el('i');
      iEl.style.width = (r.score || 0) + '%';
      iEl.style.background = r.score >= 75 ? 'var(--down)' : r.score >= 60 ? 'var(--blue)' : r.score >= 40 ? 'var(--dim)' : 'var(--up)';
      bar.appendChild(iEl); scTd.appendChild(bar);
      tr.appendChild(scTd);
      var sigTd = el('td'); sigTd.style.textAlign = 'left';
      r.sig.forEach(function (t) {
        var cls = (t === '死叉' || t === '放量下跌' || t === '过热') ? 'tag warn'
                : (t === '金叉' || t === '放量突破' || t === '超卖') ? 'tag good' : 'tag';
        sigTd.appendChild(el('span', cls, t));
      });
      if (r.sector) sigTd.appendChild(el('span', 'tag hot', r.sector));
      tr.appendChild(sigTd);
      tb.appendChild(tr);
    });
  }

  /* ---------- 主流程 ---------- */
  function evaluate() {
    calcSectors();
    STOCK_LIST.forEach(function (x) { scoreMap[x[0]] = scoreStock(x[0]); });
  }
  function renderAll() {
    renderThermo(); renderHold(); renderSectors(); renderTable();
  }
  function tick() {
    var btn = $('#btnRef'); btn.disabled = true;
    loadQuotes().then(function () { return loadKlines(false); })
      .then(function () { evaluate(); renderAll(); $('#err').textContent = ''; })
      .catch(function (e) { $('#err').textContent = '数据加载失败（接口可能被限流，稍后自动重试）：' + e.message; })
      .then(function () {
        btn.disabled = false;
        var t = REFRESH_SEC;
        clearInterval(timer);
        timer = setInterval(function () {
          $('#clock').textContent = t + 's 后自动刷新 · 行情时间 ' + new Date().toLocaleTimeString('zh-CN');
          if (--t < 0) { clearInterval(timer); tick(); }
        }, 1000);
        $('#clock').textContent = '行情时间 ' + new Date().toLocaleTimeString('zh-CN');
      });
  }

  /* ---------- 事件绑定 ---------- */
  document.querySelectorAll('#tbl th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
      renderTable();
    });
  });
  ['selHold', 'selSector'].forEach(function (id) {
    $('#' + id).addEventListener('change', renderTable);
  });
  $('#kw').addEventListener('input', renderTable);
  $('#btnRef').addEventListener('click', function () { clearInterval(timer); tick(); });

  /* 板块下拉选项 */
  (function () {
    var sel = $('#selSector'), seen = {};
    STOCK_LIST.forEach(function (x) {
      var s = SECTORS[x[0]];
      if (s && !seen[s]) { seen[s] = 1; sel.appendChild(el('option', '', s)); sel.lastChild.value = s; }
    });
  })();

  /* 启动 */
  $('#clock').textContent = '首次加载中（约 5-15 秒，请稍候）…';
  tick();
})();
