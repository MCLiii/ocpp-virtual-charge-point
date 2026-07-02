/**
 * Ivora VCP test console — TypeScript replacement for the old vcp.sh.
 *
 * Drives the running simulator through its admin API (POST :PORT/execute). The
 * simulator then talks to CitrineOS as the charger. Models the real flow:
 *
 *   pay (web/QR)  ->  charger arms (RemoteStart)  ->  PLUG IN  ->  auto-start
 *                                                     UNPLUG   ->  stop & settle
 *
 * Run via `npm run cli` (or `./vcp.sh` which shims to it).
 */
import * as readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";

const CP_ID = process.env.CP_ID ?? "cp001";
const ADMIN_PORT = process.env.ADMIN_PORT ?? "9999";
const ADMIN_URL = `http://localhost:${ADMIN_PORT}/execute`;
const HEALTH_URL = `http://localhost:${ADMIN_PORT}/`;
const LOG_FILE = process.env.LOG_FILE ?? `/tmp/vcp_${CP_ID}.log`;
const OPERATOR_UI = process.env.OPERATOR_UI ?? "https://csms-test.ivoracharge.com";

const C = {
  green: "\x1b[0;32m",
  yellow: "\x1b[0;33m",
  red: "\x1b[0;31m",
  dim: "\x1b[2m",
  off: "\x1b[0m",
};
const now = () => new Date().toISOString();

async function post(action: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(ADMIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
    const text = await res.text();
    if (!res.ok || text.trim() !== "OK") {
      console.log(`${C.red}simulator did not accept "${action}": ${text || res.status}${C.off}`);
      return false;
    }
    console.log(`${C.green}sent${C.off} ${action}`);
    // surface the charger's latest received message for context
    if (existsSync(LOG_FILE)) {
      await new Promise((r) => setTimeout(r, 700));
      const last = readFileSync(LOG_FILE, "utf8")
        .split("\n")
        .filter((l) => l.includes("Receive message"))
        .pop();
      if (last) console.log(`${C.dim}${last.slice(24, 220)}${C.off}`);
    }
    return true;
  } catch (e) {
    console.log(`${C.red}cannot reach the simulator on :${ADMIN_PORT} — is it running? (./setup-scripts/setup-vcp.sh)${C.off}`);
    return false;
  }
}

const statusNotification = (connectorStatus: string) =>
  post("StatusNotification", {
    evseId: 1,
    connectorId: 1,
    connectorStatus,
    timestamp: now(),
  });

// ---------------------------------------------------------------------------
// Log parsing: the simulator log is the console's only window into the OCPP
// traffic, so status / debug views reconstruct charger state from it.
// ---------------------------------------------------------------------------

// The simulator logs with winston colorize, so lines may carry ANSI codes.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface OcppFrame {
  ts: string; // "YYYY-MM-DD HH:MM:SS" log timestamp
  dir: "sent" | "recv";
  raw: unknown[]; // the OCPP frame: [2,id,action,payload] | [3,id,payload] | [4,id,code,desc,details]
}

/** Parse every OCPP frame ("Sending message" / "Receive message" lines) from the log. */
function readLogLines(): string[] {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, "utf8")
    .split("\n")
    .map((l) => l.replace(ANSI_RE, ""));
}

function readOcppFrames(lines: string[]): OcppFrame[] {
  const frames: OcppFrame[] = [];
  for (const l of lines) {
    const sent = l.includes("Sending message");
    const recv = l.includes("Receive message");
    if (!sent && !recv) continue;
    const start = l.indexOf("[");
    if (start < 0) continue;
    try {
      const raw = JSON.parse(l.slice(start).trim()) as unknown[];
      frames.push({ ts: l.slice(0, 19), dir: sent ? "sent" : "recv", raw });
    } catch {
      /* skip lines we can't parse */
    }
  }
  return frames;
}

/** Latest frame (scanning backwards) matching the predicate. */
function lastFrame(
  frames: OcppFrame[],
  pred: (f: OcppFrame) => boolean,
): OcppFrame | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (pred(frames[i])) return frames[i];
  }
  return null;
}

const isCall = (f: OcppFrame, action?: string): boolean =>
  f.raw[0] === 2 && (action === undefined || f.raw[2] === action);

