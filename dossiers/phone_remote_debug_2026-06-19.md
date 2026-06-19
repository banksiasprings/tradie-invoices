# Dossier — Remote Phone Debugging (Layer 2: live mirror + log stream)

**Date:** 2026-06-19
**Goal:** Let the Mac (or this Cowork session) watch Steven's phone live while it runs the
invoicing app in the cradle on the drive to work — real-time **screen mirror** (scrcpy) +
**every log line** the app emits (logcat) — carried over **Tailscale's** encrypted tunnel so
it works on home WiFi *or* LTE.

---

## TL;DR status

| Piece | State |
|---|---|
| scrcpy (Mac) | ✅ **Installed & tested** — `scrcpy 4.0` via Homebrew, connects to a live adb device |
| Tailscale GUI (Mac) | ⏳ **Downloaded, install needs Steven's password** — the `.pkg` step needs `sudo` (no TTY in this session) |
| Tailscale sign-in (Mac) | ⏳ Steven — his account, never automated |
| `scripts/monitor-phone.sh` | ✅ **Written & tested end-to-end** against a live adb device (both logcat branches + cleanup). IP/port placeholders pending phone setup |
| `scripts/setup-tailscale-debug.md` | ✅ Phone-side guide, phone-followable |
| README section | ✅ Added (“🔭 Remote Phone Monitoring”) |
| Phone on Tailscale | ⏳ Steven — install + sign in + send `100.x.y.z` IP and Wireless-debug port |
| ADB-over-Tailscale round-trip | ⏳ **Final confirmation blocked on phone** being on the tailnet (phone not reachable now) |

**Bottom line:** everything I could build and test on the Mac is done and verified. Two
things genuinely need Steven (Tailscale install password + account sign-in), and the
end-to-end Tailscale round-trip can only be confirmed once the phone is on the tailnet.

---

## What's verified on the Mac

- **Host:** Intel iMac (`Opens-iMac.local`), macOS 24.6.0, Homebrew 6.0.1.
- **Mac LAN IP:** `192.168.1.86` (en0).
- **adb:** `/Users/openclaw/Library/Android/sdk/platform-tools/adb` (present; **not on PATH** — scrcpy is told where via the `ADB` env var, handled in the script).
- **scrcpy:** `4.0`. Verified it connects to a live device, pushes `scrcpy-server`, detects the device, and negotiates codecs.
- **Invoicing app package name:** **`com.banksiasprings.invoices`** (confirmed via `pm list packages`). This is what logcat filters to.

### Phone was NOT reachable during this session
- `192.168.1.125` (the LAN IP from the earlier pairing) did **not** ping — phone is asleep / off home WiFi / on a different IP right now. So the live LAN smoke-test against the phone wasn't possible. The script's mechanics were instead tested against a live adb device on the same code path (see below).

---

## How the script was tested (honest verification log)

The phone wasn't here, so I tested every layer the script touches against a **live adb
device** (the local Android emulator, addressed exactly like a remote phone via
`127.0.0.1:5555` — same `adb connect ip:port` → `adb -s ip:port` code path):

1. **`adb connect ip:port` + device-online check** — ✅ connects, reads `ro.product.model`.
2. **logcat PID branch** (`APP_PKG` running) — ✅ `pidof` resolves the PID, `logcat --pid=<pid>` streams that app's lines only. Verified against a guaranteed-running process; an earlier direct run showed real `--pid` output streaming.
3. **logcat fallback branch** (app not running) — ✅ prints the “open the app” warning and falls back to errors-only (`'*:E'`, quoted so it survives the shell glob — bare `*:E` gets glob-expanded and errors under zsh).
4. **scrcpy launch** — ✅ scrcpy connects/negotiates. **Video frames could not be produced on the emulator** because the AVD only exposes **software** video encoders (`--list-encoders` shows `(sw)` only), and the AVD sw-encoder yields no frames (“Recording stopped before headers were processed”). **This is a documented emulator limitation, not a scrcpy/Mac/script fault** — Steven's real phone has a hardware encoder and will mirror fine. The live mirror gets its final confirmation on first real-phone connect.
5. **Cleanup trap** — ✅ logcat is killed when scrcpy exits; friendly teardown message prints.

### Bug found & fixed during testing
The first end-to-end run died silently right after “Phone online”. Root cause: `set -e`
+ `set -o pipefail` — the `APP_PID="$(pidof … | … )"` assignment **aborts the whole
script** when `pidof` exits non-zero (i.e. exactly when the app isn't running, the common
case). Fixed with a trailing `|| APP_PID=""` so it falls through to the errors-only branch
instead of exiting. Re-ran both branches afterward — both flow correctly. (This would have
bitten Steven every single time he ran the script before opening the app.)

### scrcpy v4 flag correction
The original spec used `--bit-rate 4M`. scrcpy **v2+ renamed that to `--video-bit-rate`**
(verified in `scrcpy --help`); the old flag errors on v4.0. The script uses
`--video-bit-rate 4M`.

---

## Deliverables (in the repo)

- **`scripts/monitor-phone.sh`** — single command: connect → app-scoped logcat (with
  errors-only fallback) → scrcpy mirror → clean teardown. Port fallback list
  (`5555 → 44143 → 37000 → 39000`). Overridable inline via `PHONE_IP` / `PHONE_PORT` /
  `APP_PKG` / `SCRCPY_EXTRA` env vars. **IP/port are placeholders** until Steven sends them.
- **`scripts/setup-tailscale-debug.md`** — phone-side, phone-followable: install Tailscale →
  sign in (same account) → enable VPN → grab the `100.x.y.z` IP → confirm Wireless Debugging.
