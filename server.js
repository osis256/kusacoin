'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const coins = require('./coins');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STARTING_CASH = 10000;
const TICK_MS = 3000;
const TRADING_FEE_RATE = 0.005;
const MAX_TRADE_IMPACT_PER_WINDOW = 0.0025;
const RECOVERY_THRESHOLD = 100;
const RECOVERY_DELAY_MS = 60 * 1000;
const RECOVERY_GRANT = 500;
const HISTORY_SAMPLE_MS = 10000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_POINTS = 10000;
const PLAYER_COOKIE = 'kusa_player';
const ROOT = __dirname;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const VOLATILITY_MULTIPLIERS = [0.55, 0.8, 1, 1.3, 1.7];

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPrice(value) {
  return Math.max(0.01, roundMoney(value));
}

function marketImpact(quantity, coin) {
  return Math.min(MAX_TRADE_IMPACT_PER_WINDOW, Math.tanh(quantity / (coin.liquidity * 2)) * coin.maxImpact * 0.1);
}

function japaneseDate(timestamp) {
  return new Date(timestamp + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function gaussian(random) {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function createGameServer({ dataFile = path.join(ROOT, 'data', 'game-state.json'), clock = Date.now, random = Math.random } = {}) {
  const now = clock();
  const initial = { players: {}, market: { prices: {}, volatilityLevels: {} }, updatedAt: now, resetDate: japaneseDate(now) };
  try {
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (saved && saved.players && saved.market && saved.market.prices) {
      initial.players = saved.players;
      initial.market.prices = saved.market.prices;
      initial.market.volatilityLevels = saved.market.volatilityLevels || {};
      initial.updatedAt = saved.updatedAt || now;
      initial.resetDate = saved.resetDate || japaneseDate(now);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load saved game state:', error.message);
  }

  const game = {
    players: initial.players,
    market: { prices: {}, history: {}, volatilityLevels: {}, impactWindow: Math.floor(now / TICK_MS), impactUsed: {} },
    updatedAt: now,
    resetDate: initial.resetDate,
  };
  for (const coin of coins) {
    const savedPrice = Number(initial.market.prices[coin.id]);
    const price = Number.isFinite(savedPrice) && savedPrice > 0 ? savedPrice : coin.initialPrice;
    game.market.prices[coin.id] = roundPrice(price);
    const savedLevel = Number(initial.market.volatilityLevels[coin.id]);
    game.market.volatilityLevels[coin.id] = Number.isInteger(savedLevel) && savedLevel >= 1 && savedLevel <= 5
      ? savedLevel
      : Math.floor(random() * 5) + 1;
    game.market.history[coin.id] = [
      { at: now - HISTORY_WINDOW_MS, price },
      { at: now, price },
    ];
  }
  for (const [id, player] of Object.entries(game.players)) {
    if (!player || !Number.isFinite(player.cash) || !player.holdings || typeof player.holdings !== 'object') {
      delete game.players[id];
      continue;
    }
    player.username = typeof player.username === 'string' ? player.username : 'ゲスト';
    player.trades = Array.isArray(player.trades) ? player.trades.slice(0, 20) : [];
    player.recoveryStartedAt = Number.isFinite(player.recoveryStartedAt) ? player.recoveryStartedAt : null;
    player.recoveryDate = typeof player.recoveryDate === 'string' ? player.recoveryDate : '';
    player.recoveryNotice = player.recoveryNotice && Number.isFinite(player.recoveryNotice.at) ? player.recoveryNotice : null;
    player.orders = Array.isArray(player.orders) ? player.orders.filter(order =>
      order && typeof order.id === 'string' && coins.some(coin => coin.id === order.coin)
      && ['buy', 'sell'].includes(order.side) && Number.isFinite(order.limitPrice) && order.limitPrice > 0
      && Number.isFinite(order.quantity) && order.quantity >= 0.01).slice(0, 20) : [];
  }

  function persist() {
    const directory = path.dirname(dataFile);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${dataFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({
      players: game.players,
      market: { prices: game.market.prices, volatilityLevels: game.market.volatilityLevels },
      updatedAt: game.updatedAt,
      resetDate: game.resetDate,
    }));
    fs.renameSync(temporaryFile, dataFile);
  }

  function appendHistory(id, at) {
    const points = game.market.history[id];
    points.push({ at, price: game.market.prices[id] });
    while (points.length > MAX_HISTORY_POINTS || points[0].at < at - HISTORY_WINDOW_MS) points.shift();
  }

  function resetDaily(now) {
    for (const player of Object.values(game.players)) {
      player.cash = STARTING_CASH;
      player.holdings = {};
      player.trades = [];
      player.orders = [];
      player.recoveryStartedAt = null;
      player.recoveryNotice = null;
    }
    for (const coin of coins) {
      const initialPrice = roundPrice(coin.initialPrice);
      game.market.prices[coin.id] = initialPrice;
      game.market.volatilityLevels[coin.id] = Math.floor(random() * 5) + 1;
      game.market.history[coin.id] = [
        { at: now - HISTORY_WINDOW_MS, price: initialPrice },
        { at: now, price: initialPrice },
      ];
    }
    game.resetDate = japaneseDate(now);
    game.updatedAt = now;
    persist();
  }

  function ensureDailyReset(now) {
    if (japaneseDate(now) !== game.resetDate) resetDaily(now);
  }

  function playerTotalAssets(player) {
    return player.cash + coins.reduce((sum, coin) => sum
      + (Number(player.holdings[coin.id]) || 0) * game.market.prices[coin.id], 0);
  }

  function updateRecovery(now) {
    const date = japaneseDate(now);
    let changed = false;
    for (const player of Object.values(game.players)) {
      if (playerTotalAssets(player) >= RECOVERY_THRESHOLD) {
        if (player.recoveryStartedAt !== null) {
          player.recoveryStartedAt = null;
          changed = true;
        }
        continue;
      }
      if (player.recoveryDate === date) continue;
      if (player.recoveryStartedAt === null) {
        player.recoveryStartedAt = now;
        changed = true;
        continue;
      }
      if (now - player.recoveryStartedAt < RECOVERY_DELAY_MS) continue;
      player.cash = roundMoney(player.cash + RECOVERY_GRANT);
      player.recoveryDate = date;
      player.recoveryStartedAt = null;
      player.recoveryNotice = { id: crypto.randomUUID(), amount: RECOVERY_GRANT, at: now };
      changed = true;
    }
    return changed;
  }

  function recoveryStatus(player, now) {
    const date = japaneseDate(now);
    const receivedToday = player.recoveryDate === date;
    const readyAt = player.recoveryStartedAt === null ? null : player.recoveryStartedAt + RECOVERY_DELAY_MS;
    return {
      threshold: RECOVERY_THRESHOLD,
      grant: RECOVERY_GRANT,
      delayMs: RECOVERY_DELAY_MS,
      readyAt,
      receivedToday,
      totalAssets: roundMoney(playerTotalAssets(player)),
      notice: player.recoveryNotice,
    };
  }

  function reservedCash(player) {
    return player.orders.reduce((sum, order) => {
      if (order.side !== 'buy') return sum;
      const amount = order.limitPrice * order.quantity;
      return sum + amount + tradeFee(amount);
    }, 0);
  }

  function reservedCoins(player, coinId) {
    return player.orders.reduce((sum, order) => sum + (order.side === 'sell' && order.coin === coinId ? order.quantity : 0), 0);
  }

  function getTradeImpact(coin, quantity, now) {
    const window = Math.floor(now / TICK_MS);
    if (game.market.impactWindow !== window) {
      game.market.impactWindow = window;
      game.market.impactUsed = {};
    }
    const used = game.market.impactUsed[coin.id] || 0;
    return Math.min(marketImpact(quantity, coin), Math.max(0, MAX_TRADE_IMPACT_PER_WINDOW - used));
  }

  function applyTradeImpact(coin, side, impact, now) {
    const direction = side === 'buy' ? 1 : -1;
    const nextPrice = roundPrice(Math.min(1e9, game.market.prices[coin.id] * Math.exp(direction * impact)));
    game.market.prices[coin.id] = nextPrice;
    game.market.impactUsed[coin.id] = (game.market.impactUsed[coin.id] || 0) + impact;
    appendHistory(coin.id, now);
    return nextPrice;
  }

  function tradeFee(amount) {
    return roundMoney(amount * TRADING_FEE_RATE);
  }

  function matchLimitOrders(now) {
    for (const player of Object.values(game.players)) {
      const remaining = [];
      for (const order of player.orders) {
        const price = game.market.prices[order.coin];
        const triggered = order.side === 'buy' ? price <= order.limitPrice : price >= order.limitPrice;
        if (!triggered) {
          remaining.push(order);
          continue;
        }

        const coin = coins.find(item => item.id === order.coin);
        const impact = getTradeImpact(coin, order.quantity, now);
        const fillPrice = order.side === 'buy' ? roundPrice(price * Math.exp(impact)) : price;
        if (order.side === 'buy' && fillPrice > order.limitPrice) {
          remaining.push(order);
          continue;
        }
        const amount = roundMoney(fillPrice * order.quantity);
        const fee = tradeFee(amount);
        const owned = Number(player.holdings[order.coin]) || 0;
        if (order.side === 'buy') {
          if (amount + fee > player.cash + 0.000001) {
            remaining.push(order);
            continue;
          }
          player.cash = roundMoney(player.cash - amount - fee);
          player.holdings[order.coin] = Math.round((owned + order.quantity) * 100) / 100;
        } else {
          if (order.quantity > owned + 0.000001) continue;
          player.holdings[order.coin] = Math.round((owned - order.quantity) * 100) / 100;
          if (player.holdings[order.coin] < 0.01) delete player.holdings[order.coin];
          player.cash = roundMoney(player.cash + amount - fee);
        }

        player.trades.unshift({ id: crypto.randomUUID(), orderType: 'limit', coin: order.coin, side: order.side, quantity: order.quantity, price: fillPrice, fee, at: now });
        player.trades = player.trades.slice(0, 20);
        applyTradeImpact(coin, order.side, impact, now);
      }
      player.orders = remaining;
    }
  }

  function advanceMarket() {
    const now = clock();
    ensureDailyReset(now);
    const elapsedMs = now - game.updatedAt;
    if (elapsedMs < TICK_MS) {
      if (updateRecovery(now)) persist();
      return;
    }
    const elapsedSeconds = Math.min(elapsedMs / 1000, 300);
    for (const coin of coins) {
      const logReturn = coin.drift * elapsedSeconds / 86400
        + gaussian(random) * coin.volatility * VOLATILITY_MULTIPLIERS[game.market.volatilityLevels[coin.id] - 1]
          * Math.sqrt(elapsedSeconds / (TICK_MS / 1000));
      game.market.prices[coin.id] = roundPrice(Math.min(1e9, game.market.prices[coin.id] * Math.exp(logReturn)));
      const history = game.market.history[coin.id];
      if (now - history[history.length - 1].at >= HISTORY_SAMPLE_MS) appendHistory(coin.id, now);
    }
    game.updatedAt = now;
    matchLimitOrders(now);
    updateRecovery(now);
    persist();
  }

  function getPlayerId(request, response, create = false) {
    const cookie = (request.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${PLAYER_COOKIE}=`));
    const existing = cookie && cookie.slice(PLAYER_COOKIE.length + 1);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    if (!create) return null;

    const id = crypto.randomUUID();
    const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${PLAYER_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
    if (!game.players[id]) game.players[id] = { username: 'ゲスト', cash: STARTING_CASH, holdings: {}, trades: [], orders: [], recoveryStartedAt: null, recoveryDate: '', recoveryNotice: null };
    persist();
    return id;
  }

  function getLeaderboard() {
    return Object.values(game.players)
      .filter(player => player.trades.length > 0)
      .map(player => ({
        username: player.username || 'ゲスト',
        totalAssets: roundMoney(player.cash + coins.reduce((sum, coin) => sum
          + (Number(player.holdings[coin.id]) || 0) * game.market.prices[coin.id], 0)),
      }))
      .sort((left, right) => right.totalAssets - left.totalAssets || left.username.localeCompare(right.username, 'ja'))
      .slice(0, 10)
      .map((player, index) => ({ rank: index + 1, ...player }));
  }

  function sampled(points, limit) {
    if (points.length <= limit) return points;
    return Array.from({ length: limit }, (_, index) => points[Math.round(index * (points.length - 1) / (limit - 1))]);
  }

  function marketSnapshot(coinId, hours) {
    const now = clock();
    const changes24h = {};
    const sparks = {};
    for (const coin of coins) {
      const points = game.market.history[coin.id];
      const threshold = now - HISTORY_WINDOW_MS;
      let reference = points[0];
      for (const point of points) {
        if (point.at > threshold) break;
        reference = point;
      }
      changes24h[coin.id] = (game.market.prices[coin.id] / reference.price - 1) * 100;
      sparks[coin.id] = sampled(points.filter(point => point.at >= now - 60 * 60 * 1000), 14).map(point => point.price);
    }
    const start = now - hours * 60 * 60 * 1000;
    const chart = sampled(game.market.history[coinId].filter(point => point.at >= start), 61)
      .map(point => ({ at: point.at, price: point.price }));
    const currentPrice = game.market.prices[coinId];
    if (chart.length === 0 || chart[chart.length - 1].at < now - TICK_MS) {
      chart.push({ at: now, price: currentPrice });
    }
    if (chart.length === 1) chart.unshift({ at: start, price: chart[0].price });
    return { prices: game.market.prices, changes24h, sparks, chart, updatedAt: game.updatedAt };
  }

  function sendJson(response, status, value) {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(value));
  }

  async function readJson(request) {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 8192) throw Object.assign(new Error('リクエストが大きすぎます。'), { status: 413 });
    }
    try { return JSON.parse(body); }
    catch { throw Object.assign(new Error('送信内容を読み取れません。'), { status: 400 }); }
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/state' && request.method === 'GET') {
      advanceMarket();
      const playerId = getPlayerId(request, response, true);
      const player = game.players[playerId];
      if (!player) game.players[playerId] = { username: 'ゲスト', cash: STARTING_CASH, holdings: {}, trades: [], orders: [] };
      const coinId = coins.some(coin => coin.id === url.searchParams.get('coin')) ? url.searchParams.get('coin') : coins[0].id;
      const requestedHours = Number(url.searchParams.get('hours'));
      const hours = [1, 6, 24].includes(requestedHours) ? requestedHours : 1;
      sendJson(response, 200, {
        startingCash: STARTING_CASH,
        player: game.players[playerId],
        recovery: recoveryStatus(game.players[playerId], clock()),
        leaderboard: getLeaderboard(),
        coins: coins.map(({ id, name, color }) => ({ id, name, color })),
        market: marketSnapshot(coinId, hours),
      });
      return;
    }

    if (url.pathname === '/api/profile' && request.method === 'PATCH') {
      const playerId = getPlayerId(request, response);
      if (!playerId || !game.players[playerId]) {
        sendJson(response, 401, { error: 'プレイヤー情報を確認できません。画面を再読み込みしてください。' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: 'このリクエストは許可されていません。' });
        return;
      }
      const body = await readJson(request);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const length = Array.from(username).length;
      if (length < 1 || length > 16 || /[\u0000-\u001f\u007f]/.test(username)) {
        sendJson(response, 400, { error: '名前は1〜16文字で入力してください。' });
        return;
      }
      game.players[playerId].username = username;
      persist();
      sendJson(response, 200, { username });
      return;
    }

    if (url.pathname === '/api/trade' && request.method === 'POST') {
      const playerId = getPlayerId(request, response);
      if (!playerId || !game.players[playerId]) {
        sendJson(response, 401, { error: 'プレイヤー情報を確認できません。画面を再読み込みしてください。' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: 'この取引リクエストは許可されていません。' });
        return;
      }
      const body = await readJson(request);
      const coin = coins.find(item => item.id === body.coin);
      const quantity = Number(body.quantity);
      if (!coin || !['buy', 'sell'].includes(body.side) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1e6) {
        sendJson(response, 400, { error: 'コイン、取引種類、数量を確認してください。' });
        return;
      }

      advanceMarket();
      const player = game.players[playerId];
      const marketPrice = game.market.prices[coin.id];
      const now = clock();
      const impact = getTradeImpact(coin, quantity, now);
      const price = body.side === 'buy' ? roundPrice(marketPrice * Math.exp(impact)) : marketPrice;
      const amount = roundMoney(price * quantity);
      const fee = tradeFee(amount);
      const owned = Number(player.holdings[coin.id]) || 0;
      if (body.side === 'buy' && amount + fee > player.cash - reservedCash(player) + 0.000001) {
        sendJson(response, 409, { error: '葉っぱが足りません。数量を調整してください。' });
        return;
      }
      if (body.side === 'sell' && quantity > owned - reservedCoins(player, coin.id) + 0.000001) {
        sendJson(response, 409, { error: '売却できる保有数を超えています。' });
        return;
      }

      if (body.side === 'buy') {
        player.cash = roundMoney(player.cash - amount - fee);
        player.holdings[coin.id] = Math.round((owned + quantity) * 100) / 100;
      } else {
        player.cash = roundMoney(player.cash + amount - fee);
        player.holdings[coin.id] = Math.round((owned - quantity) * 100) / 100;
        if (player.holdings[coin.id] < 0.01) delete player.holdings[coin.id];
      }
      player.trades.unshift({ id: crypto.randomUUID(), orderType: 'market', coin: coin.id, side: body.side, quantity, price, fee, at: now });
      player.trades = player.trades.slice(0, 20);

      applyTradeImpact(coin, body.side, impact, now);
      matchLimitOrders(now);
      persist();
      const total = body.side === 'buy' ? amount + fee : amount - fee;
      sendJson(response, 200, { ok: true, fill: { coin: coin.id, side: body.side, quantity, price, amount, fee, total } });
      return;
    }

    if (url.pathname === '/api/orders' && request.method === 'POST') {
      const playerId = getPlayerId(request, response);
      if (!playerId || !game.players[playerId]) {
        sendJson(response, 401, { error: 'プレイヤー情報を確認できません。画面を再読み込みしてください。' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: 'この注文リクエストは許可されていません。' });
        return;
      }
      const body = await readJson(request);
      const coin = coins.find(item => item.id === body.coin);
      const quantity = Number(body.quantity);
      const limitPrice = roundMoney(Number(body.limitPrice));
      if (!coin || !['buy', 'sell'].includes(body.side) || !Number.isFinite(quantity)
        || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1e6 || !Number.isFinite(limitPrice)
        || limitPrice < 0.01 || limitPrice > 1e9) {
        sendJson(response, 400, { error: '銘柄、注文種類、指値価格、数量を確認してください。' });
        return;
      }

      advanceMarket();
      const player = game.players[playerId];
      if (player.orders.length >= 20) {
        sendJson(response, 409, { error: '未約定注文は20件までです。' });
        return;
      }
      const reservation = limitPrice * quantity + tradeFee(limitPrice * quantity);
      if (body.side === 'buy' && reservation > player.cash - reservedCash(player) + 0.000001) {
        sendJson(response, 409, { error: '指値注文に必要な葉っぱが足りません。' });
        return;
      }
      const owned = Number(player.holdings[coin.id]) || 0;
      if (body.side === 'sell' && quantity > owned - reservedCoins(player, coin.id) + 0.000001) {
        sendJson(response, 409, { error: '指値注文に必要な保有数が足りません。' });
        return;
      }

      const order = { id: crypto.randomUUID(), coin: coin.id, side: body.side, quantity, limitPrice, createdAt: clock() };
      player.orders.push(order);
      matchLimitOrders(clock());
      persist();
      sendJson(response, 200, { ok: true, order });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i);
    if (cancelMatch && request.method === 'DELETE') {
      const playerId = getPlayerId(request, response);
      if (!playerId || !game.players[playerId]) {
        sendJson(response, 401, { error: 'プレイヤー情報を確認できません。画面を再読み込みしてください。' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: 'この取消リクエストは許可されていません。' });
        return;
      }
      const player = game.players[playerId];
      const orderIndex = player.orders.findIndex(order => order.id === cancelMatch[1]);
      if (orderIndex < 0) {
        sendJson(response, 404, { error: '未約定注文が見つかりません。' });
        return;
      }
      player.orders.splice(orderIndex, 1);
      persist();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/client.js')) {
      const file = url.pathname === '/client.js' ? 'client.js' : 'index.html';
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(path.join(ROOT, file)).pipe(response);
      return;
    }
    sendJson(response, 404, { error: 'ページが見つかりません。' });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'サーバーでエラーが発生しました。' });
      else response.destroy();
      if (!error.status) console.error(error);
    });
  });
  const ticker = setInterval(advanceMarket, TICK_MS);
  ticker.unref();
  server.on('close', () => clearInterval(ticker));
  ensureDailyReset(now);
  persist();
  return server;
}

if (require.main === module) {
  const server = createGameServer();
  server.listen(PORT, HOST, () => console.log(`Kusacoin is running at http://localhost:${PORT}`));
}

module.exports = { createGameServer };