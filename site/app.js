// SPUR Pit frontend — zero external bundle dependencies, native MetaMask/Rabby EIP-1193 on Robinhood Chain (4663).

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const FEATURE_BURN_WEI = 50000n * 10n ** 18n;

const SEL = {
  openBout: '0x061f03d8',
  matchBout: '0xa2a7ec22',
  cancelBout: '0x4960ac0c',
  settle: '0x8df82800',
  featureBout: '0x2eb4862a',
  stakeSpur: '0x253c3c0e',
  unstakeSpur: '0xb1664007',
  claimEth: '0xb7cdddcb',
  ignite: '0xf768923a',
  approve: '0x095ea7b3',
};

const EMBEDDED_SPUR_CA = '';

const state = {
  wallet: '',
  chainId: 4663,
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  pitAddress: '',
  spurAddress: /^0x[0-9a-fA-F]{40}$/.test(EMBEDDED_SPUR_CA) ? EMBEDDED_SPUR_CA.toLowerCase() : '',
  spurBound: false,
  xHandle: '',
  mode: 0,           // 0=GRADUATION, 1=CURVE_LINE, 2=CLASH, 3=HAND_CHECK
  makerSideA: true,
  filter: 'all',     // all | open | live | ko | mine | settled
  focusBoutId: 0,
  probeA: null,
  probeB: null,
  arena: null,
  ponsTokens: [],
};

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isAddr(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

function shortAddr(a) {
  if (!a || a === ZERO_ADDR) return 'Open Pit';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function toast(msg, bad = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), 4200);
}

