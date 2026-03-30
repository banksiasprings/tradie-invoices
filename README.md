# Invoice & PDF Generator

A Progressive Web App (PWA) for tradespeople to manage timesheets, track work hours, and generate professional PDF invoices.

## Features

- **GPS Geofencing** — automatically start/stop the timer when you arrive or leave a worksite
- **Interactive Map** — pin worksites on a hybrid satellite map with adjustable geofence radius (50m–500m)
- **Time Tracking** — separate Standard Rate and Extra Labourer hours with automatic subtotals
- **Machine Hire** — log Excavator, Grader, Bobcat, Dozer, or Tractor hours with editable rates
- **Multiple Clients** — store and manage multiple client details for invoicing
- **GST Toggle** — optional 10% GST on invoices
- **PDF Export** — generate and save professional invoices as PDF files
- **Saved Invoices** — view, export, and delete saved invoices within the app (IndexedDB)
- **Installable PWA** — install directly from Chrome on Android or iOS

## Live App

**[Open in Browser](https://banksiasprings.github.io/mcnichol-invoices/)**

## Install on Android

Download the signed APK from the [Releases](https://github.com/banksiasprings/mcnichol-invoices/releases) page.

> **Note:** Enable "Install from unknown sources" in Android settings before installing.

## Tech Stack

- Vanilla HTML/CSS/JavaScript (no framework dependencies)
- Leaflet.js for interactive maps
- ESRI World Imagery for satellite map tiles
- Web Notifications API for geofence alerts
- IndexedDB for local invoice storage
- Service Worker for offline support

## Getting Started (Development)

```bash
git clone https://github.com/banksiasprings/mcnichol-invoices.git
cd mcnichol-invoices
# Open index.html in a browser — no build step required
```

## License

MIT
