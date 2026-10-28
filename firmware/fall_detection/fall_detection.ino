/*
 * =============================================================================
 *  Patient Fall Detection System — ESP32 Firmware
 *  Educational Prototype — NOT a certified medical device
 * =============================================================================
 *
 *  Hardware:
 *    - ESP32 DevKit V1
 *    - MPU6050 accelerometer + gyroscope (I2C: SDA=GPIO21, SCL=GPIO22)
 *    - Active Buzzer  → GPIO 26
 *    - Red LED        → GPIO 25 (through 220Ω to GND)
 *    - Green LED      → GPIO 27 (through 220Ω to GND)
 *    - Push Button    → GPIO 14 (INPUT_PULLUP; other end to GND)
 *
 *  Required Library (install via Arduino Library Manager):
 *    Adafruit MPU6050  (by Adafruit)   — also installs Adafruit Unified Sensor
 *
 *  Wi-Fi Mode: Access Point (AP)
 *    SSID     : FallMonitor
 *    Password : fallmon8  (must be 8+ characters)
 *    Dashboard: http://192.168.4.1/
 *    API data : http://192.168.4.1/api/data
 *    API reset: POST http://192.168.4.1/api/reset
 *
 *  HOW TO TUNE THRESHOLDS:
 *    1. Open Serial Monitor at 115200 baud.
 *    2. Print rawAx, rawAy, rawAz and magnitude while doing normal movements.
 *    3. Note the magnitude peaks — adjust IMPACT_THRESHOLD so routine bumps
 *       do NOT trigger it, but a sharp drop would.
 *    4. Similarly observe gyro values during a simulated fall-like motion and
 *       adjust GYRO_THRESHOLD.
 *    5. TILT_THRESHOLD: 45° works well for "lying down vs standing" detection.
 *    6. CONFIRMATION_WINDOW_MS: how long after impact we check for posture
 *       change. 2000 ms gives a 2-second window.
 * =============================================================================
 */

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <WiFi.h>
#include <WebServer.h>
#include <math.h>

// ─── Wi-Fi Access Point credentials ─────────────────────────────────────────
const char* AP_SSID     = "FallMonitor";
const char* AP_PASSWORD = "fallmon8";       // Must be ≥ 8 characters

// ─── GPIO pin assignments ─────────────────────────────────────────────────────
#define PIN_BUZZER       26
#define PIN_LED_RED      25
#define PIN_LED_GREEN    27
#define PIN_BUTTON       14

// ─── Fall-detection thresholds (tune these for your environment) ─────────────
//  IMPACT_THRESHOLD    : acceleration magnitude (g) to flag a possible impact.
//                        Normal walking ≈ 1.1–1.4 g; a sharp fall can exceed 2 g.
const float IMPACT_THRESHOLD        = 2.2f;   // g  — adjust after observation

//  GYRO_THRESHOLD      : angular velocity magnitude (°/s) at time of impact.
//                        Adds confidence that the body rotated suddenly.
const float GYRO_THRESHOLD          = 100.0f; // °/s

//  TILT_THRESHOLD      : tilt from vertical (degrees) after the impact window.
//                        A person lying down typically has >45° tilt.
const float TILT_THRESHOLD          = 45.0f;  // degrees

//  CONFIRMATION_WINDOW_MS: time after detecting an impact during which we check
//                          if the body is now tilted (lying down).
const unsigned long CONFIRMATION_WINDOW_MS = 2000UL; // 2 seconds

//  FREE_FALL_THRESHOLD : if magnitude drops very low, it may be free-fall.
//                        Keep this low to avoid false positives from tilting.
const float FREE_FALL_THRESHOLD     = 0.4f;   // g

// ─── Buzzer and LED control ───────────────────────────────────────────────────
#define BUZZER_BEEP_INTERVAL_MS  500  // Buzzer alternates every 500 ms during alert

// ─── Button debounce ─────────────────────────────────────────────────────────
#define DEBOUNCE_MS  50

// ─── Sensor sampling interval ────────────────────────────────────────────────
#define SAMPLE_INTERVAL_MS  50   // 20 Hz sensor polling

// ─── Circular sample buffer for the rolling graph (sent in JSON) ─────────────
#define GRAPH_BUFFER_SIZE  60    // 60 samples × 50 ms = 3 seconds of history

// ─── Global objects ───────────────────────────────────────────────────────────
Adafruit_MPU6050 mpu;
WebServer        server(80);

