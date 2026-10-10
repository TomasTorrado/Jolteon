// INA219 battery / USB boost test
//
// Wiring:
//   INA219 VCC -> ESP32 3V3        INA219 SDA -> GPIO 25
//   INA219 GND -> common ground    INA219 SCL -> GPIO 26
//   Battery +  -> INA219 VIN-
//   INA219 VIN+ -> switch -> boost IN+
//   Battery -  -> common ground -> boost IN-
//
// Open Serial Monitor at 115200 baud. Flip the switch to start the USB output.

#include <Wire.h>
#include <Adafruit_INA219.h>

const int SDA_PIN = 25;
const int SCL_PIN = 26;
const unsigned long SAMPLE_INTERVAL_MS = 500;
const float USB_ON_THRESHOLD_MA = 15.0;
const float LOW_BATTERY_V = 3.0;

// Battery on VIN- with the boost on VIN+ makes outflow read negative.
// Set to 1.0 if the battery is on VIN+ instead.
const float OUTFLOW_SIGN = -1.0;

Adafruit_INA219 ina219(0x40);

unsigned long lastSampleMs = 0;
unsigned long usbOnSinceMs = 0;
bool usbOn = false;
float sessionmAh = 0;
float sessionmWh = 0;
float totalmAh = 0;
float totalmWh = 0;

void setup() {
  Serial.begin(115200);
  delay(500);

  Wire.begin(SDA_PIN, SCL_PIN);
  if (!ina219.begin(&Wire)) {
    Serial.println("INA219 not found. Check SDA=25, SCL=26, VCC=3V3 and GND.");
    while (true) delay(1000);
  }

  // Phone charging pulls well over 400 mA from the pack, so use the 2 A range.
  ina219.setCalibration_32V_2A();

  Serial.println("INA219 ready. Battery idle readings below; flip the switch to enable USB.");
  Serial.println();
  lastSampleMs = millis();
}

void loop() {
  unsigned long now = millis();
  if (now - lastSampleMs < SAMPLE_INTERVAL_MS) return;
  float dtHours = (now - lastSampleMs) / 3600000.0;
  lastSampleMs = now;

  float busV = ina219.getBusVoltage_V();
  float shuntmV = ina219.getShuntVoltage_mV();
  float currentmA = ina219.getCurrent_mA();

  // Bus voltage is measured at VIN-, so it is the battery voltage when the battery sits on VIN-.
  float batteryV = OUTFLOW_SIGN < 0 ? busV : busV + shuntmV / 1000.0;
  float outflowmA = OUTFLOW_SIGN * currentmA;
  float outflowmW = batteryV * outflowmA;

  bool nowOn = outflowmA > USB_ON_THRESHOLD_MA;
  if (nowOn && !usbOn) {
    usbOnSinceMs = now;
    sessionmAh = 0;
    sessionmWh = 0;
    Serial.println(">>> USB output ON");
  } else if (!nowOn && usbOn) {
    Serial.printf("<<< USB output OFF after %.1f s: %.2f mAh, %.2f mWh delivered\n",
                  (now - usbOnSinceMs) / 1000.0, sessionmAh, sessionmWh);
  }
  usbOn = nowOn;

  if (usbOn) {
    sessionmAh += outflowmA * dtHours;
    sessionmWh += outflowmW * dtHours;
    totalmAh += outflowmA * dtHours;
    totalmWh += outflowmW * dtHours;
  }

  Serial.printf("Battery %.3f V | Current %7.1f mA | Power %7.1f mW | Shunt %6.2f mV | USB %-3s | Total out %.2f mAh, %.2f mWh\n",
                batteryV, outflowmA, outflowmW, shuntmV, usbOn ? "ON" : "off", totalmAh, totalmWh);

  if (batteryV < LOW_BATTERY_V && batteryV > 0.5) {
    Serial.println("!!! Battery below 3.0 V - turn the USB off to protect the cells");
  }
}
