import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Proxy API calls to ESP32 during development so you avoid CORS issues.
    // Change the target to the ESP32's IP (default AP IP: 192.168.4.1).
    // When you connect your PC to the 'FallMonitor' Wi-Fi and run `npm run dev`,
    // the dev server will forward /api/* requests to the ESP32.
    proxy: {
      '/api': {
        target: 'http://192.168.4.1',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
