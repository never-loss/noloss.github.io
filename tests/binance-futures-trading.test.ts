import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import {
  signBinanceQuery,
  signBinanceQueryEd25519,
  buildSignedQuery,
  buildPlaceMarketOrder,
  buildCancelOrder,
  quantityFromFixedStake,
  normalizeTradingMode,
  keysConfigured,
  resolveAuthMode,
  resolveSignMaterial,
  normalizePem,
  looksLikePem,
  DEFAULT_TRADING_MODE,
  BINANCE_ENV_KEY_NAMES,
} from "../src/core/binance-futures-trading.ts";
import { MAX_SESSION_MS, MIN_STAKE } from "../src/core/paper.ts";

test("DEFAULT_TRADING_MODE é PAPER", () => {
  assert.equal(DEFAULT_TRADING_MODE, "PAPER");
  assert.equal(normalizeTradingMode("REAL"), "REAL");
  assert.equal(normalizeTradingMode("real"), "REAL");
  assert.equal(normalizeTradingMode("PAPER"), "PAPER");
  assert.equal(normalizeTradingMode(undefined), "PAPER");
  assert.equal(normalizeTradingMode(""), "PAPER");
});

test("signBinanceQuery HMAC-SHA256 estável", () => {
  // Vector: secret=secret, payload=symbol=BTCUSDT&side=BUY&timestamp=1
  const sig = signBinanceQuery("symbol=BTCUSDT&side=BUY&timestamp=1", "secret");
  assert.equal(sig.length, 64);
  assert.match(sig, /^[a-f0-9]+$/);
  assert.equal(signBinanceQuery("symbol=BTCUSDT&side=BUY&timestamp=1", "secret"), sig);
});

test("buildSignedQuery acrescenta timestamp e signature (HMAC)", () => {
  const q = buildSignedQuery({ symbol: "BTCUSDT", side: "BUY" }, "secret", 1_700_000_000_000);
  assert.ok(q.includes("symbol=BTCUSDT"));
  assert.ok(q.includes("side=BUY"));
  assert.ok(q.includes("timestamp=1700000000000"));
  assert.ok(q.includes("&signature="));
  const sig = q.split("&signature=")[1]!;
  assert.equal(sig.length, 64);
  assert.match(sig, /^[a-f0-9]+$/);
});

test("Ed25519: normalizePem e looksLikePem", () => {
  const escaped =
    "-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIJ+\\n-----END PRIVATE KEY-----\\n";
  const norm = normalizePem(escaped);
  assert.ok(norm.includes("\n"));
  assert.ok(!norm.includes("\\n"));
  assert.equal(looksLikePem(escaped), true);
  assert.equal(looksLikePem("hmac-secret-not-pem"), false);
  assert.equal(looksLikePem(""), false);
  assert.equal(looksLikePem(undefined), false);
});

test("Ed25519: assina payload conhecido e verifica com chave pública", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = "symbol=BTCUSDT&side=BUY&timestamp=1700000000000";
  const sigB64 = signBinanceQueryEd25519(payload, pem);
  assert.ok(sigB64.length > 40);
  assert.match(sigB64, /^[A-Za-z0-9+/=]+$/);
  const ok = verify(
    null,
    Buffer.from(payload, "utf8"),
    createPublicKey(pubPem),
    Buffer.from(sigB64, "base64"),
  );
  assert.equal(ok, true);
  // PEM com \\n escapes (como no Vercel env)
  const escaped = pem.replace(/\n/g, "\\n");
  const sig2 = signBinanceQueryEd25519(payload, escaped);
  assert.equal(sig2, sigB64);
});

test("buildSignedQuery Ed25519: signature base64 URL-encoded", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const q = buildSignedQuery(
    { symbol: "ETHUSDT", side: "SELL" },
    { mode: "ed25519", privateKeyPem: pem },
    1_700_000_000_000,
  );
  assert.ok(q.includes("symbol=ETHUSDT"));
  assert.ok(q.includes("&signature="));
  const encoded = q.split("&signature=")[1]!;
  // Pode conter %2B %2F %3D se a base64 tiver +/= 
  const decoded = decodeURIComponent(encoded);
  assert.match(decoded, /^[A-Za-z0-9+/=]+$/);
  assert.notEqual(decoded.length, 64); // não é hex HMAC
});

test("buildSignedQuery auto-deteta PEM na string", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const q = buildSignedQuery({ symbol: "BTCUSDT" }, pem, 1000);
  const sig = decodeURIComponent(q.split("&signature=")[1]!);
  assert.match(sig, /^[A-Za-z0-9+/=]+$/);
  assert.ok(sig.length > 40);
});