// ─── Sensor data (updated every SAMPLE_INTERVAL_MS) ─────────────────────────
struct SensorReading {
  float ax, ay, az;          // Accelerometer (g)
  float gx, gy, gz;          // Gyroscope (°/s)
  float magnitude;           // Acceleration magnitude (g)
  float tiltDeg;             // Estimated tilt from vertical (degrees)
  unsigned long timestamp;   // millis() when captured
};
volatile SensorReading latestReading;
bool sensorOK = false;

// ─── Graph buffer ─────────────────────────────────────────────────────────────
struct GraphPoint {
  float magnitude;
  unsigned long t;
};
GraphPoint graphBuffer[GRAPH_BUFFER_SIZE];
int graphHead = 0;
int graphCount = 0;

// ─── Fall-detection state machine ─────────────────────────────────────────────
enum FallState {
  STATE_NORMAL,           // No event
  STATE_IMPACT_DETECTED,  // High-impact detected — watching for posture change
  STATE_FALL_ALERT        // Alert latched — buzzer/LED active
};
FallState fallState = STATE_NORMAL;
unsigned long impactTime = 0;   // millis() when impact was detected

// ─── Alert tracking ───────────────────────────────────────────────────────────
bool        alertActive     = false;
String      alertTimestamp  = "";   // Human-readable time of fall event
unsigned long alertStartMs  = 0;
unsigned long lastBuzzerMs  = 0;
bool        buzzerOn        = false;

// ─── Alert history (last 20 events) ──────────────────────────────────────────
#define MAX_HISTORY 20
struct HistoryEntry {
  String timestamp;
  String type;   // "FALL_DETECTED" or "ALERT_RESET"
};
HistoryEntry alertHistory[MAX_HISTORY];
int historyCount = 0;

// ─── Button state ─────────────────────────────────────────────────────────────
bool     lastButtonState   = HIGH;  // INPUT_PULLUP → idle = HIGH
bool     buttonState       = HIGH;
unsigned long lastDebounceMs = 0;

