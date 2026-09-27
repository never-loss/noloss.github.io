# Bybit chart stuck on BNB — analysis 2026-09-27 (PT)

## Paths that should change chart symbol
1. `#bybitSymbolSelect` change → `switchSymbol(value)` ✓
2. Radar row click → `switchSymbol(sym)` (same path) ✓
3. Search Enter → `switchSymbol(pick.value)` ✓
4. Search filter → `filterSymbols` only re-renders select (sticky); must NOT mutate `state.symbol` ✓
5. Strategy change → `onStrategyChange` must NOT reload chart/WS ✓
6. Arm/disarm → arm pins `sessionSymbol`; STOP clears pin

## Root causes found
1. **Poll race (primary for “stuck on old pair”)**: `startPollFeed` tick has no `feedGen` / symbol guard. An in-flight BNB poll can overwrite `chartCandles` after switch to ETH/SOL.
2. **Armed/paused lock**: `switchSymbol` early-returns while `state.running` (including PAUSED). Select snaps back via `syncSymbolSelectToState` — feels “stuck on BNB” if that was the armed pair. Idle arm-failure path also left `sessionSymbol`/`armState` set.
3. **Empty paint didn’t clear series**: `paintChartFromState([])` hid overlay but left previous candles drawn until new `setData`.
4. No `chartSymbol` ownership stamp — late ticks could merge into the wrong series.

## Not the cause
- API `/api/bybit-klines` has no BNB hardcode (validates `*USDT`).
- `renderBybitSymbolSelect` sticky no longer assigns `state.symbol` (prior BTC fix still intact).
- WS path already checks `feedGen` + topic + `state.symbol !== sym`.

## Fix plan
- Guard poll ticks with feedGen + captured symbol/interval; ignore stale responses.
- Intentional switch while armed/paused → `stopSession()` then load new pair (chart always follows select).
- Clear series on empty paint; stamp `chartSymbol`; ignore WS/poll updates for other symbols.
- Clear `sessionSymbol`/`armState` on arm failure.
- Tests: arbitrary symbols, series clear, WS topic = state.symbol, poll guard, no hardcoded BNB/BTC in switch path.