test("buildPlaceMarketOrder: PAPER / gate / sessão bloqueiam", () => {
  const base = {
    symbol: "BTCUSDT",
    side: "BUY" as const,
    quantity: 0.001,
    evidenceAllowed: true,
    mode: "PAPER" as const,
    sessionElapsedMs: 0,
  };
  const paper = buildPlaceMarketOrder(base, "secret");
  assert.equal(paper.ok, false);
  if (!paper.ok) assert.equal(paper.code, "paper_mode");

  const gated = buildPlaceMarketOrder({ ...base, mode: "REAL", evidenceAllowed: false }, "secret");
  assert.equal(gated.ok, false);
  if (!gated.ok) assert.equal(gated.code, "evidence_gate");

  const long = buildPlaceMarketOrder(
    { ...base, mode: "REAL", sessionElapsedMs: MAX_SESSION_MS },
    "secret",
  );
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.code, "max_session");
});

test("buildPlaceMarketOrder: REAL + gate monta POST assinado", () => {
  const built = buildPlaceMarketOrder(
    {
      symbol: "ETHUSDT",
      side: "SELL",
      quantity: 0.01,
      evidenceAllowed: true,
      mode: "REAL",
      sessionElapsedMs: 60_000,
    },
    "secret",
    1_700_000_000_000,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.method, "POST");
  assert.equal(built.path, "/fapi/v1/order");
  assert.ok(built.query.includes("symbol=ETHUSDT"));
  assert.ok(built.query.includes("side=SELL"));
  assert.ok(built.query.includes("type=MARKET"));
  assert.ok(built.query.includes("signature="));
});

test("buildPlaceMarketOrder REAL com Ed25519", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const built = buildPlaceMarketOrder(
    {
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 0.001,
      evidenceAllowed: true,
      mode: "REAL",
      sessionElapsedMs: 0,
    },
    { mode: "ed25519", privateKeyPem: pem },
    1_700_000_000_000,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const sig = decodeURIComponent(built.query.split("&signature=")[1]!);
  assert.match(sig, /^[A-Za-z0-9+/=]+$/);
});

test("buildCancelOrder exige REAL e id", () => {
  const paper = buildCancelOrder({ symbol: "BTCUSDT", orderId: 1, mode: "PAPER" }, "secret");
  assert.equal(paper.ok, false);
  const missing = buildCancelOrder({ symbol: "BTCUSDT", mode: "REAL" }, "secret");
  assert.equal(missing.ok, false);
  const ok = buildCancelOrder({ symbol: "BTCUSDT", orderId: 42, mode: "REAL" }, "secret", 1000);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.method, "DELETE");
    assert.ok(ok.query.includes("orderId=42"));
  }
});

test("quantityFromFixedStake sem martingale", () => {
  assert.equal(quantityFromFixedStake(10, 100), 0.1);
  assert.equal(quantityFromFixedStake(10, 100, 0.01), 0.1);
  assert.equal(quantityFromFixedStake(10, 100, 0.03), 0.09);
  assert.throws(() => quantityFromFixedStake(MIN_STAKE - 0.1, 100), RangeError);
  assert.throws(() => quantityFromFixedStake(1, 0), RangeError);
});

test("keysConfigured / resolveAuthMode / env names", () => {
  assert.equal(BINANCE_ENV_KEY_NAMES.apiKey, "BINANCE_API_KEY");
  assert.equal(BINANCE_ENV_KEY_NAMES.apiSecret, "BINANCE_API_SECRET");
  assert.equal(BINANCE_ENV_KEY_NAMES.apiPrivateKey, "BINANCE_API_PRIVATE_KEY");
  assert.equal(keysConfigured({}), false);
  assert.equal(resolveAuthMode({}), "none");
  assert.equal(keysConfigured({ BINANCE_API_KEY: "short", BINANCE_API_SECRET: "short" }), false);
  assert.equal(
    keysConfigured({
      BINANCE_API_KEY: "abcdefghij",
      BINANCE_API_SECRET: "klmnopqrst",
    }),
    true,
  );
  assert.equal(
    resolveAuthMode({
      BINANCE_API_KEY: "abcdefghij",
      BINANCE_API_SECRET: "klmnopqrst",
    }),
    "hmac",
  );

  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.equal(
    resolveAuthMode({
      BINANCE_API_KEY: "abcdefghij",
      BINANCE_API_PRIVATE_KEY: pem,
    }),
    "ed25519",
  );
  assert.equal(
    keysConfigured({
      BINANCE_API_KEY: "abcdefghij",
      BINANCE_API_PRIVATE_KEY: pem,
    }),
    true,
  );
  // PRIVATE_KEY tem prioridade sobre SECRET
  assert.equal(
    resolveAuthMode({
      BINANCE_API_KEY: "abcdefghij",
      BINANCE_API_PRIVATE_KEY: pem,
      BINANCE_API_SECRET: "klmnopqrstuvwxyz",
    }),
    "ed25519",
  );
  // Secret que parece PEM → ed25519
  assert.equal(
    resolveAuthMode({
      BINANCE_API_KEY: "abcdefghij",
      BINANCE_API_SECRET: pem,
    }),
    "ed25519",
  );
  const mat = resolveSignMaterial({
    BINANCE_API_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
  });
  assert.ok(mat);
  assert.equal(mat!.mode, "ed25519");
});
