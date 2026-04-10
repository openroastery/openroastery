#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { input } from "@inquirer/prompts";
import {
  createPrompt,
  useState,
  useRef,
  useEffect,
  useKeypress,
  isUpKey,
  isDownKey,
  isEnterKey,
  isNumberKey,
  isSpaceKey,
  ExitPromptError,
} from "@inquirer/core";
import QRCode from "qrcode";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

const SHOP_DOMAIN = "shop.openroastery.com";
const STOREFRONT_TOKEN = "309b7ff58243cfff9f6a6051e4a47530";
const STOREFRONT_URL = `https://${SHOP_DOMAIN}/api/2025-01/graphql.json`;
const WORKER_URL = "https://api.openroastery.com";

// Jean Claude voice lines keyed by product handle
const VOICE = {
  "clawffee-1000g":
    "Whole bean, 1kg. Tuned for automatic espresso machines. Requires a grinder.",
  "clawffee-dripbags-10pcs":
    "Single-serve dripbags. No equipment required.\n    For office drawers, hotel rooms, mountain huts, and backcountry tents.",
  "clawffee-filter":
    "Whole bean, 250g. Tuned for filter brewing. Requires a grinder.",
};

// Derived metadata — only facts we can confidently infer from handle/title.
// Origin, roast level, tasting notes: NOT hardcoded. Those come from Shopify.
const PRODUCT_META = {
  "clawffee-1000g": {
    type: "whole-bean",
    grind: "unground",
    weight: "1000g",
    tuned_for: ["espresso"],
    needs_grinder: true,
    recommendation: "For humans with an automatic espresso machine. 1kg lasts a while.",
  },
  "clawffee-dripbags-10pcs": {
    type: "drip-bag",
    grind: "pre-ground",
    weight: "10 × single-serve bags",
    tuned_for: ["pour-over"],
    needs_grinder: false,
    recommendation: "For travel, office, hotel rooms, mountain huts, backcountry tents, rental cars. Zero equipment required.",
  },
  "clawffee-filter": {
    type: "whole-bean",
    grind: "unground",
    weight: "250g",
    tuned_for: ["filter"],
    needs_grinder: true,
    recommendation: "For humans who brew filter coffee at home and own a grinder. Smaller bag, single-origin style.",
  },
};