const callPayload = (f: OcppFrame | null): Record<string, any> =>
  (f?.raw[3] as Record<string, any>) ?? {};

/** Identity actually reported to the CSMS (from the last BootNotification sent),
 * which beats CP_VENDOR_NAME/CP_MODEL env — those are only set on the simulator
 * process, not necessarily on this console. */
function bootIdentity(frames: OcppFrame[]): {
  vendor: string;
  model: string;
  reason?: string;
  ts?: string;
  reply?: Record<string, any>;
} {
  const boot = lastFrame(frames, (f) => f.dir === "sent" && isCall(f, "BootNotification"));
  if (!boot) {
    return {
      vendor: process.env.CP_VENDOR_NAME ?? "?",
      model: process.env.CP_MODEL ?? "?",
    };
  }
  const payload = callPayload(boot);
  const station = (payload.chargingStation ?? {}) as Record<string, string>;
  // Pair the CALLRESULT by message id to surface the CSMS's verdict (status/interval).
  const replyFrame = lastFrame(
    frames,
    (f) => f.dir === "recv" && f.raw[0] === 3 && f.raw[1] === boot.raw[1],
  );
  return {
    vendor: station.vendorName ?? "?",
    model: station.model ?? "?",
    reason: payload.reason,
    ts: boot.ts,
    reply: (replyFrame?.raw[2] as Record<string, any>) ?? undefined,
  };
}

/** Latest QR-ish thing that reached the charger: a Renova DataTransfer (url) or
 * a standard SetDisplayMessage (image). */
