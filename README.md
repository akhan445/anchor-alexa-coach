# ⚓ Anchor

**An adaptive routine coach for Alexa+: a self-hosted MCP server, with Amazon Bedrock and Amazon Polly behind it.**

Most productivity tools are lists you have to remember to open. Anchor runs your day by voice instead. You tell Alexa the fixed points of your week (lunch, end of work, the gym, or your prayer times), and those become **anchors**. You plan what you want done between them, Alexa checks in at each anchor to ask how it went, and your morning and evening routines are walked through step by step, timed, and adjusted over time.

It's built for people who struggle to *start* things (including people with ADHD), and for anyone whose day moves around. Prayer times shift every day of the year, so a Muslim user's anchors are recalculated automatically.

---

## What it does

Anchor sets you up in three steps the first time you talk to it, then runs your day.

1. **Anchors.** *"This app uses key habits or tasks called anchors to plan your day…"* Say "lunch at 12 on weekdays, gym Tuesday and Thursday at 7 PM and Saturday at 8 AM", or "use my prayer times". Alexa sets a reminder for each of today's anchors.
2. **Routines.** *"Morning and evening routines are the outliers within our days…"* Describe your morning and evening routines with a start time. Each routine becomes an anchor too.
3. **Planning.** "Before lunch I want to finish the API. At lunch remind me to drink water." Tasks are saved against the anchor that ends their block.

Then, through the day:

- **Check-ins at every anchor.** "Ahmed, it's 1:03 and time for Dhuhr. Before this you planned to work on your slides. How did that go?" Your reflection is saved, plans for the next block are saved in the same breath, and Bedrock turns the day's check-ins into a coaching tip for the next one.
- **Guided routines.** "4 steps today: make your bed, drink water, shower, plan your day." Say "done" to move on. At the end you hear how long each step really took.
- **Routines that adapt.** If a step keeps taking longer than planned, its planned time moves to your average after 3 runs. Say "the shower felt rushed, make it 20 minutes" and Bedrock rewrites the routine for next time.
- **Always knows what's next.** "Your next anchor is Asr at 3:53 PM, about 2 hours and 50 minutes from now."

## How it works

```
 You speak ─▶ ┌──────────── Simulated Alexa+  (public/index.html + src/agent.js) ────────────┐
              │ Chrome speech-to-text ─▶ Amazon Bedrock, Nova Pro (Converse API, tool use)  │
 You hear  ◀─ │ Amazon Polly (text-to-speech) ◀─ reply      │ picks a tool                  │
              │ Alexa reminders ◀─ structuredContent        │                               │
              └─────────────────────────────────────────────┼───────────────────────────────┘
                                                            │ MCP 2025-11-25, Streamable HTTP
                                                            ▼  POST /mcp
              ┌──────────── Anchor MCP server  (src/server.js, src/tools.js) ───────────────┐
              │ 10 tools ─▶ routines.js ─▶ per-user JSON store (data/users/<user>.json)      │
              │                 └──▶ Amazon Bedrock, Nova Lite, in the background (adjust.js)│
              └──────────────────────────────────────────────────────────────────────────────┘
```

