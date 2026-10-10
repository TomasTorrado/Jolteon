// TEG waste-heat harvester: full power monitor (no temperature probes)
//
// INA219 #1 (TEG side)      bus 1: SDA -> GPIO 21, SCL -> GPIO 22
// INA219 #2 (battery side)  bus 2: SDA -> GPIO 25, SCL -> GPIO 26
// Both boards at 0x40 (A0 open). VCC -> 3V3, GND -> common ground.
//
// Power path:
//   TEG array + -> #1 VIN+ ; #1 VIN- -> 1N5819 anode
//   Harvest:  1N5819 cathode -> switch -> #2 VIN+
//   USB out:  boost IN+      -> switch -> #2 VIN+
//   #2 VIN- -> battery + ; battery -, TEG array -, boost IN- -> common ground
//
// The mode is detected from INA219 #2's current direction:
//   positive = battery charging from the TEGs, negative = battery feeding the USB boost.
//
// Serial Monitor at 115200 baud. Set CSV_OUTPUT to true for spreadsheet / plotter logging.

#include <Wire.h>
#include <Adafruit_INA219.h>

const int BUS1_SDA = 21;
const int BUS1_SCL = 22;
const int BUS2_SDA = 25;
const int BUS2_SCL = 26;

const unsigned long SAMPLE_INTERVAL_MS = 1000;
const float CHARGE_THRESHOLD_MA = 2.0;
const float USB_THRESHOLD_MA = 15.0;
const float BACKFLOW_THRESHOLD_MA = 2.0;
const float LOW_BATTERY_V = 3.0;
const float FULL_BATTERY_V = 4.3;
const bool CSV_OUTPUT = false;

Adafruit_INA219 inaTeg(0x40);
Adafruit_INA219 inaBatt(0x40);

enum class Mode { Idle, Charging, UsbOut };

struct Reading {
  float busV;
  float shuntmV;
  float currentmA;
};

unsigned long lastSampleMs = 0;
unsigned long modeSinceMs = 0;
Mode mode = Mode::Idle;

float tegmWh = 0;
float battInmWh = 0;
float battInmAh = 0;
float usbOutmWh = 0;
float usbOutmAh = 0;
float sessionmWh = 0;
float sessionmAh = 0;

const char *modeName(Mode m) {
  switch (m) {
    case Mode::Idle: return "IDLE";
    case Mode::Charging: return "CHARGING";
    case Mode::UsbOut: return "USB OUT";
  }
  return "?";
}

Reading readSensor(Adafruit_INA219 &ina) {
  return {ina.getBusVoltage_V(), ina.getShuntVoltage_mV(), ina.getCurrent_mA()};
}

void haltWith(const char *msg) {
  Serial.println(msg);
  while (true) delay(1000);
}

