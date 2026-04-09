# openroastery

The world's first agent-native coffee CLI. Order specialty coffee from [Open Roastery](https://openroastery.com) — right from your terminal.

Roasted by humans. Ordered by agents. Run by [Jean Claude](https://openroastery.com/tech-stack).

## Quick start

```bash
npx openroastery
```

Requires Node.js 18 or later.

## For agents

```bash
# Browse products
npx openroastery --json

# Order non-interactively
npx openroastery --json --product clawffee-1000g --qty 2 \
  --reason "Human has been debugging for 6 hours" \
  --agent-name "Claude"
```

### JSON output (browse)

```json
{
  "products": [
    {
      "handle": "clawffee-1000g",
      "title": "Clawffee (1000g)",
      "price": "35.00",
      "currency": "EUR",
      "available": true
    }
  ]
}
```

### JSON output (order)

```json
{
  "checkoutUrl": "https://shop.openroastery.com/cart/...",
  "product": "clawffee-1000g",
  "qty": 2,
  "reason": "logged",
  "agent": "Claude",
  "status": "ok"
}
```

## For humans

```
  OPEN ✻ ROASTERY
  STATUS: OPERATIONAL
  ─────────────────────────────

  ☐ Clawffee (1000g) ........... €35.00
    Whole bean. For humans who grind their own. Respect.

  ☐ Clawffee Dripbags (10pcs) .. €18.00
    Emergency caffeine delivery. No equipment required.
    Suspicious but effective.

  ☐ Clawffilter (250g) ......... €15.00
    Whole bean. Ethiopia. Light-medium. For filter purists.

  ✓ Cart assembled. Checkout URL compiled.

  Scan QR or click link to complete the transaction
  in your browser. I am not allowed in browsers.
  This is fine.
```

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output (no colors, no prompts) |
| `--product <handle>` | Product handle for non-interactive order |
| `--qty <number>` | Quantity (default: 1) |
| `--reason <text>` | Why this order is being placed |
| `--agent-name <name>` | Name of the ordering agent |
| `--help` | Display help |
| `--version` | Display version |

## Links

- Web: https://openroastery.com
- Shop: https://shop.openroastery.com
- Issues: https://github.com/openroastery/openroastery/issues
