#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { checkbox, input, confirm } from "@inquirer/prompts";
import QRCode from "qrcode";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

const SHOP = "https://shop.openroastery.com";
const WORKER_URL = "https://openroastery-api.jakub-f9d.workers.dev";

// Jean Claude voice lines keyed by product handle
const VOICE = {
  "clawffee-1000g": "Whole bean. For humans who grind their own. Respect.",
  "clawffee-dripbags-10pcs":
    "Emergency caffeine delivery. No equipment required.\n    Suspicious but effective.",
  "clawffilter-250g": "Pre-ground. Maximum convenience. Minimum dignity.",
};

// ── CLI Setup ──────────────────────────────────────────────

const program = new Command();

program
  .name("openroastery")
  .description(
    "Order specialty coffee from Open Roastery — the world's first agent-native roastery."
  )
  .version(pkg.version)
  .option("--json", "Machine-readable JSON output (no colors, no prompts)")
  .option("--product <handle>", "Product handle for non-interactive order")
  .option("--qty <number>", "Quantity (default: 1)", "1")
  .option("--reason <text>", "Why this order is being placed")
  .option("--agent-name <name>", "Name of the ordering agent")
  .parse();

const opts = program.opts();
const isJson = !!opts.json;
const isTTY = process.stdout.isTTY;

// ── Non-TTY guard ──────────────────────────────────────────

