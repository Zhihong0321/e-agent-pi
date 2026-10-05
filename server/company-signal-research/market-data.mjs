/**
 * Real-time 7-day stock price and market data provider for Company Signal Research.
 * Supports all global stock exchanges (Bursa Malaysia, US NASDAQ/NYSE, HKEX, SGX, LSE, etc.)
 */

export function resolveStockSymbol(seed) {
  let ticker = String(seed?.ticker || '').trim().toUpperCase();
  const exchange = String(seed?.exchange || '').trim().toUpperCase();
  const name = String(seed?.name || '').trim();

  // If already formatted with Yahoo suffix (.KL, .HK, .SI, .L, etc.)
  if (/\.[A-Z]{2,4}$/.test(ticker)) {
    return ticker;
  }

  // 1. Bursa Malaysia (KLSE / MYX)
  if (['BURSA', 'KLSE', 'MALAYSIA', 'MYX', 'KL'].includes(exchange)) {
    if (/^\d+$/.test(ticker)) return `${ticker}.KL`;
    if (ticker === 'TNB' || ticker === 'TENAGA') return '5347.KL';
    if (ticker === 'MAYBANK') return '1155.KL';
    if (ticker === 'PCHEM') return '5183.KL';
    if (ticker === 'CIMB') return '1023.KL';
    if (ticker === 'IHH') return '5225.KL';
    if (ticker === 'MAXIS') return '6012.KL';
    if (ticker === 'AXIATA') return '6888.KL';
    if (ticker === 'MISC') return '3816.KL';
    if (ticker === 'SIME') return '4197.KL';
    if (ticker === 'GENTING') return '3182.KL';
    if (ticker === 'YTL') return '4677.KL';
    if (ticker === 'YTLPOWR') return '6742.KL';
    if (ticker === 'CELCOMDIGI' || ticker === 'CDB') return '6947.KL';
    return `${ticker}.KL`;
  }

  // 2. Hong Kong (HKEX)
  if (['HKEX', 'HK', 'HONGKONG'].includes(exchange)) {
    if (/^\d+$/.test(ticker)) return `${ticker.padStart(4, '0')}.HK`;
  }

  // 3. Singapore (SGX)
  if (['SGX', 'SINGAPORE'].includes(exchange)) {
    return `${ticker}.SI`;
  }

  // 4. United States (NASDAQ, NYSE, AMEX)
  if (['NASDAQ', 'NYSE', 'AMEX', 'US'].includes(exchange)) {
    return ticker;
  }

  // 5. United Kingdom (LSE)
  if (['LSE', 'LONDON', 'UK'].includes(exchange)) {
    return `${ticker}.L`;
  }

  // 6. Japan (TSE)
  if (['TSE', 'TOKYO', 'JAPAN'].includes(exchange)) {
    return `${ticker}.T`;
  }

  // 7. China (SSE / SZSE)
  if (['SSE', 'SHANGHAI'].includes(exchange)) {
    return `${ticker}.SS`;
  }
  if (['SZSE', 'SHENZHEN'].includes(exchange)) {
    return `${ticker}.SZ`;
  }

  // 8. Australia (ASX)
  if (['ASX', 'AUSTRALIA'].includes(exchange)) {
    return `${ticker}.AX`;
  }

  // 9. Canada (TSX)
  if (['TSX', 'CANADA'].includes(exchange)) {
    return `${ticker}.TO`;
  }

  return ticker;
}

export function resolveTradingViewSymbol(seed, marketData) {
  const exchange = String(seed?.exchange || '').trim().toUpperCase();
  const ticker = String(seed?.ticker || '').trim().toUpperCase();

  if (['BURSA', 'KLSE', 'MALAYSIA', 'MYX', 'KL'].includes(exchange)) {
    if (ticker === 'TNB' || ticker === '5347') return 'MYX:TENAGA';
    if (ticker === '1155' || ticker === 'MAYBANK') return 'MYX:MAYBANK';
    return `MYX:${ticker}`;
  }
  if (['HKEX', 'HK'].includes(exchange)) {
    const num = parseInt(ticker, 10);
    return isNaN(num) ? `HKEX:${ticker}` : `HKEX:${num}`;
  }
  if (['SGX'].includes(exchange)) {
    return `SGX:${ticker}`;
  }
  if (['NASDAQ', 'NYSE', 'AMEX'].includes(exchange)) {
    return `${exchange}:${ticker}`;
  }
  if (marketData?.symbol) {
    return marketData.symbol.replace('.', ':');
  }
  return ticker;
}