- **`README.md`** — new “🔭 Remote Phone Monitoring (dev tooling)” section.

*(No app version bump: this is dev/ops tooling — no change to `www/index.html`, so the
APP_VERSION bump rule doesn't apply.)*

---

## What Steven needs to do

### A) Finish the Tailscale install on the Mac (one command, needs your password)
The GUI cask is already downloaded; only the privileged `.pkg` step is left. In **Terminal**:
```bash
brew install --cask tailscale
```
- Enter your Mac password when prompted.
- If macOS asks to approve a **system/kernel extension**: **System Settings → Privacy &
  Security** → **Allow** for Tailscale, then re-run the command if needed.
- Open **Tailscale** from the menu bar → **Sign in** (this is your account — pick whichever
  provider you'll also use on the phone).

Then grab the **Mac's Tailscale IP** (starts with `100.`):
```bash
tailscale ip -4    # if not found, try: /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
```
*(Or just read it from the Tailscale menu-bar app.)*

### B) Phone side (~3 min) — follow `scripts/setup-tailscale-debug.md`
Install Tailscale → sign in to the **same account** → enable VPN → **send back the phone's
`100.x.y.z` IP** and the **port** shown on the Wireless-debugging screen.

### C) Then I wire it up (once you send IP + port)
1. `adb connect <phone-100-ip>:<port>` (script tries fallback ports automatically).
2. If first-ever pair from this Mac: you send the 6-digit pairing code + pair-port → `adb pair`.
3. `adb devices` shows the phone over Tailscale → `./scripts/monitor-phone.sh` → mirror +
   log stream confirmed end-to-end. I'll fill the real IP/port into the script's defaults.

---

## Security / privacy / battery (carry-forward notes)

- **Encrypted, device-to-device.** Tailscale = WireGuard mesh between *your* signed-in
  devices only. Nobody else on WiFi/LTE, and not Tailscale itself, sees the traffic.
- **adb-over-Tailscale = full control of the phone** from the Mac (screen, input, logs,
  install). If the **Mac is lost/stolen:** https://login.tailscale.com → **Machines** →
  remove/disable the Mac. Access dies instantly.
- **Wireless Debugging auto-disables on reboot** (safe default) and its **port changes each
  reboot** — re-read it from the phone's Wireless-debugging screen after a reboot. No risky
  persistent USB-debug bridge was enabled.
- **Battery:** mirror + Tailscale + logcat drain noticeably — **keep the phone on the 12V
  charger** while monitoring.

---

## Open items / next session

1. Steven finishes Mac Tailscale install + sign-in; sends Mac's `100.` IP.
2. Steven completes phone-side setup; sends phone's `100.` IP + Wireless-debug port.
3. Confirm the **ADB-over-Tailscale round-trip** and **live scrcpy video** on the real
   phone; bake the real IP/port into `monitor-phone.sh` defaults.
4. (Optional) A launchd/login item or `tailscale up` flag so the Mac auto-reconnects, and a
   helper to read the phone's current Wireless-debug port over the already-up adb link so we
   don't have to re-fetch it manually after each phone reboot.

---

## 2026-06-19 — paired & end-to-end verified on the real phone

**Devices:** Mac Tailscale `100.107.176.12`; phone `steven-phone` `100.122.43.30` /
LAN `192.168.1.125`. Phone = Motorola Edge 50 Neo ("vienna"), Android 16.

**Pairing — DONE ✅ (route-independent trust, persists across reboots).**
`adb pair` over Tailscale failed (phone's Tailscale node was offline at the time), so the
script's LAN fallback paired instead: `Successfully paired to 192.168.1.125:39679
[guid=adb-ZY22KBQWCF-cBV18y]`. The trust is not route-specific — it applies over Tailscale too.

**Connect port — auto-discovered, no extra screenshot.** On the same LAN, `adb mdns services`
revealed `_adb-tls-connect._tcp 192.168.1.125:41767`, and the phone auto-connected. Baked
`41767` into the script default. ⚠️ This port **changes on reboot / WiFi-debug toggle** — on
LAN re-discover with `adb mdns services`; over Tailscale read it off the Wireless-debugging
screen and pass `PHONE_PORT=`.

**Pipeline — VERIFIED end-to-end on the real phone (over LAN):**
- scrcpy: a 3s `--no-window --record` captured **152,535 bytes of real H.264** — the mirror
  works on real hardware (the thing the emulator's sw-encoder could never prove).
- logcat: streams from the phone over the adb-tls link.

**⚠️ THE reliability blocker — the phone drops connections when idle.**
- `tailscale status` showed `steven-phone … offline, last seen 3h ago` (relay syd, rx 0) — the
  phone's VPN had dropped. So **cellular monitoring won't work until Tailscale is reconnected
  on the phone.**
- Even on LAN, the wireless-debug connection dropped after ~1 min idle (`41767` went to
  "Connection refused", mDNS stopped advertising) — Android Doze suspends adbd-wireless when
  the screen is off.
- **Fix (phone side):** (a) keep the phone **awake + charging** — Developer options → **"Stay
  awake"** is ideal for the 12V cradle; (b) **reconnect Tailscale** and make it stick:
  Always-on VPN + battery optimization **Unrestricted** for Tailscale; (c) keep Wireless
  debugging on and battery-unrestricted. This is almost certainly the root of the earlier
  "can't login" flakiness too — the VPN simply wasn't staying up.

**Watch commands (run on the Mac):**
- Home / same WiFi:  `PHONE_IP=192.168.1.125 ./scripts/monitor-phone.sh`
- Anywhere (once the phone's Tailscale is back online):  `./scripts/monitor-phone.sh`