function parseUnits18(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error('Enter a valid positive number');
  const [w, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  const v = BigInt(w) * 10n ** 18n + BigInt(frac);
  if (v <= 0n) throw new Error('Amount must be greater than zero');
  return v;
}

function fmtEth(weiStr, decimals = 4) {
  const w = BigInt(weiStr || '0');
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return whole.toString() + (frac ? '.' + frac : '');
}

function fmtSpur(weiStr) {
  const n = Number(BigInt(weiStr || '0') / 10n ** 15n) / 1000;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(n).toLocaleString('en-US');
}

function timeLeft(unixSec) {
  const diff = unixSec - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'expired';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

// ─── ABI Encoding Helpers ─────────────────────────────────────────────────────

function pad32(hexNoPrefix) {
  return hexNoPrefix.padStart(64, '0');
}

function encUint(v) {
  return pad32(BigInt(v).toString(16));
}

function encBool(v) {
  return encUint(v ? 1 : 0);
}

function encAddr(a) {
  const clean = isAddr(a) ? a.trim().toLowerCase().slice(2) : '0'.repeat(40);
  return pad32(clean);
}

function encodeOpenBout(p) {
  // openBout((uint8 mode, bool makerSideA, address tokenA, address tokenB, address opponent, address promoter, uint256 targetValue, uint64 joinWindow, uint64 duration, string callout))
  // Single dynamic tuple argument -> outer head word = 0x20 (32)
  // Inside tuple: 10 fields => 10 * 32 = 320 (0x140) bytes head, followed by callout length + UTF-8 padded to 32 bytes.
  const strBytes = new TextEncoder().encode(p.callout || '');
  if (strBytes.length > 140) throw new Error('Callout max length is 140 UTF-8 bytes');
  let strHex = '';
  for (const b of strBytes) strHex += b.toString(16).padStart(2, '0');
  const paddedLen = Math.ceil(strHex.length / 64) * 64;
  const strBody = strHex.padEnd(paddedLen, '0');

  return (
    SEL.openBout +
    encUint(32) +
    encUint(p.mode) +
    encBool(p.makerSideA) +
    encAddr(p.tokenA) +
    encAddr(p.tokenB) +
    encAddr(p.opponent) +
    encAddr(p.promoter) +
    encUint(p.targetValue) +
    encUint(p.joinWindow) +
    encUint(p.duration) +
    encUint(320) +
    encUint(strBytes.length) +
    strBody
  );
}

// ─── Wallet & Transaction Helpers ─────────────────────────────────────────────

async function rpcCall(method, params) {
  const res = await fetch(state.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

async function connectWallet(silent = false) {
  if (!window.ethereum) {
    if (!silent) toast('Install MetaMask or Rabby to enter the pit', true);
    return '';
  }
  const method = silent ? 'eth_accounts' : 'eth_requestAccounts';
  const accounts = await window.ethereum.request({ method });
  const acct = (accounts?.[0] || '').toLowerCase();
  state.wallet = acct;
  renderWalletButton();
  if (acct && !silent) {
    await ensureChain();
  }
  return acct;
}

async function ensureChain() {
  if (!window.ethereum) throw new Error('No EVM wallet detected in browser');
  const hexId = '0x' + Number(state.chainId).toString(16);
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(current, 16) === Number(state.chainId)) return;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexId }],
    });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId,
        chainName: state.chainId === 4663 ? 'Robinhood Chain' : `Chain ${state.chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [state.rpcUrl],
        blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
      }],
    });
  }
}

async function sendTx({ to, data, valueWei = 0n, label = 'Transaction' }) {
  const from = (await connectWallet(false)) || '';
  if (!from) throw new Error('Connect wallet first');
  await ensureChain();
  const txParams = {
    from,
    to,
    data,
    value: '0x' + BigInt(valueWei).toString(16),
  };
  toast(`${label}: confirm in wallet…`);
  const hash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  });
  toast(`${label} sent — awaiting block…`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const rc = await rpcCall('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) {
      if (rc.status !== '0x1') throw new Error(`${label} reverted on-chain`);
      toast(`${label} confirmed ✓`);
      await refreshArena();
      return hash;
    }
  }
  await refreshArena();
  return hash;
}

function renderWalletButton() {
  const btn = $('btn-connect');
  if (!btn) return;
  btn.textContent = state.wallet ? shortAddr(state.wallet) : 'Connect wallet';
  btn.classList.toggle('ghost-brass', Boolean(state.wallet));
  btn.classList.toggle('brass', !state.wallet);
}

// ─── Mode & Form Builder UI ───────────────────────────────────────────────────

function updateModeUi() {
  document.querySelectorAll('.mode-tab').forEach((el) => {
    el.classList.toggle('on', Number(el.dataset.mode) === state.mode);
  });

  $('field-target-eth').hidden = state.mode !== 1;
  $('field-token-b').hidden = state.mode !== 2;
  $('field-holder').hidden = state.mode !== 3;

  const symA = state.probeA?.symbol ? `$${state.probeA.symbol}` : 'Token A';
  const symB = state.probeB?.symbol ? `$${state.probeB.symbol}` : 'Token B';
  const targetEth = $('in-target-eth').value.trim() || '2.0';

  const sideLabels = {
    0: [`YES · ${symA} Graduates`, `NO · Stays on Curve`],
    1: [`OVER · ≥ ${targetEth} ETH`, `UNDER · < ${targetEth} ETH`],
    2: [`CORNER A · ${symA} Wins`, `CORNER B · ${symB} Wins`],
    3: [`DIAMOND HANDS · Holds 100%`, `PAPER HANDS · Sells Any`],
  }[state.mode];

  const btnA = $('side-a');
  const btnB = $('side-b');
  btnA.textContent = sideLabels[0];
  btnB.textContent = sideLabels[1];
  btnA.className = 'side-btn' + (state.makerSideA ? ' on-a' : '');
  btnB.className = 'side-btn' + (!state.makerSideA ? ' on-b' : '');
}

async function probeTokenInput(which) {
  const inputEl = which === 'A' ? $('in-token-a') : $('in-token-b');
  const boxEl = which === 'A' ? $('probe-a') : $('probe-b');
  const addr = inputEl.value.trim();
  if (!isAddr(addr)) {
    boxEl.hidden = true;
    if (which === 'A') state.probeA = null;
    else state.probeB = null;
    updateModeUi();
    return;
  }
  const holderQ = which === 'A' && state.mode === 3 && isAddr($('in-holder').value)
    ? `?holder=${encodeURIComponent($('in-holder').value.trim())}`
    : '';
  boxEl.hidden = false;
  boxEl.innerHTML = 'Reading Pons V2 bonding curve on Robinhood Chain…';
  try {
    const res = await fetch(`/v1/token/${addr}${holderQ}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Token lookup failed');
    if (which === 'A') state.probeA = data;
    else state.probeB = data;

    const statusTxt = data.graduated
      ? '<span style="color:var(--crimson2)">ALREADY GRADUATED</span>'
      : `Curve reserve: <b style="color:var(--ink)">${esc(data.reserveEth)} / ${esc(data.thresholdEth)} ETH</b> (${data.progressPct}%)`;
    const bagTxt = which === 'A'
      ? `<div style="margin-top:4px;color:var(--faint)">Watched bag (${shortAddr(data.watchedHolder)}): <b style="color:var(--dim)">${esc(data.holderBalanceFormatted)} $${esc(data.symbol)}</b></div>`
      : '';
    boxEl.innerHTML = `
      <div><strong style="color:var(--brass2)">$${esc(data.symbol)}</strong> · ${esc(data.name)} · ${statusTxt}</div>
      ${bagTxt}
      <div class="probe-bar"><div class="probe-fill" style="width:${data.progressPct}%"></div></div>
    `;
    updateModeUi();
  } catch (e) {
    boxEl.innerHTML = `<span style="color:var(--crimson2)">${esc(e.message)}</span>`;
  }
}

