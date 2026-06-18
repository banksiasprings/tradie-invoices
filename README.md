# 📋 Tradie Invoices

[![Live Demo](https://img.shields.io/badge/live%20demo-tradie--invoices-brightgreen)](https://banksiasprings.github.io/tradie-invoices/)

A professional Invoice & PDF Generator PWA for sole traders and small businesses. Built for earthmoving contractors, it combines GPS-based worksite detection, time tracking, and invoice generation in one sleek interface.

## ✨ Features

- **GPS Worksite Detection** – Automatically detects and logs work locations using geofencing
- **Time Tracking** – Check-in/check-out with automated timers and manual overrides
- **Machine Hire Logging** – Track equipment usage with hourly rates
- **Standard & Extra Rates** – Different rates for standard hours vs. overtime
- **PDF Invoice Generation** – Professional invoices with custom branding
- **Multi-User Auth** – Secure Firebase authentication with role-based access
- **Admin Panel** – Manage clients, rates, and invoice templates
- **Cloud Sync** – Real-time Firebase Firestore sync across devices
- **GST Support** – Optional 10% GST calculation per invoice
- **Offline Support** – Full PWA with service worker caching
- **Installable** – Add to home screen on Android & iOS
- **Clean UI** – Navy and amber color scheme for professional appearance
- **Version:** v3

## 🛠️ Tech Stack

- **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3
- **Mapping:** Leaflet.js with ESRI World Imagery
- **Backend:** Firebase (Firestore + Authentication)
- **PDF:** jsPDF library
- **Storage:** IndexedDB for local caching
- **PWA:** Service Worker for offline functionality
- **Hosting:** GitHub Pages

## 🚀 Getting Started

### For Users
1. **Open the app:** https://banksiasprings.github.io/tradie-invoices/
2. **Sign up or login** with your email
3. **Set up your clients** and hourly rates in settings
4. **Start tracking work:**
   - Click "Check In" at your worksite (GPS optional)
   - Device will automatically detect geofence entry
   - Click "Check Out" when done
5. **Generate invoices:**
   - Review your timesheet
   - Adjust rates if needed
   - Generate and download PDF

### For Development
```bash
git clone https://github.com/banksiasprings/tradie-invoices.git
cd tradie-invoices
# Serve the root directory with any static file server
python3 -m http.server 8000
# Open http://localhost:8000 in your browser
```

## 🔭 Remote Phone Monitoring (dev tooling)

When the app is running on the real phone (e.g. in the 12V cradle on the drive to a
worksite), you can watch it live from the Mac — screen mirror **and** every log line
the app prints — over an encrypted [Tailscale](https://tailscale.com) tunnel that works
on WiFi *or* LTE.

```bash
./scripts/monitor-phone.sh        # opens scrcpy mirror + streams the app's logcat
```

- **scrcpy** mirrors the phone screen in real time.
- **logcat** streams `com.banksiasprings.invoices`'s output (auto-scoped to the app's
  PID — this is where `[GeoLog]` and `Capacitor/Console` lines show up).
- **Tailscale** carries it end-to-end encrypted; only Steven's signed-in devices can see
  each other.

First-time phone setup (install Tailscale, sign in, grab the phone's `100.x.y.z` IP) is a
~3-minute, phone-followable guide: **[`scripts/setup-tailscale-debug.md`](scripts/setup-tailscale-debug.md)**.
Once set up, override the target inline without editing the script:

```bash
PHONE_IP=100.x.y.z PHONE_PORT=42385 ./scripts/monitor-phone.sh
```

> Keep the phone on the 12V charger while monitoring — mirror + Tailscale + logcat drain
> the battery noticeably. If the Mac is ever lost/stolen, remove it from
> [the Tailscale admin console](https://login.tailscale.com) to instantly cut its access.

## 📸 Screenshots

- Time tracking dashboard with map view
- Invoice generation interface
- Admin panel for client management

## 📄 License

MIT – See LICENSE file for details

---

**Found a bug?** [Open an issue](https://github.com/banksiasprings/tradie-invoices/issues). **Want to contribute?** PRs welcome!
