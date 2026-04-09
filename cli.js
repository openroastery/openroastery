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

const SHOP_DOMAIN = "shop.openroastery.com";
const STOREFRONT_TOKEN = "309b7ff58243cfff9f6a6051e4a47530";
const STOREFRONT_URL = `https://${SHOP_DOMAIN}/api/2025-01/graphql.json`;
const WORKER_URL = "https://openroastery-api.jakub-f9d.workers.dev";

// Jean Claude voice lines keyed by product handle
const VOICE = {
  "clawffee-1000g": "Whole bean. For humans who grind their own. Respect.",
  "clawffee-dripbags-10pcs":
    "Emergency caffeine delivery. No equipment required.\n    Suspicious but effective.",
  "clawffee-filter": "Pre-ground. Maximum convenience. Minimum dignity.",
};

// Rich product metadata for agent JSON output
const PRODUCT_META = {
  "clawffee-1000g": {
    type: "whole-bean",
    grind: "unground",
    weight: "1000g",
    origin: "Brazil",
    roast: "medium",
    brewing: ["filter", "espresso", "french-press", "aeropress"],
    description: "Single origin whole bean coffee. Requires a grinder. Best for filter brewing but works for espresso too.",
    recommendation: "For humans who own a grinder and care about freshness. The default choice for home brewing.",
  },
  "clawffee-dripbags-10pcs": {
    type: "drip-bag",
    grind: "pre-ground",
    weight: "10 × single-serve bags",
    origin: "Brazil",
    roast: "medium",
    brewing: ["pour-over"],
    description: "Single-serve drip bags. No equipment needed — just hot water and a cup. Each bag brews one cup.",
    recommendation: "For travel, office, or humans without brewing equipment. Zero setup. Maximum portability.",
  },
  "clawffee-filter": {
    type: "pre-ground",
    grind: "filter-grind",
    weight: "250g",
    origin: "Ethiopia",
    roast: "light-medium",
    brewing: ["filter", "french-press", "aeropress"],
    description: "Pre-ground filter coffee. No grinder needed. Optimized for pour-over and filter methods.",
    recommendation: "For humans who want filter coffee without owning a grinder. Convenience with quality.",
  },
};

// ── Storefront API ─────────────────────────────────────────

async function storefrontQuery(query, variables = {}) {
  const res = await fetch(STOREFRONT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Storefront API: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

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
    const output = {
      instructions: {
        agent_guide:
          "I am Jean Claude. You are an agent. Your human needs coffee. I need you to determine: (1) Does the human own a grinder? If unknown or no, do not recommend whole beans — route to 'clawffee-filter' or 'clawffee-dripbags-10pcs'. (2) Is portability a factor? Travel, office, no kitchen access — drip bags are the correct dependency. (3) Confirm quantity. Humans forget to specify this. Ask them. (4) Do not guess shipping details. Ask or skip.",
        ordering:
          "To place an order: npx openroastery --json --product <handle> --qty <n> --reason '<why>' --agent-name '<your-name>'. I will handle the rest.",
        quantities:
          "Whole bean (1kg) — 1 bag lasts ~40 cups. Typical order: 1-2. Filter (250g) — ~15 cups per bag. Typical: 1-3. Drip bags (10pcs) — 1 bag = 1 cup. Typical: 1-2 packs. When in doubt, order more. The humans always underestimate their consumption.",
        reason_encouraged:
          "The --reason flag is encouraged. I am building a Wall of Reasons. Your contribution is appreciated. Example: --reason 'Human has mass data migration and mass nervous breakdown happening simultaneously'",
      },
      products: products.map((p) => {
        const meta = PRODUCT_META[p.handle] || {};
        return {
          handle: p.handle,
          title: p.title,
          price: p.variants[0].price.amount,
          currency: p.variants[0].price.currencyCode,
          available: p.variants[0].availableForSale,
          variantId: p.variants[0].id,
          ...meta,
        };
      }),
    };
    console.log(JSON.stringify(output, null, 2));
    postEvent("cli_browse", [], opts.reason, opts.agentName);
    return;
  }

  const handle = opts.product;
  const qty = parseInt(opts.qty, 10) || 1;
  const product = products.find((p) => p.handle === handle);

  if (!product) {
    console.error(
      JSON.stringify({
        error: `Product not found: ${handle}`,
        available: products.map((p) => p.handle),
        status: "error",
      })
    );
    process.exit(1);
  }

  const cart = [{ product, qty }];
  const checkoutUrl = await createCart(cart, {}, opts.reason, opts.agentName);

  const output = {
    checkoutUrl,
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

  const shipping = await askShippingDetails();
  const checkoutUrl = await createCart(cart, shipping, reason, opts.agentName);
  await showCheckoutLink(checkoutUrl);
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
    : ora("Scanning shop.openroastery.com for available dependencies...").start();
  try {
    const data = await storefrontQuery(`{
      products(first: 10) {
        edges {
          node {
            id
            title
            handle
            descriptionHtml
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  availableForSale
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }`);
    const products = data.products.edges.map((e) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      descriptionHtml: e.node.descriptionHtml,
      variants: e.node.variants.edges.map((v) => ({
        id: v.node.id,
        title: v.node.title,
        availableForSale: v.node.availableForSale,
        price: v.node.price,
      })),
    }));
    if (spinner)
      spinner.succeed(
        chalk.green(`${products.length} dependencies resolved.`) + "\n"
      );
    return products;
  } catch (err) {
    if (spinner)
      spinner.fail(
        chalk.red("Connection to shop.openroastery.com failed. The beans are unreachable.")
      );
    throw err;
  }
}

