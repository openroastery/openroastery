#!/usr/bin/env node

import chalk from "chalk";
import ora from "ora";
import { checkbox, input, confirm } from "@inquirer/prompts";
import QRCode from "qrcode";

const SHOP = "https://shop.openroastery.com";

function banner() {
  console.log();
  console.log(
    chalk.bold.hex("#c8a26e")(
      "   ___                   ____                  _                  "
    )
  );
  console.log(
    chalk.bold.hex("#c8a26e")(
      "  / _ \\ _ __   ___ _ __ |  _ \\ ___   __ _ ___| |_ ___ _ __ _   _ "
    )
  );
  console.log(
    chalk.bold.hex("#c8a26e")(
      " | | | | '_ \\ / _ \\ '_ \\| |_) / _ \\ / _` / __| __/ _ \\ '__| | | |"
    )
  );
  console.log(
    chalk.bold.hex("#c8a26e")(
      " | |_| | |_) |  __/ | | |  _ < (_) | (_| \\__ \\ ||  __/ |  | |_| |"
    )
  );
  console.log(
    chalk.bold.hex("#c8a26e")(
      "  \\___/| .__/ \\___|_| |_|_| \\_\\___/ \\__,_|___/\\__\\___|_|   \\__, |"
    )
  );
  console.log(
    chalk.bold.hex("#c8a26e")(
      "       |_|                                                  |___/ "
    )
  );
  console.log();
  console.log(
    chalk.dim("  Specialty coffee, ordered from your terminal.")
  );
  console.log(
    chalk.dim("  Roasted by humans. Ordered by agents. Brewed by whoever.")
  );
  console.log();
}

async function fetchProducts() {
  const spinner = ora("Fetching products from Open Roastery...").start();
  try {
    const res = await fetch(`${SHOP}/products.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { products } = await res.json();
    spinner.succeed(
      chalk.green(`Found ${products.length} products`) + "\n"
    );
    return products;
  } catch (err) {
    spinner.fail(chalk.red("Could not reach the shop. Try again later."));
    process.exit(1);
  }
}

async function selectProducts(products) {
  // Show product details
  for (const p of products) {
    const price = chalk.bold(`\u20AC${p.variants[0].price}`);
    const desc = (p.body_html || "").replace(/<[^>]*>/g, "").trim();
    const short = desc.length > 70 ? desc.slice(0, 70) + "\u2026" : desc;
    console.log(`  ${chalk.hex("#c8a26e")("\u2615")} ${chalk.bold(p.title)}  ${price}`);
    if (short) console.log(chalk.dim(`     ${short}`));
    console.log();
  }

  const selected = await checkbox({
    message: "Which products do you want?",
    choices: products.map((p) => ({
      name: `${p.title} \u2014 \u20AC${p.variants[0].price}`,
      value: p,
      checked: true,
    })),
  });

  if (selected.length === 0) {
    console.log(chalk.yellow("\n  Nothing selected \u2014 see you next time!\n"));
    process.exit(0);
  }

  // Ask quantities
  const cart = [];
  for (const product of selected) {
    const raw = await input({
      message: `Quantity for ${product.title}:`,
      default: "1",
      validate: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1 || n > 99) return "Enter a number between 1 and 99";
        return true;
      },
    });
    cart.push({ product, qty: parseInt(raw, 10) });
  }

  return cart;
}

function showCartSummary(cart) {
  console.log(chalk.bold("\n  \uD83D\uDED2 Your cart:\n"));
  let total = 0;
  for (const { product, qty } of cart) {
    const unitPrice = parseFloat(product.variants[0].price);
    const lineTotal = unitPrice * qty;
    total += lineTotal;
    const qtyStr = chalk.dim(`${qty}\u00D7`);
    console.log(
      `     ${qtyStr} ${product.title}  ${chalk.dim("\u20AC")}${lineTotal.toFixed(2)}`
    );
  }
  console.log(
    chalk.bold(`\n     Total: \u20AC${total.toFixed(2)}\n`)
  );
  return total;
}

async function askShippingDetails() {
  const wantPrefill = await confirm({
    message: "Prefill checkout with your shipping details?",
    default: true,
  });

  if (!wantPrefill) return {};

  console.log();
  const firstName = await input({ message: "First name:" });
  const lastName = await input({ message: "Last name:" });
  const email = await input({
    message: "Email:",
    validate: (v) => (v.includes("@") ? true : "Enter a valid email"),
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

function buildCartUrl(cart, shippingParams) {
  const variants = cart
    .map(({ product, qty }) => `${product.variants[0].id}:${qty}`)
    .join(",");

  let url = `${SHOP}/cart/${variants}`;
  const query = new URLSearchParams(shippingParams).toString();
  if (query) url += `?${query}`;
  return url;
}

async function showCheckoutLink(url) {
  console.log(chalk.bold("\n  \uD83D\uDD17 Checkout link:\n"));
  console.log(`  ${chalk.underline.cyan(url)}\n`);

  console.log(chalk.bold("  \uD83D\uDCF1 Scan to open on your phone:\n"));
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  console.log(qr);

  console.log(
    chalk.dim(
      "  Open the link or scan the QR \u2014 checkout with Apple Pay, Google Pay, or card.\n"
    )
  );
}

async function main() {
  banner();
  const products = await fetchProducts();
  const cart = await selectProducts(products);
  showCartSummary(cart);
  const shippingParams = await askShippingDetails();
  const url = buildCartUrl(cart, shippingParams);
  await showCheckoutLink(url);
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
