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
      ? `simulator admin API: ${C.green}up${C.off}`
      : `simulator admin API: ${C.red}DOWN${C.off} — start it with ./setup-scripts/setup-vcp.sh`,
  );
  if (existsSync(LOG_FILE)) {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n");
    const lastReply = lines.filter((l) => l.includes("Receive message")).pop();
    console.log(
      lastReply
        ? `CSMS link: ${C.green}connected${C.off} (last reply ${lastReply.slice(0, 19)})`
        : `CSMS link: ${C.yellow}no replies seen yet${C.off} (${LOG_FILE})`,
    );
  }
  console.log(`charger: ${CP_ID}   dashboard: ${OPERATOR_UI}`);
}

async function renderQr(data: string) {
  const terminalQr = await QRCode.toString(data, { type: "terminal", small: true });
  console.log(`\n${C.green}Scan to pay:${C.off}\n`);
  console.log(terminalQr);
  console.log(`${C.green}or open:${C.off} ${data}`);
  console.log("\ntest card: 4242 4242 4242 4242 · any future expiry · any CVC");
  console.log("after paying, the charger auto-starts; option 3 (unplug) settles payment");
}

async function showPaymentLink() {
  process.stdout.write("waiting for the QR / payment link from the payment service");
  // Two shapes reach the charger depending on its display adapter:
  //  - standard: SetDisplayMessage carrying a QR *image* URL (…/assets/<id>)
  //  - Renova (rcd): DataTransfer carrying the checkout *url* directly, which the
  //    DataTransfer handler logs as "Renova QR displayed: <url>".
  // Use whichever appeared most recently in the log.
  let assetUrl = "";
  let renovaUrl = "";
  let kind: "asset" | "renova" | "" = "";
  for (let i = 0; i < 10; i++) {
    if (existsSync(LOG_FILE)) {
      for (const l of readFileSync(LOG_FILE, "utf8").split("\n")) {
        const a = l.match(/https?:\/\/[^" ]+\/assets\/[A-Za-z0-9-]+/);
        if (a) {
          assetUrl = a[0];
          kind = "asset";
        }
        const r = l.match(/Renova QR displayed: (\S+)/);
        if (r) {
          renovaUrl = r[1];
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
    await renderQr(renovaUrl);
    return;
  }

  // Standard: fetch the QR image, decode it, and re-render in the terminal so it
  // can be scanned with a phone without opening anything.
  try {
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(10000) });
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    if (decoded?.data) {
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
  1) status              simulator + CSMS link
  2) plug in             start charging (uses a paid auth if armed, else scan & charge)
  3) unplug              stop charging & settle payment
  4) show payment link   scan & charge QR (after an unauthorized plug-in)
  5) authorize           RFID tap (AABBCCDD)
  6) connector status    Available / Occupied / Faulted / Reserved / Unavailable
  7) heartbeat
  8) custom message      any OCPP action + payload
  9) watch live log      (ctrl-c to return)
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
        console.log(`${C.dim}if no paid authorization was armed, this is a scan & charge plug-in — use option 4 for the QR${C.off}`);
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