export async function fetchStockPriceData(seed, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let resolvedSymbol = resolveStockSymbol(seed);

  // Try direct chart query first
  const tryFetchChart = async (sym, range = '7d') => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  let chartJson = null;
  try {
    chartJson = await tryFetchChart(resolvedSymbol, '7d');
  } catch (err) {
    // If not found and we haven't searched, try searching Yahoo finance
    try {
      const q = seed?.name || `${seed?.ticker} ${seed?.exchange}`;
      const searchRes = await fetchImpl(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const hit = searchData.quotes?.find(x => x.quoteType === 'EQUITY') || searchData.quotes?.[0];
        if (hit?.symbol) {
          resolvedSymbol = hit.symbol;
          chartJson = await tryFetchChart(resolvedSymbol, '7d');
        }
      }
    } catch {
      // Ignore fallback error
    }
  }

  const result = chartJson?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta || {};
  let timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  // If fewer than 4 points (due to weekend / holiday), fetch 14d and take the last 7
  if (timestamps.length < 4) {
    try {
      const expandedJson = await tryFetchChart(resolvedSymbol, '14d');
      const expandedResult = expandedJson?.chart?.result?.[0];
      if (expandedResult && expandedResult.timestamp?.length > timestamps.length) {
        timestamps = expandedResult.timestamp;
        const eq = expandedResult.indicators?.quote?.[0] || {};
        opens.length = 0; opens.push(...(eq.open || []));
        highs.length = 0; highs.push(...(eq.high || []));
        lows.length = 0; lows.push(...(eq.low || []));
        closes.length = 0; closes.push(...(eq.close || []));
        volumes.length = 0; volumes.push(...(eq.volume || []));
      }
    } catch {}
  }

  const allPoints = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c === null || c === undefined) continue;
    const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    const o = opens[i] ?? c;
    const h = highs[i] ?? Math.max(o, c);
    const l = lows[i] ?? Math.min(o, c);
    const v = volumes[i] ?? 0;
    const prevClose = i > 0 ? (closes[i - 1] ?? o) : (meta.chartPreviousClose || o);
    const chgPct = prevClose ? ((c - prevClose) / prevClose) * 100 : 0;
    allPoints.push({
      date: d,
      timestamp: timestamps[i],
      open: Number(o.toFixed(2)),
      high: Number(h.toFixed(2)),
      low: Number(l.toFixed(2)),
      close: Number(c.toFixed(2)),
      volume: v,
      changePercent: Number(chgPct.toFixed(2)),
    });
  }

  // Keep the most recent 7 trading days
  const points = allPoints.slice(-7);
  if (!points.length) return null;

  const currentPrice = meta.regularMarketPrice ?? points[points.length - 1].close;
  const firstClose = points[0].open || points[0].close;
  const sevenDayChange = currentPrice - firstClose;
  const sevenDayChangePercent = firstClose ? (sevenDayChange / firstClose) * 100 : 0;
  const sevenDayHigh = Math.max(...points.map(p => p.high));
  const sevenDayLow = Math.min(...points.map(p => p.low));
  const totalVolume = points.reduce((acc, p) => acc + (p.volume || 0), 0);
  const tradingViewSymbol = resolveTradingViewSymbol(seed, { symbol: meta.symbol || resolvedSymbol });

  return {
    symbol: meta.symbol || resolvedSymbol,
    currency: meta.currency || 'USD',
    exchangeName: meta.exchangeName || seed.exchange,
    currentPrice: Number(currentPrice.toFixed(2)),
    chartPreviousClose: meta.chartPreviousClose ? Number(meta.chartPreviousClose.toFixed(2)) : null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ? Number(meta.fiftyTwoWeekLow.toFixed(2)) : null,
    regularMarketDayHigh: meta.regularMarketDayHigh ? Number(meta.regularMarketDayHigh.toFixed(2)) : null,
    regularMarketDayLow: meta.regularMarketDayLow ? Number(meta.regularMarketDayLow.toFixed(2)) : null,
    regularMarketVolume: meta.regularMarketVolume || points[points.length - 1].volume,
    sevenDayChange: Number(sevenDayChange.toFixed(2)),
    sevenDayChangePercent: Number(sevenDayChangePercent.toFixed(2)),
    sevenDayHigh: Number(sevenDayHigh.toFixed(2)),
    sevenDayLow: Number(sevenDayLow.toFixed(2)),
    totalVolume,
    tradingViewSymbol,
    points,
  };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Renders the full Bloomberg Terminal-grade 7-day price chart HTML component.
 */
