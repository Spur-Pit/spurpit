import {
  SEL, ZERO_ADDR, addrAt, boolAt, decodeAbiString, decodeBoutTuple, decodeBoutsArray,
  decodeLaunchedToken, ethCallBatch, fmtEthShort, fmtTokenCompact, isAddr, normAddr,
  padAddr, padUint, rpcBatch, uintAt,
} from './evm.js';

const DEFAULT_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com';

// Warm in-memory caches per isolate
const tokenMetaCache = new Map();
const calloutCache = new Map();
let ponsListCache = { ts: 0, items: [] };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortAddr(a) {
  return a && a !== ZERO_ADDR ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'Open Pit';
}

async function inspectOnchainToken(rpcUrl, factory, tokenAddr, watchedHolder = '') {
  const addr = normAddr(tokenAddr);
  if (addr === ZERO_ADDR) return null;

  const [launchedHex, symHex, nameHex] = await ethCallBatch(rpcUrl, [
    { to: factory, data: SEL.getLaunchedToken + padAddr(addr) },
    { to: addr, data: SEL.symbol },
    { to: addr, data: SEL.name },
  ]);

  const info = decodeLaunchedToken(launchedHex);
  if (!info.exists || info.curve === ZERO_ADDR) return null;

  const symbol = decodeAbiString(symHex) || addr.slice(2, 6).toUpperCase();
  const name = decodeAbiString(nameHex) || symbol;
  tokenMetaCache.set(addr, { address: addr, symbol, name, curve: info.curve, deployer: info.deployer, threshold: info.graduationThreshold });

  const holderTarget = isAddr(watchedHolder) ? normAddr(watchedHolder) : info.deployer;
  const subCalls = [
    { to: info.curve, data: SEL.realQuoteReserve },
    { to: info.curve, data: SEL.graduated },
  ];
  if (holderTarget && holderTarget !== ZERO_ADDR) {
    subCalls.push({ to: addr, data: SEL.balanceOf + padAddr(holderTarget) });
  }

  const subRes = await ethCallBatch(rpcUrl, subCalls);
  const reserveWei = uintAt(subRes[0], 0);
  const curveGrad = boolAt(subRes[1], 0) || info.phase !== 0;
  const holderBalWei = subRes[2] ? uintAt(subRes[2], 0) : 0n;
  const threshWei = BigInt(info.graduationThreshold || '4200000000000000000');
  const effectiveReserve = curveGrad ? threshWei : reserveWei;
  const pct = threshWei > 0n ? Math.min(100, Number((effectiveReserve * 10000n) / threshWei) / 100) : 0;

  return {
    address: addr,
    symbol,
    name,
    curve: info.curve,
    deployer: info.deployer,
    pairToken: info.pairToken,
    ethPaired: info.pairToken === ZERO_ADDR,
    graduated: curveGrad,
    reserveWei: effectiveReserve.toString(),
    reserveEth: fmtEthShort(effectiveReserve.toString(), 4),
    thresholdWei: threshWei.toString(),
    thresholdEth: fmtEthShort(threshWei.toString(), 2),
    progressPct: pct,
    watchedHolder: holderTarget,
    holderBalanceWei: holderBalWei.toString(),
    holderBalanceFormatted: fmtTokenCompact(holderBalWei.toString()),
  };
}

async function fetchPonsDirectory(query = '') {
  const now = Date.now();
  if (!query && now - ponsListCache.ts < 20_000 && ponsListCache.items.length) {
    return ponsListCache.items;
  }
  try {
    const url = query
      ? `https://ponsfamily.com/api/launches?q=${encodeURIComponent(query)}`
      : 'https://ponsfamily.com/api/launches';
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return ponsListCache.items;
    const raw = await res.json();
    const arr = Array.isArray(raw) ? raw : (raw.launches || raw.items || raw.data || []);
    const mapped = arr
      .filter((item) => isAddr(item?.address || item?.token))
      .slice(0, 36)
      .map((item) => ({
        address: (item.address || item.token).toLowerCase(),
        symbol: item.symbol || item.ticker || 'TOKEN',
        name: item.name || item.symbol || 'Pons Token',
        stage: item.stage || (item.graduated ? 'graduated' : 'curve'),
        artwork: item.artwork || item.image || '',
      }));
    if (!query && mapped.length) ponsListCache = { ts: now, items: mapped };
    return mapped;
  } catch {
    return ponsListCache.items;
  }
}

