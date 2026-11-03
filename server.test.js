'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { createGameServer } = require('./server');
const coins = require('./coins');

test('players keep separate balances while trades move the shared quote', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kusacoin-test-'));
  const dataFile = path.join(directory, 'state.json');
  const now = Date.now();
  let server = createGameServer({ dataFile, clock: () => now, random: () => 0.5 });
  const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const close = instance => new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  await listen(server);
  let origin = `http://127.0.0.1:${server.address().port}`;
  let playerCookie;

  try {
    const firstResponse = await fetch(`${origin}/api/state`);
    playerCookie = firstResponse.headers.get('set-cookie').split(';')[0];
    const first = await firstResponse.json();
    const initialPrice = first.market.prices.KUSA;
    assert.ok(Object.values(first.market.prices).every(price => price === Math.round(price * 100) / 100));
    const secondResponse = await fetch(`${origin}/api/state`);
    const secondCookie = secondResponse.headers.get('set-cookie').split(';')[0];
    const second = await secondResponse.json();

    assert.notEqual(playerCookie, secondCookie);
    assert.equal(first.player.cash, 10000);
    assert.equal(second.player.cash, 10000);
    assert.deepEqual(first.leaderboard, []);

    const overdrawnTrade = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: playerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'buy', quantity: 10000 }),
    });
    assert.equal(overdrawnTrade.status, 409);
    const afterRejectedTrade = await fetch(`${origin}/api/state`, { headers: { Cookie: playerCookie } }).then(response => response.json());
    assert.equal(afterRejectedTrade.player.cash, 10000);
    assert.deepEqual(afterRejectedTrade.player.holdings, {});
    assert.equal(afterRejectedTrade.market.prices.KUSA, initialPrice);

    const tradeResponse = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: playerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'buy', quantity: 50, cash: 1e9, holdings: { KUSA: 1e9 }, price: 0.01, prices: { KUSA: 0.01 } }),
    });
    assert.equal(tradeResponse.status, 200);
    const firstFill = (await tradeResponse.json()).fill;

    const firstRefresh = await fetch(`${origin}/api/state`, { headers: { Cookie: playerCookie } }).then(response => response.json());
    const secondRefresh = await fetch(`${origin}/api/state`, { headers: { Cookie: secondCookie } }).then(response => response.json());
    assert.equal(firstRefresh.player.holdings.KUSA, 50);
    assert.equal(firstRefresh.player.cash, 10000 - firstFill.total);
    assert.equal(secondRefresh.player.cash, 10000);
    assert.equal(secondRefresh.player.holdings.KUSA, undefined);
    assert.ok(secondRefresh.market.prices.KUSA > initialPrice);
    assert.ok(secondRefresh.market.prices.KUSA < initialPrice * 1.001);
    assert.equal(secondRefresh.leaderboard.length, 1);

    const secondBuy = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: secondCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'buy', quantity: 100 }),
    });
    assert.equal(secondBuy.status, 200);
    const beforeSell = await fetch(`${origin}/api/state`, { headers: { Cookie: secondCookie } }).then(response => response.json());
    const sellPrice = beforeSell.market.prices.KUSA;
    const secondSell = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: secondCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'sell', quantity: 100 }),
    });
    assert.equal(secondSell.status, 200);
    const afterSell = await fetch(`${origin}/api/state`, { headers: { Cookie: playerCookie } }).then(response => response.json());
    const secondAfterSell = await fetch(`${origin}/api/state`, { headers: { Cookie: secondCookie } }).then(response => response.json());
    assert.ok(afterSell.market.prices.KUSA < sellPrice);
    assert.equal(afterSell.player.holdings.KUSA, 50);
    assert.equal(secondAfterSell.player.holdings.KUSA, undefined);
    assert.ok(secondAfterSell.player.cash < 10000);

    await close(server);
    server = createGameServer({ dataFile });
    await listen(server);
    origin = `http://127.0.0.1:${server.address().port}`;
    const restored = await fetch(`${origin}/api/state`, { headers: { Cookie: playerCookie } }).then(response => response.json());
    assert.equal(restored.player.holdings.KUSA, 50);
    assert.equal(restored.player.cash, firstRefresh.player.cash);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JST midnight resets daily assets and prices but keeps the player name', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kusacoin-reset-test-'));
  const dataFile = path.join(directory, 'state.json');
  let now = Date.UTC(2026, 10, 3, 14, 59, 0);
  let server = createGameServer({ dataFile, clock: () => now, random: () => 0.5 });
  const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const close = instance => new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const stateResponse = await fetch(`${origin}/api/state`);
    const cookie = stateResponse.headers.get('set-cookie').split(';')[0];
    const initial = await stateResponse.json();
    assert.equal(new Date(initial.market.updatedAt).toISOString(), new Date(now).toISOString());
    assert.equal(initial.market.prices.KUSA, 42);
    assert.equal(Object.keys(initial.coins[0]).sort().join(','), 'color,id,name');
    assert.equal('volatilityLevels' in initial.market, false);

    const profileResponse = await fetch(`${origin}/api/profile`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'なずな' }),
    });
    assert.equal(profileResponse.status, 200);

    const tradeResponse = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'buy', quantity: 20 }),
    });
    assert.equal(tradeResponse.status, 200);

    const beforeReset = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } }).then(response => response.json());
    assert.equal(beforeReset.leaderboard[0].username, 'なずな');
    assert.ok(beforeReset.leaderboard[0].totalAssets < 10000);
    assert.ok(beforeReset.leaderboard[0].totalAssets > 9900);
    assert.equal(beforeReset.player.holdings.KUSA, 20);

    now = Date.UTC(2026, 10, 3, 15, 0, 0);
    const afterReset = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } }).then(response => response.json());
    assert.equal(afterReset.player.username, 'なずな');
    assert.equal(afterReset.player.cash, 10000);
    assert.deepEqual(afterReset.player.holdings, {});
    assert.equal(afterReset.player.trades.length, 0);
    assert.equal(afterReset.market.prices.KUSA, 42);
    assert.deepEqual(afterReset.leaderboard, []);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('limit orders reserve funds and coins, fill at the limit, and release on cancellation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kusacoin-order-test-'));
  const dataFile = path.join(directory, 'state.json');
  let now = Date.UTC(2026, 10, 3, 3, 0, 0);
  let server = createGameServer({ dataFile, clock: () => now, random: () => 0.5 });
  const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const close = instance => new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const firstResponse = await fetch(`${origin}/api/state`);
    const firstCookie = firstResponse.headers.get('set-cookie').split(';')[0];
    await firstResponse.json();
    const secondResponse = await fetch(`${origin}/api/state`);
    const secondCookie = secondResponse.headers.get('set-cookie').split(';')[0];
    await secondResponse.json();

    const buyOrderResponse = await fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'buy', quantity: 10, limitPrice: 41.995 }),
    });
    assert.equal(buyOrderResponse.status, 200);
    const buyOrder = (await buyOrderResponse.json()).order;

    const overcommittedBuy = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'buy', quantity: 230 }),
    });
    assert.equal(overcommittedBuy.status, 409);

    const foreignCancel = await fetch(`${origin}/api/orders/${buyOrder.id}`, { method: 'DELETE', headers: { Cookie: secondCookie } });
    assert.equal(foreignCancel.status, 404);

    now += 3000;
    const filledState = await fetch(`${origin}/api/state`, { headers: { Cookie: firstCookie } }).then(response => response.json());
    assert.equal(filledState.player.orders.length, 0);
    assert.equal(filledState.player.holdings.KUSA, 10);
    assert.equal(filledState.player.trades[0].orderType, 'limit');
    assert.ok(filledState.player.trades[0].price <= buyOrder.limitPrice);

    const sellOrderResponse = await fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'sell', quantity: 10, limitPrice: 50 }),
    });
    assert.equal(sellOrderResponse.status, 200);
    const sellOrder = (await sellOrderResponse.json()).order;
    const overcommittedSell = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'sell', quantity: 1 }),
    });
    assert.equal(overcommittedSell.status, 409);
    const fractionalSell = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'sell', quantity: 0.5 }),
    });
    assert.equal(fractionalSell.status, 400);

    const canceled = await fetch(`${origin}/api/orders/${sellOrder.id}`, { method: 'DELETE', headers: { Cookie: firstCookie } });
    assert.equal(canceled.status, 200);
    const marketSell = await fetch(`${origin}/api/trade`, {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KUSA', side: 'sell', quantity: 10 }),
    });
    assert.equal(marketSell.status, 200);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('low-assets recovery grants leaves after waiting, only once per JST day', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kusacoin-recovery-test-'));
  const dataFile = path.join(directory, 'state.json');
  const playerId = '00000000-0000-4000-8000-000000000001';
  let now = Date.UTC(2026, 10, 3, 3, 0, 0);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    players: {
      [playerId]: { username: 'ピンチ', cash: 50, holdings: {}, trades: [], orders: [], recoveryStartedAt: null, recoveryDate: '', recoveryNotice: null },
    },
    market: {
      prices: Object.fromEntries(coins.map(coin => [coin.id, coin.initialPrice])),
      volatilityLevels: Object.fromEntries(coins.map(coin => [coin.id, 3])),
    },
    updatedAt: now,
    resetDate: '2026-11-03',
  }));

  let server = createGameServer({ dataFile, clock: () => now, random: () => 0.5 });
  const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const close = instance => new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: `kusa_player=${playerId}` };

  try {
    const initial = await fetch(`${origin}/api/state`, { headers }).then(response => response.json());
    assert.equal(initial.player.cash, 50);
    assert.equal(initial.recovery.readyAt, now + 60000);
    assert.equal(initial.recovery.receivedToday, false);

    now += 59000;
    const waiting = await fetch(`${origin}/api/state`, { headers }).then(response => response.json());
    assert.equal(waiting.player.cash, 50);
    assert.equal(waiting.recovery.readyAt, Date.UTC(2026, 10, 3, 3, 1, 0));

    now += 2000;
    const granted = await fetch(`${origin}/api/state`, { headers }).then(response => response.json());
    assert.equal(granted.player.cash, 550);
    assert.equal(granted.recovery.receivedToday, true);
    assert.equal(granted.recovery.notice.amount, 500);

    now += 60000;
    const noDuplicate = await fetch(`${origin}/api/state`, { headers }).then(response => response.json());
    assert.equal(noDuplicate.player.cash, 550);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('many same-window sellers cannot push the shared quote past the impact cap', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kusacoin-impact-cap-test-'));
  const dataFile = path.join(directory, 'state.json');
  const now = Date.UTC(2026, 10, 3, 3, 0, 0);
  const playerIds = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    players: Object.fromEntries(playerIds.map((id, index) => [id, {
      username: `売り手${index + 1}`, cash: 10000, holdings: { KUSA: 1000 }, trades: [], orders: [],
      recoveryStartedAt: null, recoveryDate: '', recoveryNotice: null,
    }])),
    market: {
      prices: Object.fromEntries(coins.map(coin => [coin.id, coin.initialPrice])),
      volatilityLevels: Object.fromEntries(coins.map(coin => [coin.id, 3])),
    },
    updatedAt: now,
    resetDate: '2026-11-03',
  }));

  const server = createGameServer({ dataFile, clock: () => now, random: () => 0.5 });
  const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const close = instance => new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const id of playerIds) {
      const response = await fetch(`${origin}/api/trade`, {
        method: 'POST',
        headers: { Cookie: `kusa_player=${id}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin: 'KUSA', side: 'sell', quantity: 1000 }),
      });
      assert.equal(response.status, 200);
    }
    const snapshot = await fetch(`${origin}/api/state`, { headers: { Cookie: `kusa_player=${playerIds[0]}` } }).then(response => response.json());
    assert.ok(snapshot.market.prices.KUSA >= 42 * Math.exp(-0.0025));
    assert.ok(snapshot.market.prices.KUSA < 42);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});