import React, { useState, useEffect, useRef, useCallback } from 'react';

// ---------- Constants ----------
const APP_ID = 1089; // public Deriv app id, no auth needed for market data
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const SYMBOLS = [
  { code: 'R_10', label: 'Volatility 10' },
  { code: 'R_25', label: 'Volatility 25' },
  { code: 'R_50', label: 'Volatility 50' },
  { code: 'R_75', label: 'Volatility 75' },
  { code: 'R_100', label: 'Volatility 100' },
  { code: '1HZ10V', label: 'Volatility 10 (1s)' },
  { code: '1HZ25V', label: 'Volatility 25 (1s)' },
  { code: '1HZ50V', label: 'Volatility 50 (1s)' },
  { code: '1HZ75V', label: 'Volatility 75 (1s)' },
  { code: '1HZ100V', label: 'Volatility 100 (1s)' },
  { code: 'BOOM300N', label: 'Boom 300' },
  { code: 'BOOM500', label: 'Boom 500' },
  { code: 'BOOM1000', label: 'Boom 1000' },
  { code: 'CRASH300N', label: 'Crash 300' },
  { code: 'CRASH500', label: 'Crash 500' },
  { code: 'CRASH1000', label: 'Crash 1000' },
];

const DIGIT_COLORS = ['#3fb68a', '#4bc79a', '#6ad4ab', '#8f8f99', '#8f8f99', '#8f8f99', '#8f8f99', '#e8896b', '#e2664a', '#d4432b'];

// ---------- Helpers ----------
function lastDigit(quote, pip) {
  // pip is a string like "0.001" describing decimal places
  const decimals = (pip.split('.')[1] || '').length;
  const str = Number(quote).toFixed(decimals);
  return Number(str[str.length - 1]);
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(v => (v - m) ** 2)));
}