- **Anchor is a self-hosted MCP server** implementing MCP spec **2025-11-25** over **Streamable HTTP** (`@modelcontextprotocol/sdk` 1.32), stateless. Any MCP client can use it, including Alexa+.
- **The simulated Alexa+ is a separate MCP client.** It reaches Anchor only through `POST /mcp`, exactly as Alexa+ would, with Amazon Bedrock as its reasoning model. We built it because Alexa+ add-on developer access wasn't available to us during the hackathon (the track rules allow a simulated experience).
- **Every tool answers in under ~30 ms.** Alexa+ requires tool answers within 500 ms and a model call is slower than that, so tools answer from local data and the Bedrock work (rewriting routines, coaching tips) runs in the background after the reply. If a background call fails, the user already has their answer and the feedback is retried later.
- **Tool results carry structured data.** Each answer includes today's anchors as MCP `structuredContent`, and the simulated Alexa keeps its reminders in sync from it. The model never has to copy times correctly for a reminder to fire.
- **The server guides the conversation.** Setup progress lives in Anchor, not in the model's memory: `get_started` tells Alexa which step the user is on and what to say next, so a returning user is never walked through setup twice.
- **Prayer times** are calculated on the server with the [adhan](https://github.com/batoulapps/adhan-js) library from latitude, longitude and date: no API call, works offline. Toronto by default; say your city and Alexa passes its coordinates. The calculation method (ISNA / North America) and Asr madhab (Shafi) are settings in `src/store.js`, because mosques differ.

### MCP tools

| Tool | What it does |
|---|---|
| `get_started` | Where the user is in setup (anchors → routines → planning) and what Alexa should say next; for a returning user, today's overview |
| `set_anchors` | Save the week's anchors: custom times with weekdays, or prayer times (optionally for another city) |
| `set_routine` | Save the morning or evening routine with its start time and steps |
| `get_day` | Today's anchors with planned tasks and time to the next one, or another weekday |
| `plan_tasks` | Save tasks before an anchor ("finish the API before lunch") or reminders at it ("hydrate at Dhuhr") |
| `anchor_arrived` | Called when a reminder fires: what to remind the user of and which planned tasks to ask about |
| `check_in` | Save a reflection at an anchor, plus any plans for the next block; Bedrock prepares a tip for the next check-in |
| `start_routine` | List today's steps and start the first |
| `next_step` | Time the current step and move on (with optional feedback); read the stats at the end |
| `reflect_and_adjust` | Save routine feedback; Bedrock rewrites the routine in the background |

## AWS services used

| Service | Where | What it does |
|---|---|---|
| **Amazon Bedrock**, Nova Pro | `src/agent.js` | The simulated Alexa+ brain: a Converse API tool-use loop over Anchor's MCP tools. Falls back to Nova Lite if the account has no Nova Pro access. |
| **Amazon Bedrock**, Nova Lite | `src/adjust.js` → `adjustRoutine` | Rewrites a routine from the user's feedback and recent step timings. Returns JSON, validated with zod before it's saved. |
| **Amazon Bedrock**, Nova Lite | `src/adjust.js` → `makeCoachTip` | Turns today's check-ins into one spoken coaching tip, said at the next check-in. |
| **Amazon Polly** (generative, falls back to neural) | `src/voice.js` → `POST /api/speak` | Alexa's voice in the simulator. The page falls back to the browser's voice if Polly is unavailable. |

Models and voice are configurable: `AGENT_MODEL_ID`, `BEDROCK_MODEL_ID`, `POLLY_VOICE` (default `Danielle`), `AWS_REGION` (default `us-east-1`).

---

## Run it

**You need:** Node.js 20+ (tested on 24), Google Chrome (for voice input), and an AWS account.

### 1. AWS access (one time)

1. In the AWS console, region **us-east-1**, open **Amazon Bedrock → Model access** and make sure **Amazon Nova Pro** and **Nova Lite** are available.
2. In **IAM**, create a user for local code and attach **AmazonBedrockFullAccess** and **AmazonPollyReadOnlyAccess**. Create an access key for it.
3. Run `aws configure` with that key and region `us-east-1`. Keys stay in `~/.aws/credentials`, never in this repo.

### 2. Install and check

```bash
npm install
npm run check-bedrock    # ✅ Bedrock works
npm run check-voice      # ✅ Polly works (writes data/voice-test.mp3)
```

### 3. Start

```bash
npm start
```

Open **http://localhost:3000** in Chrome. (`http://localhost:3000/mcp` is the MCP endpoint for Alexa+ and other clients, not a web page.)

### Using the simulator

- Pick **Bob** (custom anchors) or **Ahmed** (prayer times) in the left bar. Each has their own saved data and clock.
- **Tap the light ring** and talk. It keeps listening through pauses and sends after 3 seconds of quiet, or when you tap it again. You can also type.
- Say **"Hi Alexa"** to start setup.
- The clock runs live from midnight and reminders fire on their own. **Skip to …** fast-forwards to the next anchor.
- **New day** keeps the user's setup and starts a fresh day. **Start over** erases the user.
- **Voice on/off** and **speed** are at the top of the chat.
- The right panel shows every MCP call: green for Anchor's tools (with latency), orange for Alexa's built-in reminders.

### No AWS account?

`BEDROCK_MOCK=1 npm start` swaps Bedrock for a simple keyword matcher (and turns off Polly) so you can click through the flow. It only understands simple phrases.

## Tests

| Command | What it checks |
|---|---|
| `npm run smoke` | Connects as an MCP client and runs a new user through setup, a routine and a check-in, printing each tool's answer and latency (server must be running) |
| `npm run live-test` | Plays full conversations for test copies of Bob and Ahmed through the **real** model and flags missing tool calls, leaked reasoning, claimed changes no tool made, and tools slower than 500 ms. Saves a transcript to `data/live-test.md` (server must be running, real Bedrock) |
| `npm run check-bedrock` / `check-voice` | AWS credentials and access |

## Use it from any MCP client

The endpoint is `http://localhost:3000/mcp` (Streamable HTTP). Optional headers:
- `x-anchor-user`: which user's data to use (default `bob`). With real Alexa+, this would come from account linking.
- `x-anchor-now`: an ISO timestamp to treat as "now" (the simulator's clock uses this).

### Connecting to real Alexa+

With Alexa+ add-on access, expose the server over HTTPS (for example `cloudflared tunnel --url http://localhost:3000`) and register it with the Alexa AI CLI:

```bash
alexa-ai new mcp --name "Anchor" --locale en-US --mcp-server-url "https://<your-host>/mcp"
alexa-ai deploy
```

Reminders would then come from Alexa's own reminders, and a fired reminder starts a new turn that calls `anchor_arrived`.

## Project structure

```
src/server.js      Express app: POST /mcp (Anchor) plus the simulator's /api routes
src/tools.js       The 10 MCP tools: names, descriptions, input schemas, structured output
src/routines.js    What each tool does: setup steps, planning, check-ins, routines
src/anchors.js     Anchors, prayer times, "what's next"
src/adjust.js      Background Bedrock jobs (routine rewrites, coaching tips)
src/store.js       Per-user JSON store
src/agent.js       Simulated Alexa+: Bedrock tool-use loop acting as an MCP client, plus reminders
src/voice.js       Amazon Polly text-to-speech
public/index.html  Simulated Alexa+ screen: voice, clock, reminders, MCP call log
scripts/           smoke-test, live-test, check-bedrock, check-voice
```

## License

MIT, see [LICENSE](LICENSE).
