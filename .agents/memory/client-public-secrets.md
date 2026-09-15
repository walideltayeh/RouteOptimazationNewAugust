---
name: Client-side public secrets
description: How to supply intentionally public browser SDK keys stored without a Vite prefix.
---

Public browser SDK keys stored in Replit Secrets without a `VITE_` prefix are available to the server but not through `import.meta.env` in Vite client code. Expose only intentionally public values through a same-origin configuration endpoint and load them before initializing the browser SDK.

**Why:** The Mapbox public key existed in the workspace but both map components saw no browser token.

**How to apply:** Use this approach for public SDK configuration only. Do not use it for private credentials or other sensitive server secrets.