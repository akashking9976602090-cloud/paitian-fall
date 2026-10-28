/**
 * useFallMonitor.js — Custom React hook for ESP32 polling
 *
 * Responsibilities:
 *  - Poll /api/data at a configurable interval (default 500 ms).
 *  - Maintain a local alert history to avoid duplicate entries from the same
 *    event (deduplication by alert timestamp string).
 *  - Track connection status (online / offline / error).
 *  - Expose a resetAlert() function that POSTs to /api/reset.
 *  - Clean up the polling timer when the component unmounts (no memory leaks).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchSensorData, postResetAlert } from './api.js';

// Polling interval in milliseconds — lower = more responsive, higher network load
const POLL_INTERVAL_MS = 500;

// How many alert history entries to keep locally
const MAX_LOCAL_HISTORY = 50;

const initialState = {
  connected: false,       // Is the ESP32 reachable?
  loading: true,          // First fetch in progress
  sensorOK: false,        // Did the MPU6050 initialise on the ESP32?
  error: null,            // Latest error message string or null
  ax: 0, ay: 0, az: 0,   // Accelerometer (g)
  gx: 0, gy: 0, gz: 0,   // Gyroscope (°/s)
  magnitude: 0,           // Acceleration magnitude (g)
  tiltDeg: 0,             // Estimated body tilt (degrees)
  fallState: 'UNKNOWN',   // "NORMAL" | "IMPACT_DETECTED" | "FALL_ALERT"
  alertActive: false,
  alertTimestamp: '',
  uptimeMs: 0,
  graph: [],              // Rolling graph samples [{t, mag}]
  history: [],            // Deduplicated history entries [{ts, type}]
  lastUpdated: null,      // Date object of last successful fetch
};

export function useFallMonitor() {
  const [state, setState] = useState(initialState);
  const abortRef    = useRef(null);   // AbortController for fetch cleanup
  const intervalRef = useRef(null);   // setInterval handle
  // Track the latest alert timestamp we've already recorded so we don't add duplicates
  const seenAlertTs = useRef(new Set());

  /** Merge incoming history from ESP32 with local dedup tracking */
  const mergeHistory = useCallback((incomingHistory) => {
    // ESP32 sends history newest-last; we want newest-first for display
    const reversed = [...(incomingHistory || [])].reverse();
    return reversed.slice(0, MAX_LOCAL_HISTORY);
  }, []);

  const poll = useCallback(async () => {
    // Create a new AbortController for this request
    abortRef.current = new AbortController();
    try {
      const data = await fetchSensorData(abortRef.current.signal);
      setState((prev) => ({
        ...prev,
        connected:      true,
        loading:        false,
        error:          null,
        sensorOK:       data.sensorOK ?? false,
        ax:             data.ax ?? 0,
        ay:             data.ay ?? 0,
        az:             data.az ?? 0,
        gx:             data.gx ?? 0,
        gy:             data.gy ?? 0,
        gz:             data.gz ?? 0,
        magnitude:      data.magnitude ?? 0,
        tiltDeg:        data.tiltDeg ?? 0,
        fallState:      data.fallState ?? 'UNKNOWN',
        alertActive:    data.alertActive ?? false,
        alertTimestamp: data.alertTimestamp ?? '',
        uptimeMs:       data.uptimeMs ?? 0,
        graph:          data.graph ?? [],
        history:        mergeHistory(data.history),
        lastUpdated:    new Date(),
      }));
    } catch (err) {
      // Ignore aborted fetches (happens on unmount)
      if (err.name === 'AbortError') return;
      setState((prev) => ({
        ...prev,
        connected:   false,
        loading:     false,
        error:       err.message ?? 'Connection failed',
        lastUpdated: prev.lastUpdated, // keep last known timestamp
      }));
    }
  }, [mergeHistory]);

  // Start polling on mount, clean up on unmount
  useEffect(() => {
    poll(); // Immediate first fetch
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalRef.current);
      abortRef.current?.abort();
    };
  }, [poll]);

  /** Send reset command to ESP32 */
  const resetAlert = useCallback(async () => {
    try {
      await postResetAlert();
      // Optimistically update local state so UI feels instant
      setState((prev) => ({
        ...prev,
        alertActive: false,
        fallState:   'NORMAL',
      }));
    } catch (err) {
      console.error('Reset request failed:', err);
    }
  }, []);

  return { ...state, resetAlert };
}