function lastQrState(lines: string[]): string {
  let state = "none seen";
  for (const l of lines) {
    const shown = l.match(/Renova QR displayed: (\S+)/);
    if (shown) state = `Renova url ${shown[1]} (${l.slice(0, 19)})`;
    if (l.includes("Renova QR cleared")) state = `cleared (${l.slice(0, 19)})`;
    if (l.includes('"SetDisplayMessage"')) {
      const img = l.match(/https?:\/\/[^" ]+\/assets\/[A-Za-z0-9-]+/);
      if (img) state = `image ${img[0]} (${l.slice(0, 19)})`;
    }
    if (l.includes('"ClearDisplayMessage"')) state = `cleared (${l.slice(0, 19)})`;
  }
  return state;
}

async function showStatus() {
  let adminUp = false;
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    adminUp = res.ok || res.status === 404; // any response = listening
  } catch {
    adminUp = false;
  }
  console.log(
    adminUp
      ? `simulator admin API: ${C.green}up${C.off} (:${ADMIN_PORT})`
      : `simulator admin API: ${C.red}DOWN${C.off} — start it with ./setup-scripts/setup-vcp.sh`,
  );

  const lines = readLogLines();
  if (lines.length === 0) {
    console.log(`${C.yellow}no simulator log yet at ${LOG_FILE}${C.off}`);
    console.log(`charger: ${CP_ID}   dashboard: ${OPERATOR_UI}`);
    return;
  }
  const frames = readOcppFrames(lines);

  // link: last message received from the CSMS + last websocket PING
  const lastRecv = lastFrame(frames, (f) => f.dir === "recv");
  const lastPing = lines.filter((l) => l.includes("Received PING")).pop();
  console.log(
    lastRecv
      ? `CSMS link: ${C.green}connected${C.off} (last reply ${lastRecv.ts}${lastPing ? `, last ping ${lastPing.slice(0, 19)}` : ""})`
      : `CSMS link: ${C.yellow}no replies seen yet${C.off} (${LOG_FILE})`,
  );

  // identity: what the charger told the CSMS at boot (drives the payment
  // service's display-adapter choice, e.g. RCD => Renova DataTransfer QR)
  const boot = bootIdentity(frames);
  const bootDetails: string[] = [];
  if (boot.reason) bootDetails.push(`boot ${boot.reason} @ ${boot.ts}`);
  if (boot.reply) bootDetails.push(`CSMS ${boot.reply.status}, heartbeat ${boot.reply.interval}s`);
  console.log(
    `identity : vendor=${C.green}${boot.vendor}${C.off} model=${C.green}${boot.model}${C.off}` +
      (bootDetails.length ? ` (${bootDetails.join("; ")})` : ""),
  );

  // connector: last StatusNotification we sent
  const status = lastFrame(frames, (f) => f.dir === "sent" && isCall(f, "StatusNotification"));
  if (status) {
    const p = callPayload(status);
    const color = p.connectorStatus === "Available" ? C.green : C.yellow;
    console.log(
      `connector: ${color}${p.connectorStatus}${C.off} (evse ${p.evseId}, connector ${p.connectorId}, ${status.ts})`,
    );
  }

  // charging session: last TransactionEvent tells us if one is live
  const tx = lastFrame(frames, (f) => f.dir === "sent" && isCall(f, "TransactionEvent"));
  if (tx) {
    const p = callPayload(tx);
    const active = p.eventType !== "Ended";
    const kwh = p.meterValue?.[0]?.sampledValue?.[0]?.value;
    console.log(
      `session  : ${active ? `${C.yellow}CHARGING${C.off}` : `${C.green}idle${C.off}`} (last event ${p.eventType}/${p.triggerReason} @ ${tx.ts}` +
        `${kwh !== undefined ? `, meter ${Number(kwh).toFixed(3)} kWh` : ""}, tx ${p.transactionInfo?.transactionId ?? "?"})`,
    );
  } else {
    console.log(`session  : ${C.green}idle${C.off} (no TransactionEvent in log)`);
  }

  console.log(`QR shown : ${lastQrState(lines)}`);

  // log health: parse warnings/errors so protocol problems surface here
  const warns = lines.filter((l) => / warn: | error: /.test(l));
  if (warns.length > 0) {
    const lastWarn = warns[warns.length - 1];
    console.log(
      `warnings : ${C.yellow}${warns.length} warn/error line(s)${C.off} in log, last @ ${lastWarn.slice(0, 19)}:`,
    );
    console.log(`  ${C.dim}${lastWarn.slice(20, 220)}${C.off}`);
  } else {
    console.log(`warnings : ${C.green}none${C.off}`);
  }
  console.log(
    `log      : ${LOG_FILE} (${lines.length} lines)   charger: ${CP_ID}   dashboard: ${OPERATOR_UI}`,
  );
}

/** Compact dump of the most recent OCPP frames: time, direction, action (or the
 * action a reply belongs to), and a payload preview. Option "d". */
function showRecentTraffic(count = 15) {
  const lines = readLogLines();
  const frames = readOcppFrames(lines);
  if (frames.length === 0) {
    console.log(`${C.yellow}no OCPP traffic found in ${LOG_FILE}${C.off}`);
    return;
  }
  // Map message id -> action across the whole log so CALLRESULTs can be labeled.
  const actionById = new Map<string, string>();
  for (const f of frames) {
    if (f.raw[0] === 2) actionById.set(String(f.raw[1]), String(f.raw[2]));
  }
  const preview = (v: unknown, max = 130): string => {
    const s = JSON.stringify(v) ?? "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  console.log(`${C.dim}── last ${Math.min(count, frames.length)} OCPP messages (of ${frames.length} in log) ──${C.off}`);
  for (const f of frames.slice(-count)) {
    const arrow = f.dir === "sent" ? `${C.green}→${C.off}` : `${C.yellow}←${C.off}`;
    let label: string;
    let payload: unknown;
    if (f.raw[0] === 2) {
      label = String(f.raw[2]);
      payload = f.raw[3];
      // surface the interesting discriminator inline
      const p = (f.raw[3] ?? {}) as Record<string, any>;
      if (label === "TransactionEvent" && p.eventType) label += `(${p.eventType})`;
      if (label === "StatusNotification" && p.connectorStatus) label += `(${p.connectorStatus})`;
      if (label === "DataTransfer" && p.messageId) label += `(${p.vendorId}/${p.messageId})`;
    } else if (f.raw[0] === 3) {
      label = `reply:${actionById.get(String(f.raw[1])) ?? "?"}`;
      payload = f.raw[2];
    } else if (f.raw[0] === 4) {
      label = `${C.red}CallError${C.off}:${actionById.get(String(f.raw[1])) ?? "?"} ${f.raw[2]}`;
      payload = f.raw[3];
    } else {
      label = `type${f.raw[0]}`;
      payload = f.raw.slice(1);
    }
    console.log(`${C.dim}${f.ts.slice(11)}${C.off} ${arrow} ${label.padEnd(32)} ${C.dim}${preview(payload)}${C.off}`);
  }
  // recent protocol complaints, so a bad payload doesn't hide in the scroll
  const warns = lines.filter((l) => / warn: | error: /.test(l)).slice(-3);
  if (warns.length > 0) {
    console.log(`${C.dim}── recent warnings ──${C.off}`);
    for (const w of warns) console.log(`${C.yellow}${w.slice(0, 240)}${C.off}`);
  }
}

async function renderQr(data: string) {
  const terminalQr = await QRCode.toString(data, { type: "terminal", small: true });
  console.log(`\n${C.green}Scan to pay:${C.off}\n`);
  console.log(terminalQr);
  console.log(`${C.green}or open:${C.off} ${data}`);
  console.log("\ntest card: 4242 4242 4242 4242 · any future expiry · any CVC");
  console.log("after paying, the charger auto-starts; option 3 (unplug) settles payment");
}

/** Print a debug panel above the QR: what reached the charger and how. */
function printPaymentDebug(rows: Array<[string, unknown]>) {
  // Identity from the BootNotification actually sent, not env: CP_VENDOR_NAME /
  // CP_MODEL are set on the simulator process and may be unset here.
  const boot = bootIdentity(readOcppFrames(readLogLines()));
  console.log(`${C.dim}── payment page (debug) ──────────────────────────────${C.off}`);
  console.log(
    `${C.dim}charger  :${C.off} ${CP_ID}  vendor=${boot.vendor}  model=${boot.model}`,
  );
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === "") continue;
    console.log(`${C.dim}${k.padEnd(9)}:${C.off} ${v}`);
  }
  console.log(`${C.dim}──────────────────────────────────────────────────────${C.off}`);
}

