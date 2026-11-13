import { PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { isBlacklisted } from '../token-blacklist.js';
import { isDevBlocked, getBlockedDevs } from '../dev-blocklist.js';
import { isBaseMintOnCooldown, isPoolOnCooldown } from '../pool-memory.js';
import { fetchJson, readRpc } from './rpc.js';
import { TOKEN_PROGRAMS } from './balances.js';
import { analyzePoolWithChronos } from './chronos.js';

const number = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const discovery = 'https://pool-discovery-api.datapi.meteora.ag/pools';
const requestSignal = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
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
export async function checkMintOnChain(mint, signal) {
  signal?.throwIfAborted();
  const result = await readRpc('monitor', c => c.getParsedAccountInfo(new PublicKey(mint), 'confirmed'));
  signal?.throwIfAborted();
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
export async function screenMint(mint, { poolAddress = null, thresholds = config.screening, signal } = {}) {
  signal?.throwIfAborted();
  if (isBlacklisted(mint) || isBaseMintOnCooldown(mint)) return { pass: false, terminal: true, reason: 'Token is blocked or on cooldown' };
  const assets = await fetchJson(`https://datapi.jup.ag/v1/assets/search?query=${mint}`, { signal: requestSignal(signal, 10_000) });
  signal?.throwIfAborted();
  const token = (Array.isArray(assets) ? assets : []).find(t => t.id === mint);
  const reason = rejectToken(token, mint, thresholds);
  if (reason) return { pass: false, reason };
  if (token.dev ? isDevBlocked(token.dev) : Object.keys(getBlockedDevs()).length > 0) return { pass: false, terminal: true, reason: 'Deployer blocked or unavailable' };
  let decimals;
  try { decimals = await checkMintOnChain(mint, signal); }
  catch (error) {
    if (!error.terminal) throw error;
    return { pass: false, terminal: true, reason: error.message };
  }
  let addresses;
  if (poolAddress) addresses = [poolAddress];
  else {
    const pools = await fetchJson(`https://dlmm.datapi.meteora.ag/pools?${new URLSearchParams({ query: mint, page_size: '50', sort_by: 'tvl:desc' })}`, { signal: requestSignal(signal, 10_000) });
    signal?.throwIfAborted();
    if (!Array.isArray(pools.data)) throw new Error('Invalid pool search response');
    addresses = pools.data.filter(p => p.token_x?.address === mint && p.token_y?.address === config.tokens.SOL).map(p => p.address).slice(0, 10);
  }
  const candidates = [], rejected = [];
  for (const address of addresses) {
    if (isPoolOnCooldown(address)) { rejected.push('Pool cooldown'); continue; }
    try {
      signal?.throwIfAborted();
      const p = await poolDetail(address, config.screening.timeframe, { signal: requestSignal(signal, 6_000) });
      signal?.throwIfAborted();
      const minutes = { '5m': 5, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '12h': 720, '24h': 1440 };
      if ((minutes[config.screening.timeframe] || 5) < 30) p.volatility = (await poolDetail(address, '30m', { signal: requestSignal(signal, 6_000) })).volatility;
      if (!(number(p.volatility) > 0)) p.volatility = (await poolDetail(address, '1h', { signal: requestSignal(signal, 6_000) })).volatility;
      const why = rejectPool(p, mint, thresholds);
      if (why) { rejected.push(why); continue; }
      candidates.push(p);
    } catch (e) {
      if (signal?.aborted) throw e;
      rejected.push(e.message);
    }
  }
  candidates.sort((a, b) => b.fee_active_tvl_ratio - a.fee_active_tvl_ratio || b.active_tvl - a.active_tvl || a.pool_address.localeCompare(b.pool_address));
  if (candidates.length > 1) {
    const chronos = await analyzePoolWithChronos(candidates[0].pool_address, {
      signal,
      binStep: candidates[0].dlmm_params?.bin_step ?? 100,
      activePrice: candidates[0].pool_price,
    }).catch(() => null);
    signal?.throwIfAborted();
    const spreadPct = Number(chronos?.tactical_signals?.spread_pct ?? 20);
    const scoreCandidate = p => {
      const base = Number(p.fee_active_tvl_ratio ?? 0);
      const step = Number(p.dlmm_params?.bin_step ?? 100);
      const mult = spreadPct > 35 && step >= 100 ? 1.25 : spreadPct < 18 && step <= 80 ? 1.20 : 1.0;
      return base * mult;
    };
    candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || b.active_tvl - a.active_tvl || a.pool_address.localeCompare(b.pool_address));
  }
  return candidates.length ? { pass: true, pool: candidates[0], token, decimals, fetchedAt: Date.now() } : { pass: false, reason: rejected.slice(0, 3).join('; ') || 'No eligible token/SOL pool' };
}