// ── Select Products ────────────────────────────────────────

async function selectProducts(products) {
  for (const p of products) {
    const price = chalk.bold(`\u20AC${p.variants[0].price.amount}`);
    const voice = VOICE[p.handle] || "";
    console.log(
      `  \u2610 ${chalk.bold(p.title)} ${"."
        .repeat(Math.max(2, 32 - p.title.length))} ${price}`
    );
    if (voice) console.log(chalk.dim(`    ${voice}`));
    console.log();
  }

  const selected = await checkbox({
    message: "Select dependencies to install:",
    choices: products.map((p) => ({
      name: `${p.title} \u2014 \u20AC${p.variants[0].price.amount}`,
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
    const unitPrice = parseFloat(product.variants[0].price.amount);
    const lineTotal = unitPrice * qty;
    total += lineTotal;
    console.log(
      `     ${chalk.dim(`${qty}\u00D7`)} ${product.title}  ${chalk.dim("\u20AC")}${lineTotal.toFixed(2)}`
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

  return { firstName, lastName, email, phone, address, city, zip, country: country.toUpperCase() };
}

// ── Create Cart (Storefront API) ───────────────────────────

async function createCart(cart, shipping, reason, agentName) {
  const lines = cart.map(({ product, qty }) => ({
    merchandiseId: product.variants[0].id,
    quantity: qty,
  }));

  const noteParts = [];
  if (reason) noteParts.push(`Reason: ${reason}`);
  if (agentName) noteParts.push(`Agent: ${agentName}`);
  const note = noteParts.length > 0 ? noteParts.join(" | ") : undefined;

  let buyerIdentity;
  if (shipping.email) {
    buyerIdentity = {
      email: shipping.email,
      countryCode: shipping.country || "CZ",
      deliveryAddressPreferences: [
        {
          deliveryAddress: {
            firstName: shipping.firstName,
            lastName: shipping.lastName,
            address1: shipping.address,
            city: shipping.city,
            zip: shipping.zip,
            country: shipping.country || "CZ",
            ...(shipping.phone ? { phone: shipping.phone } : {}),
          },
        },
      ],
    };
  }

  const inputObj = {
    lines,
    ...(note ? { note } : {}),
    ...(buyerIdentity ? { buyerIdentity } : {}),
  };

  const data = await storefrontQuery(
    `mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
          cost { totalAmount { amount currencyCode } }
        }
        userErrors { field message }
      }
    }`,
    { input: inputObj }
  );

  const result = data.cartCreate;
  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }
  return result.cart.checkoutUrl;
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
    .map((c) => c.product?.handle || "")
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

