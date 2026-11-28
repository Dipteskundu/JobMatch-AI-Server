

import "./config/dotenv.js";
import app from "./server/app.js";
import { loadEnv } from "./config/env.js";

const { env } = loadEnv();
const PORT = Number(env.PORT) || 5001;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    // Server started silently; port info available via /health endpoint
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[server] Port ${PORT} is already in use. Stop the existing backend process or set PORT to another available port.`,
      );
    } else {
      console.error(`[server] Failed to listen on port ${PORT}.`, err);
    }

    process.exit(1);
  });
}

export default app;