async function hydrateCalloutsFromLogs(rpcUrl, pitAddr) {
  try {
    const [blockHex] = await rpcBatch(rpcUrl, [{ method: 'eth_blockNumber', params: [] }]);
    if (!blockHex) return;
    const latest = BigInt(blockHex);
    const fromBlock = latest > 45000n ? '0x' + (latest - 45000n).toString(16) : '0x0';
    const [logs] = await rpcBatch(rpcUrl, [{
      method: 'eth_getLogs',
      params: [{
        address: pitAddr,
        fromBlock,
        toBlock: 'latest',
        topics: [SEL.boutOpenedTopic],
      }],
    }]);
    for (const log of logs || []) {
      const id = Number(BigInt(log.topics?.[1] || '0x0'));
      if (!id) continue;
      // Non-indexed words in BoutOpened:
      // 0:mode, 1:makerSideA, 2:tokenA, 3:tokenB, 4:stake, 5:targetValue, 6:joinBy, 7:resolveAt, 8:promoter, 9:offset(callout)
      const strOffset = Number(uintAt(log.data, 9));
      const text = decodeAbiString(log.data, strOffset);
      calloutCache.set(id, { callout: text, txHash: log.transactionHash || '' });
    }
  } catch {
    // Non-fatal if RPC limits log range
  }
}