// ─── Rendering Bouts & Telemetry ──────────────────────────────────────────────

function describeBout(b) {
  const symA = `$${b.tokenASymbol}`;
  if (b.mode === 0) {
    return {
      modeTag: 'GRADUATION',
      title: `Will ${symA} graduate from Pons curve?`,
      sideA: `YES · ${symA} Graduates`,
      sideB: `NO · Stays on Curve`,
      meter: b.live
        ? (b.live.gradA ? 'GRADUATED (KO READY)' : `Live curve: ${fmtEth(b.live.reserveAWei, 3)} / ${fmtEth(b.tokenAThresholdWei, 2)} ETH`)
        : `Threshold: ${fmtEth(b.tokenAThresholdWei, 2)} ETH`,
    };
  }
  if (b.mode === 1) {
    const line = fmtEth(b.targetValue, 3);
    return {
      modeTag: 'CURVE LINE',
      title: `${symA} curve reserve ≥ ${line} ETH`,
      sideA: `OVER ≥ ${line} ETH`,
      sideB: `UNDER < ${line} ETH`,
      meter: b.live
        ? `Live reserve: ${fmtEth(b.live.reserveAWei, 3)} ETH (line ${line} ETH)`
        : `Target line: ${line} ETH`,
    };
  }
  if (b.mode === 2) {
    const symB = `$${b.tokenBSymbol}`;
    return {
      modeTag: 'TOKEN CLASH',
      title: `${symA} vs ${symB} — higher reserve / first grad`,
      sideA: `${symA} Wins`,
      sideB: `${symB} Wins`,
      meter: b.live
        ? `${symA}: ${fmtEth(b.live.reserveAWei, 3)} ETH vs ${symB}: ${fmtEth(b.live.reserveBWei, 3)} ETH`
        : `${symA} vs ${symB}`,
    };
  }
  const snap = fmtSpur(b.targetValue);
  const cur = b.live ? fmtSpur(b.live.currentHolderWei) : snap;
  return {
    modeTag: 'HAND CHECK',
    title: `Will ${shortAddr(b.tokenB)} hold 100% of ${snap} ${symA}?`,
    sideA: `HOLDS 100%`,
    sideB: `SELLS ANY TOKEN`,
    meter: b.live
      ? `Snapshot: ${snap} ${symA} · Current bag: ${cur} ${symA}`
      : `Snapshot bag: ${snap} ${symA}`,
  };
}

