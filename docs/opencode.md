# Floorplan in OpenCode

Floorplan works in [OpenCode](https://opencode.ai) the same way it works in Claude Code and Codex: the same skill, scripts and map. The AI can be any provider and model you have set up in OpenCode; Floorplan itself needs no API keys.

## What you need

- [OpenCode](https://opencode.ai) 2.x.
- [Node.js](https://nodejs.org) 18 or newer.
- A model with tool calling, set as your OpenCode model. A stronger model makes a better map, because deciding what the parts of an app are is reading work.

## Install

Clone this repository somewhere stable, then add its `skills` folder to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": ["/absolute/path/to/floorplan-opencode/skills"]
}
```

Use the path where your clone lives. On Windows, forward slashes work (`C:/Users/you/floorplan-opencode/skills`), or escape the backslashes. OpenCode reloads configuration automatically; `/reload` forces it.

Every project now sees the **floorplan** skill. You can also invoke it explicitly as `@floorplan`.

To add the `/floorplan` shortcut for every project, create `~/.config/opencode/commands/floorplan.md`:

```md
---
description: Draw or update a floorplan of this codebase
---

Use the `floorplan` skill. $ARGUMENTS

If no request is given, draw a floorplan of this codebase.
```

If you open this repository itself in OpenCode, it already has `opencode.json` and `.opencode/commands/floorplan.md`, so there is nothing to configure.

## Make your first map

Open the project you want to map and ask in plain words:

> Draw a floorplan of this codebase

Or run `/floorplan`, or type `@floorplan`. Approve the script commands OpenCode asks to run (`scan.mjs`, `build.mjs`, `describe.mjs`, and so on). Everything else is the same as in [Getting started](getting-started.md#make-your-first-map): OpenCode reads your READMEs, setup files and entry points, names the parts, describes every file and endpoint, builds the map and opens it.

The map is written to `floorplan/` and stays out of git. OpenCode has no personal, uncommitted notes file — `AGENTS.md` is shared with the team — so Floorplan does not add a note to your project.

When you have done more work, ask:

> Update the floorplan

Only what changed is re-read.

## Asking questions on the map

The map's Ask bar runs your own OpenCode, on your computer:

```
opencode run --format json --archived --agent plan -
```

It runs in the project folder with OpenCode's **Plan** agent, which cannot edit your project's files, and receives the map's lookup instructions. Answers can read your source code and cite it; they cannot change it. Each run is archived, so it stays out of your OpenCode session list. A follow-up carries the last few questions and answers along.

The server uses the agent that built the map, and falls back to another installed CLI if needed. To choose:

```bash
node floorplan/serve.mjs --engine opencode
```

The Ask bar also names the model it uses, and clicking that name opens a model picker. It lists the models OpenCode has for this project, grouped by provider (**OpenCode Go**, **OpenCode**, and any other provider you have connected), with a search box. Models without tool calling are disabled, because answers need to read the map and source. Free models carry a **FREE** tag: OpenCode requires permission for free endpoints in Console → Settings → Privacy, and the map offers that link when a free model fails.

Choosing a model there changes the map only. The choice is saved in `floorplan/.cache/model.json` and used for later questions and after a restart. It is not written to your OpenCode configuration, so other projects and sessions keep their own model.

To choose a model before the map opens, or to override the saved choice:

```bash
node floorplan/serve.mjs --engine opencode --model provider/model
```

`opencode models` lists the model IDs your OpenCode has. You can also set `FLOORPLAN_MODEL`; it wins over the saved choice. `open.mjs` passes `--engine`, `--model`, `--opencode`, and the rest through when the skill opens the map.

OpenCode's `/models` picker in the terminal applies to that session only; `opencode run`, which asks the map's questions, starts a new session. Setting `"model"` in `opencode.json` changes OpenCode's default for every new session, including the map when you have not chosen a model there.

The map asks OpenCode's own server API for the list (and for OpenCode's default), not on every question: it asks once for the default when no model is chosen, fetches the list only when the picker opens, and caches both. A chosen model, with its name and provider saved, needs no call at all.

**Read-only:** OpenCode's Plan agent refuses file edits, and the map's instructions tell it to read only. Unlike Codex, OpenCode's shell is not a hard sandbox, so if you want a hard boundary, use Codex for questions instead.

## What's different from Claude Code and Codex

- **No notes file.** OpenCode uses `AGENTS.md`, which is shared with the team, so Floorplan leaves your project's notes alone.
- **No Claude app.** Publishing the map to the Claude app is a Claude feature. In OpenCode the map opens in your browser, served from your computer.
- **No blueprint Change yet.** OpenCode's CLI does not hold answers to a JSON schema, so the map does not offer **Change** on a blueprint. Ask OpenCode in the chat to change the plan, then run `refresh.mjs` (or ask OpenCode to update the floorplan).
- **"Fix with OpenCode".** The Health panel's ready-made fix prompts and a blueprint's **Build this with OpenCode** prompts are for pasting into OpenCode, in your project folder.
- **Model choice is yours.** Floorplan records `opencode` as the map's agent, and the map's Ask bar uses OpenCode's provider and model. Claude Code and Codex maps still work the same way.

## Update or remove it

Update the clone with `git pull`, then run `/reload` or start a new OpenCode session so it picks up the latest skill. Maps made before a skill update get the model picker on their next update: ask for **Update the floorplan**, or run `refresh.mjs`, then restart the map's server.

To remove it, delete the `skills` entry from `~/.config/opencode/opencode.json` (and the optional command file), then delete the `floorplan/` folder from any project you mapped. Your project's tracked files are never touched.

## Troubleshooting

- **The skill isn't listed.** Check that the `skills` path in `opencode.json` is absolute and points at the folder that holds `floorplan/SKILL.md`. Start OpenCode at the project root and run `/reload`.
- **Ask says OpenCode isn't found.** Install the `opencode` CLI and make sure it is on `PATH`, or pass `--opencode /path/to/opencode`. `node floorplan/serve.mjs --engine opencode --opencode /path/to/opencode` works too.
- **The model has no credits or isn't signed in.** Run `opencode auth login`, or use the model picker in the Ask bar (or pass `--model`) with a model your account can use.
- **“Free models may train on request data.”** OpenCode chose a free model, or you picked one. Use the **FREE** tag to spot it, then choose a paid model from the Ask bar's picker. To keep using free models, allow free endpoints at the link in the message (OpenCode Console → Settings → Privacy).
- **A script command asks for approval.** Approve it, or add a permission rule for Floorplan's scripts in your OpenCode config. Floorplan only runs its own scripts and Node.

For what runs where and what leaves your machine, see [Privacy and security](privacy-and-security.md).