async function loadArena(env, viewer = '') {
  const rpcUrl = env.RH_RPC_URL || DEFAULT_RPC;
  const factory = env.PONS_FACTORY || DEFAULT_FACTORY;
  const pit = isAddr(env.PIT_ADDRESS) ? normAddr(env.PIT_ADDRESS) : '';
  const configuredSpur = isAddr(env.SPUR_ADDRESS) ? normAddr(env.SPUR_ADDRESS) : '';

  if (!pit) {
    return {
      deployed: false,
      chainId: Number(env.CHAIN_ID || 4663),
      pitAddress: '',
      spurAddress: configuredSpur,
      stats: {
        boutsCreated: 0, boutsSettled: 0, volumeWei: '0', stakedSpur: '0',
        ringsideEth: '0', promoterEth: '0', pendingBurnWei: '0', burnedEthWei: '0', burnedSpur: '0',
      },
      bouts: [],
      viewer: null,
    };
  }

  const baseCalls = [
    { to: pit, data: SEL.pitStats },
    { to: pit, data: SEL.spur },
    { to: pit, data: SEL.getBouts + padUint(1) + padUint(80) },
  ];
  const hasViewer = isAddr(viewer);
  if (hasViewer) {
    baseCalls.push({ to: pit, data: SEL.staked + padAddr(viewer) });
    baseCalls.push({ to: pit, data: SEL.earnedEth + padAddr(viewer) });
  }

  const [statsRes, logsDone] = await Promise.all([
    ethCallBatch(rpcUrl, baseCalls),
    hydrateCalloutsFromLogs(rpcUrl, pit),
  ]);
  void logsDone;

  const statsHex = statsRes[0];
  const boundSpur = addrAt(statsRes[1], 0);
  const spurAddr = boundSpur !== ZERO_ADDR ? boundSpur : configuredSpur;
  const rawBouts = decodeBoutsArray(statsRes[2]);

  const stats = {
    boutsCreated: Number(uintAt(statsHex, 0)),
    boutsSettled: Number(uintAt(statsHex, 1)),
    volumeWei: uintAt(statsHex, 2).toString(),
    stakedSpur: uintAt(statsHex, 3).toString(),
    ringsideEth: uintAt(statsHex, 4).toString(),
    promoterEth: uintAt(statsHex, 5).toString(),
    pendingBurnWei: uintAt(statsHex, 6).toString(),
    burnedEthWei: uintAt(statsHex, 7).toString(),
    burnedSpur: uintAt(statsHex, 8).toString(),
  };

  // Collect unknown token symbols + live preview calls for active bouts
  const unknownTokens = new Set();
  for (const b of rawBouts) {
    if (b.tokenA !== ZERO_ADDR && !tokenMetaCache.has(b.tokenA)) unknownTokens.add(b.tokenA);
    if (b.mode === 2 && b.tokenB !== ZERO_ADDR && !tokenMetaCache.has(b.tokenB)) unknownTokens.add(b.tokenB);
  }
  const unknownList = [...unknownTokens];
  if (unknownList.length) {
    const metaCalls = [];
    for (const t of unknownList) {
      metaCalls.push({ to: t, data: SEL.symbol });
      metaCalls.push({ to: t, data: SEL.name });
      metaCalls.push({ to: factory, data: SEL.getLaunchedToken + padAddr(t) });
    }
    const metaRes = await ethCallBatch(rpcUrl, metaCalls);
    unknownList.forEach((t, idx) => {
      const sym = decodeAbiString(metaRes[idx * 3]) || t.slice(2, 6).toUpperCase();
      const nm = decodeAbiString(metaRes[idx * 3 + 1]) || sym;
      const lt = decodeLaunchedToken(metaRes[idx * 3 + 2]);
      tokenMetaCache.set(t, { address: t, symbol: sym, name: nm, curve: lt.curve, deployer: lt.deployer, threshold: lt.graduationThreshold || '4200000000000000000' });
    });
  }

  // Live telemetry + previewOutcome for OPEN (0) and LIVE (1) bouts
  const liveCalls = [];
  const liveMap = [];
  rawBouts.forEach((b, idx) => {
    const id = idx + 1;
    if (b.status === 0 || b.status === 1) {
      const previewPos = liveCalls.length;
      liveCalls.push({ to: pit, data: SEL.previewOutcome + padUint(id) });

      let resAPos = -1, gradAPos = -1, resBPos = -1, gradBPos = -1, holderPos = -1;
      if (b.curveA !== ZERO_ADDR) {
        resAPos = liveCalls.length;
        liveCalls.push({ to: b.curveA, data: SEL.realQuoteReserve });
        gradAPos = liveCalls.length;
        liveCalls.push({ to: b.curveA, data: SEL.graduated });
      }
      if (b.mode === 2 && b.curveB !== ZERO_ADDR) {
        resBPos = liveCalls.length;
        liveCalls.push({ to: b.curveB, data: SEL.realQuoteReserve });
        gradBPos = liveCalls.length;
        liveCalls.push({ to: b.curveB, data: SEL.graduated });
      }
      if (b.mode === 3 && b.tokenB !== ZERO_ADDR) {
        holderPos = liveCalls.length;
        liveCalls.push({ to: b.tokenA, data: SEL.balanceOf + padAddr(b.tokenB) });
      }
      liveMap.push({ idx, previewPos, resAPos, gradAPos, resBPos, gradBPos, holderPos });
    }
  });

  if (hasViewer && spurAddr) {
    liveCalls.push({ to: spurAddr, data: SEL.balanceOf + padAddr(viewer) });
    liveCalls.push({ to: spurAddr, data: SEL.allowance + padAddr(viewer) + padAddr(pit) });
  }

  const liveRes = liveCalls.length ? await ethCallBatch(rpcUrl, liveCalls) : [];
  const extraByIdx = new Map();
  for (const m of liveMap) {
    const pHex = liveRes[m.previewPos];
    extraByIdx.set(m.idx, {
      canSettle: boolAt(pHex, 0),
      isDraw: boolAt(pHex, 1),
      sideAWon: boolAt(pHex, 2),
      reserveAWei: m.resAPos >= 0 ? uintAt(liveRes[m.resAPos], 0).toString() : '0',
      gradA: m.gradAPos >= 0 ? boolAt(liveRes[m.gradAPos], 0) : false,
      reserveBWei: m.resBPos >= 0 ? uintAt(liveRes[m.resBPos], 0).toString() : '0',
      gradB: m.gradBPos >= 0 ? boolAt(liveRes[m.gradBPos], 0) : false,
      currentHolderWei: m.holderPos >= 0 ? uintAt(liveRes[m.holderPos], 0).toString() : '0',
    });
  }

  let viewerInfo = null;
  if (hasViewer) {
    const stakedWei = uintAt(statsRes[3], 0).toString();
    const earnedHex = statsRes[4];
    const ringsideWei = uintAt(earnedHex, 0).toString();
    const promoWei = uintAt(earnedHex, 1).toString();
    const spurBalWei = spurAddr ? uintAt(liveRes[liveRes.length - 2], 0).toString() : '0';
    const spurAllowWei = spurAddr ? uintAt(liveRes[liveRes.length - 1], 0).toString() : '0';
    viewerInfo = {
      address: normAddr(viewer),
      stakedWei,
      ringsideEthWei: ringsideWei,
      promoterEthWei: promoWei,
      spurBalanceWei: spurBalWei,
      spurAllowanceWei: spurAllowWei,
    };
  }

  const bouts = rawBouts.map((b, idx) => {
    const id = idx + 1;
    const metaA = tokenMetaCache.get(b.tokenA) || { symbol: b.tokenA.slice(2, 6).toUpperCase(), name: 'Token', threshold: '4200000000000000000' };
    const metaB = b.mode === 2 ? (tokenMetaCache.get(b.tokenB) || { symbol: b.tokenB.slice(2, 6).toUpperCase(), name: 'Token' }) : null;
    const logInfo = calloutCache.get(id) || { callout: '', txHash: '' };
    const live = extraByIdx.get(idx) || null;
    const potWei = (BigInt(b.stake) * 2n).toString();
    return {
      id,
      ...b,
      potWei,
      stakeEth: fmtEthShort(b.stake, 4),
      potEth: fmtEthShort(potWei, 4),
      tokenASymbol: metaA.symbol,
      tokenAName: metaA.name,
      tokenAThresholdWei: metaA.threshold || '4200000000000000000',
      tokenBSymbol: metaB ? metaB.symbol : '',
      tokenBName: metaB ? metaB.name : '',
      callout: logInfo.callout,
      openTxHash: logInfo.txHash,
      live,
    };
  }).reverse();

  return {
    deployed: true,
    chainId: Number(env.CHAIN_ID || 4663),
    pitAddress: pit,
    spurAddress: spurAddr,
    spurBound: boundSpur !== ZERO_ADDR,
    xHandle: env.X_HANDLE || '',
    siteDomain: env.SITE_DOMAIN || '',
    stats,
    bouts,
    viewer: viewerInfo,
  };
}

