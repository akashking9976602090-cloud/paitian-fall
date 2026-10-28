/**
 * App.jsx — Patient Fall Detection Dashboard
 *
 * This is the complete single-page React application. It:
 *  - Polls the ESP32 at /api/data every 500 ms via useFallMonitor hook.
 *  - Shows live acceleration, gyroscope, tilt, and magnitude readings.
 *  - Renders a rolling acceleration graph using Recharts.
 *  - Displays a prominent alert banner when a possible fall is detected.
 *  - Shows deduplicated alert history.
 *  - Sends a reset command to the ESP32 when the user clicks "Acknowledge".
 *  - Handles offline / sensor error states gracefully.
 *  - Never fabricates sensor data.
 */

import { useMemo } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, Wifi, WifiOff,
  RotateCcw, Clock, Shield, Zap, TrendingUp, Radio,
  ChevronDown, Loader2, AlertCircle, ThumbsUp
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer
} from 'recharts';
import { useFallMonitor } from './useFallMonitor.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a JS Date to "HH:MM:SS" */
function formatTime(date) {
  if (!date) return '--:--:--';
  return date.toLocaleTimeString('en-US', { hour12: false });
}

/** Convert uptimeMs to human-readable "Xh Ym Zs" */
function formatUptime(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Round a float to N decimal places as a string */
function fmt(val, decimals = 3) {
  return (typeof val === 'number' ? val : 0).toFixed(decimals);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Header bar */
function Header({ connected, loading }) {
  const badgeClass = loading ? 'loading' : connected ? 'online' : 'offline';
  const badgeText  = loading ? 'Connecting…' : connected ? 'Device Online' : 'Device Offline';

  return (
    <header className="header">
      <div className="header-inner">
        <div className="header-brand">
          <div className="header-brand-icon">
            <Activity size={20} color="#fff" />
          </div>
          <div>
            <div className="header-title">Patient Fall Detection System</div>
            <div className="header-subtitle">Educational IoT Prototype · ESP32 + MPU6050</div>
          </div>
        </div>
        <div className="header-right">
          <div className={`conn-badge ${badgeClass}`}>
            <span className="conn-dot" />
            {loading
              ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
              : connected
                ? <Wifi size={12} />
                : <WifiOff size={12} />
            }
            {badgeText}
          </div>
        </div>
      </div>
    </header>
  );
}

/** Sensor-error warning bar */
function SensorErrorBar() {
  return (
    <div className="sensor-error-bar">
      <AlertCircle size={16} />
      <span>
        <strong>MPU6050 not detected.</strong> Check the I2C wiring (SDA→GPIO21, SCL→GPIO22)
        and confirm the sensor address is 0x68. Restart the ESP32 after fixing wiring.
      </span>
    </div>
  );
}

/** Offline / cannot reach ESP32 state */
function OfflineCard({ error }) {
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="offline-overlay">
        <div className="offline-icon">
          <WifiOff size={28} color="var(--clr-red-400)" />
        </div>
        <div className="offline-title">Cannot reach ESP32</div>
        <div className="offline-body">
          {error
            ? `Error: ${error}`
            : 'The dashboard cannot connect to the ESP32 access point.'}
        </div>
        <ul className="offline-steps">
          <li>Connect your phone or PC to the Wi-Fi network called <strong>FallMonitor</strong> (password: <code>fallmon8</code>)</li>
          <li>Make sure the ESP32 is powered on (green LED should blink at startup)</li>
          <li>Check the USB cable and power supply</li>
          <li>Confirm Serial Monitor shows <em>"System ready"</em> at 115200 baud</li>
          <li>If running React on a separate PC, ensure both are on the same network</li>
        </ul>
      </div>
    </div>
  );
}

/** Latched fall alert banner */
function AlertBanner({ alertActive, alertTimestamp, fallState, onReset }) {
  if (!alertActive && fallState !== 'IMPACT_DETECTED') return null;

  if (fallState === 'IMPACT_DETECTED') {
    return (
      <div className="alert-banner" style={{
        borderColor: 'rgba(251,191,36,0.4)',
        background: 'linear-gradient(135deg,rgba(251,191,36,0.1),rgba(251,191,36,0.04))'
      }}>
        <div className="alert-banner-left">
          <div className="alert-icon-ring" style={{ borderColor: 'rgba(251,191,36,0.5)', background: 'rgba(251,191,36,0.1)' }}>
            <Zap size={22} color="var(--clr-amber-400)" />
          </div>
          <div>
            <div className="alert-banner-title" style={{ color: 'var(--clr-amber-400)' }}>
              ⚠ Impact Detected — Confirming Fall…
            </div>
            <div className="alert-banner-time">Monitoring body orientation within 2-second window</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="alert-banner">
      <div className="alert-banner-left">
        <div className="alert-icon-ring">
          <AlertTriangle size={24} color="var(--clr-red-400)" />
        </div>
        <div>
          <div className="alert-banner-title">🚨 POSSIBLE FALL DETECTED</div>
          <div className="alert-banner-time">
            Detected at uptime: {alertTimestamp || '--:--:--'} &nbsp;·&nbsp;
            Educational prototype — not a medical device
          </div>
        </div>
      </div>
      <button className="btn btn-danger" onClick={onReset} id="btn-acknowledge-alert">
        <ThumbsUp size={15} />
        Acknowledge &amp; Reset
      </button>
    </div>
  );
}

/** Patient status card */
function StatusCard({ fallState, alertActive }) {
  let label, cls, icon;
  if (!fallState || fallState === 'UNKNOWN') {
    label = 'WAITING FOR DATA'; cls = 'unknown';
    icon = <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />;
  } else if (alertActive || fallState === 'FALL_ALERT') {
    label = 'POSSIBLE FALL DETECTED'; cls = 'alert';
    icon = <AlertTriangle size={18} />;
  } else if (fallState === 'IMPACT_DETECTED') {
    label = 'IMPACT — CONFIRMING…'; cls = 'impact';
    icon = <Zap size={18} />;
  } else {
    label = 'NORMAL'; cls = 'normal';
    icon = <CheckCircle2 size={18} />;
  }

  return (
    <div className={`card ${alertActive ? 'card-alert' : ''}`}>
      <div className="card-header">
        <span className="card-title"><Shield size={13} /> Patient Status</span>
        {icon}
      </div>
      <div className={`status-value ${cls}`}>{label}</div>
      <div className="status-sub">
        {cls === 'normal'  && 'No fall event detected.'}
        {cls === 'alert'   && 'Alert is latched. Press Acknowledge or the physical button to reset.'}
        {cls === 'impact'  && 'High-impact detected. Checking posture change…'}
        {cls === 'unknown' && 'Waiting for first sensor reading from ESP32.'}
      </div>
    </div>
  );
}

/** Magnitude metric card */
function MagnitudeCard({ magnitude }) {
  const val = typeof magnitude === 'number' ? magnitude : 0;
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title"><TrendingUp size={13} /> Accel. Magnitude</span>
      </div>
      <div className="metric-big">{fmt(val, 3)}</div>
      <div className="metric-unit">g  (1 g = 9.807 m/s²)</div>
      <div className="uptime-row">
        <span style={{ color: val > 2.2 ? 'var(--clr-red-400)' : val > 1.5 ? 'var(--clr-amber-400)' : 'var(--clr-green-400)' }}>
          {val > 2.2 ? '● HIGH IMPACT RANGE' : val > 1.5 ? '● ELEVATED' : '● NORMAL RANGE'}
        </span>
      </div>
    </div>
  );
}

/** Tilt card */
function TiltCard({ tiltDeg }) {
  const deg = typeof tiltDeg === 'number' ? tiltDeg : 0;
  // Clamp 0–90 for display bar
  const pct = Math.min(100, (deg / 90) * 100);
  const barColor = deg > 45
    ? 'var(--clr-red-400)'
    : deg > 25
      ? 'var(--clr-amber-400)'
      : 'var(--clr-green-400)';

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title"><RotateCcw size={13} /> Estimated Body Tilt</span>
      </div>
      <div className="tilt-arc-container">
        <div className="tilt-value">{fmt(deg, 1)}°</div>
        <div style={{ width: '100%' }}>
          <div className="tilt-bar-track">
            <div className="tilt-bar-fill" style={{ width: `${pct}%`, background: barColor }} />
          </div>
          <div className="uptime-row" style={{ marginTop: '0.35rem' }}>
            <span>0° (upright)</span>
            <span style={{ color: barColor }}>{deg > 45 ? 'Possible lying down' : 'Upright / seated'}</span>
            <span>90°</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Accelerometer XYZ axis card */
function AxisCard({ ax, ay, az }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title"><Activity size={13} /> Accelerometer (g)</span>
      </div>
      <div className="axis-grid">
        {[
          { label: 'X', value: ax, cls: 'x' },
          { label: 'Y', value: ay, cls: 'y' },
          { label: 'Z', value: az, cls: 'z' },
        ].map(({ label, value, cls }) => (
          <div key={label} className="axis-item">
            <div className={`axis-label ${cls}`}>{label}-axis</div>
            <div className="axis-value">{fmt(value, 3)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Gyroscope XYZ card */
function GyroCard({ gx, gy, gz }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title"><RotateCcw size={13} /> Gyroscope (°/s)</span>
      </div>
      <div className="gyro-grid">
        {[
          { label: 'GX', value: gx },
          { label: 'GY', value: gy },
          { label: 'GZ', value: gz },
        ].map(({ label, value }) => (
          <div key={label} className="gyro-item">
            <div className="gyro-label">{label}</div>
            <div className="gyro-value">{fmt(value, 1)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Custom Recharts tooltip */
function GraphTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--clr-bg-card)',
      border: '1px solid var(--clr-border)',
      borderRadius: '8px',
      padding: '0.5rem 0.75rem',
      fontSize: '0.75rem',
      fontFamily: 'JetBrains Mono, monospace',
      color: 'var(--clr-text-primary)',
    }}>
      <div>Mag: <strong>{Number(payload[0].value).toFixed(4)} g</strong></div>
    </div>
  );
}

/** Rolling acceleration graph */
function AccelGraph({ graph }) {
  // Normalize the graph data for Recharts: use index as X axis
  const data = useMemo(() => {
    if (!graph || graph.length === 0) return [];
    return graph.map((pt, i) => ({
      index: i,
      mag: typeof pt.mag === 'number' ? pt.mag : 0,
    }));
  }, [graph]);

  return (
    <div className="card graph-card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-header">
        <span className="card-title"><Activity size={13} /> Live Acceleration Magnitude — Rolling Window</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--clr-text-muted)' }}>
          {data.length} samples @ 20 Hz
        </span>
      </div>
      {data.length === 0 ? (
        <div style={{
          height: 200, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--clr-text-muted)', fontSize: '0.85rem'
        }}>
          Waiting for data from ESP32…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="magGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis
              dataKey="index"
              tick={false}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              tickLine={false}
            />
            <YAxis
              domain={[0, 'auto']}
              tick={{ fontSize: 10, fill: 'var(--clr-text-muted)', fontFamily: 'JetBrains Mono' }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              tickLine={false}
              tickFormatter={(v) => `${v.toFixed(1)}g`}
            />
            <Tooltip content={<GraphTooltip />} />
            {/* Impact threshold reference line */}
            <ReferenceLine y={2.2} stroke="rgba(248,113,113,0.5)"
              strokeDasharray="4 3" label={{ value: 'Impact threshold', fill: 'rgba(248,113,113,0.6)', fontSize: 10 }} />
            <ReferenceLine y={1.0} stroke="rgba(74,222,128,0.3)"
              strokeDasharray="4 3" label={{ value: 'Rest (1 g)', fill: 'rgba(74,222,128,0.5)', fontSize: 10 }} />
            <Area
              type="monotone"
              dataKey="mag"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#magGrad)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Alert history panel */
function HistoryPanel({ history }) {
  return (
    <div className="card" style={{ height: '100%' }}>
      <div className="card-header">
        <span className="card-title"><Clock size={13} /> Alert History</span>
        {history.length > 0 && (
          <span style={{ fontSize: '0.72rem', color: 'var(--clr-text-muted)' }}>
            {history.length} event{history.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {history.length === 0 ? (
        <div className="history-empty">
          <CheckCircle2 size={32} color="var(--clr-text-muted)" style={{ marginBottom: '0.5rem' }} />
          <div>No events recorded yet.</div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.75rem' }}>Events will appear here when a fall is detected or reset.</div>
        </div>
      ) : (
        <div className="history-list">
          {history.map((entry, i) => {
            const isFall = entry.type === 'FALL_DETECTED';
            return (
              <div key={`${entry.ts}-${entry.type}-${i}`} className="history-entry">
                <div className={`history-dot ${isFall ? 'fall' : 'reset'}`} />
                <div className="history-ts">{entry.ts}</div>
                <div className={`history-type ${isFall ? 'fall' : 'reset'}`}>
                  {isFall ? '🚨 Possible Fall Detected' : '✓ Alert Reset'}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Timestamp + uptime row */
function InfoRow({ lastUpdated, uptimeMs }) {
  return (
    <div className="uptime-row" style={{ padding: '0.25rem 0', marginBottom: '1rem' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        <Radio size={12} />
        Last update: {formatTime(lastUpdated)}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        <Clock size={12} />
        Device uptime: {formatUptime(uptimeMs)}
      </span>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const {
    connected, loading, sensorOK, error,
    ax, ay, az, gx, gy, gz,
    magnitude, tiltDeg,
    fallState, alertActive, alertTimestamp,
    uptimeMs, graph, history, lastUpdated,
    resetAlert,
  } = useFallMonitor();

  return (
    <div className="app-shell">
      <Header connected={connected} loading={loading} />

      <main className="main-content" role="main">

        {/* ── Sensor error warning ──────────────────────────── */}
        {connected && !sensorOK && <SensorErrorBar />}

        {/* ── Offline state ─────────────────────────────────── */}
        {!loading && !connected && <OfflineCard error={error} />}

        {/* ── Active fall alert banner ──────────────────────── */}
        {connected && (
          <AlertBanner
            alertActive={alertActive}
            fallState={fallState}
            alertTimestamp={alertTimestamp}
            onReset={resetAlert}
          />
        )}

        {/* ── Info row ──────────────────────────────────────── */}
        {connected && <InfoRow lastUpdated={lastUpdated} uptimeMs={uptimeMs} />}

        {/* ── Top row: Status, Magnitude, Tilt ─────────────── */}
        <div className="grid-top">
          <StatusCard fallState={fallState} alertActive={alertActive} />
          <MagnitudeCard magnitude={magnitude} />
          <TiltCard tiltDeg={tiltDeg} />
        </div>

        {/* ── Middle row: Accel axes, Gyro ─────────────────── */}
        <div className="grid-mid">
          <AxisCard ax={ax} ay={ay} az={az} />
          <GyroCard gx={gx} gy={gy} gz={gz} />
        </div>

        {/* ── Graph (full width) ────────────────────────────── */}
        <div style={{ marginBottom: '1rem' }}>
          <AccelGraph graph={graph} />
        </div>

        {/* ── Bottom row: History ───────────────────────────── */}
        <div className="grid-bottom">
          <HistoryPanel history={history} />
          {/* Info card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title"><Shield size={13} /> System Info</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.8rem' }}>
              {[
                ['ESP32 IP',       '192.168.4.1'],
                ['Wi-Fi SSID',     'FallMonitor'],
                ['Poll rate',      '500 ms'],
                ['Sample rate',    '20 Hz (50 ms)'],
                ['Accel range',    '±8 g'],
                ['Gyro range',     '±500 °/s'],
                ['Impact thresh',  '2.2 g + 100 °/s'],
                ['Tilt thresh',    '45°'],
                ['Confirm window', '2 seconds'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--clr-text-muted)' }}>{k}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--clr-text-primary)', fontWeight: 500, textAlign: 'right' }}>{v}</span>
                </div>
              ))}
            </div>
            {/* Manual reset button (always available if not already normal) */}
            {(alertActive || fallState === 'FALL_ALERT' || fallState === 'IMPACT_DETECTED') && (
              <button
                id="btn-manual-reset"
                className="btn btn-danger"
                onClick={resetAlert}
                style={{ marginTop: '1rem', width: '100%', justifyContent: 'center' }}
              >
                <RotateCcw size={14} /> Reset Alert
              </button>
            )}
            {!alertActive && fallState === 'NORMAL' && connected && (
              <div style={{
                marginTop: '1rem',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontSize: '0.78rem', color: 'var(--clr-green-400)'
              }}>
                <CheckCircle2 size={14} /> System nominal
              </div>
            )}
          </div>
        </div>

      </main>

      <footer className="disclaimer" role="contentinfo">
        ⚠ Educational Prototype Only — This system is NOT a certified medical device and must NOT be used for clinical patient monitoring.
        Fall detection accuracy depends on sensor placement, threshold tuning, and environmental conditions.
        Always ensure patient safety through qualified medical personnel and certified equipment.
      </footer>
    </div>
  );
}