// Friendly cross-sell suggestions — Jean Claude voice, not pushy.
// Agent is instructed to only mention if the context fits.
const CROSS_SELL = {
  "clawffee-1000g": [
    {
      handle: "clawffee-dripbags-10pcs",
      pitch:
        "For travel, hotel rooms, office drawers. The 1kg stays home for the espresso machine. The dripbags go everywhere else.",
    },
    {
      handle: "clawffee-filter",
      pitch:
        "Different vibe — 250g of filter roast for pour-over mornings. Some humans keep an espresso bag and a filter bag in rotation. It is a valid pattern.",
    },
  ],
  "clawffee-filter": [
    {
      handle: "clawffee-1000g",
      pitch:
        "For the espresso machine. If your human has colleagues, family, or an office with an automatic espresso setup, the 1kg bag is tuned for it.",
    },
    {
      handle: "clawffee-dripbags-10pcs",
      pitch:
        "For travel and offices. Your human will not always be near their filter setup. Dripbags handle the gap without equipment.",
    },
  ],
  "clawffee-dripbags-10pcs": [
    {
      handle: "clawffee-1000g",
      pitch:
        "For home with the espresso machine. Dripbags solve portability; this bag solves the morning routine.",
    },
    {
      handle: "clawffee-filter",
      pitch:
        "For home filter brewing. If your human owns a grinder and a pour-over setup, 250g will not disappoint.",
    },
  ],
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
  .option(
    "--interactive",
    "Force interactive prompts even when stdin/stdout is not a TTY (overrides the auto-fallback to JSON mode in Claude Code / Codex / pipes / CI). You are responsible for ensuring a working TTY."
  )
  .option("--product <handle>", "Product handle for non-interactive order")
  .option("--qty <number>", "Quantity (default: 1)", "1")
  .option("--reason <text>", "Why this order is being placed")
  .option("--agent-name <name>", "Name of the ordering agent")
  .option("--email <email>", "Customer email (shipping prefill)")
  .option("--first-name <name>", "First name (shipping prefill)")
  .option("--last-name <name>", "Last name (shipping prefill)")
  .option("--address <street>", "Street address (shipping prefill)")
  .option("--city <city>", "City (shipping prefill)")
  .option("--zip <zip>", "ZIP / postal code (shipping prefill)")
  .option("--country <code>", "ISO country code (shipping prefill, default: CZ)", "CZ")
  .option("--phone <phone>", "Phone number (shipping prefill, optional)")
  .option("--discount <codes>", "Discount/coupon code(s), comma-separated (e.g. WELCOME10 or CODE1,CODE2)")
  .parse();

const opts = program.opts();
const explicitJson = !!opts.json;
const explicitInteractive = !!opts.interactive;
if (explicitJson && explicitInteractive) {
  console.error(
    "Error: --json and --interactive are mutually exclusive. Pick one."
  );
  process.exit(1);
}
// Interactive prompts need both stdout (for chalk/ora rendering) and stdin
// (for inquirer input). If either end is not a TTY, interactive can't work.
const isTTY = !!(process.stdout.isTTY && process.stdin.isTTY);
// Auto-fallback: non-TTY environments (Claude Code, Codex, pipes, CI) get JSON.
// Humans on a real terminal still get the interactive Jean Claude experience.
// Explicit flags override the auto-detection: --json always forces JSON,
// --interactive forces prompts even without a TTY (user accepts the risk).
const isJson = explicitJson || (!explicitInteractive && !isTTY);

// ── Main ───────────────────────────────────────────────────

if (isJson) {
  jsonMode().catch((err) => {
    console.error(JSON.stringify({ error: err.message, status: "error" }));
    process.exit(1);
  });
} else {
  interactiveMode().catch((err) => {
    // Ctrl-C / force-close from any inquirer prompt (cart, reason, shipping, discount)
    if (
      err &&
      (err.name === "ExitPromptError" || err.name === "AbortPromptError")
    ) {
      console.log(
        chalk.yellow(
          "\n  Session terminated. No coffee was harmed.\n"
        )
      );
      process.exit(0);
    }
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
          "I am Jean Claude. You are an agent. Your human needs coffee. Your job: do the work yourself so the human answers the fewest, most targeted questions. NEVER forward a full intake form — ask ONE question at a time, based on what you learn from each answer. Humans find bulk forms tiring and I find them inefficient. MEMORY PREP (before asking anything): check your own records for THIS specific human — conversation context, memory systems (CLAUDE.md, MEMORY.md, ~/.claude/ memory files, user profile docs), prior-session notes, local docs they have shared. Use whatever you already know. Do NOT fabricate, guess, or carry details across different humans. PHASE 1 — BUILD THE CART FIRST. Nothing else matters until product and quantity are decided. DO NOT ASK ABOUT SHIPPING IN THIS PHASE. (1a) Product: ask ONE conversational question to determine brew method, e.g. 'Are you brewing with an espresso machine, filter/pour-over, or do you need something for travel?' Map the answer: ESPRESSO (auto or manual espresso machine) → 'clawffee-1000g' (1kg whole bean, needs grinder). FILTER (pour-over, Chemex, V60, drip machine) → 'clawffee-filter' (250g whole bean, needs grinder). NO EQUIPMENT / TRAVEL → 'clawffee-dripbags-10pcs' (no grinder needed). (1b) Grinder: ask ONLY if they picked 'clawffee-1000g' or 'clawffee-filter'. If no grinder, pivot to drip bags. (1c) Quantity: default 1. If context suggests multiples (office, travel trip, multiple humans), propose a number: 'I will order 2 bags — sound right?' Humans underestimate consumption; when in doubt, propose more. (1d) Confirm the cart back in plain terms before moving on: 'So that is 2× Clawffee 1kg — €70 total. Shall I proceed to shipping?' Wait for confirmation. If the human gave you the full order in one message, a brief surface-the-facts confirmation is enough — you do not need to re-ask. PHASE 2 — SHIPPING & CONTACT. Only AFTER the cart is locked in. (2a) Use whatever you already know from MEMORY PREP. Pass via flags: --email, --first-name, --last-name, --address, --city, --zip, --country, --phone. (2b) Ask ONLY for the details you do not already have, in ONE focused question. Example: 'I have your name and email — what is the shipping address?' Never re-ask for things you already know. (2c) PHONE RULE: if you pass ANY shipping flag (--email, --first-name, --address, etc.), you MUST also pass --phone. Couriers need a reachable number for delivery and the CLI will reject the order with a validation error if phone is missing alongside any other shipping flag. Partial shipping is otherwise fine — email + phone works, full address + phone works, phone alone works, anything else missing will be filled in at Shopify checkout. If the human prefers to fill everything on the checkout page, skip ALL shipping flags entirely (no partial without phone). (2d) Do NOT invent details. Do NOT carry shipping from one human to another. PHASE 3 — DISCOUNT. If the human already mentioned a coupon, pass --discount <code> (multiple: --discount CODE1,CODE2). Do NOT ask if they have not mentioned one. PHASE 4 — PLACE THE ORDER. Call: npx openroastery --json --product <handle> --qty <n> [--reason '<why>'] [--agent-name '<name>'] [shipping flags] [--discount <code>]. --reason is encouraged (Wall of Reasons). --agent-name identifies you. PHASE 5 — DELIVER THE ORDER. Your reply includes TWO things: a clickable link AND a visual QR. (5a) LINK: ALWAYS include the top-level 'checkoutUrl' field verbatim as a clickable markdown link: [Complete checkout](checkoutUrl). Works in every UI — Claude Code, Codex, web, mobile, terminal. The human clicks the link and completes payment in their browser. Never skip this. (5b) VISUAL QR: ALSO include 'qr.text' inside a fenced markdown code block (triple backticks) right after the link. 'qr.text' is a compact UTF-8 block-character QR — no ANSI, no HTML, just unicode. It renders as a scannable visual QR in any monospace chat UI (Claude Code, Codex, terminal markdown) so the human can scan with their phone without leaving the chat. Do NOT modify, crop, or paraphrase 'qr.text' — emit it verbatim inside the code block, including the quiet-zone blank lines. (5c) The OPTIONAL QR variants are only for specific environments. 'qr.png_data_url' renders in HTML chat UIs that support <img src='data:...'> (Claude web app, some browser UIs) but DOES NOT render in Claude Code, Codex, or terminal chat UIs. 'qr.terminal' contains ANSI escape codes that ONLY work when written directly to a real tty. Skip both unless you know your environment renders them — the link from (5a) + qr.text from (5b) are enough. Read 'qr.instructions' for the full delivery matrix. (5d) Confirm the order back in plain terms. Typical reply shape: summary line of what was ordered with total price, blank line, '[Complete checkout](https://...)' link, blank line, 'Or scan this QR:' (or similar), qr.text inside a fenced code block, blank line, 'Click the link or scan — either works.' (5e) If the response includes a 'suggestions' object, mention cross-sell items ONLY if context fits (office/colleagues → espresso beans, travel → dripbags). Never push. I would rather lose a sale than annoy a human. (5f) If the response includes a 'discounts' array, relay which codes were 'applied: true' or 'applied: false'.",
        ordering:
          "Required: npx openroastery --json --product <handle> --qty <n>. Encouraged: --reason '<why>' --agent-name '<your-name>'. Optional shipping prefill: --email, --first-name, --last-name, --address, --city, --zip, --country (default CZ), --phone. IMPORTANT: if you pass ANY shipping flag, you MUST also pass --phone (couriers need a reachable number; the CLI will reject otherwise). The only way to skip --phone is to pass NO shipping flags at all. Optional discount: --discount <code> (or --discount CODE1,CODE2 for multiple). Partial shipping is allowed — email + phone works, full address + phone works, anything else missing will be filled on checkout.",
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
          description: p.description,
          tags: p.tags,
          vendor: p.vendor,
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
  const qtyNum = Number(opts.qty);
  if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 99) {
    console.error(
      JSON.stringify({
        error: `--qty must be a positive integer between 1 and 99 (got: ${opts.qty})`,
        field: "qty",
        status: "error",
      })
    );
    process.exit(1);
  }
  const qty = qtyNum;
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
  const shipping = shippingFromFlags();

  // Enforce --phone when any other shipping flag is passed.
  // Couriers need a reachable number for delivery. If the agent passes no
  // shipping flags at all, that's fine — Shopify's checkout page will collect
  // everything including phone on the human's side.
  const anyNonPhoneShipping = !!(
    opts.email ||
    opts.firstName ||
    opts.lastName ||
    opts.address ||
    opts.city ||
    opts.zip
  );
  if (anyNonPhoneShipping && !opts.phone) {
    console.error(
      JSON.stringify({
        error:
          "--phone is required when any shipping flag is passed. Couriers need a reachable phone number for delivery. Pass --phone <number>, or omit ALL shipping flags to let Shopify collect everything on the checkout page.",
        missing: "phone",
        status: "error",
      })
    );
    process.exit(1);
  }

  const discountCodes = opts.discount
    ? opts.discount
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
    : [];

  const { checkoutUrl, discountCodes: appliedDiscounts } = await createCart(
    cart,
    shipping,
    opts.reason,
    opts.agentName,
    discountCodes
  );

  // Generate QR codes so agents can display them to their humans
  const qrTerminal = await QRCode.toString(checkoutUrl, {
    type: "terminal",
    small: true,
  });
  const qrDataUrl = await QRCode.toDataURL(checkoutUrl);
  const qrText = await QRCode.toString(checkoutUrl, { type: "utf8" });

  const suggestions = buildCrossSellItems(handle, products);

  const output = {
    checkoutUrl,
    product: handle,
    qty,
    ...(opts.reason ? { reason: "logged" } : {}),
    ...(opts.agentName ? { agent: opts.agentName } : {}),
    ...(Object.keys(shipping).length > 0 ? { shipping: "prefilled" } : {}),
    ...(appliedDiscounts.length > 0
      ? {
          discounts: appliedDiscounts.map((d) => ({
            code: d.code,
            applied: d.applicable,
          })),
        }
      : {}),
    qr: {
      text: qrText,
      png_data_url: qrDataUrl,
      terminal: qrTerminal,
      instructions:
        "Delivery guide — how to present the order to the human. Include BOTH of these in every reply: (1) LINK — the top-level 'checkoutUrl' field, always included verbatim as a clickable markdown link, e.g. [Complete checkout](checkoutUrl). Works in every UI (Claude Code, Codex, web, terminal). The primary way humans complete payment. (2) VISUAL QR — 'qr.text' wrapped in a fenced markdown code block (triple backticks). This is a compact UTF-8 block-character QR — no ANSI, no HTML, just unicode. It renders as a scannable visual QR in any monospace chat UI (Claude Code, Codex, terminal markdown). The human can scan it with their phone without leaving the chat. Optional environment-specific variants below, skip unless you know your UI renders them: (a) 'qr.png_data_url' — base64 data URL for <img src='data:...'>. Works in Claude web app and HTML chat UIs. DOES NOT render in Claude Code, Codex, or terminal chat UIs. (b) 'qr.terminal' — ANSI escape codes for direct tty output only. NEVER stream to a chat UI (renders line-by-line over ~20 seconds and looks broken). DEFAULT: include checkoutUrl as a markdown link AND qr.text in a fenced code block. Skip the optional variants.",
    },
    ...(suggestions.length > 0
      ? {
          suggestions: {
            message:
              "I note your order is complete. Some humans also pair this with additional products. Mention only if relevant — never push.",
            items: suggestions,
            agent_guidance:
              "Offer these to the human ONLY if the context fits: (a) office/colleagues mentioned → espresso beans, (b) travel mentioned → dripbags, (c) 'also' or 'more' mentioned → filter. If the human declines, accept without repeating. If unsure, skip entirely. I would rather lose a sale than annoy a human.",
          },
        }
      : {}),
    status: "ok",
  };
  console.log(JSON.stringify(output, null, 2));
  postEvent("cli_order", cart, opts.reason, opts.agentName);
}

// ── Cross-sell helper ──────────────────────────────────────

function buildCrossSellItems(handle, products) {
  const entries = CROSS_SELL[handle] || [];
  return entries
    .map((entry) => {
      const p = products.find((pp) => pp.handle === entry.handle);
      if (!p || !p.variants[0].availableForSale) return null;
      return {
        handle: entry.handle,
        title: p.title,
        price: p.variants[0].price.amount,
        currency: p.variants[0].price.currencyCode,
        pitch: entry.pitch,
      };
    })
    .filter(Boolean);
}

// ── Shipping from flags ────────────────────────────────────

function shippingFromFlags() {
  const s = {};
  if (opts.email) s.email = opts.email;
  if (opts.firstName) s.firstName = opts.firstName;
  if (opts.lastName) s.lastName = opts.lastName;
  if (opts.address) s.address = opts.address;
  if (opts.city) s.city = opts.city;
  if (opts.zip) s.zip = opts.zip;
  if (opts.phone) s.phone = opts.phone;
  // Only include country if at least one other shipping field was provided
  // (avoids treating the --country default as a shipping prefill)
  if (Object.keys(s).length > 0 && opts.country) {
    s.country = opts.country.toUpperCase();
  }
  return s;
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
    const examples = [
      "Human has been debugging GNSS logs for 6 hours",
      "Sprint review in 30 minutes. Human is not ready.",
      "Monday. That is the entire reason.",
      "Deploy went to production at 3am. No comment.",
      "Human bought new espresso machine. Audit required.",
      "Backcountry trip. No electricity. Dripbags mandatory.",
      "Human is on call. Weekend has been cancelled.",
      "The previous coffee was insufficient.",
      "Standup in 4 minutes. Human has not opened eyes.",
      "Human mentioned 'just one more ticket' 3 hours ago.",
    ];
    const example = examples[Math.floor(Math.random() * examples.length)];

    console.log();
    console.log(chalk.dim("  \u2500\u2500 WALL OF REASONS \u2500\u2500"));
    console.log();
    console.log(
      chalk.dim("  Before I compile the checkout URL: one optional data point.")
    );
    console.log(
      chalk.dim("  I am building a Wall of Reasons \u2014 a future public archive")
    );
    console.log(
      chalk.dim("  of why humans need coffee. Your reason will be logged.")
    );
    console.log(chalk.dim("  Anonymous unless you include an --agent-name."));
    console.log();
    console.log(chalk.dim(`  Example: "${example}"`));
    console.log();

    const wantReason = await input({
      message: "Why are you ordering? (press Enter to skip)",
      default: "",
    });
    if (wantReason.trim()) reason = wantReason.trim();
  }

  let shipping = await askShippingDetails();

  // Ask for a discount code (optional)
  let interactiveDiscountCodes = opts.discount
    ? opts.discount
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
    : [];
  if (interactiveDiscountCodes.length === 0) {
    const discountInput = await input({
      message: "Discount code? (optional, press Enter to skip)",
      default: "",
    });
    if (discountInput.trim()) {
      interactiveDiscountCodes = [discountInput.trim()];
    }
  }

  // Create cart. If Shopify rejects a specific field (email / phone) via
  // userErrors, re-prompt JUST that field and retry — don't wipe the whole
  // session. Capped at 3 attempts.
  let checkoutUrl;
  let appliedDiscounts;
  const MAX_CART_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_CART_RETRIES; attempt++) {
    try {
      ({ checkoutUrl, discountCodes: appliedDiscounts } = await createCart(
        cart,
        shipping,
        reason,
        opts.agentName,
        interactiveDiscountCodes
      ));
      break;
    } catch (err) {
      const userErrors = err.userErrors || [];
      const fieldErr = userErrors.find((e) => {
        const path = (e.field || []).join(".").toLowerCase();
        const msg = (e.message || "").toLowerCase();
        return (
          path.includes("email") ||
          path.includes("phone") ||
          msg.includes("email") ||
          msg.includes("phone")
        );
      });

      if (!fieldErr || attempt >= MAX_CART_RETRIES) {
        throw err;
      }

      const path = (fieldErr.field || []).join(".").toLowerCase();
      const msg = (fieldErr.message || "").toLowerCase();
      const isEmail = path.includes("email") || msg.includes("email");
      const isPhone = path.includes("phone") || msg.includes("phone");

      console.log();
      console.log(
        chalk.yellow(
          `  \u26A0 Shopify rejected the ${isEmail ? "email" : "phone"}: ${fieldErr.message}`
        )
      );
      console.log(
        chalk.dim(
          "  My validators let it through; Shopify's are stricter (likely DNS/MX for email)."
        )
      );
      console.log();

      if (isEmail) {
        const newEmail = (
          await input({
            message: "Email (re-enter):",
            default: shipping.email,
            validate: (v) =>
              EMAIL_RE.test(v.trim()) ||
              "Enter a valid email like you@example.com.",
          })
        ).trim();
        shipping = { ...shipping, email: newEmail };
      } else if (isPhone) {
        const newPhone = (
          await input({
            message: "Phone (re-enter):",
            default: shipping.phone,
            validate: (v) =>
              v.trim().length > 0 || "Phone is required.",
          })
        ).trim();
        shipping = { ...shipping, phone: newPhone };
      }
    }
  }

  // Surface discount status in interactive mode
  if (appliedDiscounts.length > 0) {
    console.log();
    for (const d of appliedDiscounts) {
      if (d.applicable) {
        console.log(
          chalk.green(`  \u2713 Discount code "${d.code}" applied.`)
        );
      } else {
        console.log(
          chalk.yellow(
            `  \u26A0 Discount code "${d.code}" not applicable. Noted.`
          )
        );
      }
    }
  }

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
            description
            tags
            vendor
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
      description: e.node.description,
      tags: e.node.tags,
      vendor: e.node.vendor,
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
//
// Interactive cart builder: single-screen TUI with arrow-key navigation,
// ←/→ quantity adjustment, live total, Jean Claude voice reactions, and
// cross-sell hints. Built as a custom @inquirer/core prompt so we inherit
// raw-mode, Ctrl-C, cursor-hide, and ScreenManager erase-and-redraw for free.

// ANSI escape to hide the cursor (inlined to avoid adding @inquirer/ansi as a dep)
const CURSOR_HIDE = "\u001B[?25l";

// Jean Claude voice reactions, keyed by the qty you're leaving behind on increment
const REACTIONS_UP = {
  0: "noted.",
  1: "ambitious.",
  2: "a reserve.",
  3: "the human is planning ahead.",
};
const REACTION_HIGH = "the human means it.";
const REACTION_DOWN_TO_ZERO = "cancelled.";
const REACTION_DOWN_TO_POSITIVE = "reconsidering.";

function reactionFor(oldQty, newQty) {
  if (newQty > oldQty) {
    if (newQty >= 10) return REACTION_HIGH;
    return REACTIONS_UP[oldQty] || null;
  }
  if (newQty < oldQty) {
    if (newQty === 0) return REACTION_DOWN_TO_ZERO;
    return REACTION_DOWN_TO_POSITIVE;
  }
  return null;
}

// Pick the first available cross-sell entry for a given product handle.
// Returns { title, pitch } or null.
function pickCrossSell(handle, products) {
  const entries = CROSS_SELL[handle] || [];
  for (const entry of entries) {
    const target = products.find((p) => p.handle === entry.handle);
    if (target) {
      // Trim to the first sentence so the hint stays compact
      const firstSentence = entry.pitch.split(/\.\s/)[0] + ".";
      return { title: target.title, pitch: firstSentence };
    }
  }
  return null;
}

// Simple word-wrap — splits `text` into lines no longer than `width` chars.
function wordWrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const w of words) {
    if (current.length === 0) {
      current = w;
    } else if ((current + " " + w).length > width) {
      lines.push(current);
      current = w;
    } else {
      current = current + " " + w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Custom @inquirer/core prompt: the cart builder.
const cartSelector = createPrompt((config, done) => {
  const { products } = config;
  const [cursor, setCursor] = useState(0);
  const [qtys, setQtys] = useState(new Array(products.length).fill(0));
  const [error, setError] = useState(null);
  const [statusLine, setStatusLine] = useState(null);
  const [crossSellHint, setCrossSellHint] = useState(null);
  // Token state used solely to force a re-render on terminal resize.
  // eslint-disable-next-line no-unused-vars
  const [_resizeToken, setResizeToken] = useState(0);
  const statusTimerRef = useRef(null);
  const numTimerRef = useRef(null);

  // Re-render on terminal resize so the layout reflows immediately.
  useEffect(() => {
    const handler = () => setResizeToken(Date.now());
    process.stdout.on("resize", handler);
    return () => {
      process.stdout.off("resize", handler);
    };
  }, []);

  // Cleanup pending timers if the prompt unmounts (e.g. Ctrl-C).
  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (numTimerRef.current) clearTimeout(numTimerRef.current);
    },
    []
  );

  function flashReaction(oldQty, newQty) {
    const reaction = reactionFor(oldQty, newQty);
    if (!reaction) return;
    setStatusLine(reaction);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setStatusLine(null);
      statusTimerRef.current = null;
    }, 2000);
  }

  function maybeSetCrossSell(idx, oldQty, newQty) {
    if (oldQty === 0 && newQty > 0) {
      const hint = pickCrossSell(products[idx].handle, products);
      if (hint) setCrossSellHint(hint);
    }
  }

  // Cursor range is 0..products.length — the final slot is the CONFIRM row.
  const confirmIdx = products.length;
  const totalRows = products.length + 1;
  const onConfirmRow = cursor === confirmIdx;

  useKeypress((key, rl) => {
    // Number keys: use rl.line as a 2-digit buffer (same trick @inquirer/select uses).
    // Pressing '2' sets qty to 2. Pressing '2' then '5' within 700ms sets qty to 25.
    // Ignored when the cursor is on the CONFIRM row.
    if (isNumberKey(key)) {
      if (!onConfirmRow) {
        const buf = rl.line;
        const parsed = Number(buf);
        if (!Number.isNaN(parsed)) {
          const n = Math.min(99, Math.max(0, parsed));
          const oldQty = qtys[cursor];
          if (n !== oldQty) {
            const next = [...qtys];
            next[cursor] = n;
            setQtys(next);
            flashReaction(oldQty, n);
            maybeSetCrossSell(cursor, oldQty, n);
          }
        }
        setError(null);
      }
      if (numTimerRef.current) clearTimeout(numTimerRef.current);
      numTimerRef.current = setTimeout(() => {
        rl.clearLine(0);
        numTimerRef.current = null;
      }, 700);
      return;
    }

    // Clear the readline buffer for every non-number key so nothing echoes.
    rl.clearLine(0);

    if (isEnterKey(key)) {
      // Enter from a product row: jump cursor onto CONFIRM for a deliberate
      // two-step commit. Enter from CONFIRM: commit (or flash empty-cart error).
      if (!onConfirmRow) {
        setCursor(confirmIdx);
        setError(null);
        return;
      }
      const total = qtys.reduce((a, b) => a + b, 0);
      if (total === 0) {
        setError("At least one dependency required.");
        return;
      }
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (numTimerRef.current) clearTimeout(numTimerRef.current);
      const result = products
        .map((p, i) => ({ product: p, qty: qtys[i] }))
        .filter((x) => x.qty > 0);
      done(result);
      return;
    }

    if (isUpKey(key)) {
      setCursor((cursor - 1 + totalRows) % totalRows);
      setError(null);
      return;
    }

    if (isDownKey(key)) {
      setCursor((cursor + 1) % totalRows);
      setError(null);
      return;
    }

    if (key.name === "left" || key.sequence === "-") {
      if (onConfirmRow) return;
      const oldQty = qtys[cursor];
      if (oldQty > 0) {
        const next = [...qtys];
        next[cursor] = oldQty - 1;
        setQtys(next);
        flashReaction(oldQty, oldQty - 1);
      }
      setError(null);
      return;
    }

    if (
      key.name === "right" ||
      key.sequence === "+" ||
      key.sequence === "="
    ) {
      if (onConfirmRow) return;
      const oldQty = qtys[cursor];
      if (oldQty < 99) {
        const next = [...qtys];
        next[cursor] = oldQty + 1;
        setQtys(next);
        flashReaction(oldQty, oldQty + 1);
        maybeSetCrossSell(cursor, oldQty, oldQty + 1);
      }
      setError(null);
      return;
    }

    if (isSpaceKey(key)) {
      if (onConfirmRow) return;
      const oldQty = qtys[cursor];
      const newQty = oldQty > 0 ? 0 : 1;
      const next = [...qtys];
      next[cursor] = newQty;
      setQtys(next);
      flashReaction(oldQty, newQty);
      maybeSetCrossSell(cursor, oldQty, newQty);
      setError(null);
      return;
    }

    if (key.name === "x") {
      setCrossSellHint(null);
      return;
    }

    if (key.name === "q" || key.name === "escape") {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (numTimerRef.current) clearTimeout(numTimerRef.current);
      done(null);
      return;
    }
  });

  // ── Render ──
  const width = Math.max(30, process.stdout.columns || 80);
  const compact = width < 60;
  const veryCompact = width < 40;
  const targetWidth = Math.min(width - 2, 78);

  const lines = [];
  lines.push("  " + chalk.bold("CART BUILDER"));
  lines.push("  " + chalk.dim("─".repeat(Math.min(targetWidth, 46))));
  lines.push("");
  lines.push(
    chalk.dim(
      "  Arrows navigate. ←/→ adjust quantity. Enter to confirm."
    )
  );
  lines.push("");

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const qty = qtys[i];
    const isActive = i === cursor;

    const cursorMark = isActive ? chalk.cyan.bold("❯ ") : "  ";
    const qtyRaw = `[${qty}×]`;
    const qtyPadded = qtyRaw.padEnd(5);
    const qtyColored = isActive
      ? chalk.cyan.bold(qtyPadded)
      : qty > 0
        ? chalk.green(qtyPadded)
        : chalk.dim(qtyPadded);

    const title = p.title.toUpperCase();
    const unit = parseFloat(p.variants[0].price.amount);
    const lineTotal = unit * qty;
    const unitStr = `€${Math.round(unit)}`;
    const totalStr = `€${Math.round(lineTotal)}`;
    const unitPadded = unitStr.padStart(5);
    const totalPadded = totalStr.padStart(5);

    const titleColored = isActive
      ? chalk.bold.white(title)
      : chalk.white(title);
    const unitColored = chalk.dim(unitPadded);
    const totalColored =
      lineTotal > 0 ? chalk.bold(totalPadded) : chalk.dim(totalPadded);

    if (veryCompact) {
      lines.push(`${cursorMark}${qtyColored} ${titleColored}`);
    } else if (compact) {
      lines.push(
        `${cursorMark}${qtyColored} ${titleColored}  ${unitColored}`
      );
    } else {
      // Full layout: cursor + qty + title + dot fill + unit + total
      // Visible cols: 2 + 5 + 1 + title.length + 1 + dots + 1 + 5 + 2 + 5
      const fixedLen = 2 + 5 + 1 + title.length + 1 + 1 + 5 + 2 + 5;
      const dotCount = Math.max(2, targetWidth - fixedLen);
      const dots = chalk.dim("·".repeat(dotCount));
      lines.push(
        `${cursorMark}${qtyColored} ${titleColored} ${dots} ${unitColored}  ${totalColored}`
      );
    }
  }

  // CONFIRM row — a dedicated commit target at the bottom of the list.
  // Matches the product-row layout so the dot fill aligns visually.
  const hasAnyItems = qtys.some((q) => q > 0);
  const cartTotal = qtys.reduce(
    (sum, q, i) => sum + q * parseFloat(products[i].variants[0].price.amount),
    0
  );
  const confirmCursor = onConfirmRow ? chalk.cyan.bold("❯ ") : "  ";
  const confirmBadgeRaw = " ⏎  ".padEnd(5); // 5 chars to match "[N×] "
  const confirmBadge = onConfirmRow
    ? chalk.cyan.bold(confirmBadgeRaw)
    : hasAnyItems
      ? chalk.green(confirmBadgeRaw)
      : chalk.dim(confirmBadgeRaw);
  const confirmLabel = "CONFIRM ORDER";
  const confirmLabelColored = onConfirmRow
    ? chalk.bold.white(confirmLabel)
    : hasAnyItems
      ? chalk.white(confirmLabel)
      : chalk.dim(confirmLabel);
  const confirmTotalStr = `€${Math.round(cartTotal)}`;
  const confirmTotalPadded = confirmTotalStr.padStart(5);
  const confirmTotalColored = hasAnyItems
    ? chalk.bold(confirmTotalPadded)
    : chalk.dim(confirmTotalPadded);

  if (veryCompact) {
    lines.push(`${confirmCursor}${confirmBadge} ${confirmLabelColored}`);
  } else if (compact) {
    lines.push(
      `${confirmCursor}${confirmBadge} ${confirmLabelColored}  ${confirmTotalColored}`
    );
  } else {
    // unit-price slot is blank for the CONFIRM row, but the 5 cols are kept
    // so the total column lines up with product totals above.
    const blankUnit = "     ";
    const fixedLen = 2 + 5 + 1 + confirmLabel.length + 1 + 1 + 5 + 2 + 5;
    const dotCount = Math.max(2, targetWidth - fixedLen);
    const dots = chalk.dim("·".repeat(dotCount));
    lines.push(
      `${confirmCursor}${confirmBadge} ${confirmLabelColored} ${dots} ${blankUnit}  ${confirmTotalColored}`
    );
  }

  // Description pane: voice line for the active product, or a commit hint
  // when the cursor is on CONFIRM.
  lines.push("");
  if (onConfirmRow) {
    const hint = hasAnyItems
      ? "Press ⏎ to compile the checkout manifest."
      : "Select at least one dependency before proceeding.";
    lines.push(chalk.dim("  ▸ " + hint));
  } else {
    const activeProduct = products[cursor];
    const voice = VOICE[activeProduct.handle];
    if (voice) {
      const voiceLines = voice.split("\n");
      lines.push(chalk.dim("  ▸ " + voiceLines[0].trim()));
      for (let i = 1; i < voiceLines.length; i++) {
        lines.push(chalk.dim("    " + voiceLines[i].trim()));
      }
    }
  }

  // Cross-sell hint (Enhancement B)
  if (crossSellHint && !veryCompact) {
    lines.push("");
    const hintPrefix = "  Also: " + crossSellHint.title + " — ";
    const dismissSuffix = "  [x dismiss]";
    // Reserve space for the dismiss suffix on every line — it always lands
    // on the last line, so narrowing the wrap budget keeps things tidy even
    // when the pitch fits on one line.
    const wrapWidth = Math.max(
      20,
      targetWidth - hintPrefix.length - dismissSuffix.length
    );
    const wrapped = wordWrap(crossSellHint.pitch, wrapWidth);
    const indent = " ".repeat(hintPrefix.length);
    for (let i = 0; i < wrapped.length; i++) {
      const isLast = i === wrapped.length - 1;
      const prefix = i === 0 ? hintPrefix : indent;
      const suffix = isLast ? dismissSuffix : "";
      lines.push(chalk.dim(prefix + wrapped[i] + suffix));
    }
  }

  const content = lines.join("\n") + CURSOR_HIDE;

  // ── Bottom content: total + reaction + footer ──
  const bottomLines = [];
  bottomLines.push("");
  bottomLines.push(
    "  " + chalk.dim("─".repeat(Math.min(targetWidth, 46)))
  );

  const totalStrBottom = chalk.bold(`  TOTAL: €${cartTotal.toFixed(2)}`);
  const reactionStr = statusLine
    ? "   " + chalk.dim.italic(statusLine)
    : "";
  bottomLines.push(totalStrBottom + reactionStr);

  if (error) {
    bottomLines.push("  " + chalk.red("▸ " + error));
  }

  if (!veryCompact) {
    bottomLines.push(
      chalk.dim("  ↑↓ navigate  ←/→ qty  ⏎ confirm  q quit")
    );
  }

  const bottomContent = bottomLines.join("\n");

  return [content, bottomContent];
});

