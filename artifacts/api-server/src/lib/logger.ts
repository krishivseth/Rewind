import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "req.headers['x-rewind-key']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

// Keep operator warnings and recovery events observable even when routine
// application logging is restricted to errors. Route by the event field.
export const operatorLogger = logger.child(
  { notificationChannel: "operator", component: "snapshot_cleanup" },
  { level: "info" },
);