/** Parse the most recent Renova DataTransfer (rcd/qrcode_req) payload from the
 * log, so option 4 can show connector/evse/price alongside the url. */
function latestRenovaData(
  lines: string[],
): (Record<string, unknown> & { _ts?: string }) | null {
  let found: (Record<string, unknown> & { _ts?: string }) | null = null;
  for (const l of lines) {
    if (!l.includes('"DataTransfer"') || !l.includes("qrcode_req")) continue;
    const start = l.indexOf("[");
    if (start < 0) continue;
    try {
      const arr = JSON.parse(l.slice(start).trim()) as unknown[];
      const payload = arr[3] as { data?: unknown };
      const data =
        typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data;
      found = { ...data, _ts: l.slice(0, 19) };
    } catch {
      /* skip lines we can't parse */
    }
  }
  return found;
}

async function showPaymentLink() {
  process.stdout.write("waiting for the QR / payment link from the payment service");
  // Two shapes reach the charger depending on its display adapter:
  //  - standard: SetDisplayMessage carrying a QR *image* URL (…/assets/<id>)
  //  - Renova (rcd): DataTransfer carrying the checkout *url* directly, which the
  //    DataTransfer handler logs as "Renova QR displayed: <url>".
  // Use whichever appeared most recently in the log.
  let assetUrl = "";
  let assetLine = "";
  let renovaUrl = "";
  let renovaLine = "";
  let kind: "asset" | "renova" | "" = "";
  for (let i = 0; i < 10; i++) {
    if (existsSync(LOG_FILE)) {
      for (const l of readFileSync(LOG_FILE, "utf8").split("\n")) {
        const a = l.match(/https?:\/\/[^" ]+\/assets\/[A-Za-z0-9-]+/);
        if (a) {
          assetUrl = a[0];
          assetLine = l;
          kind = "asset";
        }
        const r = l.match(/Renova QR displayed: (\S+)/);
        if (r) {
          renovaUrl = r[1];
          renovaLine = l;
          kind = "renova";
        }
      }
      if (kind) break;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log();
  if (!kind) {
    console.log(`${C.yellow}no QR arrived — did the plug-in start carry no RFID token (scan & charge), and is the payment service seeded for this charger?${C.off}`);
    return;
  }

  // Renova: the checkout url arrives directly, so render it straight away.
  if (kind === "renova") {
    const d = latestRenovaData(readFileSync(LOG_FILE, "utf8").split("\n")) ?? {};
    const url = (d.url as string) || renovaUrl;
    printPaymentDebug([
      ["QR via", "Renova DataTransfer (vendorId=rcd, messageId=qrcode_req)"],
      ["checkout", url],
      [
        "tariff",
        d.price != null ? `${d.price} ${(d.unit as string) ?? ""}`.trim() : undefined,
      ],
      ["connector", d.connector_id],
      ["evse_id", d.evse_id],
      ["received", (d._ts as string) || renovaLine.slice(0, 19)],
    ]);
    await renderQr(url);
    return;
  }

  // Standard: fetch the QR image, decode it, and re-render in the terminal so it
  // can be scanned with a phone without opening anything.
  try {
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(10000) });
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    if (decoded?.data) {
      printPaymentDebug([
        ["QR via", "SetDisplayMessage (image / URI)"],
        ["checkout", decoded.data],
        ["image", assetUrl],
        ["received", assetLine.slice(0, 19)],
      ]);
      await renderQr(decoded.data);
    } else {
      console.log(`${C.yellow}couldn't decode the QR — open the image: ${assetUrl}${C.off}`);
    }
  } catch (e) {
    console.log(`${C.yellow}couldn't fetch/decode the QR (${(e as Error).message}) — image: ${assetUrl}${C.off}`);
  }
}

async function customMessage(ask: (q: string) => Promise<string>) {
  const action = (await ask("OCPP action (e.g. Heartbeat): ")).trim();
  if (!action) return;
  const raw = (await ask("payload JSON (default {}): ")).trim() || "{}";
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.log(`${C.red}invalid JSON${C.off}`);
    return;
  }
  await post(action, payload);
}

const MENU = `
${C.green}Ivora VCP console${C.off} — charger ${CP_ID}  (dashboard: ${OPERATOR_UI})
  1) status              simulator + CSMS link, identity, session, QR, warnings
  2) plug in             occupy connector (charging starts after payment / RFID)
  3) unplug              stop charging & settle payment
  4) show payment link   scan & charge QR (after an unauthorized plug-in)
  5) authorize           RFID tap (AABBCCDD)
  6) connector status    Available / Occupied / Faulted / Reserved / Unavailable
  7) heartbeat
  8) custom message      any OCPP action + payload
  9) watch live log      (ctrl-c to return)
  d) debug               recent OCPP traffic + warnings
  q) quit`;

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Exit cleanly on quit / ctrl-d / piped EOF (avoids "readline was closed").
  rl.on("close", () => process.exit(0));
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  console.log(MENU);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const choice = (await ask("\n> ")).trim().toLowerCase();
    switch (choice) {
      case "1":
        await showStatus();
        break;
      case "2":
        await post("Plug", {});
        console.log(`${C.dim}payment first: scan the standing QR (option 4) and pay — charging starts on payment confirmation${C.off}`);
        break;
      case "3":
        await post("Unplug", {});
        break;
      case "4":
        await showPaymentLink();
        break;
      case "5":
        await post("Authorize", { idToken: { idToken: "AABBCCDD", type: "ISO14443" } });
        break;
      case "6": {
        const s = (await ask("[a]vailable [o]ccupied [f]aulted [r]eserved [u]navailable: ")).trim().toLowerCase();
        const map: Record<string, string> = { a: "Available", o: "Occupied", f: "Faulted", r: "Reserved", u: "Unavailable" };
        if (map[s]) await statusNotification(map[s]);
        else console.log("unknown");
        break;
      }
      case "7":
        await post("Heartbeat", {});
        break;
      case "8":
        await customMessage(ask);
        break;
      case "d":
        showRecentTraffic();
        break;
      case "9":
        if (existsSync(LOG_FILE)) {
          console.log(`${C.dim}tailing ${LOG_FILE} — ctrl-c to return${C.off}`);
          try {
            execSync(`tail -f "${LOG_FILE}"`, { stdio: "inherit" });
          } catch {
            /* ctrl-c returns here */
          }
        } else {
          console.log(`no log at ${LOG_FILE}`);
        }
        break;
      case "q":
        rl.close();
        return;
      default:
        console.log(MENU);
    }
  }
}

main();
