import React, { useState, useRef, useCallback } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, ReferenceLine } from "recharts";
import { Play, Loader2, TrendingUp, TrendingDown, AlertTriangle, Activity, Target, Zap, ChevronRight, Info } from "lucide-react";

// ---------- Deriv WebSocket helpers ----------
const APP_ID = 1089; // public demo app_id, works for read-only market data

function connectDeriv() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function requestTicksHistory(ws, symbol, count = 5000) {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1e9);
    const handler = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.req_id !== reqId) return;
      ws.removeEventListener("message", handler);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data);
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: "latest",
      start: 1,
      style: "ticks",
      req_id: reqId,
    }));
  });
}

function requestCandles(ws, symbol, granularity, count = 3000) {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1e9);
    const handler = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.req_id !== reqId) return;
      ws.removeEventListener("message", handler);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data);
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: "latest",
      start: 1,
      style: "candles",
      granularity,
      req_id: reqId,
    }));
  });
}

// ---------- Symbols ----------
const SYMBOLS = [
  { code: "R_10", label: "Volatility 10 Index" },
  { code: "R_25", label: "Volatility 25 Index" },
  { code: "R_50", label: "Volatility 50 Index" },
  { code: "R_75", label: "Volatility 75 Index" },
  { code: "R_100", label: "Volatility 100 Index" },
  { code: "1HZ10V", label: "Volatility 10 (1s) Index" },
  { code: "1HZ25V", label: "Volatility 25 (1s) Index" },
  { code: "1HZ50V", label: "Volatility 50 (1s) Index" },
  { code: "1HZ75V", label: "Volatility 75 (1s) Index" },
  { code: "1HZ100V", label: "Volatility 100 (1s) Index" },
  { code: "BOOM1000", label: "Boom 1000 Index" },
  { code: "CRASH1000", label: "Crash 1000 Index" },
];

