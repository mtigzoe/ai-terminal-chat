# AI Terminal Chat — React Client

This directory contains the React frontend for the AI Terminal Chat application.

## Prerequisites

- Node.js 22 LTS and npm
- The Flask backend running from the project root

For Windows Electron packaging, use Node.js 22 LTS.

Verified packaging environment:
- Node.js: v22.23.2
- npm: 10.9.8

Check your installed versions with:

```bash
node -v
npm -v
```

## Installation

From the `client-react` directory, install the dependencies:

```bash
npm ci
```

`npm ci` installs the client/Electron dependencies from `package-lock.json` and is recommended for a clean, reproducible setup after cloning the repository.

## Run the app

Start the Vite development server with:

```bash
npm run dev
```

The React client will normally be available at:

```text
http://localhost:3000
```

## Backend API

The React client communicates with the Flask backend. By default, it expects the backend at:

```text
http://localhost:9000
```

The backend provides these endpoints:

- `/chat` — normal, non-streaming chat responses
- `/stream` — streaming chat responses

Make sure the Flask backend is running before using the React client.

## API URL configuration

You can point the React client at a different backend by setting `VITE_API_URL` in a `.env` file in the `client-react` directory.

For example:

```text
VITE_API_URL=http://localhost:9000
```

If `VITE_API_URL` is not set, the client defaults to `http://localhost:9000`.

## Electron (Stage 1)

A minimal Electron shell is provided so the same React frontend can run as a desktop window while continuing to talk to the existing Flask backend.

### Development workflow

1. Start the Flask backend (from `server-python`) as usual.
2. In one terminal, start the Vite development server:

   ```bash
   npm run dev
   ```

3. In a second terminal, launch Electron:

   ```bash
   npm run electron:dev
   ```

In development (unpackaged) Electron always loads `http://localhost:3000`. The browser-based workflow (`npm run dev` alone) remains unchanged.

### Packaged / production builds

When the application is packaged, Electron loads `dist/index.html` from the application resources. A leftover `dist/` directory on disk does not affect unpackaged development runs.

## Build and release

### Production web build

Build the production React application with:

```powershell
npm run build
```

The production files are generated in `dist/`.

### Windows installer

Build the Windows NSIS installer with:

```powershell
npm run electron:build:win
```

The installer is generated in `release/` with a filename like:

```text
AI-Terminal-Chat-Setup-0.1.0.exe
```

### Windows portable build

Build the portable Windows executable with:

```powershell
npm run electron:build:win:portable
```

The portable executable is generated in `release/` with a filename like:

```text
AI-Terminal-Chat-Portable-0.1.0.exe
```

Both Electron build commands automatically prepare the bundled TypeScript backend and install its production dependencies with `npm ci --omit=dev`. You do not need to run that backend installation manually.

### GitHub Releases

After building a Windows release, upload the generated `.exe` files from `release/` to the corresponding GitHub Release.

For example, to create a new release:

```powershell
gh release create v0.1.0 .\release\AI-Terminal-Chat-Setup-0.1.0.exe .\release\AI-Terminal-Chat-Portable-0.1.0.exe --title "AI Terminal Chat v0.1.0"
```

For a portable build added to an existing release:

```powershell
gh release upload v0.1.0 .\release\AI-Terminal-Chat-Portable-0.1.0.exe
```

Do not commit generated `.exe` files to the repository.

Before creating a release, update the `version` field in `package.json` as appropriate. Electron Builder uses that version in the generated artifact filenames.

### Notes

- No automatic Flask process management is performed in Stage 1.
- The preload script exposes only a read-only `window.electronAPI.isElectron` flag.
- Context isolation and sandboxing are enabled; Node integration is disabled in the renderer.