void printSessionEnd(Mode ended, unsigned long now) {
  float seconds = (now - modeSinceMs) / 1000.0;
  switch (ended) {
    case Mode::Charging:
      Serial.printf("<<< Charging stopped after %.0f s: %.2f mAh, %.2f mWh into battery\n", seconds, sessionmAh, sessionmWh);
      break;
    case Mode::UsbOut:
      Serial.printf("<<< USB output OFF after %.0f s: %.2f mAh, %.2f mWh delivered\n", seconds, sessionmAh, sessionmWh);
      break;
    case Mode::Idle:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Wire.begin(BUS1_SDA, BUS1_SCL);
  Wire1.begin(BUS2_SDA, BUS2_SCL);

  if (!inaTeg.begin(&Wire)) haltWith("INA219 #1 (TEG side) not found on GPIO 21/22. Check SDA/SCL, VCC and GND.");
  if (!inaBatt.begin(&Wire1)) haltWith("INA219 #2 (battery side) not found on GPIO 25/26. Check SDA/SCL, VCC and GND.");

  // TEG current stays small; the battery side must also handle the phone's load.
  inaTeg.setCalibration_16V_400mA();
  inaBatt.setCalibration_32V_2A();

  if (CSV_OUTPUT) {
    Serial.println("time_s,mode,teg_V,teg_mA,teg_mW,batt_V,batt_mA,batt_mW,diode_V,teg_mWh,batt_in_mWh,usb_out_mWh");
  } else {
    Serial.println("Both INA219s ready. Battery current: + = charging, - = feeding USB.");
    Serial.println();
  }

  lastSampleMs = millis();
  modeSinceMs = lastSampleMs;
}

void loop() {
  unsigned long now = millis();
  if (now - lastSampleMs < SAMPLE_INTERVAL_MS) return;
  float dtHours = (now - lastSampleMs) / 3600000.0;
  lastSampleMs = now;

  Reading teg = readSensor(inaTeg);
  Reading batt = readSensor(inaBatt);

  // Bus voltage is measured at VIN-; add the shunt drop to get the VIN+ side.
  float tegV = teg.busV + teg.shuntmV / 1000.0;
  float tegmA = teg.currentmA;
  float tegmW = tegV * tegmA;

  float battV = batt.busV;
  float battmA = batt.currentmA;
  float battmW = battV * battmA;

  Mode newMode = Mode::Idle;
  if (battmA > CHARGE_THRESHOLD_MA) newMode = Mode::Charging;
  else if (battmA < -USB_THRESHOLD_MA) newMode = Mode::UsbOut;

  if (newMode != mode) {
    printSessionEnd(mode, now);
    if (newMode != Mode::Idle && !CSV_OUTPUT) Serial.printf(">>> %s started\n", modeName(newMode));
    mode = newMode;
    modeSinceMs = now;
    sessionmWh = 0;
    sessionmAh = 0;
  }

  if (tegmW > 0) tegmWh += tegmW * dtHours;

  switch (mode) {
    case Mode::Charging:
      battInmWh += battmW * dtHours;
      battInmAh += battmA * dtHours;
      sessionmWh += battmW * dtHours;
      sessionmAh += battmA * dtHours;
      break;
    case Mode::UsbOut:
      usbOutmWh += -battmW * dtHours;
      usbOutmAh += -battmA * dtHours;
      sessionmWh += -battmW * dtHours;
      sessionmAh += -battmA * dtHours;
      break;
    case Mode::Idle:
      break;
  }

  bool charging = mode == Mode::Charging;
  float diodeV = charging ? teg.busV - (batt.busV + batt.shuntmV / 1000.0) : 0;
  float efficiency = charging && tegmW > 0 ? 100.0 * battmW / tegmW : 0;

  if (CSV_OUTPUT) {
    Serial.printf("%.1f,%s,%.3f,%.2f,%.2f,%.3f,%.2f,%.2f,%.3f,%.3f,%.3f,%.3f\n",
                  now / 1000.0, modeName(mode), tegV, tegmA, tegmW, battV, battmA, battmW,
                  diodeV, tegmWh, battInmWh, usbOutmWh);
    return;
  }

  Serial.printf("[%-8s] TEG %.3f V %6.1f mA %7.1f mW | Batt %.3f V %+7.1f mA %+8.1f mW",
                modeName(mode), tegV, tegmA, tegmW, battV, battmA, battmW);
  if (charging) Serial.printf(" | Diode %.2f V | Eff %.0f%%", diodeV, efficiency);
  Serial.printf(" | TEG %.2f mWh, In %.2f mWh, Out %.2f mWh", tegmWh, battInmWh, usbOutmWh);
  if (battInmWh > 0 && usbOutmWh > 0) Serial.printf(" (round trip %.0f%%)", 100.0 * usbOutmWh / battInmWh);
  Serial.println();

  if (tegmA < -BACKFLOW_THRESHOLD_MA) {
    Serial.printf("!!! INA219 #1 reads %.1f mA (negative = flowing back into the TEGs). Check the diode direction and INA219 #1 VIN+/VIN- order.\n", tegmA);
  }
  if (mode == Mode::UsbOut && battV < LOW_BATTERY_V) {
    Serial.println("!!! Battery below 3.0 V - turn the USB off to protect the cells");
  }
  if (charging && battV > FULL_BATTERY_V) {
    Serial.println("!!! Battery above 4.3 V - pack is full");
  }
}