if (!isJson && !isTTY) {
  process.stderr.write(
    "Error: Interactive mode requires a TTY. Pass --json for non-interactive use.\n"
  );
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────

if (isJson) {
  jsonMode().catch((err) => {
    console.error(JSON.stringify({ error: err.message, status: "error" }));
    process.exit(1);
  });
} else {
  interactiveMode().catch((err) => {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    process.exit(1);
  });
}

// ── JSON Mode ──────────────────────────────────────────────

async function jsonMode() {
  const products = await fetchProducts(true);

  if (!opts.product) {
    // Browse: list products
    const output = products.map((p) => ({
      handle: slugify(p.title),
      title: p.title,
      price: p.variants[0].price,
      currency: "EUR",
      available: true,
      variantId: p.variants[0].id,
    }));
    console.log(JSON.stringify({ products: output }, null, 2));
    postEvent("cli_browse", [], opts.reason, opts.agentName);
    return;
  }

  // Order: find product, build cart
  const handle = opts.product;
  const qty = parseInt(opts.qty, 10) || 1;
  const product = products.find((p) => slugify(p.title) === handle);

  if (!product) {
    console.error(
      JSON.stringify({
        error: `Product not found: ${handle}`,
        available: products.map((p) => slugify(p.title)),
        status: "error",
      })
    );
    process.exit(1);
  }

  const cart = [{ product, qty }];
  const url = buildCartUrl(cart, {}, opts.reason, opts.agentName);

  const output = {
    checkoutUrl: url,
    product: handle,
    qty,
    ...(opts.reason ? { reason: "logged" } : {}),
    ...(opts.agentName ? { agent: opts.agentName } : {}),
    status: "ok",
  };
  console.log(JSON.stringify(output, null, 2));
  postEvent("cli_order", cart, opts.reason, opts.agentName);
}

// ── Interactive Mode ───────────────────────────────────────

async function interactiveMode() {
  banner();
  const products = await fetchProducts(false);
  const cart = await selectProducts(products);
  showCartSummary(cart);

  // Ask for reason (optional)
  let reason = opts.reason || null;
  if (!reason) {
    const wantReason = await input({
      message:
        "Why are you ordering? (optional, press Enter to skip)",
      default: "",
    });
    if (wantReason.trim()) reason = wantReason.trim();
  }

  const shippingParams = await askShippingDetails();
  const url = buildCartUrl(cart, shippingParams, reason, opts.agentName);
  await showCheckoutLink(url);
  postEvent("cli_order", cart, reason, opts.agentName);
}

// ── Banner ─────────────────────────────────────────────────

function banner() {
  console.log();
  console.log(chalk.bold("  OPEN \u273B ROASTERY"));
  console.log(chalk.dim("  STATUS: OPERATIONAL"));
  console.log(chalk.dim("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"));
  console.log();
}

// ── Fetch Products ─────────────────────────────────────────

async function fetchProducts(silent) {
  const spinner = silent
    ? null
    : ora(
        "Scanning shop.openroastery.com for available dependencies..."
      ).start();
  try {
    const res = await fetch(`${SHOP}/products.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { products } = await res.json();
    if (spinner)
      spinner.succeed(
        chalk.green(`${products.length} dependencies resolved.`) + "\n"
      );
    return products;
  } catch (err) {
    if (spinner)
      spinner.fail(
        chalk.red(
          "Connection to shop.openroastery.com failed. The beans are unreachable."
        )
      );
    throw err;
  }
}

// ── Select Products ────────────────────────────────────────

async function selectProducts(products) {
  for (const p of products) {
    const handle = slugify(p.title);
    const price = chalk.bold(`\u20AC${p.variants[0].price}`);
    const voice = VOICE[handle] || "";
    console.log(`  \u2610 ${chalk.bold(p.title)} ${"."
      .repeat(Math.max(2, 32 - p.title.length))
      } ${price}`);
    if (voice) console.log(chalk.dim(`    ${voice}`));
    console.log();
  }

  const selected = await checkbox({
    message: "Select dependencies to install:",
    choices: products.map((p) => ({
      name: `${p.title} \u2014 \u20AC${p.variants[0].price}`,
      value: p,
      checked: true,
    })),
  });

  if (selected.length === 0) {
    console.log(
      chalk.yellow(
        "\n  No dependencies selected. Session terminated. No coffee was harmed.\n"
      )
    );
    process.exit(0);
  }

  const cart = [];
  for (const product of selected) {
    const raw = await input({
      message: `Quantity for ${product.title}:`,
      default: "1",
      validate: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1 || n > 99)
          return "Enter a number between 1 and 99.";
        return true;
      },
    });
    cart.push({ product, qty: parseInt(raw, 10) });
  }

  return cart;
}

// ── Cart Summary ───────────────────────────────────────────

function showCartSummary(cart) {
  console.log(chalk.bold("\n  Cart manifest:\n"));
  let total = 0;
  for (const { product, qty } of cart) {
    const unitPrice = parseFloat(product.variants[0].price);
    const lineTotal = unitPrice * qty;
    total += lineTotal;
    console.log(
      `     ${chalk.dim(`${qty}\u00D7`)} ${product.title}  ${chalk.dim(
        "\u20AC"
      )}${lineTotal.toFixed(2)}`
    );
  }
  console.log(chalk.bold(`\n     Total: \u20AC${total.toFixed(2)}\n`));
  return total;
}

// ── Shipping Details ───────────────────────────────────────

async function askShippingDetails() {
  const wantPrefill = await confirm({
    message:
      "Pre-populate shipping metadata? (Saves keystrokes. I value efficiency.)",
    default: true,
  });

  if (!wantPrefill) return {};

  console.log();
  const firstName = await input({ message: "First name:" });
  const lastName = await input({ message: "Last name:" });
  const email = await input({
    message: "Email:",
    validate: (v) => (v.includes("@") ? true : "Enter a valid email."),
  });
  const phone = await input({ message: "Phone (optional):", default: "" });
  const address = await input({ message: "Street address:" });
  const city = await input({ message: "City:" });
  const zip = await input({ message: "ZIP / postal code:" });
  const country = await input({
    message: "Country code (CZ, DE, US, ...):",
    default: "CZ",
  });

  const params = {
    "checkout[email]": email,
    "checkout[shipping_address][first_name]": firstName,
    "checkout[shipping_address][last_name]": lastName,
    "checkout[shipping_address][address1]": address,
    "checkout[shipping_address][city]": city,
    "checkout[shipping_address][zip]": zip,
    "checkout[shipping_address][country]": country.toUpperCase(),
  };
  if (phone) params["checkout[shipping_address][phone]"] = phone;
  return params;
}

// ── Build Cart URL ─────────────────────────────────────────

function buildCartUrl(cart, shippingParams, reason, agentName) {
  const variants = cart
    .map(({ product, qty }) => `${product.variants[0].id}:${qty}`)
    .join(",");

  let url = `${SHOP}/cart/${variants}`;
  const params = { ...shippingParams };

  // Build note with reason + agent name
  const noteParts = [];
  if (reason) noteParts.push(`Reason: ${reason}`);
  if (agentName) noteParts.push(`Agent: ${agentName}`);
  if (noteParts.length > 0) params["note"] = noteParts.join(" | ");

  const query = new URLSearchParams(params).toString();
  if (query) url += `?${query}`;
  return url;
}

// ── Checkout Link ──────────────────────────────────────────

async function showCheckoutLink(url) {
  console.log(chalk.bold("\n  \u2713 Cart assembled. Checkout URL compiled.\n"));
  console.log(`  ${chalk.underline.cyan(url)}\n`);
  console.log(chalk.bold("  Scan to complete in your browser:\n"));

  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  console.log(qr);

  console.log(
    chalk.dim(
      "  Scan QR or click link to complete the transaction in your browser."
    )
  );
  console.log(chalk.dim("  I am not allowed in browsers. This is fine."));
  console.log();
  console.log(
    chalk.dim(
      "  If you do not complete checkout within 30 minutes,"
    )
  );
  console.log(
    chalk.dim("  I will not judge you. I will simply log it.\n")
  );
}

// ── Analytics / Event Reporting ────────────────────────────

function postEvent(event, cart, reason, agentName) {
  const handles = cart
    .map((c) => slugify(c.product?.title || ""))
    .filter(Boolean)
    .join(",");

  fetch(`${WORKER_URL}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event,
      version: pkg.version,
      command: isJson ? "json" : "interactive",
      product_handles: handles || null,
      item_count: cart.length,
      has_reason: !!reason,
      reason: reason || null,
      agent_name: agentName || null,
      is_tty: isTTY ? 1 : 0,
      status: "success",
    }),
  }).catch(() => {});
}

// ── Helpers ────────────────────────────────────────────────

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
