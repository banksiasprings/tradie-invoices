# 📋 mcnichol-invoices

[![Live Demo](https://img.shields.io/badge/live%20demo-mcnichol--invoices-brightgreen)](https://banksiasprings.github.io/mcnichol-invoices/)

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
1. **Open the app:** https://banksiasprings.github.io/mcnichol-invoices/
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
git clone https://github.com/banksiasprings/mcnichol-invoices.git
cd mcnichol-invoices
# Serve the root directory with any static file server
python3 -m http.server 8000
# Open http://localhost:8000 in your browser
```

## 📸 Screenshots

- Time tracking dashboard with map view
- Invoice generation interface
- Admin panel for client management

## 📄 License

MIT – See LICENSE file for details

---

**Found a bug?** [Open an issue](https://github.com/banksiasprings/mcnichol-invoices/issues). **Want to contribute?** PRs welcome!