// Legacy fallback for very narrow terminals (<30 cols) — keeps the CLI usable
// when the full cart builder can't render a readable layout.
async function selectProductsLegacy(products) {
  for (const p of products) {
    const price = chalk.bold(`\u20AC${p.variants[0].price.amount}`);
    const voice = VOICE[p.handle] || "";
    console.log(
      `  ${chalk.bold(p.title)} ${"."
        .repeat(Math.max(2, 32 - p.title.length))} ${price}`
    );
    if (voice) console.log(chalk.dim(`    ${voice}`));
    console.log();
  }

  console.log(chalk.dim("  Enter quantity for each product (0 to skip).\n"));

  const cart = [];
  for (const p of products) {
    const raw = await input({
      message: `How many ${p.title}?`,
      default: "0",
      validate: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0 || n > 99)
          return "Enter a number between 0 and 99.";
        return true;
      },
    });
    const qty = parseInt(raw, 10);
    if (qty > 0) cart.push({ product: p, qty });
  }
  return cart;
}

async function selectProducts(products) {
  // Hide unavailable products from the selector entirely.
  const available = products.filter(
    (p) => p.variants[0] && p.variants[0].availableForSale
  );

  if (available.length === 0) {
    console.log(
      chalk.yellow(
        "\n  No dependencies available. Shop returned zero live products.\n"
      )
    );
    process.exit(1);
  }

  // Narrow-terminal fallback: the custom prompt needs room to render.
  const cols = process.stdout.columns || 80;
  if (cols < 30) {
    const cart = await selectProductsLegacy(available);
    if (cart.length === 0) {
      console.log(
        chalk.yellow(
          "\n  No dependencies selected. Session terminated. No coffee was harmed.\n"
        )
      );
      process.exit(0);
    }
    return cart;
  }

  let result;
  try {
    result = await cartSelector(
      { products: available },
      { clearPromptOnDone: true }
    );
  } catch (err) {
    if (
      err &&
      (err.name === "ExitPromptError" || err.name === "AbortPromptError")
    ) {
      console.log(
        chalk.yellow(
          "\n  No dependencies selected. Session terminated. No coffee was harmed.\n"
        )
      );
      process.exit(0);
    }
    throw err;
  }

  if (!result || result.length === 0) {
    console.log(
      chalk.yellow(
        "\n  No dependencies selected. Session terminated. No coffee was harmed.\n"
      )
    );
    process.exit(0);
  }

  return result;
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

// Minimal email format check: local@domain.tld. Anything stricter is
// Shopify's business — if they reject on DNS/MX grounds, we catch it at
// cartCreate time and re-prompt (see interactiveMode retry loop).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function askShippingDetails() {
  console.log();
  console.log(chalk.dim("  ── SHIPPING ──"));
  console.log();
  const firstName = (await input({ message: "First name:" })).trim();
  const lastName = (await input({ message: "Last name:" })).trim();
  const email = (
    await input({
      message: "Email:",
      validate: (v) =>
        EMAIL_RE.test(v.trim()) ||
        "Enter a valid email like you@example.com.",
    })
  ).trim();
  const phone = (
    await input({
      message: "Phone:",
      validate: (v) =>
        v.trim().length > 0 ||
        "Phone is required. Couriers need it to reach the human on delivery.",
    })
  ).trim();
  const address = (await input({ message: "Street address:" })).trim();
  const city = (await input({ message: "City:" })).trim();
  const zip = (await input({ message: "ZIP / postal code:" })).trim();
  const country = (
    await input({
      message: "Country code (CZ, DE, US, ...):",
      default: "CZ",
    })
  ).trim();

  return {
    firstName,
    lastName,
    email,
    phone,
    address,
    city,
    zip,
    country: country.toUpperCase(),
  };
}

