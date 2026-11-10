import { PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { isBlacklisted } from '../token-blacklist.js';
import { isDevBlocked, getBlockedDevs } from '../dev-blocklist.js';
import { isBaseMintOnCooldown, isPoolOnCooldown } from '../pool-memory.js';
import { fetchJson, readRpc } from './rpc.js';
import { TOKEN_PROGRAMS } from './balances.js';
import { analyzePoolWithChronos } from './chronos.js';
import { entryCandles, liveNarrowEntryRange } from './entry-plans.js';
import { getActiveBin } from '../tools/dlmm.js';

const number = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const discovery = 'https://pool-discovery-api.datapi.meteora.ag/pools';
export async function poolDetail(address, timeframe = config.screening.timeframe, options) {
  const params = new URLSearchParams({ page_size: '1', filter_by: `pool_address=${address}`, timeframe });
  const result = await fetchJson(`${discovery}?${params}`, options);
  const pool = result.data?.find(p => p.pool_address === address);
  if (!pool) throw new Error('Pool data unavailable');
  return pool;
}
export function rejectToken(token, mint, s, now = Date.now()) {
  if (token?.id !== mint) return 'Token mint mismatch';
  const updated = Date.parse(token.updatedAt);
  if (!Number.isFinite(updated) || now - updated > 240_000 || updated > now + 5000) return 'Token data is stale or has no timestamp';
  const audit = token.audit;
  if (audit?.mintAuthorityDisabled !== true || audit?.freezeAuthorityDisabled !== true) return 'Mint/freeze authority is enabled or unknown';
  for (const [key, limit] of [['topHoldersPercentage', s.maxTop10Pct], ['botHoldersPercentage', s.maxBotHoldersPct]]) {
    const n = number(audit[key]);
    if (n == null || n < 0 || n > limit) return `${key} failed (${n ?? 'unknown'})`;
  }
  if (number(token.fees) == null || token.fees < s.minTokenFeesSol) return 'Token fees below threshold or unknown';
  if (s.allowedLaunchpads.length && !s.allowedLaunchpads.includes(token.launchpad)) return 'Launchpad is not allowed';
  if (s.blockedLaunchpads.includes(token.launchpad)) return 'Launchpad is blocked';
  if (number(token.holderCount) == null || token.holderCount < s.minHolders) return 'Insufficient holders';
  if (number(token.mcap) == null || token.mcap < s.minMcap || token.mcap > s.maxMcap) return 'Market cap outside limits';
  if (number(token.organicScore) == null || token.organicScore < s.minOrganic) return 'Organic activity below threshold';
  const age = (now - Date.parse(token.createdAt)) / 3600_000;
  if ((s.minTokenAgeHours != null || s.maxTokenAgeHours != null) && (!Number.isFinite(age) || age < 0)) return 'Token age unknown';
  if (s.minTokenAgeHours != null && age < s.minTokenAgeHours) return 'Token too young';
  if (s.maxTokenAgeHours != null && age > s.maxTokenAgeHours) return 'Token too old';
  return null;
}
export function rejectPool(p, mint, s) {
  if (p.token_x?.address !== mint || p.token_y?.address !== config.tokens.SOL || p.pool_type !== 'dlmm') return 'Requires an exact-mint DLMM token/SOL pool';
  if (p.is_blacklisted !== false) return 'Pool blacklist status unsafe or unknown';
  if (!Array.isArray(p.token_x.warnings) || !Array.isArray(p.token_y.warnings)) return 'Pool token warnings unavailable';
  if ([...p.token_x.warnings, ...p.token_y.warnings].some(w => ['critical', 'danger', 'warning'].includes(w.severity))) return 'Pool token warning';
  for (const [label, raw, min, max] of [
    ['TVL', p.tvl, s.minTvl, s.maxTvl],
    ['active TVL', p.active_tvl, s.minTvl, null],
    ['volume', p.volume, s.minVolume, null],
    ['fee/active TVL', p.fee_active_tvl_ratio, s.minFeeActiveTvlRatio, null],
    ['bin step', p.dlmm_params?.bin_step, s.minBinStep, s.maxBinStep],
    ['quote organic', p.token_y.organic_score, s.minQuoteOrganic, null],
  ]) {
    const n = number(raw);
    if (n == null || n < min || (max != null && n > max)) return `${label} outside limits or unknown`;
  }
  if (!(number(p.volatility) > 0) || !(number(p.pool_price) > 0)) return 'Volatility or price unavailable';
  return null;
}
export async function checkMintOnChain(mint) {
  const result = await readRpc('monitor', c => c.getParsedAccountInfo(new PublicKey(mint), 'confirmed'));
  const account = result.value;
  const info = account?.data?.parsed?.info;
  if (!account || !info) throw new Error('On-chain mint data unavailable');
  if (!TOKEN_PROGRAMS.includes(account.owner.toString()) || info.mintAuthority !== null || info.freezeAuthority !== null) {
    throw Object.assign(new Error('On-chain mint authority check failed'), { terminal: true });
  }
  const allowed = new Set(['metadataPointer', 'tokenMetadata']);
  if (account.owner.toString() === TOKEN_PROGRAMS[1] && !Array.isArray(info.extensions)) throw new Error('Token-2022 extensions unavailable');
  for (const extension of info.extensions || []) if (!allowed.has(extension.extension)) {
    throw Object.assign(new Error(`Unsupported Token-2022 extension: ${extension.extension}`), { terminal: true });
  }
  return info.decimals;
}
export async function selectNarrowPool(candidates, now, sample = async pool => {
  const [active, candles] = await Promise.all([
    getActiveBin({ pool_address: pool.pool_address }),
    entryCandles(pool.pool_address, now),
  ]);
  return { active, candles };
}) {
  const plans = await Promise.all(candidates.slice(0, 3).map(async pool => {
    try {
      const { active, candles } = await sample(pool);
      const binStep = Number(pool.dlmm_params?.bin_step);
      if (active.binStep !== binStep) return null;
      const width = liveNarrowEntryRange(candles, { now, price: Number(active.price), binStep });
      return width ? { pool, narrowSetup: { width, candles, at: now } } : null;
    } catch { return null; }
  }));
  return plans.find(Boolean) ?? null;
}

export async function screenMint(mint, { poolAddress = null, thresholds = config.screening } = {}) {
  if (isBlacklisted(mint) || isBaseMintOnCooldown(mint)) return { pass: false, terminal: true, reason: 'Token is blocked or on cooldown' };
  const assets = await fetchJson(`https://datapi.jup.ag/v1/assets/search?query=${mint}`);
  const token = (Array.isArray(assets) ? assets : []).find(t => t.id === mint);
  const reason = rejectToken(token, mint, thresholds);
  if (reason) return { pass: false, reason };
  if (token.dev ? isDevBlocked(token.dev) : Object.keys(getBlockedDevs()).length > 0) return { pass: false, terminal: true, reason: 'Deployer blocked or unavailable' };
  let decimals;
  try { decimals = await checkMintOnChain(mint); }
  catch (error) {
    if (!error.terminal) throw error;
    return { pass: false, terminal: true, reason: error.message };
  }
  let addresses;
  const narrow = !config.standalone.shadow && config.strategy.liveNarrowRange;
  if (poolAddress) addresses = [poolAddress];
  else {
    const pools = await fetchJson(`https://dlmm.datapi.meteora.ag/pools?${new URLSearchParams({ query: mint, page_size: '50', sort_by: 'tvl:desc' })}`);
    if (!Array.isArray(pools.data)) throw new Error('Invalid pool search response');
    addresses = pools.data.filter(p => {
      if (p.token_x?.address !== mint || p.token_y?.address !== config.tokens.SOL) return false;
      const step = number(p.bin_step ?? p.dlmm_params?.bin_step);
      return !narrow || step == null || (step >= thresholds.minBinStep && step <= thresholds.maxBinStep);
    }).map(p => p.address).slice(0, 10);
  }
  const candidates = [], rejected = [];
  for (const address of addresses) {
    if (isPoolOnCooldown(address)) { rejected.push('Pool cooldown'); continue; }
    try {
      const p = await poolDetail(address);
      const minutes = { '5m': 5, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '12h': 720, '24h': 1440 };
      if ((minutes[config.screening.timeframe] || 5) < 30) p.volatility = (await poolDetail(address, '30m')).volatility;
      if (!(number(p.volatility) > 0)) p.volatility = (await poolDetail(address, '1h')).volatility;
      const why = rejectPool(p, mint, thresholds);
      if (why) { rejected.push(why); continue; }
      candidates.push(p);
    } catch (e) { rejected.push(e.message); }
  }
  candidates.sort((a, b) => b.fee_active_tvl_ratio - a.fee_active_tvl_ratio || b.active_tvl - a.active_tvl || a.pool_address.localeCompare(b.pool_address));
  if (candidates.length > 1 && !narrow) {
    const chronos = await analyzePoolWithChronos(candidates[0].pool_address, {
      binStep: candidates[0].dlmm_params?.bin_step ?? 100,
      activePrice: candidates[0].pool_price,
    }).catch(() => null);
    const spreadPct = Number(chronos?.tactical_signals?.spread_pct ?? 20);
    const scoreCandidate = p => {
      const base = Number(p.fee_active_tvl_ratio ?? 0);
      const step = Number(p.dlmm_params?.bin_step ?? 100);
      const mult = spreadPct > 35 && step >= 100 ? 1.25 : spreadPct < 18 && step <= 80 ? 1.20 : 1.0;
      return base * mult;
    };
    candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || b.active_tvl - a.active_tvl || a.pool_address.localeCompare(b.pool_address));
  }
  if (narrow && candidates.length) {
    const selected = await selectNarrowPool(candidates, Math.floor(Date.now() / 1000));
    return selected ? { pass: true, ...selected, token, decimals, fetchedAt: Date.now() }
      : { pass: false, reason: 'Range sempit: support, candle, atau bin step tidak memenuhi syarat' };
  }
  return candidates.length ? { pass: true, pool: candidates[0], token, decimals, fetchedAt: Date.now() } : { pass: false, reason: rejected.slice(0, 3).join('; ') || 'No eligible token/SOL pool' };
}
