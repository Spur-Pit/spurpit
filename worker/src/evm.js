// Zero-dependency EVM JSON-RPC batch client & ABI decoder for SpurPit + PonsV2LaunchFactory.

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export const DEAD_ADDR = '0x000000000000000000000000000000000000dEaD';

export const SEL = {
  pitStats: '0xfc8a655e',
  spur: '0x1272dc25',
  spurCurve: '0x4daec3c4',
  deployer: '0xd5f39488',
  getBout: '0x604e053b',
  getBouts: '0xeedbd907',
  previewOutcome: '0x8eb90ab7',
  earnedEth: '0x1970bc15',
  staked: '0x98807d84',
  getLaunchedToken: '0x3cf28b5a',
  realQuoteReserve: '0x4f1f58fd',
  graduated: '0xe7c2b772',
  graduationThreshold: '0x8b0bc501',
  symbol: '0x95d89b41',
  name: '0x06fdde03',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  boutOpenedTopic: '0xff502b5313d0611ad654bb58c1872c715d3827085c38dfcd14bf60aa390b2471',
};

export function isAddr(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function normAddr(v) {
  return isAddr(v) ? v.toLowerCase() : ZERO_ADDR;
}

export function padAddr(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

export function padUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

export function wordAt(hex, idx) {
  const clean = (hex || '').replace(/^0x/, '');
  const slice = clean.slice(idx * 64, (idx + 1) * 64);
  return slice.length === 64 ? slice : '';
}

export function uintAt(hex, idx) {
  const w = wordAt(hex, idx);
  return w ? BigInt('0x' + w) : 0n;
}

export function addrAt(hex, idx) {
  const w = wordAt(hex, idx);
  return w ? '0x' + w.slice(24).toLowerCase() : ZERO_ADDR;
}

export function boolAt(hex, idx) {
  return uintAt(hex, idx) !== 0n;
}

export function decodeAbiString(hex, offsetBytes = null) {
  if (!hex || hex === '0x') return '';
  const clean = hex.replace(/^0x/, '');
  if (clean.length === 64) {
    // bytes32 fallback
    const bytes = [];
    for (let i = 0; i < 64; i += 2) {
      const b = parseInt(clean.slice(i, i + 2), 16);
      if (!b) break;
      bytes.push(b);
    }
    return new TextDecoder().decode(new Uint8Array(bytes)).trim();
  }
  const dynOffset = offsetBytes !== null ? offsetBytes : Number(uintAt(clean, 0));
  const lenWordIdx = Math.floor(dynOffset / 32);
  const byteLen = Number(uintAt(clean, lenWordIdx));
  if (!Number.isFinite(byteLen) || byteLen <= 0 || byteLen > 1024) return '';
  const startChar = (lenWordIdx + 1) * 64;
  const dataHex = clean.slice(startChar, startChar + byteLen * 2);
  const bytes = new Uint8Array(dataHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export async function rpcBatch(rpcUrl, calls) {
  if (!calls.length) return [];
  const payload = calls.map((c, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: c.method,
    params: c.params,
  }));
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  const list = Array.isArray(json) ? json : [json];
  const byId = new Map(list.map((item) => [item.id, item]));
  return calls.map((_, i) => {
    const item = byId.get(i + 1);
    return item && !item.error ? item.result : null;
  });
}

export async function ethCallBatch(rpcUrl, items) {
  return rpcBatch(
    rpcUrl,
    items.map(({ to, data }) => ({
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    })),
  );
}

export function decodeLaunchedToken(hex) {
  if (!hex || hex === '0x' || hex.length < 2 + 64 * 15) return { exists: false };
  return {
    token: addrAt(hex, 0),
    curve: addrAt(hex, 1),
    deployer: addrAt(hex, 2),
    creatorFeeRecipient: addrAt(hex, 3),
    pairToken: addrAt(hex, 4),
    graduationThreshold: uintAt(hex, 5).toString(),
    poolFee: Number(uintAt(hex, 6)),
    phase: Number(uintAt(hex, 10)),
    sweptQuote: uintAt(hex, 11).toString(),
    exists: boolAt(hex, 14),
  };
}

export function decodeBoutTuple(cleanWords, baseWord) {
  // Bout struct has 14 static 32-byte words starting at baseWord
  return {
    maker: addrAt(cleanWords, baseWord + 0),
    taker: addrAt(cleanWords, baseWord + 1),
    promoter: addrAt(cleanWords, baseWord + 2),
    tokenA: addrAt(cleanWords, baseWord + 3),
    tokenB: addrAt(cleanWords, baseWord + 4),
    curveA: addrAt(cleanWords, baseWord + 5),
    curveB: addrAt(cleanWords, baseWord + 6),
    stake: uintAt(cleanWords, baseWord + 7).toString(),
    targetValue: uintAt(cleanWords, baseWord + 8).toString(),
    joinBy: Number(uintAt(cleanWords, baseWord + 9)),
    resolveAt: Number(uintAt(cleanWords, baseWord + 10)),
    mode: Number(uintAt(cleanWords, baseWord + 11)),
    makerSideA: boolAt(cleanWords, baseWord + 12),
    status: Number(uintAt(cleanWords, baseWord + 13)),
    winner: addrAt(cleanWords, baseWord + 14),
    featured: Number(uintAt(cleanWords, baseWord + 15)),
  };
}

export function decodeBoutsArray(hex) {
  if (!hex || hex === '0x') return [];
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 128) return [];
  const arrOffsetWords = Number(uintAt(clean, 0)) / 32;
  const count = Number(uintAt(clean, arrOffsetWords));
  const out = [];
  let cursor = arrOffsetWords + 1;
  for (let i = 0; i < count; i++) {
    if ((cursor + 16) * 64 > clean.length) break;
    out.push(decodeBoutTuple(clean, cursor));
    cursor += 16;
  }
  return out;
}

export function fmtEthShort(weiStr, maxDecimals = 4) {
  const w = BigInt(weiStr || '0');
  const neg = w < 0n;
  const v = neg ? -w : w;
  const whole = v / 1000000000000000000n;
  const frac = (v % 1000000000000000000n).toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

export function fmtTokenCompact(weiStr) {
  const n = Number(BigInt(weiStr || '0') / 1000000000000000n) / 1000;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(n).toLocaleString('en-US');
}
