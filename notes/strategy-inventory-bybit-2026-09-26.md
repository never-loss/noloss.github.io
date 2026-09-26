# Strategy inventory — NEVER LOSS → Bybit Linear USDT futures
Date: 2026-09-26 (Africa/Luanda)  
Scope: every candle strategy in `src/core`. Digit/tick rules (`gate.ts` / `lanes.ts` / `backtest.ts`) are **Deriv-only** and must **not** drive Bybit futures.

## Shared execution model (all candle strategies)

| Stage | Rule |
| --- | --- |
| **Signal** | On **closed** candle `i` only (`strategies.ts`). Never looks ahead. |
| **Entry** | Open of candle `i+1` (`candle-backtest.ts` / `candle-paper.ts`). |
| **Stop** | `sl = entry − dir × slAtr × ATR(signal bar)` |
| **Target (TP)** | `tp = entry + dir × tpR × dist` — this is the **exit** target, not the entry “alvo”. |
| **Time exit** | After `maxBars` if SL/TP not hit. |
| **Costs** | `costFraction` of entry price, charged in R. Crypto profile: `0.001` (`markets.ts`). |
| **Stake** | Fixed (1R = stake). **No martingale / no stake doubling.** |
| **Evidence gate** | `evaluateCandleGate` → walk-forward OOS (`candle-gate.ts`). PLAY/REAL only if `allowed`. |
| **Controller** | `CandleGateController.asStrategy()` emits signals **only while gate is open** (needs confirmations). |
| **Feasible filter** | `feasible()` drops signals whose stop fraction > `maxStopFraction` (Deriv multiplier heritage). Bybit UI uses `minMultiplier=100` → 1% max stop. Keeps stops executable; may mute high-ATR alts. |

### What “alvo” / entry target means in the co-pilot

- **Entry target** = conditions that produce `Signal` ±1 on the live (forming + closed) series for the active strategy set — measured by `evaluateLiveEntry` / indicator proximity (`strategy-live.ts`).
- **Exit target** = TP at `tpR × ATR-stop` after entry (gate preset hints).
- Gate **PORTA ABERTA** ≠ auto entry. Armed PLAY waits for **gate open AND** strategy signal (via `asStrategy()`).

---

## Primitive factories (`src/core/strategies.ts`)

| Factory | Entry long (+1) | Entry short (−1) | Exit (via backtest/paper) | Bybit linear USDT? |
| --- | --- | --- | --- | --- |
| `emaCross({fast,slow})` | Fast EMA crosses **above** slow | Fast crosses **below** slow | SL/TP/time | **Yes** — trend following |
| `rsiReversion({period,low,high})` | RSI rises back **≥ low** from below | RSI falls back **≤ high** from above | SL/TP/time | **Yes** — mean reversion; noisier on 1m |
| `macdCross({fast,slow,signal})` | MACD line crosses above signal | Crosses below | SL/TP/time | **Yes** |
| `bollingerReversion({period,k})` | Close re-enters from **below** lower band | Re-enters from **above** upper | SL/TP/time | **Yes** — chop-friendly |
| `bollingerBreakout({period,k})` | Close breaks **above** upper | Breaks **below** lower | SL/TP/time | **Yes** — momentum |
| `stochasticCross({k,d,low,high})` | %K crosses above %D from zone `< low` | Crosses down from `> high` | SL/TP/time | **Yes** |
| `adxTrend({period,minAdx})` | +DI crosses above −DI **and** ADX ≥ min | −DI crosses above +DI with ADX | SL/TP/time | **Yes** — filters weak trend |
| `dailyTrendAtrBreakout({lookback,atrPeriod,atrMult,minAdx?})` | Close > lookback high + `atrMult×ATR` (+ optional ADX) | Close < lookback low − pad | SL/TP/time | **Yes** — crypto-oriented; good on 5m–1h |
| `confluence({strategies,minAgree,hold})` | ≥ minAgree children agree long in last `hold` bars, none short | Symmetric for short | SL/TP/time | **Yes** — more selective |

None guarantee profit. All remain subject to the evidence gate.

---

## Named instances inside `strategyLibrary()` (20)

### Trend (10)

1. `ema-cruza 9/21`  
2. `ema-cruza 12/26`  
3. `ema-cruza 20/50`  
4. `macd-cruza 12/26/9`  
5. `macd-cruza 8/17/9`  
6. `adx-tendencia 14 min20`  
7. `adx-tendencia 14 min25`  
8. `bollinger-rompe 20 k2`  
9. `tendência-diária breakout-ATR 24×0.5 adx20`  
10. `tendência-diária breakout-ATR 48×0.75 adx25`  

