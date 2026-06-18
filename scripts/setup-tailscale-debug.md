# 📱 Phone setup — remote debugging over Tailscale

*This is the phone-side half. Do these steps **on the Motorola Edge 50 Neo**. You can read this guide right on the phone while you do it. The Mac side is already done by Claude.*

**Why:** so the Mac can see your phone's screen (live mirror) and every log line the invoicing app prints — over an encrypted Tailscale tunnel — whether you're on home WiFi or out on LTE. Useful for debugging the app while it runs in the cradle on the drive to work.

**Time:** ~3 minutes. You do this **once**; after that it just works.

---

## Step 1 — Install Tailscale

1. Open the **Play Store**.
2. Search **Tailscale**.
3. Install it (publisher: *Tailscale Inc.*).

## Step 2 — Sign in to the SAME account as the Mac

1. Open **Tailscale**.
2. Tap **Sign in** (or **Get started**).
3. Sign in with **the exact same account the Mac uses** — whatever you signed into on the Mac (Google / Microsoft / GitHub / email). ⚠️ Different account = the two devices can't see each other. Same account is the whole point.

## Step 3 — Turn the VPN ON

1. Tap the big **Connect** toggle so it goes **green / on**.
2. Android will pop up **"Connection request — Tailscale wants to set up a VPN connection."** Tap **OK / Allow**.
3. You'll see a small **key icon** 🔑 in the status bar — that means the tunnel is up.
4. Leave Tailscale connected. (It sits quietly in the background; barely uses battery when idle.)

## Step 4 — Grab the phone's Tailscale IP — **send this to Claude/Steven's Mac**

1. In the Tailscale app, your device is listed at the top (its name, e.g. *moto-edge-50-neo*).
2. Under it you'll see an IP that starts with **`100.`** — e.g. `100.x.y.z`. That's the phone's Tailscale IP.
3. **Send that `100.x.y.z` address back** so the Mac side can wire up. (Tap it to copy.)

## Step 5 — Confirm Wireless Debugging is ON (stays on)

*You've used this before for the APK installs, so it's probably already set.*

1. **Settings → System → Developer options** (if Developer options is hidden: Settings → About phone → tap **Build number** 7 times).
2. Scroll to **Wireless debugging** → make sure it's **ON**.
3. Tap into **Wireless debugging** and note the **IP address & Port** shown at the top — it looks like `192.168.x.x:42385` *(the port changes each boot)*. Over Tailscale we use the phone's `100.` address instead, but having Wireless debugging on is what lets adb connect at all.
4. If the Mac has never paired with this phone before, you may need **Pair device with pairing code** once (tap it → it shows a 6-digit code + a `…:port` address → send both to the Mac so it can run `adb pair`). After the first pair, plain `adb connect` works.

> **Note on ports:** modern Android Wireless Debugging uses a **random port that changes every reboot** (e.g. `42385`, `44143`…). The *connect* port is shown at the top of the Wireless debugging screen. If the Mac can't connect after a reboot, just re-open that screen and send the new `…:port` over.

---

## Daily use (after first-time setup)

1. Put the phone in the **12V cradle** and **plug it in** — screen mirroring + Tailscale + logcat all drain battery noticeably. Keep it on power.
2. Make sure **Tailscale is connected** (🔑 in the status bar).
3. Open the **invoicing app**.
4. Tell the Mac to run `./scripts/monitor-phone.sh` — the screen mirror window + log stream come up.

---

## Privacy & security (read once)

- **Encrypted, peer-to-peer.** Tailscale builds a direct, end-to-end-encrypted (WireGuard) tunnel between *your* signed-in devices only. Nobody else on WiFi/LTE — and not Tailscale itself — can see the traffic.
- **The Mac gets full control of the phone** over this link (adb = screen, input, logs, install). That's the power *and* the risk.
- **If the Mac is ever lost or stolen:** go to **https://login.tailscale.com → Machines**, find the Mac, and **remove / disable** it. The tunnel dies instantly and that device can no longer reach the phone.
- **Wireless Debugging auto-disables on reboot** on most builds — a safe default. If you reboot the phone, just flip it back on (Step 5) before the next session.
- Account credentials are always **yours to enter** — Claude never touches your Tailscale login.