export function renderPriceChartHtml(marketData, seed) {
  if (!marketData || !marketData.points || !marketData.points.length) {
    return `
      <div class="market-chart-card empty-chart">
        <div class="chart-header">
          <div class="chart-title">
            <span class="chart-icon">📈</span>
            <span class="chart-heading">标的二级市场价格走势 (7-Day Price Action)</span>
          </div>
          <span class="chart-badge-offline">市场数据暂未连通或离线</span>
        </div>
        <p class="chart-empty-text">未能获取到 ${escape(seed?.ticker || '该标的')} 在 ${escape(seed?.exchange || '公开交易所')} 的最近 7 个交易日 K 线数据。研报将继续基于公开披露与核验资讯进行定调分析。</p>
      </div>
    `;
  }

  const isUp = marketData.sevenDayChange >= 0;
  const strokeColor = isUp ? '#10b981' : '#f43f5e';
  const fillColorStart = isUp ? 'rgba(16, 185, 129, 0.32)' : 'rgba(244, 63, 94, 0.32)';
  const fillColorEnd = isUp ? 'rgba(16, 185, 129, 0.0)' : 'rgba(244, 63, 94, 0.0)';
  const changeSign = isUp ? '+' : '';
  const changeArrow = isUp ? '▲' : '▼';

  // SVG Chart Geometry
  const width = 860;
  const height = 240;
  const pad = { top: 30, bottom: 50, left: 35, right: 85 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const points = marketData.points;
  const prices = points.map(p => p.close);
  const minP = Math.min(...prices) * 0.992;
  const maxP = Math.max(...prices) * 1.008;
  const rangeP = (maxP - minP) || 1;

  // Volume scale
  const maxVol = Math.max(...points.map(p => p.volume || 1));

  const coords = points.map((p, i) => {
    const x = pad.left + (points.length === 1 ? chartW / 2 : (i / (points.length - 1)) * chartW);
    const y = pad.top + chartH - ((p.close - minP) / rangeP) * chartH;
    const volHeight = Math.max(4, Math.round(((p.volume || 0) / maxVol) * 36));
    const volY = pad.top + chartH - volHeight;
    return {
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      volY,
      volHeight,
      p,
    };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${pad.top + chartH} L ${coords[0].x} ${pad.top + chartH} Z`;

  // Horizontal Grid Lines (Max, Mid, Min)
  const midP = (minP + maxP) / 2;
  const gridLevels = [
    { p: maxP, y: pad.top },
    { p: midP, y: pad.top + chartH / 2 },
    { p: minP, y: pad.top + chartH },
  ];

  const gridHtml = gridLevels.map(lvl => `
    <line x1="${pad.left}" y1="${lvl.y.toFixed(1)}" x2="${width - pad.right}" y2="${lvl.y.toFixed(1)}" stroke="rgba(255, 255, 255, 0.08)" stroke-dasharray="4,4" />
    <text x="${width - pad.right + 10}" y="${(lvl.y + 4).toFixed(1)}" fill="#64748b" font-size="11" font-family="monospace">${lvl.p.toFixed(2)}</text>
  `).join('');

  // Daily dots and volume bars
  const dotsAndBarsHtml = coords.map((c, idx) => {
    const isDailyUp = c.p.changePercent >= 0;
    const barColor = isDailyUp ? 'rgba(16, 185, 129, 0.4)' : 'rgba(244, 63, 94, 0.4)';
    const dotBorder = isDailyUp ? '#10b981' : '#f43f5e';
    const dayLabel = c.p.date.slice(5); // MM-DD
    const barW = Math.max(12, Math.round(chartW / points.length) - 16);

    return `
      <!-- Volume bar -->
      <rect x="${(c.x - barW / 2).toFixed(1)}" y="${c.volY}" width="${barW}" height="${c.volHeight}" rx="2" fill="${barColor}" />
      <!-- Data checkpoint circle -->
      <circle cx="${c.x}" cy="${c.y}" r="4.5" fill="#0f172a" stroke="${dotBorder}" stroke-width="2.5" class="chart-point" data-date="${c.p.date}" data-open="${c.p.open}" data-high="${c.p.high}" data-low="${c.p.low}" data-close="${c.p.close}" data-vol="${c.p.volume}" data-chg="${c.p.changePercent}">
        <title>${c.p.date} | 收盘: ${c.p.close} (${c.p.changePercent >= 0 ? '+' : ''}${c.p.changePercent}%) | 成交量: ${(c.p.volume / 1000000).toFixed(2)}M</title>
      </circle>
      <!-- Date label -->
      <text x="${c.x}" y="${pad.top + chartH + 20}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="monospace">${dayLabel}</text>
      <!-- Daily Close Label -->
      <text x="${c.x}" y="${(c.y - 10).toFixed(1)}" fill="#cbd5e1" font-size="11" font-weight="600" text-anchor="middle" font-family="monospace">${c.p.close}</text>
    `;
  }).join('');

  const tvSymbol = escape(marketData.tradingViewSymbol || seed.ticker);

  return `
    <div class="market-chart-card" id="market-price-chart">
      <!-- 顶部价格横幅与核心指标 -->
      <div class="chart-card-top">
        <div class="chart-primary-info">
          <div class="chart-title-row">
            <span class="chart-live-dot"></span>
            <span class="chart-symbol-badge">${escape(marketData.symbol)}</span>
            <span class="chart-exchange-tag">${escape(marketData.exchangeName)}</span>
            <span class="chart-heading">最近 7 个交易日价格走势 & 波动全景</span>
          </div>
          <div class="chart-price-display">
            <div class="price-big-wrap">
              <span class="price-value">${marketData.currentPrice.toFixed(2)}</span>
              <span class="price-currency">${escape(marketData.currency)}</span>
            </div>
            <div class="change-pill ${isUp ? 'pill-up' : 'pill-down'}">
              <span class="change-arrow">${changeArrow}</span>
              <span class="change-abs">${changeSign}${marketData.sevenDayChange.toFixed(2)}</span>
              <span class="change-pct">(${changeSign}${marketData.sevenDayChangePercent.toFixed(2)}%)</span>
              <span class="change-period">7日区间变动</span>
            </div>
          </div>
        </div>

        <div class="chart-view-tabs">
          <button type="button" class="chart-tab-btn active" id="tab-btn-svg" onclick="switchChartMode('svg')">
            ⚡ 原生高帧走势 (Native SVG)
          </button>
          <button type="button" class="chart-tab-btn" id="tab-btn-tv" onclick="switchChartMode('tv')">
            📊 TradingView 交互式 K线
          </button>
        </div>
      </div>

      <!-- 核心辅助微型指标卡排 -->
      <div class="chart-quick-metrics">
        <div class="q-metric-pill">
          <span class="q-label">7日最高</span>
          <span class="q-val">${marketData.sevenDayHigh.toFixed(2)}</span>
        </div>
        <div class="q-metric-pill">
          <span class="q-label">7日最低</span>
          <span class="q-val">${marketData.sevenDayLow.toFixed(2)}</span>
        </div>
        ${marketData.fiftyTwoWeekHigh ? `
        <div class="q-metric-pill">
          <span class="q-label">52周最高</span>
          <span class="q-val">${marketData.fiftyTwoWeekHigh.toFixed(2)}</span>
        </div>
        <div class="q-metric-pill">
          <span class="q-label">52周最低</span>
          <span class="q-val">${marketData.fiftyTwoWeekLow.toFixed(2)}</span>
        </div>
        ` : ''}
        <div class="q-metric-pill">
          <span class="q-label">最新成交量</span>
          <span class="q-val">${(marketData.regularMarketVolume / 1000000).toFixed(2)}M 股</span>
        </div>
        <div class="q-metric-pill">
          <span class="q-label">7日累计成交量</span>
          <span class="q-val">${(marketData.totalVolume / 1000000).toFixed(2)}M 股</span>
        </div>
      </div>

      <!-- 模式 1: 原生高精度 SVG 走势图 -->
      <div class="chart-view-container" id="chart-view-svg">
        <div class="svg-chart-wrapper">
          <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" class="price-svg-chart">
            <defs>
              <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${fillColorStart}" />
                <stop offset="100%" stop-color="${fillColorEnd}" />
              </linearGradient>
            </defs>
            <!-- 背景网格与价格刻度 -->
            ${gridHtml}
            <!-- 面积填充 -->
            <path d="${areaPath}" fill="url(#chartGradient)" />
            <!-- 主趋势曲线 -->
            <path d="${linePath}" fill="none" stroke="${strokeColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            <!-- 检查点点位与柱状量能 -->
            ${dotsAndBarsHtml}
          </svg>
        </div>
        <div class="chart-legend-row">
          <span class="legend-item"><span class="legend-color-line" style="background:${strokeColor};"></span> 7日收盘走势曲线 (7-Day Trendline)</span>
          <span class="legend-item"><span class="legend-color-bar"></span> 每日成交量柱 (Volume Histogram)</span>
          <span class="legend-item note">💡 悬浮小圆点即可查看对应交易日的详细 OHLCV 报价</span>
        </div>
      </div>

      <!-- 模式 2: TradingView 实时交互 Widget -->
      <div class="chart-view-container" id="chart-view-tv" style="display: none;">
        <div class="tv-widget-embed-frame">
          <iframe
            src="https://s.tradingview.com/widgetembed/?symbol=${tvSymbol}&amp;interval=D&amp;hidesidetoolbar=1&amp;symboledit=1&amp;saveimage=0&amp;toolbarbg=0f172a&amp;studies=%5B%5D&amp;theme=dark&amp;style=1&amp;timezone=Asia%2FKuala_Lumpur&amp;locale=zh_CN"
            width="100%"
            height="390"
            frameborder="0"
            allowtransparency="true"
            scrolling="no"
            style="display: block; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);"
          ></iframe>
        </div>
        <div class="chart-legend-row">
          <span class="legend-item">📊 TradingView 实时多周期行情</span>
          <span class="legend-item">当前图表标的: <strong>${tvSymbol}</strong></span>
        </div>
      </div>
    </div>

    <script>
      function switchChartMode(mode) {
        var svgView = document.getElementById('chart-view-svg');
        var tvView = document.getElementById('chart-view-tv');
        var btnSvg = document.getElementById('tab-btn-svg');
        var btnTv = document.getElementById('tab-btn-tv');
        if (!svgView || !tvView) return;

        if (mode === 'tv') {
          svgView.style.display = 'none';
          tvView.style.display = 'block';
          btnSvg.classList.remove('active');
          btnTv.classList.add('active');
        } else {
          tvView.style.display = 'none';
          svgView.style.display = 'block';
          btnTv.classList.remove('active');
          btnSvg.classList.add('active');
        }
      }
    </script>
  `;
}