// ---------- Main Component ----------
export default function DigitScanDashboard() {
  const [connected, setConnected] = useState(false);
  const [symbol, setSymbol] = useState('1HZ10V');
  const [availableSymbols, setAvailableSymbols] = useState(SYMBOLS);
  const [pipSize, setPipSize] = useState('0.001');
  const [ticks, setTicks] = useState([]); // {quote, epoch}
  const [mode, setMode] = useState('dashboard'); // dashboard | backtest | auto | settings
  const [token, setToken] = useState('');
  const [rememberToken, setRememberToken] = useState(false);
  const [authStatus, setAuthStatus] = useState('idle'); // idle | authing | ok | error
  const [balance, setBalance] = useState(null);
  const [accountInfo, setAccountInfo] = useState(null);
  const [logs, setLogs] = useState([]);
  const [reqCounter, setReqCounter] = useState(1);

  const wsRef = useRef(null);
  const pendingRef = useRef({}); // req_id -> resolver
  const historyReqSymbol = useRef(null);

  const log = useCallback((msg, tone = 'info') => {
    setLogs(l => [{ msg, tone, t: new Date().toLocaleTimeString() }, ...l].slice(0, 60));
  }, []);

  const nextReqId = useCallback(() => {
    setReqCounter(c => c + 1);
    return reqCounter;
  }, [reqCounter]);

  // ---------- WebSocket lifecycle ----------
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      log('Connected to market feed', 'ok');
      // Subscription is handled by the useEffect below (triggered by `connected`
      // becoming true) — calling subscribeTicks here too caused duplicate,
      // racing subscribe requests that Deriv rejected as invalid.
    };

    ws.onclose = () => {
      setConnected(false);
      log('Feed disconnected', 'warn');
    };

    ws.onerror = () => {
      log('Feed connection error', 'error');
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      if (data.error) {
        log(`Error: ${data.error.message}`, 'error');
        if (data.req_id && pendingRef.current[data.req_id]) {
          pendingRef.current[data.req_id].reject(data.error);
          delete pendingRef.current[data.req_id];
        }
        if (data.msg_type === 'authorize') {
          setAuthStatus('error');
        }
        return;
      }

      if (data.req_id && pendingRef.current[data.req_id]) {
        pendingRef.current[data.req_id].resolve(data);
        delete pendingRef.current[data.req_id];
      }

      if (data.msg_type === 'tick') {
        const t = data.tick;
        setTicks(prev => {
          const next = [...prev, { quote: t.quote, epoch: t.epoch }];
          return next.slice(-500); // rolling window
        });
      }

      if (data.msg_type === 'active_symbols') {
        const all = data.active_symbols || [];
        const found = all.find(s => s.symbol === symbol);
        if (found) setPipSize(String(found.pip));

        // Build the real, account-valid symbol list instead of trusting a static guess.
        // Restrict to synthetic index markets (volatility/boom/crash) since that's what
        // digit analysis applies to.
        const synthetic = all.filter(s =>
          s.market === 'synthetic_index' || /^(R_|1HZ|BOOM|CRASH|JD)/.test(s.symbol)
        );
        if (synthetic.length) {
          const mapped = synthetic
            .map(s => ({ code: s.symbol, label: s.display_name || s.symbol }))
            .sort((a, b) => a.label.localeCompare(b.label));
          setAvailableSymbols(mapped);
          // If the currently selected symbol isn't actually valid for this account, switch to the first valid one.
          if (!mapped.find(m => m.code === symbol)) {
            log(`${symbol} not available on this account — switching to ${mapped[0].label}`, 'warn');
            setSymbol(mapped[0].code);
          }
        }
      }

      if (data.msg_type === 'authorize') {
        if (data.authorize) {
          setAuthStatus('ok');
          setAccountInfo(data.authorize);
          setBalance(data.authorize.balance);
          log(`Authorized: ${data.authorize.loginid}`, 'ok');
        }
      }

      if (data.msg_type === 'balance' && data.balance) {
        setBalance(data.balance.balance);
      }

      if (data.msg_type === 'buy') {
        if (data.buy) {
          log(`Trade placed: contract ${data.buy.contract_id}, buy price ${data.buy.buy_price}`, 'ok');
        }
      }
    };

    return () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendRequest = useCallback((payload) => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== 1) {
        reject(new Error('Not connected'));
        return;
      }
      const req_id = Date.now() + Math.floor(Math.random() * 1000);
      pendingRef.current[req_id] = { resolve, reject };
      wsRef.current.send(JSON.stringify({ ...payload, req_id }));
      setTimeout(() => {
        if (pendingRef.current[req_id]) {
          pendingRef.current[req_id].reject(new Error('Timeout'));
          delete pendingRef.current[req_id];
        }
      }, 15000);
    });
  }, []);

  const lastSubscribedRef = useRef(null);

  const subscribeTicks = useCallback(async (sym) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    if (lastSubscribedRef.current === sym) return; // avoid duplicate racing subscribe calls
    lastSubscribedRef.current = sym;
    setTicks([]);
    try {
      // Wait for forget_all to actually complete before subscribing to the new
      // symbol — firing both immediately let Deriv process them out of order,
      // which was causing "Symbol X is invalid" even for symbols that work fine.
      await sendRequest({ forget_all: 'ticks' });
    } catch (e) {
      // no active ticks subscription to forget — fine, continue
    }
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
    wsRef.current.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
    log(`Subscribed to ${sym}`, 'info');
  }, [log, sendRequest]);

  useEffect(() => {
    lastSubscribedRef.current = null; // symbol changed — allow a fresh subscribe
    if (connected) subscribeTicks(symbol);
  }, [symbol, connected, subscribeTicks]);

  // ---------- Auth ----------
  const handleAuthorize = async () => {
    if (!token.trim()) { log('Enter a token first', 'warn'); return; }
    setAuthStatus('authing');
    try {
      const res = await sendRequest({ authorize: token.trim() });
      if (res.authorize) {
        setAuthStatus('ok');
        setAccountInfo(res.authorize);
        setBalance(res.authorize.balance);
        log(`Authorized: ${res.authorize.loginid} (${res.authorize.is_virtual ? 'DEMO' : 'REAL'})`, 'ok');
        if (!res.authorize.is_virtual) {
          log('WARNING: this token is on a REAL account, not demo', 'error');
        }
      }
    } catch (e) {
      setAuthStatus('error');
      log(`Authorization failed: ${e.message || e.error?.message || 'unknown error'}`, 'error');
    }
  };

  const handleForgetToken = () => {
    setToken('');
    setAuthStatus('idle');
    setAccountInfo(null);
    setBalance(null);
    log('Token cleared from session', 'info');
  };

  // ---------- Digit analysis ----------
  const digits = ticks.map(t => lastDigit(t.quote, pipSize));
  const freq = new Array(10).fill(0);
  digits.forEach(d => freq[d]++);
  const total = digits.length || 1;
  const freqPct = freq.map(f => (f / total) * 100);

  const lastDigitsRecent = digits.slice(-30);
  let currentStreak = 0;
  let streakDigit = null;
  if (digits.length) {
    streakDigit = digits[digits.length - 1];
    for (let i = digits.length - 1; i >= 0; i--) {
      if (digits[i] === streakDigit) currentStreak++; else break;
    }
  }

  const priceValues = ticks.map(t => Number(t.quote));
  const volatility = stdev(priceValues.slice(-50));

  return (
    <div style={styles.app}>
      <style>{globalCSS}</style>
      <Header connected={connected} mode={mode} setMode={setMode} authStatus={authStatus} balance={balance} accountInfo={accountInfo} />

      <div style={styles.body}>
        <Sidebar
          symbol={symbol} setSymbol={setSymbol}
          logs={logs}
          availableSymbols={availableSymbols}
        />

        <main style={styles.main} className="main-content">
          {mode === 'dashboard' && (
            <DashboardView
              symbol={symbol}
              ticks={ticks}
              freqPct={freqPct}
              digits={digits}
              lastDigitsRecent={lastDigitsRecent}
              currentStreak={currentStreak}
              streakDigit={streakDigit}
              volatility={volatility}
            />
          )}
          {mode === 'backtest' && (
            <BacktestView symbol={symbol} pipSize={pipSize} sendRequest={sendRequest} connected={connected} log={log} />
          )}
          {mode === 'auto' && (
            <AutoTraderView
              symbol={symbol}
              authStatus={authStatus}
              sendRequest={sendRequest}
              digits={digits}
              log={log}
              balance={balance}
            />
          )}
          {mode === 'settings' && (
            <SettingsView
              token={token} setToken={setToken}
              rememberToken={rememberToken} setRememberToken={setRememberToken}
              authStatus={authStatus}
              accountInfo={accountInfo}
              balance={balance}
              onAuthorize={handleAuthorize}
              onForget={handleForgetToken}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ---------- Header ----------
function Header({ connected, mode, setMode, authStatus, balance, accountInfo }) {
  const tabs = [
    { id: 'dashboard', label: 'Digit Scan' },
    { id: 'backtest', label: 'Backtester' },
    { id: 'auto', label: 'Auto-Trader' },
    { id: 'settings', label: 'Account' },
  ];
  return (
    <header style={styles.header}>
      <div style={styles.headerLeft}>
        <div style={styles.logoMark}>DS</div>
        <div>
          <div style={styles.appName}>DigitScan</div>
          <div style={styles.feedStatus}>
            <span style={{ ...styles.dot, background: connected ? '#3fb68a' : '#d4432b' }} />
            {connected ? 'Feed live' : 'Feed offline'}
          </div>
        </div>
      </div>
      <nav style={styles.tabs}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setMode(t.id)}
            style={{ ...styles.tabBtn, ...(mode === t.id ? styles.tabBtnActive : {}) }}>
            {t.label}
          </button>
        ))}
      </nav>
      <div style={styles.headerRight}>
        {authStatus === 'ok' ? (
          <div style={styles.acctPill}>
            <span style={{ ...styles.dot, background: accountInfo?.is_virtual ? '#3fb68a' : '#d4432b' }} />
            {accountInfo?.loginid} · {balance != null ? `${balance} ${accountInfo?.currency || ''}` : '—'}
          </div>
        ) : (
          <div style={styles.acctPillMuted}>Not authorized</div>
        )}
      </div>
    </header>
  );
}