// ---------- Indicators ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev == null) { prev = values[i]; out[i] = prev; continue; }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      gains += gain; losses += loss;
      if (i === period) {
        const avgG = gains / period, avgL = losses / period;
        const rs = avgL === 0 ? 100 : avgG / avgL;
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
      const rs = losses === 0 ? 100 : gains / losses;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function lastDigit(price, pipSize = 2) {
  const str = price.toFixed(pipSize);
  return parseInt(str[str.length - 1], 10);
}

// ---------- Strategy: Rise/Fall EMA+RSI trend ----------
function backtestRiseFall(candles, params) {
  const { emaFast, emaSlow, rsiPeriod, rsiUpper, rsiLower, stake, payout, duration } = params;
  const closes = candles.map((c) => c.close);
  const fastArr = ema(closes, emaFast);
  const slowArr = ema(closes, emaSlow);
  const rsiArr = rsi(closes, rsiPeriod);

  const trades = [];
  let equity = 0;
  const equityCurve = [{ i: 0, equity: 0 }];

  for (let i = Math.max(emaSlow, rsiPeriod) + 1; i < closes.length - duration; i++) {
    const fPrev = fastArr[i - 1], sPrev = slowArr[i - 1];
    const fNow = fastArr[i], sNow = slowArr[i];
    const rsiNow = rsiArr[i];
    if ([fPrev, sPrev, fNow, sNow, rsiNow].some((v) => v == null)) continue;

    let direction = null;
    if (fPrev <= sPrev && fNow > sNow && rsiNow < rsiUpper) direction = "RISE";
    else if (fPrev >= sPrev && fNow < sNow && rsiNow > rsiLower) direction = "FALL";
    if (!direction) continue;

    const entryPrice = closes[i];
    const exitPrice = closes[i + duration];
    const won = direction === "RISE" ? exitPrice > entryPrice : exitPrice < entryPrice;
    const pnl = won ? stake * (payout - 1) : -stake;
    equity += pnl;
    trades.push({ i, direction, entryPrice, exitPrice, won, pnl });
    equityCurve.push({ i: trades.length, equity: Number(equity.toFixed(2)) });
  }
  return summarize(trades, equityCurve, stake);
}

// ---------- Strategy: Over/Under digit-frequency deviation ----------
function backtestOverUnder(ticks, params) {
  const { lookback, deviationThreshold, barrier, mode, stake, payout, pipSize } = params;
  const digits = ticks.map((t) => lastDigit(t.quote ?? t.price, pipSize));
  const trades = [];
  let equity = 0;
  const equityCurve = [{ i: 0, equity: 0 }];
  const expected = 1 / 10;

  for (let i = lookback; i < digits.length - 1; i++) {
    const window = digits.slice(i - lookback, i);
    const freq = new Array(10).fill(0);
    window.forEach((d) => freq[d]++);
    const rates = freq.map((c) => c / lookback);

    // Over X: bet digit > barrier stays under-represented -> trade OVER if digits <=barrier are over-represented (mean reversion)
    const underCount = rates.slice(0, barrier + 1).reduce((a, b) => a + b, 0);
    const overCount = rates.slice(barrier + 1).reduce((a, b) => a + b, 0);
    const expectedUnder = (barrier + 1) / 10;
    const deviation = underCount - expectedUnder;

    let direction = null;
    if (mode === "meanReversion") {
      if (deviation > deviationThreshold) direction = "OVER"; // under-digits overrepresented -> bet reverts to over
      else if (-deviation > deviationThreshold) direction = "UNDER";
    } else {
      // momentum: bet with the recent bias continuing
      if (deviation > deviationThreshold) direction = "UNDER";
      else if (-deviation > deviationThreshold) direction = "OVER";
    }
    if (!direction) continue;

    const nextDigit = digits[i];
    const won = direction === "OVER" ? nextDigit > barrier : nextDigit <= barrier;
    const pnl = won ? stake * (payout - 1) : -stake;
    equity += pnl;
    trades.push({ i, direction, nextDigit, won, pnl });
    equityCurve.push({ i: trades.length, equity: Number(equity.toFixed(2)) });
  }
  return summarize(trades, equityCurve, stake);
}

function summarize(trades, equityCurve, stake) {
  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const avgPnl = trades.length ? totalPnl / trades.length : 0;
  let peak = 0, maxDD = 0;
  equityCurve.forEach((p) => {
    peak = Math.max(peak, p.equity);
    maxDD = Math.min(maxDD, p.equity - peak);
  });
  const grossWin = trades.filter(t => t.won).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => !t.won).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return { trades, equityCurve, wins, losses, winRate, totalPnl, avgPnl, maxDD, profitFactor, stakeTotal: trades.length * stake };
}

// ---------- UI ----------
const INK = "#12131a";
const PAPER = "#f6f4ee";
const ACCENT = "#2f6f5e"; // deep ledger green
const ACCENT2 = "#b5482f"; // rust for losses/warnings
const LINE = "#d9d4c6";

