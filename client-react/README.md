# AI Terminal Chat — React Client

This directory contains the React frontend for the AI Terminal Chat application.

## Prerequisites

- Node.js and npm
- The Flask backend running from the project root

## Installation

From the `client-react` directory, install the dependencies:

```bash
npm install
```

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
   npm run electron
   ```

Electron loads `http://localhost:3000`. The browser-based workflow (`npm run dev` alone) remains unchanged.

### Using the production build

After running `npm run build`, Electron will prefer the local `dist/index.html` when it is present. Start the Flask backend, then run:

```bash
npm run electron
```

### Notes

- No automatic Flask process management is performed in Stage 1.
- The preload script exposes only a read-only `window.electronAPI.isElectron` flag.
- Context isolation and sandboxing are enabled; Node integration is disabled in the renderer.