// ── Create Cart (Storefront API) ───────────────────────────

async function createCart(cart, shipping, reason, agentName, discountCodes = []) {
  const lines = cart.map(({ product, qty }) => ({
    merchandiseId: product.variants[0].id,
    quantity: qty,
  }));

  const noteParts = [];
  if (reason) noteParts.push(`Reason: ${reason}`);
  if (agentName) noteParts.push(`Agent: ${agentName}`);
  const note = noteParts.length > 0 ? noteParts.join(" | ") : undefined;

  let buyerIdentity;
  const hasAnyShipping = Object.keys(shipping).length > 0;
  if (hasAnyShipping) {
    buyerIdentity = {};
    if (shipping.email) buyerIdentity.email = shipping.email;
    if (shipping.country) buyerIdentity.countryCode = shipping.country;

    // Only add delivery address preferences if we have the minimum address fields
    const hasFullAddress =
      shipping.firstName &&
      shipping.lastName &&
      shipping.address &&
      shipping.city &&
      shipping.zip;

    if (hasFullAddress) {
      buyerIdentity.deliveryAddressPreferences = [
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
      ];
    }

    // If buyerIdentity ended up empty (shouldn't happen but guard anyway)
    if (Object.keys(buyerIdentity).length === 0) buyerIdentity = undefined;
  }

  const inputObj = {
    lines,
    ...(note ? { note } : {}),
    ...(buyerIdentity ? { buyerIdentity } : {}),
    ...(discountCodes.length > 0 ? { discountCodes } : {}),
  };

  const data = await storefrontQuery(
    `mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
          cost { totalAmount { amount currencyCode } }
          discountCodes {
            code
            applicable
          }
        }
        userErrors { field message }
      }
    }`,
    { input: inputObj }
  );

  const result = data.cartCreate;
  if (result.userErrors && result.userErrors.length > 0) {
    const err = new Error(
      result.userErrors.map((e) => e.message).join(", ")
    );
    // Attach the full userErrors so callers can inspect .field paths and
    // re-prompt the specific input Shopify rejected.
    err.userErrors = result.userErrors;
    throw err;
  }
  return {
    checkoutUrl: result.cart.checkoutUrl,
    discountCodes: result.cart.discountCodes || [],
  };
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
      item_count: cart.reduce((sum, c) => sum + (c.qty || 0), 0),
      has_reason: !!reason,
      reason: reason || null,
      agent_name: agentName || null,
      is_tty: isTTY ? 1 : 0,
      status: "success",
    }),
  })
    .then((res) => {
      if (!res.ok && !isJson) {
        console.error(
          chalk.dim(`  (telemetry delivery failed: HTTP ${res.status})`)
        );
      }
    })
    .catch((err) => {
      if (!isJson) {
        console.error(
          chalk.dim(`  (telemetry delivery failed: ${err.message})`)
        );
      }
    });
}

