# GateClerk Terminal

Desktop application for GateClerk gate terminals. Built with Electron.

## Development Setup

### Prerequisites
- Node.js 18 or higher
- npm

### Install dependencies
```bash
npm install
```

### Run in development
```bash
npm start
```

## Building the Windows Installer

### Build unsigned (development/testing)
```bash
npm run build:unsigned
```

### Build signed (production — requires code signing certificate)
```bash
npm run build
```

The installer will be output to `dist/GateClerk Setup 1.0.0.exe`

## Auto-Update

Updates are published to GitHub Releases. When a new version is released:
1. Bump the version in `package.json`
2. Build the installer
3. Create a GitHub Release with tag `v{version}`
4. Attach the installer `.exe` and `latest.yml` from the `dist` folder

The app checks for updates on launch and installs them silently on next restart.

## Printer Setup

The app uses the Windows default printer. Set the receipt printer as the default
printer in Windows Settings before running the app.

Recommended paper size setting in printer driver: 80mm width, auto height.

## Architecture

- `main.js` — Electron main process. Manages the window, handles print jobs,
  checks for updates.
- `preload.js` — Secure bridge. Exposes `window.electronAPI.printTicket()` to
  the gate terminal web page.
- The gate terminal UI loads from `https://gateclerk.com/g/` — no local HTML
  needed. Updates to the UI deploy via Netlify as normal.

## Code Signing (future)

1. Purchase a code signing certificate from DigiCert or Sectigo (~$300-500/yr)
2. Install the certificate on your build machine
3. Add certificate config to `package.json` under `build.win`
4. Run `npm run build` (not build:unsigned)