function renderBoutCardSvg(bout, domainLabel) {
  const modeTitles = ['GRADUATION DUEL', 'CURVE RESERVE LINE', 'HEAD-TO-HEAD CLASH', 'WHALE HAND CHECK'];
  const statusLabels = ['OPEN CHALLENGE', 'LIVE IN THE PIT', 'SETTLED', 'CANCELLED', 'DRAW'];
  const symA = `$${bout.tokenASymbol}`;
  let headline = `${symA} Graduation`;
  let sideALabel = 'GRADUATES';
  let sideBLabel = 'STAYS ON CURVE';

  if (bout.mode === 1) {
    const lineEth = fmtEthShort(bout.targetValue, 3);
    headline = `${symA} Curve ≥ ${lineEth} ETH`;
    sideALabel = `OVER ${lineEth} ETH`;
    sideBLabel = `UNDER ${lineEth} ETH`;
  } else if (bout.mode === 2) {
    const symB = `$${bout.tokenBSymbol}`;
    headline = `${symA} vs ${symB}`;
    sideALabel = symA;
    sideBLabel = symB;
  } else if (bout.mode === 3) {
    headline = `${symA} Bag Check (${shortAddr(bout.tokenB)})`;
    sideALabel = 'DIAMOND HANDS (0 SOLD)';
    sideBLabel = 'DUMPS ANY TOKEN';
  }

  const makerSide = bout.makerSideA ? sideALabel : sideBLabel;
  const rivalSide = bout.makerSideA ? sideBLabel : sideALabel;
  const callout = bout.callout ? `“${bout.callout.slice(0, 88)}”` : '“Talk is cheap. Match the ETH on Robinhood Chain.”';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#0c0a09"/>
    <rect x="36" y="36" width="1128" height="558" rx="8" fill="#151210" stroke="#ebb434" stroke-opacity=".35" stroke-width="1.5"/>
    <line x1="36" y1="104" x2="1164" y2="104" stroke="#f4ecdc" stroke-opacity=".14"/>
    <line x1="36" y1="524" x2="1164" y2="524" stroke="#f4ecdc" stroke-opacity=".14"/>
    <text x="72" y="79" font-family="Consolas, monospace" font-size="17" letter-spacing="3" fill="#ebb434">SPUR PIT · BOUT #${bout.id} · ${escXml(modeTitles[bout.mode] || 'DUEL')}</text>
    <text x="1128" y="79" text-anchor="end" font-family="Consolas, monospace" font-size="16" fill="#df3f32">${escXml(statusLabels[bout.status] || 'BOUT')}</text>

    <text x="72" y="182" font-family="Georgia, serif" font-size="56" fill="#f4ecdc">${escXml(headline)}</text>
    <text x="72" y="232" font-family="Segoe UI, Arial, sans-serif" font-style="italic" font-size="24" fill="#b7aa96">${escXml(callout)}</text>

    <g transform="translate(72 272)">
      <rect width="490" height="208" rx="6" fill="#090807" stroke="#ebb434" stroke-opacity=".4"/>
      <text x="24" y="38" font-family="Consolas, monospace" font-size="14" letter-spacing="2" fill="#ebb434">MAKER CORNER · ${escXml(shortAddr(bout.maker))}</text>
      <text x="24" y="96" font-family="Georgia, serif" font-size="34" fill="#f4ecdc">${escXml(makerSide)}</text>
      <text x="24" y="166" font-family="Consolas, monospace" font-size="28" fill="#ebb434">${escXml(bout.stakeEth)} ETH LOCKED</text>
    </g>

    <text x="600" y="388" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="34" fill="#df3f32">VS</text>

    <g transform="translate(638 272)">
      <rect width="490" height="208" rx="6" fill="#090807" stroke="#df3f32" stroke-opacity=".5"/>
      <text x="24" y="38" font-family="Consolas, monospace" font-size="14" letter-spacing="2" fill="#ff857a">CHALLENGER · ${escXml(bout.status === 0 ? shortAddr(bout.taker) : shortAddr(bout.taker))}</text>
      <text x="24" y="96" font-family="Georgia, serif" font-size="34" fill="#f4ecdc">${escXml(rivalSide)}</text>
      <text x="24" y="166" font-family="Consolas, monospace" font-size="28" fill="#f4ecdc">${escXml(bout.potEth)} ETH TOTAL POT</text>
    </g>

    <text x="72" y="566" font-family="Consolas, monospace" font-size="16" letter-spacing="1.5" fill="#a89c8a">SETTLED DIRECTLY BY PONSV2 ON ROBINHOOD CHAIN · ZERO ORACLES</text>
    <text x="1128" y="566" text-anchor="end" font-family="Consolas, monospace" font-size="17" fill="#ebb434">${escXml(domainLabel || 'SPUR PIT')}</text>
  </svg>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({ ok: true });

    const rpcUrl = env.RH_RPC_URL || DEFAULT_RPC;
    const factory = env.PONS_FACTORY || DEFAULT_FACTORY;

    try {
      if (request.method === 'GET' && url.pathname === '/v1/config') {
        return json({
          chainId: Number(env.CHAIN_ID || 4663),
          rpcUrl,
          ponsFactory: factory,
          pitAddress: env.PIT_ADDRESS || '',
          spurAddress: env.SPUR_ADDRESS || '',
          xHandle: env.X_HANDLE || '',
          siteDomain: env.SITE_DOMAIN || '',
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/tokens') {
        const q = (url.searchParams.get('q') || '').trim();
        if (isAddr(q)) {
          const single = await inspectOnchainToken(rpcUrl, factory, q);
          return json({ tokens: single ? [single] : [] });
        }
        const dir = await fetchPonsDirectory(q);
        return json({ tokens: dir });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/v1/token/')) {
        const tokenAddr = decodeURIComponent(url.pathname.slice('/v1/token/'.length)).trim();
        const holder = (url.searchParams.get('holder') || '').trim();
        if (!isAddr(tokenAddr)) return json({ error: 'Invalid 0x token address' }, 400);
        const info = await inspectOnchainToken(rpcUrl, factory, tokenAddr, holder);
        if (!info) return json({ error: 'Token is not a launched Pons V2 token on Robinhood Chain' }, 404);
        return json(info);
      }

      if (request.method === 'GET' && url.pathname === '/v1/arena') {
        const viewer = (url.searchParams.get('viewer') || '').trim();
        const data = await loadArena(env, viewer);
        return json(data);
      }

      if (request.method === 'POST' && url.pathname === '/v1/callout') {
        const body = await request.json().catch(() => ({}));
        const id = Number(body.id);
        const callout = String(body.callout || '').slice(0, 140);
        const txHash = String(body.txHash || '');
        if (id > 0 && callout) {
          calloutCache.set(id, { callout, txHash });
        }
        return json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/card/')) {
        const raw = url.pathname.slice('/card/'.length).replace(/\.svg$/i, '');
        const id = Number(raw);
        const arena = await loadArena(env);
        const bout = arena.bouts.find((item) => item.id === id);
        if (!bout) return new Response('Bout not found', { status: 404 });
        return new Response(renderBoutCardSvg(bout, env.SITE_DOMAIN || url.host), {
          headers: {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};