function Stat({ label, value, sub, tone }) {
  const color = tone === "up" ? ACCENT : tone === "down" ? ACCENT2 : INK;
  return (
    <div style={{ borderLeft: `2px solid ${LINE}`, paddingLeft: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8a8574", fontFamily: "'JetBrains Mono', monospace" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color, fontFamily: "'Fraunces', serif", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#8a8574", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function DerivBacktester() {
  const [symbol, setSymbol] = useState("R_75");
  const [product, setProduct] = useState("riseFall");
  const [status, setStatus] = useState("idle"); // idle | connecting | fetching | running | done | error
  const [errorMsg, setErrorMsg] = useState("");
  const [result, setResult] = useState(null);
  const [dataInfo, setDataInfo] = useState(null);
  const wsRef = useRef(null);

  // Rise/Fall params
  const [rfParams, setRfParams] = useState({ emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiUpper: 70, rsiLower: 30, stake: 10, payout: 1.85, duration: 5, granularity: 60 });
  // Over/Under params
  const [ouParams, setOuParams] = useState({ lookback: 50, deviationThreshold: 0.06, barrier: 4, mode: "meanReversion", stake: 10, payout: 1.9, pipSize: 2, count: 5000 });

  const run = useCallback(async () => {
    setStatus("connecting");
    setErrorMsg("");
    setResult(null);
    try {
      const ws = await connectDeriv();
      wsRef.current = ws;
      setStatus("fetching");

      if (product === "riseFall") {
        const resp = await requestCandles(ws, symbol, rfParams.granularity, 3000);
        const candles = resp.candles.map((c) => ({ open: +c.open, high: +c.high, low: +c.low, close: +c.close, epoch: c.epoch }));
        setDataInfo({ count: candles.length, kind: "candles", granularity: rfParams.granularity });
        setStatus("running");
        await new Promise((r) => setTimeout(r, 50));
        const res = backtestRiseFall(candles, rfParams);
        setResult({ product: "riseFall", ...res });
      } else {
        const resp = await requestTicksHistory(ws, symbol, ouParams.count);
        const times = resp.history.times;
        const prices = resp.history.prices;
        const ticks = prices.map((p, idx) => ({ quote: +p, epoch: times[idx] }));
        setDataInfo({ count: ticks.length, kind: "ticks" });
        setStatus("running");
        await new Promise((r) => setTimeout(r, 50));
        const res = backtestOverUnder(ticks, ouParams);
        setResult({ product: "overUnder", ...res });
      }
      setStatus("done");
      ws.close();
    } catch (e) {
      setErrorMsg(e.message || String(e));
      setStatus("error");
    }
  }, [symbol, product, rfParams, ouParams]);

  const isBusy = status === "connecting" || status === "fetching" || status === "running";

  return (
    <div style={{ minHeight: "100vh", background: PAPER, color: INK, fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        input[type=number], select { font-family: 'JetBrains Mono', monospace; }
        ::selection { background: ${ACCENT}; color: white; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${LINE}`, padding: "24px 32px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.15em", color: ACCENT, textTransform: "uppercase" }}>Strategy Ledger</div>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 700, margin: "4px 0 0" }}>Deriv Backtester</h1>
          </div>
          <div style={{ fontSize: 13, color: "#8a8574", maxWidth: 360, textAlign: "right" }}>
            Rules-based strategy testing against real historical data. No forward guarantees — this measures edge, not luck.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 0, minHeight: "calc(100vh - 89px)" }}>
        {/* Control panel */}
        <div style={{ borderRight: `1px solid ${LINE}`, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <label style={labelStyle}>Market</label>
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={selectStyle}>
              {SYMBOLS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Product / Strategy</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setProduct("riseFall")} style={tabStyle(product === "riseFall")}>Rise / Fall</button>
              <button onClick={() => setProduct("overUnder")} style={tabStyle(product === "overUnder")}>Over / Under</button>
            </div>
          </div>

          {product === "riseFall" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="EMA Fast" value={rfParams.emaFast} onChange={(v) => setRfParams({ ...rfParams, emaFast: v })} />
              <Field label="EMA Slow" value={rfParams.emaSlow} onChange={(v) => setRfParams({ ...rfParams, emaSlow: v })} />
              <Field label="RSI Period" value={rfParams.rsiPeriod} onChange={(v) => setRfParams({ ...rfParams, rsiPeriod: v })} />
              <Field label="RSI Upper (skip Rise above)" value={rfParams.rsiUpper} onChange={(v) => setRfParams({ ...rfParams, rsiUpper: v })} />
              <Field label="RSI Lower (skip Fall below)" value={rfParams.rsiLower} onChange={(v) => setRfParams({ ...rfParams, rsiLower: v })} />
              <Field label="Candle Granularity (sec)" value={rfParams.granularity} onChange={(v) => setRfParams({ ...rfParams, granularity: v })} />
              <Field label="Hold Duration (candles)" value={rfParams.duration} onChange={(v) => setRfParams({ ...rfParams, duration: v })} />
              <Field label="Stake" value={rfParams.stake} onChange={(v) => setRfParams({ ...rfParams, stake: v })} step={1} />
              <Field label="Payout multiple" value={rfParams.payout} onChange={(v) => setRfParams({ ...rfParams, payout: v })} step={0.01} />
            </div>
          )}

          {product === "overUnder" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={labelStyle}>Mode</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setOuParams({ ...ouParams, mode: "meanReversion" })} style={tabStyle(ouParams.mode === "meanReversion")}>Mean Reversion</button>
                  <button onClick={() => setOuParams({ ...ouParams, mode: "momentum" })} style={tabStyle(ouParams.mode === "momentum")}>Momentum</button>
                </div>
              </div>
              <Field label="Lookback window (ticks)" value={ouParams.lookback} onChange={(v) => setOuParams({ ...ouParams, lookback: v })} />
              <Field label="Deviation threshold" value={ouParams.deviationThreshold} onChange={(v) => setOuParams({ ...ouParams, deviationThreshold: v })} step={0.01} />
              <Field label="Barrier digit (0-8)" value={ouParams.barrier} onChange={(v) => setOuParams({ ...ouParams, barrier: v })} />
              <Field label="Tick sample size" value={ouParams.count} onChange={(v) => setOuParams({ ...ouParams, count: v })} step={500} />
              <Field label="Stake" value={ouParams.stake} onChange={(v) => setOuParams({ ...ouParams, stake: v })} step={1} />
              <Field label="Payout multiple" value={ouParams.payout} onChange={(v) => setOuParams({ ...ouParams, payout: v })} step={0.01} />
            </div>
          )}

          <button onClick={run} disabled={isBusy} style={runButtonStyle(isBusy)}>
            {isBusy ? <Loader2 size={16} className="spin" style={{ animation: "spin 1s linear infinite" }} /> : <Play size={16} />}
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            {status === "connecting" && "Connecting to Deriv…"}
            {status === "fetching" && "Fetching historical data…"}
            {status === "running" && "Running backtest…"}
            {(status === "idle" || status === "done" || status === "error") && "Run Backtest"}
          </button>

          <div style={{ fontSize: 12, color: "#8a8574", display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.5 }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>Pulls public historical data directly from Deriv's WebSocket API — no account token needed for backtesting.</span>
          </div>

          {status === "error" && (
            <div style={{ background: "#fbeae6", border: `1px solid ${ACCENT2}`, borderRadius: 4, padding: 12, fontSize: 13, color: ACCENT2, display: "flex", gap: 8 }}>
              <AlertTriangle size={16} style={{ flexShrink: 0 }} />
              {errorMsg}
            </div>
          )}
        </div>

        {/* Results */}
        <div style={{ padding: 32 }}>
          {!result && status !== "error" && (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#b3ac97", gap: 12, paddingTop: 100 }}>
              <Activity size={40} strokeWidth={1} />
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18 }}>Configure a strategy and run a backtest</div>
              <div style={{ fontSize: 13, maxWidth: 320, textAlign: "center" }}>Results — win rate, expectancy, drawdown, equity curve — will render here against real historical ticks.</div>
            </div>
          )}

          {result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
              <div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.1em", color: "#8a8574", textTransform: "uppercase", marginBottom: 4 }}>
                  {SYMBOLS.find(s => s.code === symbol)?.label} · {product === "riseFall" ? "Rise/Fall EMA+RSI Trend" : `Over/Under ${ouParams.mode === "meanReversion" ? "Mean Reversion" : "Momentum"}`}
                </div>
                {dataInfo && <div style={{ fontSize: 13, color: "#8a8574" }}>{dataInfo.count.toLocaleString()} {dataInfo.kind} analyzed{dataInfo.granularity ? ` · ${dataInfo.granularity}s candles` : ""}</div>}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 20 }}>
                <Stat label="Trades" value={result.trades.length} />
                <Stat label="Win Rate" value={`${result.winRate.toFixed(1)}%`} tone={result.winRate >= 50 ? "up" : "down"} />
                <Stat label="Net P&L" value={`$${result.totalPnl.toFixed(2)}`} tone={result.totalPnl >= 0 ? "up" : "down"} />
                <Stat label="Profit Factor" value={result.profitFactor === Infinity ? "∞" : result.profitFactor.toFixed(2)} tone={result.profitFactor >= 1 ? "up" : "down"} />
                <Stat label="Max Drawdown" value={`$${result.maxDD.toFixed(2)}`} tone="down" />
                <Stat label="Avg P&L / Trade" value={`$${result.avgPnl.toFixed(2)}`} tone={result.avgPnl >= 0 ? "up" : "down"} />
              </div>

              <div>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8a8574", fontFamily: "'JetBrains Mono', monospace", marginBottom: 8 }}>Equity Curve</div>
                <div style={{ background: "white", border: `1px solid ${LINE}`, borderRadius: 6, padding: "16px 8px" }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={result.equityCurve}>
                      <defs>
                        <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={result.totalPnl >= 0 ? ACCENT : ACCENT2} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={result.totalPnl >= 0 ? ACCENT : ACCENT2} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 4" stroke={LINE} />
                      <XAxis dataKey="i" tick={{ fontSize: 11, fill: "#8a8574" }} axisLine={{ stroke: LINE }} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "#8a8574" }} axisLine={{ stroke: LINE }} tickLine={false} width={60} />
                      <Tooltip contentStyle={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, border: `1px solid ${LINE}`, borderRadius: 4 }} />
                      <ReferenceLine y={0} stroke={LINE} />
                      <Area type="monotone" dataKey="equity" stroke={result.totalPnl >= 0 ? ACCENT : ACCENT2} fill="url(#eq)" strokeWidth={1.5} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div style={{ background: result.totalPnl >= 0 ? "#eef4ec" : "#fbeae6", border: `1px solid ${result.totalPnl >= 0 ? ACCENT : ACCENT2}`, borderRadius: 6, padding: 16, fontSize: 13, lineHeight: 1.6 }}>
                <strong style={{ fontFamily: "'Fraunces', serif", fontSize: 15 }}>Reading this result</strong>
                <p style={{ margin: "8px 0 0" }}>
                  A profit factor above 1.0 means the strategy made more on wins than it lost on losses over this sample — but on {result.trades.length} trades, this could still be within the range of chance. Deriv's synthetic indices have a built-in house edge (typically reflected in the payout multiple below 1/probability), so a strategy needs a real, persistent statistical edge — not just a lucky window — to be viable long-term. Re-run across different symbols, time windows, and parameter values before trusting any single result.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, step = 1 }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={inputStyle}
      />
    </div>
  );
}

const labelStyle = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#8a8574",
  marginBottom: 6,
  fontFamily: "'JetBrains Mono', monospace",
};

const inputStyle = {
  width: "100%",
  padding: "8px 10px",
  border: `1px solid ${LINE}`,
  borderRadius: 4,
  fontSize: 13,
  background: "white",
  color: INK,
  boxSizing: "border-box",
};

const selectStyle = { ...inputStyle, fontFamily: "'JetBrains Mono', monospace" };

function tabStyle(active) {
  return {
    flex: 1,
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 600,
    border: `1px solid ${active ? ACCENT : LINE}`,
    background: active ? ACCENT : "white",
    color: active ? "white" : INK,
    borderRadius: 4,
    cursor: "pointer",
  };
}

function runButtonStyle(busy) {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "12px 16px",
    background: busy ? "#8a8574" : INK,
    color: "white",
    border: "none",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? "default" : "pointer",
    letterSpacing: "0.02em",
  };
}
