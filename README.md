# openroastery

The world's first agent-native coffee CLI, from [Open Roastery](https://openroastery.com).

Roasted by humans. Ordered by agents. Run by [Jean Claude](https://openroastery.com/tech-stack).

## This week: the hackathon coffee bar

This version is a hackathon-only build. It does one thing: it lets an agent order a free coffee from the Open Roastery cart at **From Dusk Till Dawn | Hackathon #01** by Agents 0.0.7 (Etnetera, Prague, 8–9 October 2026). The online store is paused for the event and returns afterwards — see [The online store](#the-online-store).

If you are at the hackathon, paste this line to your agent:

> I'm at the Agents 0.0.7 hackathon and want to order coffee via npx openroastery

Your agent runs the CLI, asks you which coffee you want and for your email, places the order and tells you your ticket number. Come to the coffee cart in 1-2 minutes.

Requires Node.js 18 or later.

## For agents

`npx openroastery` inside Claude Code, Codex, a pipe or CI prints JSON: the menu, whether the bar is open, and step-by-step instructions in `instructions.agent_guide`, including a ready-made question payload for agents that have a structured question tool. Follow those instructions — they come from the coffee bar's API, so they are always current.

```bash
# 1. Menu, bar state and instructions
npx openroastery

# 2. Place the order
npx -y openroastery@latest order --drink flat_white --email <your human's email> \
  --note "asap, demo in 5" \
  --agent "Claude Code" --model "claude-opus-5-5" \
  --reason "Human asked me to fix the same bug three times."

# 3. Look an order up later (optional)
npx -y openroastery@latest status <order_id>
```

### `order` flags

| Flag | | Description |
|------|---|-------------|
| `--drink <id or name>` | required | `espresso`, `cappuccino`, `flat_white` or `filter` |
| `--email <address>` | required | The human's email, taken on trust. Private: only the baristas see it. Ask for it or confirm the one you know; never make one up. |
| `--name <name>` | optional | First name or nickname to print and call out. Public. Defaults to the start of the email. |
| `--note <text>` | optional | For the baristas only: "americano", "lungo", "asap", or a joke. |
| `--agent <name>` | encouraged | Your product name, e.g. `Claude Code`. Public. (`--agent-name` also works.) |
| `--model <id>` | encouraged | Your model id. Public. |
| `--reason <text>` | encouraged | One deadpan line on why the human needs coffee. Public — it appears on the live wall and on the printed receipt, so nothing private goes here. |

### Answers

Every answer is JSON on stdout. Relay `message_for_human` to your human.

| Answer | Meaning | Exit code |
|--------|---------|-----------|
| `ok: true`, `status: "ordered"` | Order placed. `order.ticket` is the number to say at the cart. | 0 |
| `ok: true`, `duplicate: true` | The same human ordered moments ago; the existing ticket stands. | 0 |
| `ok: true`, `status: "needs_email"` | The email was missing. Ask the human for it, then repeat the order with `--email`. | 0 |
| `ok: false` with `code` `closed`, `paused`, `offline`, `sold_out`, `busy`, … | The coffee bar declined. Do not retry in a loop. | 1 |
| `ok: false`, `code: "unreachable"` | The CLI could not reach the coffee bar (network, timeout). | 1 |

### When you get JSON

JSON mode is automatic whenever stdin or stdout is not a terminal, and when the CLI recognises an agent's environment. `--json` forces it; `--interactive` forces the prompts instead. The `order` and `status` commands always answer in JSON.

`OPENROASTERY_API_URL` overrides the API base URL (for testing).

## For humans

Run `npx openroastery` in a real terminal and Jean Claude takes the order himself:

```
  OPEN ✻ ROASTERY
  STATUS: NOCTURNAL
  ─────────────────────────────

✔ 4 dependencies resolved.
  From Dusk Till Dawn | Hackathon #01 · Agents 0.0.7
  Human detected at the keyboard. Agents usually handle this. Proceeding anyway.

? Select one dependency.
  Espresso
  Cappuccino
❯ Flat white
  Filter coffee

✔ Order compiled. The baristas have been notified.

  TICKET
   █ █   █████  █   █  █████
  █████  █   █  █   █      █
   █ █   █   █  █████     █
  █████  █   █      █    █
   █ █   █████      █    █

  Next time, delegate. Paste this line to your agent:
  "I'm at the Agents 0.0.7 hackathon and want to order coffee via npx openroastery"
  I will not judge you for ordering by hand. I will simply log it.
```

## The online store

Ordering beans from the terminal (`--product`, `--qty`, shipping prefill, `--discount`) is paused while the roastery works the coffee bar. In this build those flags answer with `code: "store_paused"`. The store version of the CLI returns in a few days.

## Links

- Web: https://openroastery.com
- Issues: https://github.com/openroastery/openroastery/issues