function renderArena() {
  const data = state.arena;
  if (!data) return;

  const s = data.stats;
  $('rail-pit').textContent = data.pitAddress ? shortAddr(data.pitAddress) : 'Awaiting deploy';
  $('rail-vol').textContent = `${fmtEth(s.volumeWei, 3)} ETH`;
  $('rail-burned').textContent = `${fmtSpur(s.burnedSpur)} $SPURPIT`;

  $('st-bouts').textContent = s.boutsCreated.toLocaleString('en-US');
  $('st-vol').textContent = `${fmtEth(s.volumeWei, 3)} ETH`;
  $('st-staked').textContent = `${fmtSpur(s.stakedSpur)} $SPURPIT`;
  $('st-eth-yield').textContent = `${fmtEth((BigInt(s.ringsideEth) + BigInt(s.promoterEth)).toString(), 4)} ETH`;
  $('st-burned').textContent = `${fmtSpur(s.burnedSpur)}`;

  // Contract & Token banner strip
  if (data.spurAddress) {
    $('ca-code').textContent = data.spurAddress;
    $('btn-copy-ca').hidden = false;
    $('link-pons').href = `https://ponsfamily.com/launchpad/${data.spurAddress}`;
    $('link-pons').hidden = false;
  } else {
    $('ca-code').textContent = data.pitAddress
      ? `SpurPit live at ${data.pitAddress} · $SPURPIT CA published at Pons launch`
      : 'SpurPit contract ready — published on Robinhood Chain at launch';
    $('btn-copy-ca').hidden = true;
    $('link-pons').hidden = true;
  }

  // Vault & Furnace numbers
  $('v-total-staked').textContent = `${fmtSpur(s.stakedSpur)} $SPURPIT`;
  $('v-your-staked').textContent = data.viewer ? `${fmtSpur(data.viewer.stakedWei)} $SPURPIT` : '0 $SPURPIT';
  const claimableTotal = data.viewer
    ? BigInt(data.viewer.ringsideEthWei) + BigInt(data.viewer.promoterEthWei)
    : 0n;
  $('v-your-eth').textContent = `${fmtEth(claimableTotal.toString(), 5)} ETH`;
  $('v-bal-hint').textContent = data.viewer
    ? `Wallet: ${fmtSpur(data.viewer.spurBalanceWei)} $SPURPIT`
    : 'Connect wallet';
  $('btn-claim-eth').disabled = claimableTotal === 0n;

  $('f-bucket').textContent = `${fmtEth(s.pendingBurnWei, 5)} ETH`;
  $('f-spent').textContent = `${fmtEth(s.burnedEthWei, 4)} ETH`;
  $('f-burned').textContent = `${fmtSpur(s.burnedSpur)} $SPURPIT`;
  $('btn-ignite').disabled = !data.spurBound || BigInt(s.pendingBurnWei) < 200000000000000n;

  // Filter & sort bouts (featured Main Events float to top among active bouts)
  const nowSec = Math.floor(Date.now() / 1000);
  let list = [...data.bouts];
  if (state.focusBoutId) {
    list = list.filter((b) => b.id === state.focusBoutId);
  } else if (state.filter === 'open') {
    list = list.filter((b) => b.status === 0 && nowSec <= b.joinBy);
  } else if (state.filter === 'live') {
    list = list.filter((b) => b.status === 1);
  } else if (state.filter === 'ko') {
    list = list.filter((b) => b.status === 1 && b.live?.canSettle);
  } else if (state.filter === 'mine') {
    list = list.filter((b) => state.wallet && (b.maker === state.wallet || b.taker === state.wallet));
  } else if (state.filter === 'settled') {
    list = list.filter((b) => b.status >= 2);
  }

  list.sort((a, b) => {
    const aActive = a.status <= 1 ? 1 : 0;
    const bActive = b.status <= 1 ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    if (aActive && b.featured !== a.featured) return b.featured - a.featured;
    return b.id - a.id;
  });

  const box = $('bouts-list');
  if (!data.deployed) {
    box.innerHTML = `<div class="ticket"><div class="ticket-body"><p class="eyebrow brass">PIT STANDING BY</p><h3 style="margin:8px 0">SpurPit contract not configured in worker yet</h3><p style="color:var(--dim);margin:0">Open <code>spur/contracts/deploy.html</code> to deploy on Robinhood Chain (4663), then set <code>PIT_ADDRESS</code>.</p></div></div>`;
    return;
  }

  if (!list.length) {
    box.innerHTML = `
      <div class="ticket">
        <div class="ticket-body">
          <p class="eyebrow brass">${state.focusBoutId ? `BOUT #${state.focusBoutId} NOT FOUND` : 'NO BOUTS IN THIS FILTER'}</p>
          <h3 style="margin:8px 0">${state.focusBoutId ? 'Show all bouts in the pit' : 'Step into the ring and lock the first ETH callout.'}</h3>
          ${state.focusBoutId ? '<button class="btn sm" onclick="location.hash=\'\'">Show all bouts</button>' : '<p style="color:var(--dim);margin:0">Pick any live Pons token on the left, set your ETH stake, and share the challenge link.</p>'}
        </div>
      </div>`;
    return;
  }

  box.innerHTML = list.map((b) => {
    const d = describeBout(b);
    const makerPick = b.makerSideA ? d.sideA : d.sideB;
    const takerPick = b.makerSideA ? d.sideB : d.sideA;
    const makerCls = b.makerSideA ? 'side-a' : 'side-b';
    const takerCls = b.makerSideA ? 'side-b' : 'side-a';

    const joinExpired = b.status === 0 && nowSec > b.joinBy;
    const canSettleNow = b.status === 1 && Boolean(b.live?.canSettle);

    let statusBadge = '<span class="badge settled">SETTLED</span>';
    if (b.status === 0) {
      statusBadge = joinExpired
        ? '<span class="badge settled">UNMATCHED · EXPIRED</span>'
        : `<span class="badge open">OPEN · JOIN IN ${timeLeft(b.joinBy)}</span>`;
    } else if (b.status === 1) {
      statusBadge = canSettleNow
        ? '<span class="badge ko">● KO / READY TO SETTLE</span>'
        : `<span class="badge live">LIVE · BELL IN ${timeLeft(b.resolveAt)}</span>`;
    } else if (b.status === 3) {
      statusBadge = '<span class="badge settled">CANCELLED</span>';
    } else if (b.status === 4) {
      statusBadge = '<span class="badge settled">DRAW · REFUNDED</span>';
    }

    const mainBadge = b.featured > 0
      ? `<span class="badge main-event">★ MAIN EVENT ×${b.featured}</span>`
      : '';

    const actions = [];
    if (b.status === 0 && !joinExpired && !b.live?.canSettle) {
      const isMaker = state.wallet && state.wallet === b.maker;
      const reservedOther = b.taker !== ZERO_ADDR && state.wallet && state.wallet !== b.taker;
      if (!isMaker && !reservedOther) {
        actions.push(`<button class="btn crimson sm" data-act="match" data-id="${b.id}" data-stake="${b.stake}">Match ${esc(b.stakeEth)} ETH</button>`);
      }
      if (isMaker) {
        actions.push(`<button class="btn sm" data-act="cancel" data-id="${b.id}">Cancel &amp; refund</button>`);
      }
    } else if (b.status === 0 && joinExpired) {
      actions.push(`<button class="btn sm" data-act="cancel" data-id="${b.id}">Refund expired stake</button>`);
    }

    if (canSettleNow) {
      actions.push(`<button class="btn brass sm" data-act="settle" data-id="${b.id}">Settle &amp; pay winner</button>`);
    }

    if ((b.status === 0 || b.status === 1) && data.spurBound) {
      actions.push(`<button class="btn ghost-brass sm" data-act="feature" data-id="${b.id}" title="Burn 50,000 $SPURPIT to 0x...dEaD to pin Main Event">★ Burn 50K</button>`);
    }

    actions.push(`<button class="btn sm" data-act="share" data-id="${b.id}">Challenge link / X</button>`);

    const winnerLine = b.status === 2 && b.winner !== ZERO_ADDR
      ? `<span style="color:var(--good)">Winner: ${shortAddr(b.winner)}</span> · `
      : '';

    return `
      <article class="ticket ${b.featured > 0 ? 'featured' : ''}">
        <div class="ticket-top">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <a href="#/bout/${b.id}" style="color:var(--brass)">BOUT #${b.id}</a>
            <span>· ${esc(d.modeTag)}</span>
            ${mainBadge}
          </div>
          <div>${statusBadge}</div>
        </div>
        <div class="ticket-body">
          <div class="ticket-head">
            <div>
              <h3>${esc(d.title)}</h3>
            </div>
            <div class="pot-box">
              <strong>${esc(b.potEth)} ETH</strong>
              <small>${esc(b.stakeEth)} ETH each</small>
            </div>
          </div>
          ${b.callout ? `<p class="callout-quote">“${esc(b.callout)}”</p>` : ''}
          <div class="corners">
            <div class="corner">
              <div class="corner-role"><span>Maker</span><span>${shortAddr(b.maker)}</span></div>
              <div class="corner-pick ${makerCls}">${esc(makerPick)}</div>
            </div>
            <div class="corner-vs">VS</div>
            <div class="corner">
              <div class="corner-role"><span>${b.status === 0 ? 'Rival slot' : 'Challenger'}</span><span>${shortAddr(b.taker)}</span></div>
              <div class="corner-pick ${takerCls}">${esc(takerPick)}</div>
            </div>
          </div>
          <div class="ticket-foot">
            <div class="live-meter">${winnerLine}${esc(d.meter)}</div>
            <div style="display:flex;gap:7px;flex-wrap:wrap">${actions.join('')}</div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// ─── Data Loading & Event Wiring ──────────────────────────────────────────────

async function refreshArena() {
  const q = state.wallet ? `?viewer=${encodeURIComponent(state.wallet)}` : '';
  const res = await fetch(`/v1/arena${q}`);
  if (!res.ok) return;
  const data = await res.json();
  state.arena = data;
  state.chainId = data.chainId || 4663;
  state.pitAddress = data.pitAddress || '';
  state.spurAddress = data.spurAddress || '';
  state.spurBound = Boolean(data.spurBound);
  state.xHandle = data.xHandle || '';
  renderArena();
}

async function loadPonsChips() {
  try {
    const resCfg = await fetch('/v1/config');
    const cfg = await resCfg.json();
    if (cfg.rpcUrl) state.rpcUrl = cfg.rpcUrl;
    if (cfg.chainId) state.chainId = cfg.chainId;
    if (cfg.pitAddress) state.pitAddress = cfg.pitAddress;
    if (cfg.spurAddress) state.spurAddress = cfg.spurAddress;

    const res = await fetch('/v1/tokens');
    const data = await res.json();
    const curveOnly = (data.tokens || []).filter((t) => t.stage !== 'graduated').slice(0, 6);
    state.ponsTokens = curveOnly;
    const chipsBox = $('pons-chips');
    if (curveOnly.length) {
      chipsBox.innerHTML = curveOnly
        .map((t) => `<button type="button" class="chip" data-addr="${esc(t.address)}">$${esc(t.symbol)}</button>`)
        .join('');
    }
  } catch {
    // Chips optional if offline
  }
}

async function ensureSpurAllowance(neededWei) {
  const viewerAllow = BigInt(state.arena?.viewer?.spurAllowanceWei || '0');
  if (viewerAllow >= neededWei) return;
  const data = SEL.approve + encAddr(state.pitAddress) + encUint(MAX_UINT256);
  await sendTx({ to: state.spurAddress, data, label: 'Approve $SPURPIT' });
}

function syncHashFilter() {
  const m = location.hash.match(/^#\/bout\/(\d+)/);
  state.focusBoutId = m ? Number(m[1]) : 0;
  if (state.arena) renderArena();
}

window.addEventListener('DOMContentLoaded', async () => {
  $('btn-connect').onclick = () => connectWallet(false).then(refreshArena).catch((e) => toast(e.message, true));

  document.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.onclick = () => {
      state.mode = Number(btn.dataset.mode);
      updateModeUi();
      if ($('in-token-a').value.trim()) probeTokenInput('A');
    };
  });

  $('side-a').onclick = () => { state.makerSideA = true; updateModeUi(); };
  $('side-b').onclick = () => { state.makerSideA = false; updateModeUi(); };
  $('in-target-eth').oninput = updateModeUi;
  $('in-token-a').onchange = () => probeTokenInput('A');
  $('in-token-b').onchange = () => probeTokenInput('B');
  $('in-holder').onchange = () => probeTokenInput('A');

  $('pons-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('in-token-a').value = chip.dataset.addr;
    probeTokenInput('A');
  };

  document.querySelectorAll('.flt').forEach((btn) => {
    btn.onclick = () => {
      if (location.hash.startsWith('#/bout/')) location.hash = '';
      state.focusBoutId = 0;
      state.filter = btn.dataset.flt;
      document.querySelectorAll('.flt').forEach((b) => b.classList.toggle('on', b === btn));
      renderArena();
    };
  });

  $('btn-copy-ca').onclick = () => {
    if (!state.spurAddress) return;
    navigator.clipboard.writeText(state.spurAddress).then(() => toast('Copied $SPURPIT CA'));
  };

  $('form-open').onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (!state.pitAddress) throw new Error('SpurPit contract is not deployed yet');
      const tokenA = $('in-token-a').value.trim();
      if (!isAddr(tokenA)) throw new Error('Enter a valid 0x Pons token address');

      let tokenB = ZERO_ADDR;
      let targetValue = 0n;
      if (state.mode === 1) {
        targetValue = parseUnits18($('in-target-eth').value);
      } else if (state.mode === 2) {
        tokenB = $('in-token-b').value.trim();
        if (!isAddr(tokenB)) throw new Error('Enter a valid second Pons token address for Clash');
      } else if (state.mode === 3) {
        const h = $('in-holder').value.trim();
        if (h && !isAddr(h)) throw new Error('Watched wallet must be a valid 0x address or empty for deployer');
        tokenB = h || ZERO_ADDR;
      }

      const rival = $('in-opponent').value.trim();
      if (rival && !isAddr(rival)) throw new Error('Named rival must be a valid 0x address or left blank');

      const stakeWei = parseUnits18($('in-stake').value);
      const joinMins = Number($('in-join').value);
      const durHours = Number($('in-duration').value);
      const joinWindow = Math.max(60, Math.round(joinMins * 60));
      const duration = Math.max(joinWindow + 60, Math.round(durHours * 3600));
      const callout = $('in-callout').value.trim();

      const data = encodeOpenBout({
        mode: state.mode,
        makerSideA: state.makerSideA,
        tokenA,
        tokenB,
        opponent: rival || ZERO_ADDR,
        promoter: state.wallet || ZERO_ADDR,
        targetValue,
        joinWindow,
        duration,
        callout,
      });

      const txHash = await sendTx({ to: state.pitAddress, data, valueWei: stakeWei, label: 'Open Bout' });
      const createdId = state.arena?.stats?.boutsCreated || 0;
      if (createdId && callout) {
        fetch('/v1/callout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: createdId, callout, txHash }),
        }).catch(() => {});
      }
      $('in-callout').value = '';
    } catch (err) {
      toast(err.message || String(err), true);
    }
  };

  $('bouts-list').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = Number(btn.dataset.id);
    try {
      if (act === 'match') {
        const stakeWei = BigInt(btn.dataset.stake);
        await sendTx({
          to: state.pitAddress,
          data: SEL.matchBout + encUint(id),
          valueWei: stakeWei,
          label: `Match Bout #${id}`,
        });
      } else if (act === 'cancel') {
        await sendTx({
          to: state.pitAddress,
          data: SEL.cancelBout + encUint(id),
          label: `Cancel Bout #${id}`,
        });
      } else if (act === 'settle') {
        await sendTx({
          to: state.pitAddress,
          data: SEL.settle + encUint(id),
          label: `Settle Bout #${id}`,
        });
      } else if (act === 'feature') {
        await ensureSpurAllowance(FEATURE_BURN_WEI);
        await sendTx({
          to: state.pitAddress,
          data: SEL.featureBout + encUint(id),
          label: `Burn 50K $SPURPIT · Main Event #${id}`,
        });
      } else if (act === 'share') {
        const bout = state.arena?.bouts?.find((x) => x.id === id);
        const link = `${location.origin}/#/bout/${id}`;
        await navigator.clipboard.writeText(link).catch(() => {});
        const d = bout ? describeBout(bout) : { title: `Bout #${id}` };
        const text = `Locked ${bout?.stakeEth || ''} ETH in SPUR Pit Bout #${id}: ${d.title}.\n\nTalk is cheap — match the other corner on Robinhood Chain:\n${link}`;
        window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
        toast(`Bout #${id} challenge link copied`);
      }
    } catch (err) {
      toast(err.message || String(err), true);
    }
  };

  $('btn-stake').onclick = async () => {
    try {
      if (!state.spurBound) throw new Error('$SPURPIT token is bound right at Pons launch');
      const amt = parseUnits18($('in-stake-spur').value);
      await ensureSpurAllowance(amt);
      await sendTx({ to: state.pitAddress, data: SEL.stakeSpur + encUint(amt), label: 'Stake $SPURPIT' });
      $('in-stake-spur').value = '';
    } catch (err) {
      toast(err.message || String(err), true);
    }
  };

  $('btn-unstake').onclick = async () => {
    try {
      const amt = parseUnits18($('in-stake-spur').value);
      await sendTx({ to: state.pitAddress, data: SEL.unstakeSpur + encUint(amt), label: 'Unstake $SPURPIT' });
      $('in-stake-spur').value = '';
    } catch (err) {
      toast(err.message || String(err), true);
    }
  };

  $('btn-claim-eth').onclick = async () => {
    try {
      await sendTx({ to: state.pitAddress, data: SEL.claimEth, label: 'Claim ETH Yield' });
    } catch (err) {
      toast(err.message || String(err), true);
    }
  };

  $('btn-ignite').onclick = async () => {
    try {
      await sendTx({ to: state.pitAddress, data: SEL.ignite, label: 'Ignite $SPURPIT Buyback & Burn' });
    } catch (err) {
      toast(err.message || String(err), true);
    }
  };

  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', (accs) => {
      state.wallet = (accs?.[0] || '').toLowerCase();
      renderWalletButton();
      refreshArena();
    });
  }

  window.addEventListener('hashchange', syncHashFilter);
  updateModeUi();
  syncHashFilter();
  await connectWallet(true);
  await Promise.all([loadPonsChips(), refreshArena()]);
  setInterval(refreshArena, 6500);
});