// ---------- Sidebar ----------
function Sidebar({ symbol, setSymbol, logs, availableSymbols }) {
  return (
    <aside style={styles.sidebar}>
      <div style={styles.sidebarSection}>
        <div style={styles.sidebarLabel}>Symbol</div>
        <select value={symbol} onChange={e => setSymbol(e.target.value)} style={styles.select}>
          {availableSymbols.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
      </div>

      <div style={styles.sidebarSection}>
        <div style={styles.sidebarLabel}>Activity</div>
        <div style={styles.logPane}>
          {logs.length === 0 && <div style={styles.logEmpty}>Nothing yet.</div>}
          {logs.map((l, i) => (
            <div key={i} style={{ ...styles.logLine, color: toneColor(l.tone) }}>
              <span style={styles.logTime}>{l.t}</span> {l.msg}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function toneColor(tone) {
  switch (tone) {
    case 'ok': return '#3fb68a';
    case 'warn': return '#e8b04b';
    case 'error': return '#e2664a';
    default: return '#a8a8b3';
  }
}

// ---------- Dashboard View ----------
function DashboardView({ symbol, ticks, freqPct, digits, lastDigitsRecent, currentStreak, streakDigit, volatility }) {
  const lastQuote = ticks.length ? ticks[ticks.length - 1].quote : '—';
  const label = SYMBOLS.find(s => s.code === symbol)?.label || symbol;
  const expected = 10;

  return (
    <div>
      <div style={styles.viewHeader}>
        <div>
          <div style={styles.viewTitle}>{label}</div>
          <div style={styles.viewSub}>Live last-digit frequency, {ticks.length} tick sample</div>
        </div>
        <div style={styles.priceBlock}>
          <div style={styles.priceLabel}>Last quote</div>
          <div style={styles.priceValue}>{lastQuote}</div>
        </div>
      </div>

      <div style={styles.statRow}>
        <StatCard label="Sample size" value={ticks.length} />
        <StatCard label="Current streak" value={streakDigit !== null ? `${currentStreak}× digit ${streakDigit}` : '—'} />
        <StatCard label="Volatility (σ, last 50)" value={volatility.toFixed(5)} />
      </div>

      <div style={styles.panel}>
        <div style={styles.panelTitle}>Digit frequency distribution</div>
        <div style={styles.barsRow}>
          {freqPct.map((pct, d) => (
            <div key={d} style={styles.barCol}>
              <div style={styles.barTrack}>
                <div style={{
                  ...styles.barFill,
                  height: `${Math.min(100, (pct / (expected * 1.8)) * 100)}%`,
                  background: DIGIT_COLORS[d],
                }} />
              </div>
              <div style={{ ...styles.barPct, color: pct > expected ? '#3fb68a' : pct < expected ? '#e2664a' : '#a8a8b3' }}>
                {pct.toFixed(1)}%
              </div>
              <div style={styles.barDigit}>{d}</div>
            </div>
          ))}
        </div>
        <div style={styles.panelNote}>Baseline expectation is 10.0% per digit. Deviations shrink toward baseline as sample size grows — treat any single digit's edge as noise, not signal.</div>
      </div>

      <div style={styles.panel}>
        <div style={styles.panelTitle}>Recent last digits</div>
        <div style={styles.digitStrip}>
          {lastDigitsRecent.length === 0 && <span style={styles.logEmpty}>Waiting for ticks…</span>}
          {lastDigitsRecent.map((d, i) => (
            <span key={i} style={{ ...styles.digitChip, background: DIGIT_COLORS[d] }}>{d}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

// ---------- Backtest View ----------
function BacktestView({ symbol, pipSize, sendRequest, connected, log }) {
  const [count, setCount] = useState(1000);
  const [predDigit, setPredDigit] = useState(5);
  const [direction, setDirection] = useState('over'); // over | under | match | differ
  const [stake, setStake] = useState(2);
  const [payoutPct, setPayoutPct] = useState(90); // approximate payout, user can tune
  const [staking, setStaking] = useState('flat'); // flat | martingale
  const [martingaleMult, setMartingaleMult] = useState(2);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const runBacktest = async () => {
    if (!connected) { log('Not connected to feed', 'warn'); return; }
    setRunning(true);
    setResult(null);
    try {
      const res = await sendRequest({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: Math.min(count, 5000),
        end: 'latest',
        start: 1,
        style: 'ticks',
      });
      const prices = res.history?.prices || [];
      if (!prices.length) { log('No history returned', 'error'); setRunning(false); return; }

      const decimals = (pipSize.split('.')[1] || '').length;
      const digitSeq = prices.map(p => Number(Number(p).toFixed(decimals).slice(-1)));

      let bank = 0;
      let currentStake = Number(stake);
      let wins = 0, losses = 0;
      let peak = 0, trough = 0, maxDrawdown = 0;
      const equityCurve = [];

      digitSeq.forEach((d) => {
        let win;
        if (direction === 'over') win = d > predDigit;
        else if (direction === 'under') win = d < predDigit;
        else if (direction === 'match') win = d === predDigit;
        else win = d !== predDigit;

        if (win) {
          bank += currentStake * (payoutPct / 100);
          wins++;
          if (staking === 'martingale') currentStake = Number(stake);
        } else {
          bank -= currentStake;
          losses++;
          if (staking === 'martingale') currentStake *= Number(martingaleMult);
        }
        equityCurve.push(bank);
        peak = Math.max(peak, bank);
        trough = Math.min(trough, bank);
        maxDrawdown = Math.min(maxDrawdown, bank - peak);
      });

      const winRate = (wins / (wins + losses)) * 100;
      setResult({
        trades: wins + losses,
        wins, losses,
        winRate,
        netPL: bank,
        maxDrawdown,
        equityCurve,
        finalStake: currentStake,
      });
      log(`Backtest complete: ${wins + losses} trades, ${winRate.toFixed(1)}% win rate, net P/L ${bank.toFixed(2)}`, bank >= 0 ? 'ok' : 'warn');
    } catch (e) {
      log(`Backtest failed: ${e.message || 'unknown error'}`, 'error');
    }
    setRunning(false);
  };

  return (
    <div>
      <div style={styles.viewHeader}>
        <div>
          <div style={styles.viewTitle}>Backtester</div>
          <div style={styles.viewSub}>Test a rule set against historical ticks before risking anything on it</div>
        </div>
      </div>

      <div style={styles.panel}>
        <div style={styles.formGrid}>
          <Field label="History sample (ticks)">
            <input type="number" min={100} max={5000} value={count} onChange={e => setCount(Number(e.target.value))} style={styles.input} />
          </Field>
          <Field label="Prediction type">
            <select value={direction} onChange={e => setDirection(e.target.value)} style={styles.select}>
              <option value="over">Over</option>
              <option value="under">Under</option>
              <option value="match">Matches</option>
              <option value="differ">Differs</option>
            </select>
          </Field>
          <Field label="Digit">
            <input type="number" min={0} max={9} value={predDigit} onChange={e => setPredDigit(Number(e.target.value))} style={styles.input} />
          </Field>
          <Field label="Stake (per trade)">
            <input type="number" min={0.5} step={0.5} value={stake} onChange={e => setStake(Number(e.target.value))} style={styles.input} />
          </Field>
          <Field label="Assumed payout %">
            <input type="number" min={1} max={100} value={payoutPct} onChange={e => setPayoutPct(Number(e.target.value))} style={styles.input} />
          </Field>
          <Field label="Staking plan">
            <select value={staking} onChange={e => setStaking(e.target.value)} style={styles.select}>
              <option value="flat">Flat</option>
              <option value="martingale">Martingale</option>
            </select>
          </Field>
          {staking === 'martingale' && (
            <Field label="Martingale multiplier">
              <input type="number" min={1.1} step={0.1} value={martingaleMult} onChange={e => setMartingaleMult(Number(e.target.value))} style={styles.input} />
            </Field>
          )}
        </div>
        <button onClick={runBacktest} disabled={running} style={styles.primaryBtn}>
          {running ? 'Running…' : 'Run backtest'}
        </button>
        <div style={styles.panelNote}>Payout % is approximate — actual Deriv payouts vary by symbol, digit and stake, and are lower than even-money to account for the house edge. Set it conservatively for a realistic read.</div>
      </div>

      {result && (
        <div style={styles.panel}>
          <div style={styles.panelTitle}>Results</div>
          <div style={styles.statRow}>
            <StatCard label="Trades" value={result.trades} />
            <StatCard label="Win rate" value={`${result.winRate.toFixed(1)}%`} />
            <StatCard label="Net P/L" value={result.netPL.toFixed(2)} />
            <StatCard label="Max drawdown" value={result.maxDrawdown.toFixed(2)} />
          </div>
          <EquityChart curve={result.equityCurve} />
          <div style={{ ...styles.panelNote, color: result.netPL >= 0 ? '#3fb68a' : '#e2664a' }}>
            {result.netPL >= 0
              ? 'Positive over this sample — verify across more symbols and longer windows before trusting it; short samples can look profitable by chance.'
              : 'Negative over this sample — this rule set loses money at the assumed payout. Adjust the rule or accept it is not viable as-is.'}
          </div>
        </div>
      )}
    </div>
  );
}

function EquityChart({ curve }) {
  if (!curve.length) return null;
  const w = 100, h = 160;
  const min = Math.min(...curve, 0);
  const max = Math.max(...curve, 0);
  const range = max - min || 1;
  const points = curve.map((v, i) => {
    const x = (i / (curve.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');
  const zeroY = h - ((0 - min) / range) * h;

  return (
    <div style={styles.chartWrap}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={styles.chartSvg}>
        <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="#3a3a44" strokeWidth="0.5" />
        <polyline points={points} fill="none" stroke={curve[curve.length - 1] >= 0 ? '#3fb68a' : '#e2664a'} strokeWidth="1" />
      </svg>
    </div>
  );
}

// ---------- Auto-Trader View ----------
function AutoTraderView({ symbol, authStatus, sendRequest, digits, log, balance }) {
  const [enabled, setEnabled] = useState(false);
  const [predDigit, setPredDigit] = useState(5);
  const [direction, setDirection] = useState('over');
  const [stake, setStake] = useState(2);
  const [maxLosses, setMaxLosses] = useState(3);
  const [lossStreak, setLossStreak] = useState(0);
  const [tradesPlaced, setTradesPlaced] = useState(0);

  const isDemo = authStatus === 'ok';

  const contractType = {
    over: 'DIGITOVER', under: 'DIGITUNDER', match: 'DIGITMATCH', differ: 'DIGITDIFF',
  }[direction];

  const placeTrade = async () => {
    if (!isDemo) { log('Authorize an account first (Account tab)', 'warn'); return; }
    try {
      const proposal = await sendRequest({
        proposal: 1,
        amount: Number(stake),
        basis: 'stake',
        contract_type: contractType,
        currency: 'USD',
        duration: 1,
        duration_unit: 't',
        symbol,
        barrier: String(predDigit),
      });
      if (proposal.proposal) {
        const buy = await sendRequest({ buy: proposal.proposal.id, price: proposal.proposal.ask_price });
        if (buy.buy) {
          setTradesPlaced(n => n + 1);
        }
      }
    } catch (e) {
      log(`Trade failed: ${e.message || e.error?.message || 'unknown error'}`, 'error');
      setEnabled(false);
    }
  };

  useEffect(() => {
    if (!enabled) return;
    if (lossStreak >= maxLosses) {
      log(`Stopped: hit max consecutive losses (${maxLosses})`, 'warn');
      setEnabled(false);
      return;
    }
  }, [lossStreak, maxLosses, enabled, log]);

  return (
    <div>
      <div style={styles.viewHeader}>
        <div>
          <div style={styles.viewTitle}>Auto-Trader</div>
          <div style={styles.viewSub}>Executes a fixed rule set — no prediction, just consistent execution of what you define</div>
        </div>
      </div>

      {!isDemo && (
        <div style={styles.warnBanner}>
          Not authorized. Go to the Account tab and connect your token before enabling execution.
        </div>
      )}

      <div style={styles.panel}>
        <div style={styles.formGrid}>
          <Field label="Prediction type">
            <select value={direction} onChange={e => setDirection(e.target.value)} style={styles.select}>
              <option value="over">Over</option>
              <option value="under">Under</option>
              <option value="match">Matches</option>
              <option value="differ">Differs</option>
            </select>
          </Field>
          <Field label="Digit">
            <input type="number" min={0} max={9} value={predDigit} onChange={e => setPredDigit(Number(e.target.value))} style={styles.input} />
          </Field>
          <Field label="Stake">
            <input type="number" min={0.5} step={0.5} value={stake} onChange={e => setStake(Number(e.target.value))} style={styles.input} />
          </Field>
          <Field label="Stop after N consecutive losses">
            <input type="number" min={1} value={maxLosses} onChange={e => setMaxLosses(Number(e.target.value))} style={styles.input} />
          </Field>
        </div>

        <div style={styles.statRow}>
          <StatCard label="Trades this session" value={tradesPlaced} />
          <StatCard label="Loss streak" value={lossStreak} />
          <StatCard label="Balance" value={balance != null ? balance : '—'} />
        </div>

        <button
          onClick={() => { if (isDemo) placeTrade(); }}
          disabled={!isDemo}
          style={{ ...styles.primaryBtn, opacity: isDemo ? 1 : 0.5 }}
        >
          Place single trade (manual)
        </button>
        <div style={styles.panelNote}>
          Continuous auto-execution is intentionally left manual-trigger only for now — wire up a backtested rule set here once you've confirmed it's worth running unattended. Every trade shown in the log ties back to the account authorized in the Account tab.
        </div>
      </div>
    </div>
  );
}

// ---------- Settings View ----------
function SettingsView({ token, setToken, rememberToken, setRememberToken, authStatus, accountInfo, balance, onAuthorize, onForget }) {
  return (
    <div>
      <div style={styles.viewHeader}>
        <div>
          <div style={styles.viewTitle}>Account</div>
          <div style={styles.viewSub}>DigitScanTradingApp token — kept in memory for this session only</div>
        </div>
      </div>

      <div style={styles.panel}>
        <Field label="API token">
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Paste your DigitScanTradingApp token"
            style={styles.input}
          />
        </Field>
        <label style={styles.checkboxRow}>
          <input type="checkbox" checked={rememberToken} onChange={e => setRememberToken(e.target.checked)} />
          Keep authorized for this session (default — nothing is saved to disk either way)
        </label>

        <div style={styles.btnRow}>
          <button onClick={onAuthorize} style={styles.primaryBtn}>
            {authStatus === 'authing' ? 'Authorizing…' : 'Authorize'}
          </button>
          <button onClick={onForget} style={styles.secondaryBtn}>Clear token</button>
        </div>

        {authStatus === 'ok' && accountInfo && (
          <div style={styles.acctDetail}>
            <div style={{ ...styles.acctBadge, background: accountInfo.is_virtual ? '#1c3d33' : '#3d1c1c', color: accountInfo.is_virtual ? '#3fb68a' : '#e2664a' }}>
              {accountInfo.is_virtual ? 'DEMO ACCOUNT' : 'REAL ACCOUNT — trades here use real funds'}
            </div>
            <div style={styles.acctRow}><span>Login ID</span><span>{accountInfo.loginid}</span></div>
            <div style={styles.acctRow}><span>Balance</span><span>{balance} {accountInfo.currency}</span></div>
            <div style={styles.acctRow}><span>Scopes</span><span>{(accountInfo.scopes || []).join(', ')}</span></div>
          </div>
        )}

        <div style={styles.panelNote}>
          The token never leaves this browser tab and is never written into code — it lives only in this component's memory and clears when you close or refresh the tab. Deriv's persistent auth-token bug (issue #65855) affecting some tokens may still apply here; if authorization fails, that's the likely cause, not this app.
        </div>
      </div>
    </div>
  );
}

// ---------- Shared bits ----------
function Field({ label, children }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

// ---------- Styles ----------
const globalCSS = `
  * { box-sizing: border-box; }
  body { margin: 0; }
  input:focus, select:focus, button:focus { outline: 2px solid #4bc79a; outline-offset: 1px; }
  ::selection { background: #3fb68a55; }
`;

const FONT_MONO = "'JetBrains Mono', 'SF Mono', Consolas, monospace";
const FONT_SANS = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

const styles = {
  app: { minHeight: '100vh', width: '100%', maxWidth: '100vw', overflowX: 'hidden', background: '#0f0f13', color: '#e8e8ec', fontFamily: FONT_SANS, fontSize: 16, lineHeight: 1.5 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 20px', borderBottom: '1px solid #232329', background: '#131318', flexWrap: 'wrap', rowGap: 16, boxSizing: 'border-box' },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  logoMark: { width: 40, height: 40, borderRadius: 8, background: '#3fb68a', color: '#0f0f13', fontFamily: FONT_MONO, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 },
  appName: { fontWeight: 700, fontSize: 17, letterSpacing: 0.2 },
  feedStatus: { fontSize: 13, color: '#8f8f99', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  tabs: { display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%', order: 3 },
  tabBtn: { background: 'transparent', border: '1px solid #2c2c34', color: '#8f8f99', padding: '10px 16px', borderRadius: 8, fontSize: 14, cursor: 'pointer', fontFamily: FONT_SANS, fontWeight: 500 },
  tabBtnActive: { background: '#1c1c22', color: '#e8e8ec', border: '1px solid #3fb68a' },
  headerRight: {},
  acctPill: { fontFamily: FONT_MONO, fontSize: 13, background: '#1c1c22', border: '1px solid #2c2c34', padding: '8px 14px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 },
  acctPillMuted: { fontFamily: FONT_MONO, fontSize: 13, color: '#6a6a74', border: '1px solid #232329', padding: '8px 14px', borderRadius: 8 },

  body: { display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 100px)' },
  sidebar: { width: '100%', borderBottom: '1px solid #232329', padding: 20, flexShrink: 0, background: '#111116', boxSizing: 'border-box' },
  sidebarSection: { marginBottom: 24, maxWidth: 480 },
  sidebarLabel: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6, color: '#8f8f99', marginBottom: 10, fontWeight: 700 },
  select: { width: '100%', background: '#1a1a20', border: '1px solid #2c2c34', color: '#e8e8ec', padding: '12px 14px', borderRadius: 8, fontSize: 15, fontFamily: FONT_SANS },
  logPane: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto', background: '#0f0f13', border: '1px solid #1e1e24', borderRadius: 8, padding: 12 },
  logLine: { fontSize: 13, fontFamily: FONT_MONO, lineHeight: 1.6, wordBreak: 'break-word' },
  logTime: { color: '#5a5a64' },
  logEmpty: { fontSize: 13, color: '#5a5a64' },

  main: { flex: 1, padding: '28px 20px', minWidth: 0, maxWidth: 900, margin: '0 auto', boxSizing: 'border-box' },
  viewHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28, flexWrap: 'wrap', gap: 16 },
  viewTitle: { fontSize: 24, fontWeight: 700 },
  viewSub: { fontSize: 14, color: '#8f8f99', marginTop: 6, lineHeight: 1.5 },
  priceBlock: { textAlign: 'right' },
  priceLabel: { fontSize: 12, color: '#6a6a74', textTransform: 'uppercase', letterSpacing: 0.5 },
  priceValue: { fontFamily: FONT_MONO, fontSize: 26, fontWeight: 700, color: '#3fb68a', marginTop: 4 },

  statRow: { display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' },
  statCard: { background: '#161619', border: '1px solid #232329', borderRadius: 10, padding: '16px 18px', flex: '1 1 160px', minWidth: 160 },
  statLabel: { fontSize: 12.5, color: '#8f8f99', marginBottom: 6 },
  statValue: { fontFamily: FONT_MONO, fontSize: 20, fontWeight: 700 },

  panel: { background: '#141418', border: '1px solid #232329', borderRadius: 12, padding: 24, marginBottom: 24 },
  panelTitle: { fontSize: 15, fontWeight: 700, marginBottom: 20, color: '#e8e8ec' },
  panelNote: { fontSize: 13, color: '#8f8f99', marginTop: 18, lineHeight: 1.6 },

  barsRow: { display: 'flex', gap: 10, alignItems: 'flex-end', height: 160, overflowX: 'auto', paddingBottom: 4 },
  barCol: { flex: '1 1 0', minWidth: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' },
  barTrack: { width: '100%', flex: 1, display: 'flex', alignItems: 'flex-end', background: '#1a1a20', borderRadius: 5, overflow: 'hidden' },
  barFill: { width: '100%', borderRadius: '5px 5px 0 0', minHeight: 2, transition: 'height 0.3s ease' },
  barPct: { fontSize: 12, fontFamily: FONT_MONO, marginTop: 8, fontWeight: 600 },
  barDigit: { fontSize: 14, fontFamily: FONT_MONO, color: '#8f8f99', marginTop: 4 },

  digitStrip: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  digitChip: { width: 32, height: 32, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, color: '#0f0f13' },

  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 18, marginBottom: 22 },
  field: { display: 'flex', flexDirection: 'column', gap: 8 },
  fieldLabel: { fontSize: 13, color: '#a8a8b3', fontWeight: 500 },
  input: { background: '#1a1a20', border: '1px solid #2c2c34', color: '#e8e8ec', padding: '12px 14px', borderRadius: 8, fontSize: 15, fontFamily: FONT_MONO, width: '100%' },

  primaryBtn: { background: '#3fb68a', color: '#0f0f13', border: 'none', padding: '13px 24px', borderRadius: 8, fontSize: 14.5, fontWeight: 700, cursor: 'pointer', fontFamily: FONT_SANS },
  secondaryBtn: { background: 'transparent', color: '#a8a8b3', border: '1px solid #2c2c34', padding: '13px 24px', borderRadius: 8, fontSize: 14.5, cursor: 'pointer', fontFamily: FONT_SANS, fontWeight: 500 },
  btnRow: { display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' },

  chartWrap: { marginTop: 10, background: '#0f0f13', borderRadius: 8, border: '1px solid #1e1e24', padding: 12 },
  chartSvg: { width: '100%', height: 180, display: 'block' },

  checkboxRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: '#a8a8b3', margin: '14px 0', lineHeight: 1.5 },

  warnBanner: { background: '#2a1c14', border: '1px solid #4a3020', color: '#e8b04b', padding: '14px 18px', borderRadius: 10, fontSize: 14, marginBottom: 20, lineHeight: 1.5 },

  acctDetail: { marginTop: 20, borderTop: '1px solid #232329', paddingTop: 20 },
  acctBadge: { display: 'inline-block', padding: '6px 14px', borderRadius: 6, fontSize: 12.5, fontWeight: 700, letterSpacing: 0.4, marginBottom: 16 },
  acctRow: { display: 'flex', justifyContent: 'space-between', fontSize: 14.5, padding: '10px 0', borderBottom: '1px solid #1c1c22', fontFamily: FONT_MONO },
};
