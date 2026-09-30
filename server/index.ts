import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import compression from "compression";
import { registerRoutes } from "./routes";
import { storage } from "./storage";
import { setupVite, serveStatic, log } from "./vite";
import { randomUUID } from "crypto";
import { persistenceMode } from "./persist";
import { osrmStatus } from "./road-distance";

// One id per server process. The client compares it across responses: if two
// ids answer the same page, two instances are running without a shared
// database, and a change saved on one is invisible on the other.
const INSTANCE_ID = randomUUID().slice(0, 8);
const STARTED_AT = new Date().toISOString();

const app = express();
// 9,000 outlets are 3 MB of JSON and every page fetches them after every
// edit; gzip brings that to a few hundred KB. SSE is left alone so progress
// events are not buffered.
app.use(compression({ filter: (req, res) => req.path.startsWith('/api/optimize/progress') ? false : compression.filter(req, res) }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((_req, res, next) => {
  res.setHeader("X-App-Instance", INSTANCE_ID);
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Serve nothing until the saved state is back: on the published site it
  // comes from Postgres, and a request answered before that would see an
  // empty store and could overwrite the real one.
  await storage.ready;

  app.get("/api/health", async (_req, res) => {
    res.json({
      instance: INSTANCE_ID,
      startedAt: STARTED_AT,
      persistence: persistenceMode(),
      outlets: (await storage.getOutlets()).length,
      env: process.env.NODE_ENV || "development",
      osrm: await osrmStatus(),
    });
  });

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