### Reversion (6)

11. `rsi-reversao 14 30/70`  
12. `rsi-reversao 14 25/75`  
13. `rsi-reversao 7 20/80`  
14. `bollinger-reversao 20 k2`  
15. `bollinger-reversao 20 k2.5`  
16. `estocastico 14/3 20/80`  

### Confluence (4)

17. EMA12/26 + ADX14≥25 (`minAgree=2`, `hold=3`)  
18. MACD12/26/9 + ADX14≥20  
19. RSI14 30/70 + Bollinger reversion 20/2  
20. Stoch 14/3 20/80 + RSI14 30/70  

**Bybit verdict:** entire library is candle-based → **safe to evaluate** on linear USDT perpetuals. Gate chooses the winner OOS; UI must not invent a parallel risk model.

---

## Presets (`STRATEGY_PRESETS`)

| Preset id | Label | Strategies (count) | Gate hints | Bybit co-pilot role |
| --- | --- | --- | --- | --- |
| `lucro_rapido` | Lucro rápido | 7 — EMA 9/21, 12/26; MACD 8/17/9; BB breakout 20/2; RSI7 20/80; Stoch 14/3; ATR breakout 24×0.5 adx20 | `tpR=1.5`, `maxBars=12`, `slAtr=1.2`, `minLabel=PRELIMINARY` | Dual live card + arm target; more frequent signals |
| `loss_zero` | Loss zero | 7 — 4 confluences + ADX min25 + ATR 48×0.75 adx25 + ATR 24×1.0 | `tpR=2`, `maxBars=24`, `slAtr=1.5`, `minLabel=EVIDENCE` | Dual live card; stricter evidence; **aspirational name — NOT zero-loss** |
| `tendencia_diaria` | Tendência diária / breakout-ATR | 3 ATR breakouts (24×0.5 adx20, 48×0.75 adx25, 24×1.0) | `tpR=2`, `maxBars=24`, `slAtr=1.5`, `PRELIMINARY` | Optional select; good on futures swings |
| `biblioteca` | Biblioteca completa | All 20 from `strategyLibrary()` | same as tendência | Heavier gate CPU — throttle hard on UI |

---

## Gate coupling (must reuse — do not fork)

```
candles → strategiesForPreset(id) → [feasible(...)] → evaluateCandleGate / CandleGateController
                                                    → allowed? reason, strategy, oosTrades, meanR, pValue
PLAY arm → CandlePaperSession({ strategy: controller.asStrategy(), slAtr, tpR, maxBars, stake fixa })
         → on closed candle: signal only if gate open; entry next open; REAL mirrors via /api/bybit-order
```

- `GATE_ALPHA = 0.01`  
- Loss zero requires label `EVIDENCE`; Lucro rápido accepts `PRELIMINARY` or `EVIDENCE`  
- Honest `NO TRADE` reasons from `formatCandleGate`  

---

## NOT for Bybit futures path

| Module | Why |
| --- | --- |
| `gate.ts` / `lanes.ts` / digit `backtest.ts` rules | Tick last-digit parity/dominant/absent — Deriv options |
| `paper.ts` digit session | Digits |
| Spot / inverse / options Bybit | Out of product scope — **linear USDT perpetuals only** |

---

## Performance constraints for UI wiring

| Work | Must |
| --- | --- |
| Full `evaluateCandleGate` (~3500 candles × N strategies × walk-forward) | Off hot path: idle/queue, throttle ≥1–2s, **never** per-WS-tick on all 764 symbols |
| Live proximity (`evaluateLiveEntry`) | Cheap enough for selected symbol @ 1–2s; radar uses **short** kline windows + batch concurrency limit |
| Radar | Rotating batches; show `scanned/total`; cancel on symbol change; `requestIdleCallback` / async chunks so chart WS stays smooth |
| Chart WS | Update series immediately; defer gate/proximity to scheduled jobs |

---

## Integration checklist (post-inventory)

1. Dual cards Lucro rápido + Loss zero: live proximity + last gate result (not fake bars).  
2. Radar: all `/api/bybit-symbols` linear USDT perps; rank by live proximity per preset; honest coverage.  
3. PLAY = **ARMADO** — entry only when gate open + strategy signal; PAUSE/STOP disarm.  
4. Futures-only Portuguese copy.  
5. Deriv OAuth files untouched.  
