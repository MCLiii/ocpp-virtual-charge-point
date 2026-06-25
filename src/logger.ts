import { createLogger, format, transports } from "winston";

const linePrintf = format.printf((info) => {
  const { level, message, timestamp, ...meta } = info;
  return `${timestamp} ${level}: ${message} ${
    Object.keys(meta).length ? JSON.stringify(meta) : ""
  }`;
});

// vcp.sh tails a per-charger log file to surface things like the Scan & Charge
// payment link (SetDisplayMessage). The console transport only reaches the
// terminal the simulator runs in, so always mirror to a file at the path vcp.sh
// derives from CP_ID (override with LOG_FILE). Written without color so the
// file stays clean for vcp.sh's greps.
const logFile =
  process.env.LOG_FILE ?? `/tmp/vcp_${process.env.CP_ID ?? "vcp"}.log`;

export const logger = createLogger({
  transports: [
    new transports.Console({
      format: format.combine(
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.colorize(),
        format.simple(),
        linePrintf,
      ),
      level: process.env.LOG_LEVEL ?? "info",
    }),
    new transports.File({
      filename: logFile,
      format: format.combine(
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.uncolorize(),
        format.simple(),
        linePrintf,
      ),
      level: process.env.LOG_LEVEL ?? "info",
    }),
  ],
});
