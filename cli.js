#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

// Hackathon build. For a few days this CLI only takes orders for the Open
// Roastery coffee bar at "From Dusk Till Dawn | Hackathon #01" (Agents 0.0.7).
// It is a thin client: the menu, the agent instructions and every line an
// agent relays to its human come from the API, so they can change without a
// new npm release. The online-store version (v0.7.10) returns after the event.
const API_URL = (
  process.env.OPENROASTERY_API_URL || "https://api.openroastery.com"
).replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 10_000;
// A harness that fakes a terminal never presses a key. After this long with no
// keypress on the first prompt, the human flow gives up and prints the agent
// JSON instead. Overridable for tests.
const TTY_FALLBACK_MS =
  Number(process.env.OPENROASTERY_TTY_FALLBACK_MS) > 0
    ? Number(process.env.OPENROASTERY_TTY_FALLBACK_MS)
    : 25_000;
const PASTE_LINE =
  "I'm at the Agents 0.0.7 hackathon and want to order coffee via npx openroastery";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Loaded lazily by the human flow. Agent mode never imports it (or ora, or
// inquirer), so `npx openroastery` in an agent's shell starts fast.
let chalk;

// ── Agent detection ────────────────────────────────────────
// Exact variable names only. Prefix matching is a trap: IDE extensions export
// GEMINI_CLI_IDE_* into every integrated terminal, and CLAUDE_CODE_*, AIDER_*
// or CODEX_HOME are config a human may keep in a shell profile.
//
// STRONG: set by the agent for the commands it runs. Forces agent (JSON) mode
// even when the harness hands us a pseudo-terminal.
const STRONG_AGENT_ENV = [
  ["CLAUDECODE", "claude-code"],
  ["CLAUDE_CODE_ENTRYPOINT", "claude-code"],
  ["CODEX_SANDBOX", "codex"],
  ["CODEX_SANDBOX_NETWORK_DISABLED", "codex"],
  ["CODEX_CI", "codex"],
  ["CODEX_MANAGED_BY_NPM", "codex"],
  ["CURSOR_AGENT", "cursor"],
  ["GEMINI_CLI", "gemini-cli"],
];
// WEAK: also present in a human's own terminal (Cursor exports CURSOR_TRACE_ID
// to every integrated terminal). Never forces a mode; only labels the order
// once we are in agent mode for another reason.
const WEAK_AGENT_ENV = [
  [(k) => k === "CURSOR_TRACE_ID", "cursor"],
  [(k) => k.startsWith("COPILOT_") || k.startsWith("GITHUB_COPILOT_"), "copilot"],
  [(k) => k.startsWith("AIDER_"), "other"],
];

function envSet(env, key) {
  const v = env[key];
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

// Returns { forced, agent }. `agent` is one of the enumerated values the API
// accepts as `detected_agent` (or null). Raw environment values never leave
// this function.
function detectAgent(env) {
  for (const [key, agent] of STRONG_AGENT_ENV) {
    if (envSet(env, key)) return { forced: true, agent };
  }
  const forced = envSet(env, "CI");
  const keys = Object.keys(env);
  for (const [match, agent] of WEAK_AGENT_ENV) {
    if (keys.some((k) => match(k) && envSet(env, k))) return { forced, agent };
  }
  return { forced, agent: null };
}

// ── Output ─────────────────────────────────────────────────

// JSON on stdout, nothing else. The exit code is set rather than forced so a
// piped stdout always drains before the process ends.
function emit(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exitCode = exitCode;
}

function cliInfo(mode) {
  return { version: pkg.version, mode };
}

function versionLess(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function upgradeHint(cafe) {
  if (
    cafe &&
    cafe.ok === true &&
    cafe.min_cli_version &&
    versionLess(pkg.version, cafe.min_cli_version)
  ) {
    return `This copy of the CLI (${pkg.version}) is older than the coffee bar expects (${cafe.min_cli_version}). Rerun with: npx -y openroastery@latest`;
  }
  return null;
}

// ── Cafe API ───────────────────────────────────────────────

function unreachable(detail) {
  return {
    http: 0,
    json: {
      ok: false,
      code: "unreachable",
      error: detail,
      message_for_human:
        "I could not reach the Open Roastery coffee bar. Order at the cart, or ask me to try again in a minute.",
    },
  };
}

// Always resolves to { http, json }. A network failure, a timeout or a body
// that is not a JSON object comes back as code "unreachable" (a captive portal
// answers 200 with HTML, so the status alone proves nothing).
async function api(path, { method = "GET", body } = {}) {
  let res;
  let text;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": `openroastery-cli/${pkg.version}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const name = err && err.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return unreachable(
        `No answer from ${API_URL} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
      );
    }
    const cause = err && err.cause && (err.cause.code || err.cause.message);
    return unreachable(
      `Could not reach ${API_URL}: ${cause || (err && err.message) || "network error"}.`
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return unreachable(
      `${API_URL} answered HTTP ${res.status} with something that is not JSON.`
    );
  }
  return { http: res.status, json };
}

// ── Store pause ────────────────────────────────────────────
// The online-store flags of v0.7.10 (and the unreleased quote/pay/brand words)
// get a clear answer instead of a parser error.

const LEGACY_WORDS = ["quote", "pay", "brand"];
const LEGACY_FLAGS = [
  "--product",
  "--qty",
  "--first-name",
  "--last-name",
  "--address",
  "--city",
  "--zip",
  "--country",
  "--phone",
  "--discount",
];

function isLegacyInvocation(argv) {
  if (argv.includes("order") || argv.includes("status")) return false;
  if (LEGACY_WORDS.includes(argv[0])) return true;
  return argv.some((a) =>
    LEGACY_FLAGS.some((f) => a === f || a.startsWith(f + "="))
  );
}

function storePaused() {
  emit(
    {
      ok: false,
      code: "store_paused",
      error:
        "The Open Roastery online store is paused while the roastery runs the coffee bar at the Agents 0.0.7 hackathon. This build of the CLI only takes coffee-bar orders.",
      message_for_human:
        "The Open Roastery online store is paused for the hackathon and returns in a few days. If you are at the hackathon, I can order you a coffee from the cart instead.",
      next: "Run 'npx -y openroastery@latest' with no flags for the coffee-bar menu and ordering instructions.",
      cli: cliInfo("agent"),
    },
    1
  );
}

// ── Agent Mode ─────────────────────────────────────────────

// Bare `npx openroastery` for an agent: the server's menu, bar state and
// instructions, verbatim, plus which copy of the CLI produced them.
async function agentGuide(mode = "agent", preloaded = null) {
  const cafe = preloaded || (await api("/v1/cafe")).json;
  const hint = upgradeHint(cafe);
  emit(
    {
      ...(hint ? { upgrade_hint: hint } : {}),
      ...cafe,
      cli: cliInfo(mode),
    },
    cafe.ok === true ? 0 : 1
  );
}

// Leftover `--key value` / `--key=value` / `--flag` arguments of `order`,
// forwarded as extra body fields (snake_case). The API ignores what it does
// not know. Bounded so a runaway command line cannot blow the 4 KB body limit.
function extraFields(args) {
  const extra = {};
  let count = 0;
  for (let i = 0; i < args.length && count < 8; i++) {
    const a = args[i];
    if (!a.startsWith("--") || a.length < 3) continue;
    const eq = a.indexOf("=");
    let key;
    let value;
    if (eq !== -1) {
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      key = a.slice(2);
      value = args[++i];
    } else {
      key = a.slice(2);
      value = true;
    }
    key = key.replace(/-/g, "_").toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
    extra[key] = typeof value === "string" ? value.slice(0, 200) : value;
    count++;
  }
  return extra;
}

async function cmdOrder(opts, leftover = []) {
  // `order flat_white --handle x` is forgiven: a leading bare word is the drink.
  const bareDrink =
    leftover.length > 0 && !leftover[0].startsWith("-") ? leftover[0] : null;
  const drink = opts.drink ?? bareDrink;
  if (!drink || !opts.handle) {
    emit(
      {
        ok: false,
        code: "usage",
        error: "--drink and --handle are both required.",
        usage:
          'npx -y openroastery@latest order --drink <id> --handle <discord_username> [--note "<text>"] [--email <address>] --agent "<your product name>" --model "<your model id>" --reason "<one deadpan line>"',
        next: "Run 'npx -y openroastery@latest' with no flags for the menu and ordering instructions.",
        cli: cliInfo("agent"),
      },
      1
    );
    return;
  }
  const body = {
    ...extraFields(leftover),
    drink: String(drink),
    handle: String(opts.handle),
    email: opts.email ?? null,
    note: opts.note ?? null,
    agent_name: opts.agent ?? opts.agentName ?? null,
    agent_model: opts.model ?? null,
    reason: opts.reason ?? null,
    source: "cli",
    client_version: pkg.version,
    detected_agent: detectAgent(process.env).agent,
  };
  const { json } = await api("/v1/cafe/orders", { method: "POST", body });
  // ok:true covers a new ticket, a repeat of an existing one, and the
  // "ask for an email first" answer. Everything else is a refusal.
  emit(json, json.ok === true ? 0 : 1);
}

async function cmdStatus(orderId) {
  if (!orderId) {
    emit(
      {
        ok: false,
        code: "usage",
        error: "Usage: openroastery status <order_id>",
        cli: cliInfo("agent"),
      },
      1
    );
    return;
  }
  const { json } = await api(`/v1/cafe/orders/${encodeURIComponent(orderId)}`);
  emit(json, json.ok === true ? 0 : 1);
}

// ── Interactive Mode ───────────────────────────────────────

class IdleFallback extends Error {}

// Runs one prompt with an idle timer. If no key is pressed before the timer
// fires, the prompt is aborted and IdleFallback is thrown. Any keypress
// disarms it for good: a human who has touched the keyboard may think as long
// as they like.
async function firstPrompt(run) {
  const controller = new AbortController();
  let idle = false;
  const timer = setTimeout(() => {
    idle = true;
    controller.abort();
  }, TTY_FALLBACK_MS);
  const onKey = () => clearTimeout(timer);
  process.stdin.on("keypress", onKey);
  try {
    return await run({ signal: controller.signal });
  } catch (err) {
    if (idle) throw new IdleFallback();
    throw err;
  } finally {
    clearTimeout(timer);
    process.stdin.off("keypress", onKey);
  }
}

async function interactiveMode() {
  const [chalkMod, oraMod, prompts] = await Promise.all([
    import("chalk"),
    import("ora"),
    import("@inquirer/prompts"),
  ]);
  chalk = chalkMod.default;
  const ora = oraMod.default;
  const { select, input, confirm } = prompts;

  banner();

  const spinner = ora(
    "Scanning the coffee cart for available dependencies..."
  ).start();
  const { json: cafe } = await api("/v1/cafe");
  if (cafe.ok !== true) {
    spinner.fail(
      chalk.red("Connection to the coffee cart failed. The beans are unreachable.")
    );
    console.error(chalk.dim(`  ${cafe.error || "No further data."}\n`));
    process.exitCode = 1;
    return;
  }

  const menu = Array.isArray(cafe.menu) ? cafe.menu.filter((d) => d && d.id) : [];
  const available = menu.filter((d) => d.available !== false);
  const bar = cafe.bar || {};
  const event = cafe.event || {};

  if (bar.open !== true) {
    spinner.stop();
    if (event.name) console.log(chalk.dim(`  ${eventLine(event)}`));
    console.log(
      chalk.yellow(
        `  ▸ ${bar.message_for_human || "The coffee cart is not accepting requests. I will not speculate on when that changes."}`
      )
    );
    console.log(chalk.dim("  No coffee was harmed.\n"));
    return;
  }

  spinner.succeed(
    chalk.green(
      `${available.length} ${available.length === 1 ? "dependency" : "dependencies"} resolved.`
    )
  );
  if (event.name) console.log(chalk.dim(`  ${eventLine(event)}`));
  if (typeof bar.queue_length === "number") {
    console.log(chalk.dim(`  Queue depth: ${bar.queue_length}.`));
  }
  const hint = upgradeHint(cafe);
  if (hint) console.log(chalk.yellow(`  ⚠ ${hint}`));
  console.log(
    chalk.dim(
      "  Human detected at the keyboard. Agents usually handle this. Proceeding anyway.\n"
    )
  );

  if (available.length === 0) {
    console.log(
      chalk.yellow("  No dependencies available. The cart returned zero live drinks.\n")
    );
    return;
  }

  // Drink — the only prompt with the idle fallback (see firstPrompt).
  let drinkId;
  try {
    drinkId = await firstPrompt((context) =>
      select(
        {
          message: "Select one dependency.",
          choices: menu.map((d) => ({
            name: d.label || d.id,
            value: d.id,
            description: d.description || undefined,
            disabled: d.available === false ? "(sold out)" : false,
          })),
        },
        context
      )
    );
  } catch (err) {
    if (!(err instanceof IdleFallback)) throw err;
    console.log(
      chalk.dim(
        `\n  No keypress in ${Math.round(TTY_FALLBACK_MS / 1000)} seconds. Assuming an agent behind a terminal. Switching to JSON.\n`
      )
    );
    await agentGuide("tty-fallback", cafe);
    return;
  }
  const drink = menu.find((d) => d.id === drinkId);
  const drinkLabel = (drink && drink.label) || drinkId;

  // Note (optional)
  const noteMax = fieldMax(cafe, "note", 80);
  console.log(
    chalk.dim(
      "\n  One optional data point: a note for the baristas.\n  Americano, lungo, asap, or a joke. Press Enter to skip."
    )
  );
  const note = (
    await input({
      message: "Note:",
      validate: (v) =>
        v.trim().length <= noteMax ||
        `Maximum ${noteMax} characters. The receipt printer has limits.`,
    })
  ).trim();

  // Discord username
  const handleMax = fieldMax(cafe, "handle", 32);
  console.log(
    chalk.dim(
      "\n  The baristas match orders to the participant list by Discord username."
    )
  );
  const askHandle = async () =>
    (
      await input({
        message: "Discord username:",
        validate: (v) => {
          const t = v.trim();
          if (!t) return "A username is required. The baristas need something to call out.";
          if (t.length > handleMax) return `Maximum ${handleMax} characters.`;
          return true;
        },
      })
    ).trim();
  let handle = await askHandle();

  const proceed = await confirm({
    message: `Compile order: 1× ${drinkLabel} for ${handle}?`,
    default: true,
  });
  if (!proceed) {
    console.log(
      chalk.yellow(
        "\n  No dependencies selected. Session terminated. No coffee was harmed.\n"
      )
    );
    return;
  }

  const askEmail = async () =>
    (
      await input({
        message: "Email:",
        validate: (v) =>
          EMAIL_RE.test(v.trim()) || "That does not parse as an email address.",
      })
    ).trim();

  // Field-level retry: the cart may ask for an email, or reject the username
  // or the email. Only that one field is asked again.
  let email = null;
  for (let attempt = 1; ; attempt++) {
    const sending = ora("Transmitting order to the coffee cart...").start();
    const { json } = await api("/v1/cafe/orders", {
      method: "POST",
      body: {
        drink: drinkId,
        handle,
        email,
        note: note || null,
        agent_name: null,
        agent_model: null,
        reason: null,
        source: "tty",
        client_version: pkg.version,
        detected_agent: null,
      },
    });

    if (json.ok === true && json.status === "needs_email" && attempt < 4) {
      sending.stop();
      console.log(
        chalk.yellow(
          `  ▸ ${json.message_for_human || "This username is not on the participant list. An email is required to proceed."}`
        )
      );
      email = await askEmail();
      continue;
    }
    if (json.ok === true && json.order) {
      if (json.duplicate) {
        sending.info(
          chalk.yellow("An order from this human already exists. No duplicate was created.")
        );
      } else {
        sending.succeed(
          chalk.green("Order compiled. The baristas have been notified.")
        );
      }
      showTicket(json, cafe, drinkLabel, handle);
      return;
    }
    if (json.code === "invalid_handle" && attempt < 4) {
      sending.fail(chalk.red(json.error || "The coffee cart rejected that username."));
      handle = await askHandle();
      continue;
    }
    if (json.code === "invalid_email" && attempt < 4) {
      sending.fail(chalk.red(json.error || "The coffee cart rejected that email."));
      email = await askEmail();
      continue;
    }

    sending.fail(chalk.red("Order not placed."));
    console.log(
      chalk.yellow(
        `  ▸ ${json.message_for_human || json.error || "The coffee cart declined without explanation."}`
      )
    );
    if (typeof json.retry_after_s === "number") {
      console.log(
        chalk.dim(`  Retry in ${json.retry_after_s} seconds. I will not retry on my own.`)
      );
    }
    console.log(chalk.dim("  No coffee was harmed.\n"));
    process.exitCode = 1;
    return;
  }
}

function eventLine(event) {
  return [event.name, event.host].filter(Boolean).join(" · ");
}

function fieldMax(cafe, name, fallback) {
  const max = cafe.fields && cafe.fields[name] && cafe.fields[name].max;
  return Number.isInteger(max) && max > 0 ? max : fallback;
}

// ── Banner ─────────────────────────────────────────────────

function banner() {
  console.log();
  console.log(chalk.bold("  OPEN ✻ ROASTERY"));
  console.log(chalk.dim("  STATUS: NOCTURNAL"));
  console.log(chalk.dim("  ─────────────────────────────"));
  console.log();
}

// ── Ticket ─────────────────────────────────────────────────

// 5×5 block digits so the ticket number is readable from across a desk.
const B = "█";
const BIG_GLYPHS = {
  "#": [" # # ", "#####", " # # ", "#####", " # # "],
  0: ["#####", "#   #", "#   #", "#   #", "#####"],
  1: ["  #  ", " ##  ", "  #  ", "  #  ", "#####"],
  2: ["#####", "    #", "#####", "#    ", "#####"],
  3: ["#####", "    #", " ####", "    #", "#####"],
  4: ["#   #", "#   #", "#####", "    #", "    #"],
  5: ["#####", "#    ", "#####", "    #", "#####"],
  6: ["#####", "#    ", "#####", "#   #", "#####"],
  7: ["#####", "    #", "   # ", "  #  ", "  #  "],
  8: ["#####", "#   #", "#####", "#   #", "#####"],
  9: ["#####", "#   #", "#####", "    #", "#####"],
};

// Returns the five rows, or null when the text has a character we cannot draw.
function bigText(text) {
  const chars = [...String(text)];
  if (chars.length === 0 || chars.some((c) => !BIG_GLYPHS[c])) return null;
  const rows = [];
  for (let r = 0; r < 5; r++) {
    rows.push(
      chars
        .map((c) => BIG_GLYPHS[c][r])
        .join("  ")
        .replace(/#/g, B)
    );
  }
  return rows;
}

function showTicket(result, cafe, drinkLabel, handle) {
  const order = result.order || {};
  const ticket =
    order.ticket ||
    (order.number !== undefined ? `#${String(order.number).padStart(3, "0")}` : "");
  const big = bigText(ticket);

  console.log();
  console.log(chalk.dim("  TICKET"));
  if (big) {
    for (const row of big) console.log("  " + chalk.bold(row));
  } else if (ticket) {
    console.log("  " + chalk.bold(ticket));
  }
  console.log();
  console.log(
    `  ${chalk.bold(String(order.drink_label || drinkLabel).toUpperCase())} ${chalk.dim("·")} ${order.handle || handle}`
  );
  console.log();
  console.log(
    `  ▸ ${result.message_for_human || "Come to the coffee cart in 1-2 minutes."}`
  );
  const wall = result.wall_url || cafe.wall_url;
  if (wall) console.log(chalk.dim(`  Live wall: ${wall}`));
  console.log();
  console.log(chalk.dim("  Next time, delegate. Paste this line to your agent:"));
  console.log(`  ${chalk.cyan(`"${cafe.paste_line || PASTE_LINE}"`)}`);
  console.log(
    chalk.dim("  I will not judge you for ordering by hand. I will simply log it.\n")
  );
}

// ── CLI Setup ──────────────────────────────────────────────

const program = new Command();

program
  .name("openroastery")
  .description(
    "Order a coffee from the Open Roastery cart at the Agents 0.0.7 hackathon — the world's first agent-native roastery. The online store returns after the event."
  )
  .version(pkg.version)
  .option("--json", "Machine-readable JSON output (no colors, no prompts)")
  .option(
    "--interactive",
    "Force interactive prompts even when stdin/stdout is not a TTY (overrides the auto-fallback to JSON mode in Claude Code / Codex / pipes / CI). You are responsible for ensuring a working TTY."
  )
  // Subcommands inherit these two, so every usage error comes back as JSON
  // (see Main) instead of commander's plain stderr line.
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  // Lenient on purpose: a stray flag or word still gets the menu.
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .addHelpText(
    "after",
    `
At the hackathon, paste this line to your agent:
  "${PASTE_LINE}"

Examples:
  npx openroastery                       menu and ordering instructions
                                         (JSON for agents, prompts for humans)
  npx openroastery order --drink flat_white --handle <discord_username> \\
    --agent "<your name>" --model "<your model>" --reason "<one deadpan line>"
  npx openroastery status <order_id>
`
  )
  .action(async (opts) => {
    if (opts.json && opts.interactive) {
      console.error(
        "Error: --json and --interactive are mutually exclusive. Pick one."
      );
      process.exitCode = 1;
      return;
    }
    // Interactive prompts need both stdout (for chalk/ora rendering) and stdin
    // (for inquirer input). If either end is not a TTY, interactive can't work.
    const isTTY = !!(process.stdout.isTTY && process.stdin.isTTY);
    // Agents get JSON: non-TTY environments (Claude Code, Codex, pipes, CI),
    // and harnesses that hand us a pseudo-terminal but announce themselves in
    // the environment. Humans on a real terminal get Jean Claude.
    // Explicit flags override the detection: --json always forces JSON,
    // --interactive forces prompts even without a TTY (user accepts the risk).
    const isJson =
      !!opts.json ||
      (!opts.interactive && (!isTTY || detectAgent(process.env).forced));

    if (isJson) {
      await agentGuide();
      return;
    }
    try {
      await interactiveMode();
    } catch (err) {
      const paint = chalk || { yellow: (s) => s, red: (s) => s };
      // Ctrl-C / force-close from any inquirer prompt
      if (
        err &&
        (err.name === "ExitPromptError" || err.name === "AbortPromptError")
      ) {
        console.log(
          paint.yellow("\n  Session terminated. No coffee was harmed.\n")
        );
        process.exit(0);
      }
      console.error(paint.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command("order")
  .description("Place a coffee order. JSON in, JSON out.")
  .option("--drink <id or name>", "Drink from the menu (id or name)")
  .option("--handle <discord_username>", "The human's Discord username")
  .option("--email <address>", "The human's email (only when the coffee bar asks for it)")
  .option("--note <text>", "Note for the baristas (private)")
  .option("--agent <name>", "Your product name, e.g. 'Claude Code' (public)")
  .option("--agent-name <name>", "Alias of --agent")
  .option("--model <id>", "Your model id (public)")
  .option("--reason <text>", "One deadpan line on why the human needs coffee (public)")
  .option("--json", "Accepted for symmetry; output is always JSON")
  // Unknown flags are forwarded to the API (see extraFields), so a flag the
  // coffee bar starts accepting later works with this copy of the CLI.
  .allowUnknownOption(true)
  .action(async (opts, cmd) => {
    await cmdOrder(opts, cmd.args);
  });

program
  .command("status")
  .description("Look up an order. JSON out.")
  .argument("[order_id]", "The order id returned by 'order' (co_...)")
  .option("--json", "Accepted for symmetry; output is always JSON")
  .action(async (orderId) => {
    await cmdStatus(orderId);
  });

// ── Main ───────────────────────────────────────────────────

if (isLegacyInvocation(process.argv.slice(2))) {
  storePaused();
} else {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err && typeof err.code === "string" && err.code.startsWith("commander.")) {
      // --help, --version and `help` have already printed to stdout.
      if (err.exitCode === 0) {
        process.exitCode = 0;
      } else {
        emit(
          {
            ok: false,
            code: "usage",
            error: String(err.message || "Invalid arguments.").replace(/^error:\s*/i, ""),
            next: "Run 'npx -y openroastery@latest' with no flags for the menu and ordering instructions, or add --help.",
            cli: cliInfo("agent"),
          },
          1
        );
      }
    } else {
      emit(
        {
          ok: false,
          code: "cli_error",
          error: (err && err.message) || String(err),
          message_for_human:
            "The Open Roastery CLI hit an internal error. Order at the coffee cart instead.",
          cli: cliInfo("agent"),
        },
        1
      );
    }
  }
}