// ─── Timing ───────────────────────────────────────────────────────────────────
unsigned long lastSampleMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: Format millis() into a short timestamp string hh:mm:ss
// ─────────────────────────────────────────────────────────────────────────────
String formatTimestamp(unsigned long ms) {
  unsigned long totalSec = ms / 1000;
  unsigned int  h   = totalSec / 3600;
  unsigned int  m   = (totalSec % 3600) / 60;
  unsigned int  s   = totalSec % 60;
  char buf[12];
  snprintf(buf, sizeof(buf), "%02u:%02u:%02u", h, m, s);
  return String(buf);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Push a new entry to alert history (circular, oldest dropped)
// ─────────────────────────────────────────────────────────────────────────────
void pushHistory(const String& ts, const String& type) {
  if (historyCount < MAX_HISTORY) {
    alertHistory[historyCount].timestamp = ts;
    alertHistory[historyCount].type      = type;
    historyCount++;
  } else {
    // Shift left and insert at end
    for (int i = 0; i < MAX_HISTORY - 1; i++) {
      alertHistory[i] = alertHistory[i + 1];
    }
    alertHistory[MAX_HISTORY - 1].timestamp = ts;
    alertHistory[MAX_HISTORY - 1].type      = type;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Activate the fall alert (latch state, turn on buzzer & red LED)
// ─────────────────────────────────────────────────────────────────────────────
void activateFallAlert() {
  if (alertActive) return;   // Already alerting — do not double-push to history
  alertActive    = true;
  fallState      = STATE_FALL_ALERT;
  alertStartMs   = millis();
  alertTimestamp = formatTimestamp(alertStartMs);

  digitalWrite(PIN_LED_RED, HIGH);
  digitalWrite(PIN_LED_GREEN, LOW);

  Serial.println("[ALERT] Possible fall detected! Alert latched.");
  pushHistory(alertTimestamp, "FALL_DETECTED");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reset / cancel the alert
// ─────────────────────────────────────────────────────────────────────────────
void resetAlert() {
  if (!alertActive && fallState == STATE_NORMAL) return;

  alertActive = false;
  fallState   = STATE_NORMAL;
  impactTime  = 0;

  // Turn off buzzer and red LED; restore green LED
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_LED_GREEN, HIGH);
  buzzerOn = false;

  String ts = formatTimestamp(millis());
  Serial.println("[RESET] Alert cancelled at " + ts);
  pushHistory(ts, "ALERT_RESET");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Update buzzer and LEDs based on current state (called every loop iteration)
// ─────────────────────────────────────────────────────────────────────────────
void updateOutputs() {
  if (!alertActive) {
    // Normal — green LED, no buzzer
    digitalWrite(PIN_LED_RED,   LOW);
    digitalWrite(PIN_LED_GREEN, HIGH);
    if (buzzerOn) {
      digitalWrite(PIN_BUZZER, LOW);
      buzzerOn = false;
    }
    return;
  }

  // Alert active — blink buzzer at BUZZER_BEEP_INTERVAL_MS
  unsigned long now = millis();
  if (now - lastBuzzerMs >= BUZZER_BEEP_INTERVAL_MS) {
    lastBuzzerMs = now;
    buzzerOn     = !buzzerOn;
    digitalWrite(PIN_BUZZER,   buzzerOn ? HIGH : LOW);
    digitalWrite(PIN_LED_RED,  HIGH);   // Keep red LED solid
    digitalWrite(PIN_LED_GREEN, LOW);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Read the physical cancel button with debouncing
// ─────────────────────────────────────────────────────────────────────────────
void readButton() {
  bool raw = digitalRead(PIN_BUTTON);

  if (raw != lastButtonState) {
    lastDebounceMs = millis();
  }
  lastButtonState = raw;

  if ((millis() - lastDebounceMs) >= DEBOUNCE_MS) {
    if (raw != buttonState) {
      buttonState = raw;
      if (buttonState == LOW) {
        // Button pressed (pulled LOW by connecting to GND)
        Serial.println("[BUTTON] Physical cancel button pressed.");
        resetAlert();
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sample MPU6050 and update latestReading + graph buffer
// ─────────────────────────────────────────────────────────────────────────────
void sampleSensor() {
  sensors_event_t accel, gyro, temp;
  if (!mpu.getEvent(&accel, &gyro, &temp)) {
    Serial.println("[WARN] MPU6050 read failed.");
    return;
  }

  // Accelerometer in m/s² → convert to g (1 g = 9.80665 m/s²)
  float ax = accel.acceleration.x / 9.80665f;
  float ay = accel.acceleration.y / 9.80665f;
  float az = accel.acceleration.z / 9.80665f;

  // Gyroscope already in rad/s from Adafruit library — convert to °/s
  float gx = gyro.gyro.x * 57.2958f;
  float gy = gyro.gyro.y * 57.2958f;
  float gz = gyro.gyro.z * 57.2958f;

  // Acceleration magnitude
  float mag = sqrtf(ax*ax + ay*ay + az*az);

  // Tilt from vertical: angle between gravity vector and vertical axis
  // Using atan2 for a robust estimate (degrees from upright)
  float tilt = atan2f(sqrtf(ax*ax + ay*ay), fabsf(az)) * 57.2958f;

  // Update global reading (no mutex needed — simple write; one core reads/writes)
  latestReading.ax        = ax;
  latestReading.ay        = ay;
  latestReading.az        = az;
  latestReading.gx        = gx;
  latestReading.gy        = gy;
  latestReading.gz        = gz;
  latestReading.magnitude = mag;
  latestReading.tiltDeg   = tilt;
  latestReading.timestamp = millis();

  // Push to graph buffer
  graphBuffer[graphHead].magnitude = mag;
  graphBuffer[graphHead].t         = latestReading.timestamp;
  graphHead  = (graphHead + 1) % GRAPH_BUFFER_SIZE;
  if (graphCount < GRAPH_BUFFER_SIZE) graphCount++;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fall-detection state machine  (call after each sensor sample)
// ─────────────────────────────────────────────────────────────────────────────
void runFallDetection() {
  if (alertActive) return;  // Already in alert state — wait for reset

  float mag  = latestReading.magnitude;
  float tilt = latestReading.tiltDeg;
  float gMag = sqrtf( latestReading.gx * latestReading.gx
                     + latestReading.gy * latestReading.gy
                     + latestReading.gz * latestReading.gz );

  switch (fallState) {
    case STATE_NORMAL:
      // Check for high-impact event
      if (mag > IMPACT_THRESHOLD && gMag > GYRO_THRESHOLD) {
        Serial.printf("[STATE] Impact detected: mag=%.2fg, gyro=%.1f°/s\n", mag, gMag);
        fallState  = STATE_IMPACT_DETECTED;
        impactTime = millis();
      }
      // Optional: pure free-fall detection (very low g)
      // If you want to catch free-fall scenarios, uncomment below:
      // else if (mag < FREE_FALL_THRESHOLD) {
      //   fallState  = STATE_IMPACT_DETECTED;
      //   impactTime = millis();
      // }
      break;

    case STATE_IMPACT_DETECTED: {
      unsigned long elapsed = millis() - impactTime;

      if (elapsed <= CONFIRMATION_WINDOW_MS) {
        // Within window: check for posture change (body now tilted > threshold)
        if (tilt > TILT_THRESHOLD) {
          Serial.printf("[STATE] Posture change confirmed: tilt=%.1f°\n", tilt);
          activateFallAlert();
        }
      } else {
        // Window expired without posture change — treat as false positive
        Serial.println("[STATE] Confirmation window expired — no fall confirmed.");
        fallState = STATE_NORMAL;
      }
      break;
    }

    case STATE_FALL_ALERT:
      // Waiting for manual reset (button or API)
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP handler: GET /api/data  — returns sensor data as JSON
// ─────────────────────────────────────────────────────────────────────────────
void handleApiData() {
  // CORS headers so a React app on a different origin can reach this endpoint
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Cache-Control", "no-cache");

  if (!sensorOK) {
    server.send(503, "application/json",
      "{\"error\":\"MPU6050 not detected. Check wiring.\","
      "\"sensorOK\":false}");
    return;
  }

  // Build the graph array (ordered from oldest to newest)
  String graphJson = "[";
  int startIdx = (graphCount < GRAPH_BUFFER_SIZE)
                  ? 0
                  : graphHead;   // Oldest sample index

  for (int i = 0; i < graphCount; i++) {
    int idx = (startIdx + i) % GRAPH_BUFFER_SIZE;
    if (i > 0) graphJson += ",";
    char buf[48];
    snprintf(buf, sizeof(buf), "{\"t\":%lu,\"mag\":%.4f}",
             graphBuffer[idx].t, graphBuffer[idx].magnitude);
    graphJson += buf;
  }
  graphJson += "]";

  // Build history array
  String histJson = "[";
  for (int i = 0; i < historyCount; i++) {
    if (i > 0) histJson += ",";
    histJson += "{\"ts\":\"" + alertHistory[i].timestamp
              + "\",\"type\":\"" + alertHistory[i].type + "\"}";
  }
  histJson += "]";

  // Determine fall state string
  String stateStr;
  switch (fallState) {
    case STATE_NORMAL:           stateStr = "NORMAL";            break;
    case STATE_IMPACT_DETECTED:  stateStr = "IMPACT_DETECTED";   break;
    case STATE_FALL_ALERT:       stateStr = "FALL_ALERT";        break;
    default:                     stateStr = "UNKNOWN";
  }

  char json[1024];
  snprintf(json, sizeof(json),
    "{"
      "\"sensorOK\":true,"
      "\"ax\":%.4f,"
      "\"ay\":%.4f,"
      "\"az\":%.4f,"
      "\"gx\":%.4f,"
      "\"gy\":%.4f,"
      "\"gz\":%.4f,"
      "\"magnitude\":%.4f,"
      "\"tiltDeg\":%.2f,"
      "\"fallState\":\"%s\","
      "\"alertActive\":%s,"
      "\"alertTimestamp\":\"%s\","
      "\"uptimeMs\":%lu,"
      "\"graph\":%s,"
      "\"history\":%s"
    "}",
    latestReading.ax, latestReading.ay, latestReading.az,
    latestReading.gx, latestReading.gy, latestReading.gz,
    latestReading.magnitude, latestReading.tiltDeg,
    stateStr.c_str(),
    alertActive ? "true" : "false",
    alertTimestamp.c_str(),
    latestReading.timestamp,
    graphJson.c_str(),
    histJson.c_str()
  );

  server.send(200, "application/json", json);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP handler: POST /api/reset  — cancel active alert
// ─────────────────────────────────────────────────────────────────────────────
void handleApiReset() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");

  Serial.println("[API] Reset request received.");
  resetAlert();
  server.send(200, "application/json", "{\"status\":\"reset\",\"alertActive\":false}");
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP handler: OPTIONS preflight (for CORS)
// ─────────────────────────────────────────────────────────────────────────────
void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP handler: GET /  — redirect to dashboard info
// ─────────────────────────────────────────────────────────────────────────────
void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/html",
    "<!DOCTYPE html><html><head><title>Fall Monitor</title></head>"
    "<body style='font-family:sans-serif;background:#0d1b2a;color:#fff;padding:2rem'>"
    "<h1>&#128680; Patient Fall Detection System</h1>"
    "<p>API endpoint: <a href='/api/data' style='color:#4ade80'>/api/data</a></p>"
    "<p>Reset endpoint: POST to <code>/api/reset</code></p>"
    "<p>Connect your phone/computer to Wi-Fi: <strong>FallMonitor</strong></p>"
    "<p>Then open the React dashboard (running on your PC) and set the ESP32 IP to <strong>192.168.4.1</strong></p>"
    "</body></html>"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== Patient Fall Detection System ===");

  // GPIO setup
  pinMode(PIN_BUZZER,    OUTPUT);
  pinMode(PIN_LED_RED,   OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_BUTTON,    INPUT_PULLUP);

  digitalWrite(PIN_BUZZER,    LOW);
  digitalWrite(PIN_LED_RED,   LOW);
  digitalWrite(PIN_LED_GREEN, LOW);

  // Startup LED flash to confirm power-on
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED_GREEN, HIGH);
    delay(150);
    digitalWrite(PIN_LED_GREEN, LOW);
    delay(150);
  }

  // ── Initialize I2C and MPU6050 ───────────────────────────────────────────
  Wire.begin(21, 22);   // SDA=GPIO21, SCL=GPIO22
  Serial.println("[INIT] Initializing MPU6050...");

  if (!mpu.begin()) {
    Serial.println("[ERROR] MPU6050 not found! Check wiring and I2C address.");
    Serial.println("        Most MPU6050 modules use address 0x68 (AD0 pin LOW).");
    sensorOK = false;
    // Blink red LED to signal sensor error
    while (true) {
      digitalWrite(PIN_LED_RED, HIGH); delay(300);
      digitalWrite(PIN_LED_RED, LOW);  delay(300);
    }
  }

  sensorOK = true;
  Serial.println("[INIT] MPU6050 detected successfully.");

  // Configure MPU6050 ranges
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);   // ±8 g — good for fall detection
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);         // ±500 °/s
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);      // Low-pass filter

  Serial.println("[INIT] MPU6050 configured: ±8g, ±500°/s, 21Hz LPF");

  // ── Start Wi-Fi Access Point ─────────────────────────────────────────────
  Serial.println("[WIFI] Starting Access Point...");
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  IPAddress apIP = WiFi.softAPIP();
  Serial.print("[WIFI] Access Point IP: ");
  Serial.println(apIP);
  Serial.print("[WIFI] SSID: ");
  Serial.println(AP_SSID);
  Serial.println("[WIFI] Connect your device to 'FallMonitor' then open:");
  Serial.print("[WIFI]   http://");
  Serial.println(apIP);

  // ── Register HTTP routes ─────────────────────────────────────────────────
  server.on("/",          HTTP_GET,     handleRoot);
  server.on("/api/data",  HTTP_GET,     handleApiData);
  server.on("/api/reset", HTTP_POST,    handleApiReset);
  server.on("/api/reset", HTTP_OPTIONS, handleOptions);
  server.on("/api/data",  HTTP_OPTIONS, handleOptions);
  server.onNotFound([]() {
    server.send(404, "application/json", "{\"error\":\"Not found\"}");
  });

  server.begin();
  Serial.println("[HTTP] Web server started on port 80.");

  // Normal operating state — green LED ON
  digitalWrite(PIN_LED_GREEN, HIGH);
  Serial.println("[READY] System ready. Sampling sensor at 20 Hz.");
  Serial.println("=========================================");
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOOP — non-blocking: sensor sampling, fall detection, button, web server
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // 1. Service the HTTP server (non-blocking)
  server.handleClient();

  // 2. Read the cancel button
  readButton();

  // 3. Sample sensor at configured interval
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    if (sensorOK) {
      sampleSensor();
      runFallDetection();
    }
  }

  // 4. Update buzzer and LED outputs
  updateOutputs();

  // 5. Debug print every 2 seconds (remove in production to reduce serial noise)
  static unsigned long lastDebugMs = 0;
  if (now - lastDebugMs >= 2000) {
    lastDebugMs = now;
    if (sensorOK) {
      Serial.printf("[DATA] ax=%.2f ay=%.2f az=%.2f | mag=%.2f | tilt=%.1f° | state=%d alert=%d\n",
        latestReading.ax, latestReading.ay, latestReading.az,
        latestReading.magnitude, latestReading.tiltDeg,
        (int)fallState, (int)alertActive);
    }
  }
}
