import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { rpcBalances, priceBalances } from "../standalone/balances.js";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

export async function quoteTokenToSol(mint, rawAmount, { expectedOutput = false } = {}) {
  const params = new URLSearchParams({ inputMint: mint, outputMint: config.tokens.SOL, amount: String(rawAmount) });
  const response = await fetch(`${JUPITER_SWAP_V2_API}/order?${params}`, {
    headers: { 'x-api-key': getJupiterApiKey() }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw Error(`Jupiter quote HTTP ${response.status}`);
  const quote = await response.json();
  const expected = Number(quote.outAmount);
  const minimum = Number(quote.otherAmountThreshold);
  if (quote.inputMint !== mint || quote.outputMint !== config.tokens.SOL ||
      quote.inAmount !== String(rawAmount) || !(minimum > 0 && minimum <= expected) ||
      !Number.isSafeInteger(minimum) || !Number.isSafeInteger(expected)) throw Error('No valid token/SOL exit quote');
  return (expectedOutput ? expected : minimum) / LAMPORTS_PER_SOL;
}

export const SETTLEMENT_SLIPPAGE_BPS = 100;

export function meetsSettlementMinimum(order, inputMint, outputMint, amount, minimumOut) {
  const expected = Number(order.outAmount);
  const threshold = Number(order.otherAmountThreshold);
  if (order.inputMint !== inputMint || order.outputMint !== outputMint || order.inAmount !== amount ||
      !Number.isSafeInteger(expected) || !Number.isSafeInteger(threshold) || threshold <= 0 || threshold > expected) return false;
  const floor = Math.floor(expected * (10_000 - SETTLEMENT_SLIPPAGE_BPS) / 10_000);
  return threshold >= Math.max(floor, Math.floor(minimumOut * LAMPORTS_PER_SOL + 1e-6));
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/** Standard RPC balances; native SOL and wrapped SOL remain separate. */
export async function getWalletBalances(options = {}) {
  try {
    const walletAddress = config.standalone.walletAddress || getWallet().publicKey.toString();
    const raw = await rpcBalances(walletAddress, options);
    return options.nativeOnly ? raw : await priceBalances(raw, options);
  } catch (error) {
    return { wallet: null, sol: null, sol_price: null, sol_usd: null, usdc: null, tokens: [], total_usd: null, error: error.message };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  raw_amount,
  beforeExecute,
  minimumOut,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = typeof beforeExecute === "function" && raw_amount != null
      ? raw_amount : Math.floor(amount * Math.pow(10, decimals)).toString();
    if (!/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n) throw new Error("Invalid swap amount");

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    if (minimumOut != null) search.set("slippageBps", String(SETTLEMENT_SLIPPAGE_BPS));
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }
    if (minimumOut != null && !meetsSettlementMinimum(order, input_mint, output_mint, amountStr, minimumOut)) {
      throw Error("Executable swap order does not meet quoted minimum");
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");
    const signature = tx.signatures[0]?.some(Boolean) ? bs58.encode(tx.signatures[0]) : null;
    const lastValidBlockHeight = Number(order.lastValidBlockHeight);
    if (beforeExecute) {
      const simulation = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
      if (simulation.value.err) throw Error("Settlement swap simulation rejected");
      await beforeExecute(signature, Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0 ? lastValidBlockHeight : null);
    }

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
