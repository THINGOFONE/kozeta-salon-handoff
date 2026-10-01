import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";
import { buildStaticHomeHtml } from "./staticHomeContent";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

const KNOWN_SPA_ROUTES = new Set(["/", "/admin/products", "/admin/deposits"]);

function isKnownRoute(pathname: string): boolean {
  return KNOWN_SPA_ROUTES.has(pathname);
}

function build404Html(isDev: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>404 Not Found — Kozeta Salon &amp; Spa</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #faf9f7; color: #333; }
    .box { text-align: center; padding: 2rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { color: #666; margin-bottom: 1.5rem; }
    a { color: #8b6f4e; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="box">
    <h1>404 — Page Not Found</h1>
    <p>The page you're looking for doesn't exist.</p>
    <a href="/">Return to Kozeta Salon &amp; Spa</a>
  </div>
</body>
</html>`;
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    const pathname = url.split("?")[0];

    if (!isKnownRoute(pathname)) {
      res
        .status(404)
        .set({ "Content-Type": "text/html" })
        .end(build404Html(true));
      return;
    }

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );

      if (pathname === "/") {
        template = template.replace(
          '<div id="root"></div>',
          `<div id="root"></div>${buildStaticHomeHtml()}`,
        );
      }

      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  app.use("*", (req, res) => {
    const pathname = req.originalUrl.split("?")[0];

    if (!isKnownRoute(pathname)) {
      res
        .status(404)
        .set({ "Content-Type": "text/html" })
        .end(build404Html(false));
      return;
    }

    if (pathname === "/") {
      const indexPath = path.resolve(distPath, "index.html");
      fs.readFile(indexPath, "utf-8", (err, html) => {
        if (err) {
          res.status(500).send("Internal Server Error");
          return;
        }
        const injected = html.replace(
          '<div id="root"></div>',
          `<div id="root"></div>${buildStaticHomeHtml()}`,
        );
        res.status(200).set({ "Content-Type": "text/html" }).end(injected);
      });
      return;
    }

    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
