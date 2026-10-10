# Joltean: TEG Waste-Heat Harvester

Joltean shows how waste heat from a data center could be turned back into usable electricity, using an older gaming laptop as a stand-in for a server. Four SP1848 thermoelectric generators (TEGs) sit between two aluminum plates. The top plate presses against the bottom of the running laptop, and the bottom plate rests in ice water. The temperature difference across the modules produces electricity, which charges a pack of three NiMH AA cells. An ESP32 measures the TEG output, the battery current and both plate temperatures. On demo day, the stored energy charges a phone through a 5 V USB boost module.

## Wiring diagram

**Interactive diagram:** [Cirkit Designer project](https://app.cirkitdesigner.com/project/c7100911-46c1-4ae9-b2e7-7fafb2f43829)

# INSERT IMAGE OF DIAGRAM

The diagram uses Cirkit's TEC1-12706 part as a placeholder. The real modules are SP1848-27145 generators.

### Power path

```
TEG array + → INA219 #1 VIN+
INA219 #1 VIN− → 1N5819 anode
1N5819 cathode (band) → harvest switch → INA219 #2 VIN+
Boost IN+ → USB switch → INA219 #2 VIN+
INA219 #2 VIN− → battery +
Battery −, TEG array −, boost IN−, all GND pins → common ground rail
```

Each INA219 gets exactly one wire on VIN+ and one on VIN−. The screw terminals and the header pins with the same label are the same connection.

### Sensor pins

| Sensor | ESP32 pins | Notes |
| --- | --- | --- |
| INA219 #1 (TEG side) | SDA GPIO 21, SCL GPIO 22 | I²C bus 1 (`Wire`), address 0x40 |
| INA219 #2 (battery side) | SDA GPIO 25, SCL GPIO 26 | I²C bus 2 (`Wire1`), address 0x40 |
| DS18B20 hot plate | DAT GPIO 4 | 4.7 kΩ pull-up from DAT to 3V3 |
| DS18B20 cold plate | DAT GPIO 27 | 4.7 kΩ pull-up from DAT to 3V3. GPIO 5 also works; change `COLD_PROBE_PIN`. |

All sensor VCC pins go to ESP32 3V3, and all GND pins go to the common ground. The two INA219s sit on separate I²C buses, so both stay at 0x40 and neither A0 pad needs soldering. Power the ESP32 from USB only, never from the battery pack.

## Bill of materials

| Item | Qty | Approx. price | Notes |
| --- | --- | --- | --- |
| **Harvesting** | | | |
| SP1848-27145 TEG (Comimark 2-pack) | 3 packs (6 modules) | $29.07 | 4 in series, 2 spares |
| 1060 aluminum plate, 100×100×5 mm | 2 | $19.98 | Top plate under the laptop, bottom plate in the ice water |
| 1N5819 Schottky diodes | 1 pack | $5–7 | Stops the pack draining back into the TEGs |
| ARCTIC MX-4 thermal paste, 4 g | 1 | $4.99 | Thin layer on every TEG and plate face |
| Thermal pad, 1.5–2 mm, ~100×100 mm | 1 | $8–12 | Between the laptop bottom and the top plate |
| M3 nylon screws and nuts | 1 kit | $6–8 | Clamp the plates evenly |
| **Storage and output** | | | |
| Amazon Basics AA NiMH, 2400 mAh | 1 pack | $6.43 | 3 matched cells in use |
| AA battery holder bundle (1/2/3/4AA) | 1 | $4.99 | Use the 3AA holder |
| 0.9–5 V to 5 V 600 mA USB boost (10-pack) | 1 | $7.99 | Charges the phone on demo day |
| USB-A to USB-C cable | 1 | $6–10 | Boost module to iPhone |
| SPST toggle switches | 2 | — | One for the harvest path, one for USB output |
| **Sensing and logging** | | | |
| ESP32 dev board | 1 | — | Powered from USB, not the pack |
| INA219 breakout (2-pack) | 1 | $6.99 | #1 on the TEG output, #2 in series with the pack |
| DS18B20 probe kit | 1 | $8.99 | One probe on each plate |
| 4.7 kΩ resistors | 2 | — | One pull-up per probe data line. Skip if using the DROK adapter boards. |
| Breadboard and jumper wires | — | $8–10 | Common ground and 3V3 rails |
| **Cold side** | | | |
| Shallow pan or tray | 1 | $5–10 | Bottom plate rests in a few millimeters of ice water |
| Reusable gel packs | 4–6 | $10–15 | Rotate between the freezer and the setup |
| Bagged ice | As needed | ~$3 per bag | About 1 kg every 4–6 hours |
| Closed-cell foam sheet | 1 | $8–12 | Fills gaps around the TEGs and insulates the pan |
| Kapton tape | 1 roll | $6 | Holds the probes and wires in place |

**Tools:** soldering iron and solder, multimeter, wire strippers, heat-shrink tubing, a drill with a 3.2–3.5 mm bit, a small screwdriver and isopropyl alcohol.

## Hot side and cold side

Each SP1848 has two ceramic faces:

| Face | Faces toward | Side |
| --- | --- | --- |
| **Blank face** (no text) | Top plate and laptop | **Hot** |
| **Printed face** (part number) | Bottom plate and ice water | **Cold** |

To check the orientation, hold a module with its blank face against your hand and its printed face on something cold, and measure across its leads. Red should read **positive** relative to black. A negative reading means the module is flipped. Keep all four facing the same way, or they cancel each other out.

## Building the plate and TEG stack

The stack, top to bottom:

```
Laptop (solid area near the CPU/GPU)
Thermal pad
Top aluminum plate           ← hot side
Thermal paste
4 TEGs, blank face up, printed face down
Thermal paste
Bottom aluminum plate        ← cold side
Ice water in the pan
```

### 1. Prepare the plates
1. Clamp the two plates together and drill one hole near each corner, about 8 mm in from the edges, through both plates at once so the holes line up.
2. Peel any protective film and wipe both faces of each plate with isopropyl alcohol.

### 2. Wire the TEGs in series
1. Lay the 4 modules in a 2×2 square, **printed side down**, with all the leads coming out the same side.
2. Connect TEG 1 red → TEG 2 black, TEG 2 red → TEG 3 black, and TEG 3 red → TEG 4 black. Solder each joint and cover it with heat-shrink.
3. TEG 1's free black lead is the **array −**. TEG 4's free red lead is the **array +**.
4. Check with the multimeter: with the blank faces warm and the printed faces cold, the array should read about the sum of the four modules.

### 3. Apply the paste and assemble
1. **Bottom layer:** spread a thin layer of MX-4 on the bottom plate where each TEG will sit. Place the wired array **printed side down**, centered, with 2–5 mm between modules.
2. **Top layer:** spread a thin layer of paste on the four blank faces, then set the top plate on them with the holes lined up.
3. Use about the thickness of a sheet of paper. Too much paste insulates instead of conducting.
4. **Insulate:** cut closed-cell foam to fill the gaps between the plates around the TEGs. Keep it no thicker than the modules (about 3.6 mm), or it will hold the plates apart.
5. **Clamp:** push the nylon M3 screws through the corner holes and add the nuts. Tighten in a cross pattern, finger-tight plus a small turn. Overtightening cracks the ceramic.
6. **Probes:** tape the hot-plate DS18B20 to the top plate and the cold-plate DS18B20 to the bottom plate's top face, each right beside a TEG, with a dab of paste under the tip and Kapton tape over it.
7. **Thermal pad:** lay it on the top plate, where the laptop will sit.

### 4. Set up the cold side
1. Put the pan inside foam or a cooler and add ice water a few millimeters deep.
2. Rest the stack in it. The water should touch the bottom plate's underside but stay **below the TEGs and every wire joint**.
3. Set the laptop on the pad and support the rest of it at the same height so it sits level with its vents clear.

## Firmware

| Sketch | Purpose |
| --- | --- |
| `complete_hardware_test/` | Full system test: both INA219s, both temperature probes, mode detection, energy totals and warnings |
| `teg_harvester/` | Power monitoring only, without the temperature probes |
| `ina219_battery_test/` | One INA219 between the battery and the USB boost |

Required libraries: **Adafruit INA219**, **OneWire** and **DallasTemperature**. Open the Serial Monitor at 115200 baud. Set `CSV_OUTPUT = true` for logging to a spreadsheet.

## Safety

- Never let the battery pack's two leads touch.
- Keep every wire joint, INA219 board and the ESP32 above the water line and away from condensation.
- Use 3 matched NiMH cells of the same brand, capacity and age. Never mix in alkaline cells.
- Stop discharging when the pack reaches about 3.0 V.
- Keep the laptop's intake vents clear the whole time it runs under load.
