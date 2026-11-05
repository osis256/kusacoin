'use strict';

(() => {
  const number = value => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 }).format(value);
  const money = value => number(value * 100);
  let coins = [];
  let coinById = {};
  let state = null;
  let market = null;
  let tradeFeeRate = 0.01;
  let leaderboard = [];
  let recovery = null;
  let lastRecoveryNoticeId = null;
  let selectedCoin = 'KUSA';
  let tradeMode = 'buy';
  let limitMode = 'buy';
  let advancedCoin = null;
  let chartMinutes = 10;
  let toastTimer;
  let syncSequence = 0;
  let tradePending = false;
  let limitPending = false;
  let soundContext;
  const jstDateTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const jstTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const apiBaseUrl = (window.KUSACOIN_API_BASE_URL || window.location.origin).replace(/\/+$/, '');

  function apiUrl(path) {
    return `${apiBaseUrl}${path}`;
  }

  function estimatedTradeFee(amount) {
    return amount > 0 ? Math.max(0.01, Math.ceil(amount * tradeFeeRate * 100 - 1e-9) / 100) : 0;
  }

  function availableCash() {
    const reserved = (state.orders || []).reduce((sum, order) => {
      if (order.side !== 'buy') return sum;
      const amount = Math.round(order.limitPrice * order.quantity * 100) / 100;
      return sum + amount + estimatedTradeFee(amount);
    }, 0);
    return Math.max(0, state.cash - reserved);
  }

  function availableCoins(coinId) {
    const reserved = (state.orders || []).reduce((sum, order) => sum + (order.side === 'sell' && order.coin === coinId ? order.quantity : 0), 0);
    return Math.max(0, (Number(state.holdings[coinId]) || 0) - reserved);
  }

  function renderCoinOptions() {
    const select = document.getElementById('chart-coin');
    select.innerHTML = coins.map(coin => `<option value="${coin.id}">${coin.id} / ${coin.name}・${coin.characteristic}</option>`).join('');
    select.value = selectedCoin;
  }

  function renderCoinList() {
    const host = document.getElementById('coin-list');
    host.innerHTML = coins.map(coin => {
      const price = market.prices[coin.id];
      const change = market.changes10m[coin.id] || 0;
      const color = change >= 0 ? '#69a64d' : '#dc7561';
      const points = market.sparks[coin.id] || [price, price];
      const min = Math.min(...points);
      const max = Math.max(...points);
      const coords = points.map((value, index) => `${(index / Math.max(1, points.length - 1)) * 58},${20 - ((value - min) / (max - min || 1)) * 17}`).join(' ');
      return `<button type="button" class="coin-row${coin.id === selectedCoin ? ' selected' : ''}" data-coin="${coin.id}" aria-pressed="${coin.id === selectedCoin}">
        <span class="coin-name"><i class="coin-icon" style="background:${coin.color}">${coin.id.slice(0, 2)}</i><span class="coin-label"><strong>${coin.name}</strong><small>${coin.id}</small><small class="coin-feature">${coin.characteristic}</small></span></span>
        <span class="mono">${money(price)}</span><span class="mono ${change >= 0 ? 'positive' : 'negative'}">${change >= 0 ? '+' : ''}${Math.round(change)}%</span>
        <svg class="mini-spark" viewBox="0 0 58 23" aria-hidden="true"><polyline points="${coords}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
    }).join('');
    host.querySelectorAll('[data-coin]').forEach(button => button.addEventListener('click', () => select(button.dataset.coin)));
  }

  function renderPortfolio() {
    const holdingsValue = coins.reduce((sum, coin) => sum + (Number(state.holdings[coin.id]) || 0) * market.prices[coin.id], 0);
    const total = state.cash + holdingsValue;
    const pnl = total - state.startingCash;
    document.getElementById('cash-value').textContent = money(availableCash());
    document.getElementById('total-value').textContent = money(total);
    const pnlElement = document.getElementById('pnl-value');
    pnlElement.textContent = `${pnl >= 0 ? '+' : ''}${money(pnl)}`;
    pnlElement.className = pnl >= 0 ? 'positive' : 'negative';
    renderRecovery();

    const holdings = coins.filter(coin => (Number(state.holdings[coin.id]) || 0) >= 0.01);
    const host = document.getElementById('holdings-list');
    host.innerHTML = holdings.length ? holdings.map(coin => {
      const quantity = Number(state.holdings[coin.id]);
      return `<div class="holding-item"><span>${coin.name} <span class="mono">${quantity.toFixed(2)} ${coin.id}</span></span><strong>${money(quantity * market.prices[coin.id])} 葉</strong></div>`;
    }).join('') : '<p class="empty-holdings">まだコインを持っていません。</p>';
  }

  function renderRecovery() {
    const status = document.getElementById('recovery-status');
    if (!recovery) return;
    if (recovery.receivedToday) {
      status.textContent = `本日の救済を受取済み（${money(recovery.grant)} 葉）`;
      return;
    }
    if (recovery.readyAt === null) {
      status.textContent = `総資産 ${money(recovery.threshold)} 葉未満で60秒タイマー開始・1日1回`;
      return;
    }
    const seconds = Math.max(0, Math.ceil((recovery.readyAt - Date.now()) / 1000));
    status.textContent = seconds > 0
      ? `葉っぱが飛んでくるまで ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : '葉っぱが飛んでくるのを確認中...';
  }

  function animateLeaves() {
    const host = document.getElementById('leaf-burst');
    host.replaceChildren();
    for (let index = 0; index < 11; index++) {
      const leaf = document.createElement('span');
      leaf.className = 'flying-leaf';
      leaf.textContent = '🍃';
      leaf.style.setProperty('--leaf-x', `${Math.round((Math.random() - 0.5) * 280)}px`);
      leaf.style.setProperty('--leaf-y', `${Math.round(-80 - Math.random() * 180)}px`);
      leaf.style.setProperty('--leaf-rotate', `${Math.round((Math.random() - 0.5) * 200)}deg`);
      leaf.style.animationDelay = `${Math.random() * 0.22}s`;
      host.append(leaf);
    }
    setTimeout(() => host.replaceChildren(), 1800);
  }

  function renderProfile() {
    const username = state.username || 'ゲスト';
    document.getElementById('profile-name').textContent = username;
    const input = document.getElementById('username-input');
    if (document.activeElement !== input) input.value = username;
  }

  function renderLeaderboard() {
    const list = document.getElementById('leaderboard-list');
    list.replaceChildren();
    if (!leaderboard.length) {
      const empty = document.createElement('li');
      empty.className = 'leaderboard-empty';
      empty.textContent = 'まだプレイヤーがいません。';
      list.append(empty);
      return;
    }
    for (const player of leaderboard) {
      const row = document.createElement('li');
      row.className = 'leaderboard-row';
      const rank = document.createElement('span');
      rank.className = 'leaderboard-rank';
      rank.textContent = String(player.rank).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'leaderboard-name';
      name.textContent = player.username;
      const total = document.createElement('span');
      total.className = 'leaderboard-value';
      total.textContent = `${money(player.totalAssets)} 葉っぱ`;
      row.append(rank, name, total);
      list.append(row);
    }
  }

  function renderAdvanced() {
    const coin = coinById[selectedCoin];
    const limitPrice = document.getElementById('limit-price');
    if (advancedCoin !== selectedCoin) {
      limitPrice.value = String(Math.round(market.prices[selectedCoin] * 100));
      advancedCoin = selectedCoin;
    }
    document.getElementById('limit-quantity-unit').textContent = coin.id;
    document.getElementById('limit-available').textContent = limitMode === 'buy'
      ? `利用可能 ${money(availableCash())} 葉`
      : `売却可能 ${number(availableCoins(coin.id))} 枚`;
    document.getElementById('limit-total-label').textContent = limitMode === 'buy' ? '必要な葉っぱ（手数料込）' : '売却数量';
    const quantity = Math.max(0, Number(document.getElementById('limit-quantity').value) || 0);
    const amount = quantity * ((Number(limitPrice.value) || 0) / 100);
    const total = amount + estimatedTradeFee(amount);
    document.getElementById('limit-total').textContent = limitMode === 'buy'
      ? `${money(total)} 葉`
      : `${number(quantity)} ${coin.id}`;
    document.getElementById('place-limit-order').disabled = limitPending;

    const host = document.getElementById('open-orders-list');
    host.replaceChildren();
    const orders = state.orders || [];
    if (!orders.length) {
      const empty = document.createElement('p');
      empty.className = 'no-orders';
      empty.textContent = '注文はありません。';
      host.append(empty);
      return;
    }
    for (const order of orders) {
      const row = document.createElement('div');
      row.className = 'open-order';
      const info = document.createElement('div');
      info.className = 'open-order-info';
      const coinInfo = coinById[order.coin];
      const side = order.side === 'buy' ? '買い' : '売り';
      const title = document.createElement('strong');
      title.textContent = `${side} ${coinInfo ? coinInfo.name : order.coin}`;
      const detail = document.createElement('span');
      detail.textContent = `${number(order.quantity)} 枚 @ ${money(order.limitPrice)} 葉`;
      info.append(title, document.createElement('br'), detail);
      const cancel = document.createElement('button');
      cancel.className = 'cancel-order';
      cancel.type = 'button';
      cancel.dataset.orderId = order.id;
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => cancelLimitOrder(order.id));
      row.append(info, cancel);
      host.append(row);
    }
  }

  function drawChart() {
    const canvas = document.getElementById('price-chart');
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    const width = rect.width;
    const height = rect.height;
    const values = market.chart.map(point => point.price);
    const points = values.length ? values : [market.prices[selectedCoin]];
    const min = Math.min(...points);
    const max = Math.max(...points);
    const spread = max - min || max * 0.01 || 1;
    const left = 5, right = width - 8, top = 12, bottom = height - 23;
    const yFor = value => bottom - ((value - min) / spread) * (bottom - top);
    context.font = '10px "DM Mono", monospace';
    context.textBaseline = 'middle';
    for (let index = 0; index < 4; index++) {
      const y = top + (bottom - top) * index / 3;
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y);
      context.strokeStyle = '#edf0ea'; context.lineWidth = 1; context.stroke();
      context.fillStyle = '#9aa097';
      context.fillText(money(max - spread * index / 3), left + 2, Math.max(7, y - 7));
    }
    const xFor = index => left + (right - left) * index / Math.max(1, points.length - 1);
    context.beginPath();
    points.forEach((value, index) => index ? context.lineTo(xFor(index), yFor(value)) : context.moveTo(xFor(index), yFor(value)));
    if (points.length > 1) {
      context.lineTo(right, bottom); context.lineTo(left, bottom); context.closePath();
      const fill = context.createLinearGradient(0, top, 0, bottom);
      fill.addColorStop(0, '#aee96a48'); fill.addColorStop(1, '#aee96a00');
      context.fillStyle = fill; context.fill();
    }
    context.beginPath();
    points.forEach((value, index) => index ? context.lineTo(xFor(index), yFor(value)) : context.moveTo(xFor(index), yFor(value)));
    context.strokeStyle = '#6b9f45'; context.lineWidth = 2; context.lineJoin = 'round'; context.lineCap = 'round'; context.stroke();
    const lastX = xFor(points.length - 1), lastY = yFor(points[points.length - 1]);
    context.beginPath(); context.arc(lastX, lastY, 3.5, 0, Math.PI * 2); context.fillStyle = '#6b9f45'; context.fill();
    const elapsedLabel = chartMinutes < 60 ? `${chartMinutes}M AGO` : `${chartMinutes / 60}H AGO`;
    context.fillStyle = '#9aa097'; context.textAlign = 'left'; context.fillText(elapsedLabel, left, height - 7);
    context.textAlign = 'right'; context.fillText('NOW', right, height - 7); context.textAlign = 'left';
  }

  function renderOrder() {
    const coin = coinById[selectedCoin];
    const price = market.prices[coin.id];
    const quantity = Math.max(0, Number(document.getElementById('quantity').value) || 0);
    document.getElementById('quantity-unit').textContent = coin.id;
    document.getElementById('available-label').textContent = tradeMode === 'buy'
      ? `残高 ${money(availableCash())} 葉っぱ`
      : `保有 ${number(availableCoins(coin.id))} ${coin.id}`;
    document.getElementById('order-price').textContent = `${money(price)} 葉っぱ`;
    const gross = quantity * price;
    const fee = estimatedTradeFee(gross);
    const total = tradeMode === 'buy' ? gross + fee : Math.max(0, gross - fee);
    document.getElementById('order-total').textContent = `${money(total)} 葉っぱ`;
    document.getElementById('total-label').textContent = tradeMode === 'buy' ? 'お支払い（手数料込）' : '受け取り（手数料差引）';
    const button = document.getElementById('execute-trade');
    button.classList.toggle('sell', tradeMode === 'sell');
    button.disabled = tradePending;
    button.querySelector('span').textContent = tradePending ? '取引中...' : tradeMode === 'buy' ? 'この内容で買う' : 'この内容で売る';
    button.querySelector('svg').innerHTML = tradeMode === 'buy'
      ? '<path d="M12 5v14m-6-6 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M12 19V5m6 6-6-6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function refresh() {
    const coin = coinById[selectedCoin];
    const price = market.prices[selectedCoin];
    const change = market.changes10m[selectedCoin] || 0;
    const timestamp = new Date(market.updatedAt);
    const shortClock = window.matchMedia('(max-width: 380px)').matches;
    document.getElementById('clock').textContent = `${(shortClock ? jstTime : jstDateTime).format(timestamp)} JST`;
    document.getElementById('chart-price').textContent = `${money(price)} 葉っぱ`;
    const changeElement = document.getElementById('chart-change');
    changeElement.textContent = `${change >= 0 ? '+' : ''}${Math.round(change)}% / 10分`;
    changeElement.className = `chart-change ${change >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('chart-heading').textContent = `${coin.name} の値動き`;
    document.getElementById('chart-characteristic').textContent = coin.characteristic;
    renderPortfolio();
    renderProfile();
    renderLeaderboard();
    renderOrder();
    renderAdvanced();
    renderCoinList();
    drawChart();
  }

  async function syncState() {
    const sequence = ++syncSequence;
    try {
      const query = new URLSearchParams({ coin: selectedCoin, minutes: String(chartMinutes) });
      const response = await fetch(apiUrl(`/api/state?${query}`), { cache: 'no-store', credentials: 'include' });
      if (!response.ok) throw new Error('サーバーに接続できません。');
      const snapshot = await response.json();
      if (sequence !== syncSequence) return;
      const previousTradeIds = state ? new Set(state.trades.map(trade => trade.id)) : null;
      coins = snapshot.coins;
      tradeFeeRate = snapshot.tradeFeeRate;
      coinById = Object.fromEntries(coins.map(coin => [coin.id, coin]));
      if (!coinById[selectedCoin]) selectedCoin = coins[0].id;
      state = { ...snapshot.player, startingCash: snapshot.startingCash };
      market = snapshot.market;
      leaderboard = snapshot.leaderboard;
      recovery = snapshot.recovery;
      renderCoinOptions();
      refresh();
      const recoveryNotice = recovery.notice;
      if (recoveryNotice && recoveryNotice.id !== lastRecoveryNoticeId) {
        lastRecoveryNoticeId = recoveryNotice.id;
        showToast(`${money(recoveryNotice.amount)} 葉っぱが飛んできました。`);
        animateLeaves();
      }
      if (previousTradeIds) {
        const fills = state.trades.filter(trade => trade.orderType === 'limit' && !previousTradeIds.has(trade.id));
        if (fills.length === 1) {
          const fill = fills[0];
          const side = fill.side === 'buy' ? '買い' : '売り';
          showToast(`${fill.coin} を ${number(fill.quantity)} 枚、指値${side}注文で売買しました。`);
          playTradeSound(fill.side);
        } else if (fills.length > 1) {
          showToast(`${fills.length} 件の指値注文が約定しました。`);
          playTradeSound(fills[fills.length - 1].side);
        }
      }
      document.getElementById('trade-notice').textContent = '';
    } catch (error) {
      document.getElementById('trade-notice').textContent = '相場サーバーに接続中です。';
    }
  }

  async function select(id) {
    if (!coinById[id]) return;
    selectedCoin = id;
    document.getElementById('chart-coin').value = id;
    await syncState();
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2300);
  }

  function playTradeSound(side) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      soundContext ||= new AudioContext();
      if (soundContext.state === 'suspended') soundContext.resume();
      const oscillator = soundContext.createOscillator();
      const volume = soundContext.createGain();
      const start = soundContext.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(side === 'buy' ? 740 : 520, start);
      oscillator.frequency.exponentialRampToValueAtTime(side === 'buy' ? 560 : 390, start + 0.12);
      volume.gain.setValueAtTime(0.0001, start);
      volume.gain.exponentialRampToValueAtTime(0.11, start + 0.015);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      oscillator.connect(volume);
      volume.connect(soundContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.17);
    } catch (_) {}
  }

  async function executeTrade() {
    const quantity = Number(document.getElementById('quantity').value);
    const notice = document.getElementById('trade-notice');
    if (!Number.isFinite(quantity) || quantity <= 0) {
      notice.textContent = '数量を入力してください。'; return;
    }
    tradePending = true;
    renderOrder();
    try {
      const response = await fetch(apiUrl('/api/trade'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ coin: selectedCoin, side: tradeMode, quantity }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '取引できませんでした。');
      notice.textContent = '';
      showToast(`${result.fill.coin} を ${number(result.fill.quantity)} 枚、${tradeMode === 'buy' ? '購入' : '売却'}しました。`);
      playTradeSound(tradeMode);
      await syncState();
    } catch (error) {
      notice.textContent = error.message || '取引できませんでした。';
    } finally {
      tradePending = false;
      if (state && market) renderOrder();
    }
  }

  async function placeLimitOrder() {
    const quantity = Number(document.getElementById('limit-quantity').value);
    const limitPrice = Number(document.getElementById('limit-price').value);
    const notice = document.getElementById('limit-notice');
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(limitPrice) || limitPrice <= 0) {
      notice.textContent = '指値価格と注文数量を入力してください。'; return;
    }
    limitPending = true;
    renderAdvanced();
    try {
      const response = await fetch(apiUrl('/api/orders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ coin: selectedCoin, side: limitMode, quantity, limitPrice: limitPrice / 100 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '指値注文を出せませんでした。');
      notice.textContent = '指値注文を受け付けました。';
      showToast(`${coinById[selectedCoin].id} の指値注文を受け付けました。`);
      await syncState();
    } catch (error) {
      notice.textContent = error.message || '指値注文を出せませんでした。';
    } finally {
      limitPending = false;
      if (state && market) renderAdvanced();
    }
  }

  async function cancelLimitOrder(orderId) {
    const notice = document.getElementById('limit-notice');
    try {
      const response = await fetch(apiUrl(`/api/orders/${encodeURIComponent(orderId)}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '注文を取り消せませんでした。');
      notice.textContent = '指値注文を取り消しました。';
      showToast('指値注文を取り消しました。');
      await syncState();
    } catch (error) {
      notice.textContent = error.message || '注文を取り消せませんでした。';
    }
  }

  function setLimitMode(mode) {
    limitMode = mode;
    const buy = mode === 'buy';
    document.getElementById('limit-buy-tab').className = `trade-tab${buy ? ' active buy' : ''}`;
    document.getElementById('limit-sell-tab').className = `trade-tab${buy ? '' : ' active sell'}`;
    document.getElementById('limit-buy-tab').setAttribute('aria-pressed', String(buy));
    document.getElementById('limit-sell-tab').setAttribute('aria-pressed', String(!buy));
    if (state && market) renderAdvanced();
  }

  function setTradingView(view) {
    const advanced = view === 'advanced';
    document.getElementById('market-trading-panel').hidden = advanced;
    document.getElementById('advanced-trading-panel').hidden = !advanced;
    document.getElementById('market-trading-tab').classList.toggle('active', !advanced);
    document.getElementById('advanced-trading-tab').classList.toggle('active', advanced);
    document.getElementById('market-trading-tab').setAttribute('aria-selected', String(!advanced));
    document.getElementById('advanced-trading-tab').setAttribute('aria-selected', String(advanced));
  }

  async function saveProfile(event) {
    event.preventDefault();
    const notice = document.getElementById('profile-notice');
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    notice.textContent = '保存中...';
    try {
      const response = await fetch(apiUrl('/api/profile'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: document.getElementById('username-input').value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '名前を保存できませんでした。');
      if (state) state.username = result.username;
      notice.textContent = '保存しました';
      if (state) renderProfile();
      document.getElementById('profile-menu').open = false;
      await syncState();
    } catch (error) {
      notice.textContent = error.message || '名前を保存できませんでした。';
    } finally {
      button.disabled = false;
    }
  }

  function setMode(mode) {
    tradeMode = mode;
    const buy = mode === 'buy';
    document.getElementById('buy-tab').className = `trade-tab${buy ? ' active buy' : ''}`;
    document.getElementById('sell-tab').className = `trade-tab${buy ? '' : ' active sell'}`;
    document.getElementById('buy-tab').setAttribute('aria-selected', String(buy));
    document.getElementById('sell-tab').setAttribute('aria-selected', String(!buy));
    document.getElementById('trade-notice').textContent = '';
    if (state && market) renderOrder();
  }

  document.getElementById('chart-coin').addEventListener('change', event => select(event.target.value));
  document.getElementById('buy-tab').addEventListener('click', () => setMode('buy'));
  document.getElementById('sell-tab').addEventListener('click', () => setMode('sell'));
  document.getElementById('market-trading-tab').addEventListener('click', () => setTradingView('market'));
  document.getElementById('advanced-trading-tab').addEventListener('click', () => setTradingView('advanced'));
  document.getElementById('quantity').addEventListener('input', () => { if (state && market) renderOrder(); });
  document.getElementById('execute-trade').addEventListener('click', executeTrade);
  document.getElementById('place-limit-order').addEventListener('click', placeLimitOrder);
  document.getElementById('limit-buy-tab').addEventListener('click', () => setLimitMode('buy'));
  document.getElementById('limit-sell-tab').addEventListener('click', () => setLimitMode('sell'));
  document.getElementById('limit-price').addEventListener('input', () => { if (state && market) renderAdvanced(); });
  document.getElementById('limit-quantity').addEventListener('input', () => { if (state && market) renderAdvanced(); });
  document.getElementById('profile-form').addEventListener('submit', saveProfile);
  document.getElementById('quantity-presets').addEventListener('click', event => {
    const button = event.target.closest('[data-quantity]');
    if (!button) return;
    document.getElementById('quantity').value = button.dataset.quantity;
    renderOrder();
  });
  document.getElementById('quick-row').addEventListener('click', event => {
    const button = event.target.closest('[data-percent]');
    if (!button || !state || !market) return;
    const coin = coinById[selectedCoin];
    const price = market.prices[coin.id];
    const percent = Number(button.dataset.percent) / 100;
    const max = tradeMode === 'buy' ? availableCash() / price : availableCoins(coin.id);
    document.getElementById('quantity').value = String(Math.floor(max * percent));
    renderOrder();
  });
  document.querySelectorAll('.range-btn').forEach(button => button.addEventListener('click', async () => {
    chartMinutes = Number(button.dataset.minutes);
    document.querySelectorAll('.range-btn').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    const labels = { 1: '過去1分', 10: '過去10分', 30: '過去30分', 60: '過去1時間', 360: '過去6時間', 1440: '過去1日' };
    document.getElementById('chart-range-label').textContent = labels[chartMinutes];
    await syncState();
  }));
  window.addEventListener('resize', () => { if (market) drawChart(); });
  window.addEventListener('focus', syncState);
  const marketEvents = new EventSource(apiUrl('/api/market-events'), { withCredentials: true });
  marketEvents.addEventListener('open', syncState);
  marketEvents.addEventListener('message', syncState);
  syncState();
})();