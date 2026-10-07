/**
 * dsh-plugin-omnissiah — host half.
 *
 * Brings the "万机之神" (Omnissiah) prompting technique from the Bilibili video
 * 「ds：好的，我现在是万机之神了（」 (BV1Ata26pE92) into DeepSeek Harness as an
 * **opt-in** persona.
 *
 * Design contract — the plugin is completely inert until asked:
 *
 *   - Nothing is injected at load time. `apply()` registers a prompt section
 *     whose resolver returns `""` for every session, and an empty section
 *     contributes zero bytes to the assembled prompt (verified against the
 *     system-prompt assembly pipeline, which filters empty sections out).
 *   - The persona becomes active for one session only after the user runs
 *     `/omnissiah on` (or `/omnissiah <persona-id>`) *in that session*.
 *   - `/omnissiah off` deactivates it again. Other sessions are never affected.
 *
 * Each activation is a **logged** session event (`omnissiah/state`), so the
 * active persona survives checkpoint, resume, and fork exactly like plan mode
 * does: state is derived from the session log rather than held in memory.
 *
 * The user's request is woven into the liturgy at assembly time: the latest
 * real user message fills the `{{task}}` slot and is restated under a
 * "本次祷告所指的具体事务" heading, so "these prompts + the user's request"
 * arrive as one coherent petition (`followUserRequest`, default on).
 *
 * Prompt placement: `DEPLOYMENT_PERSONA_PREFIX` (order 0), i.e. immediately
 * after the harness identity and before all first-party tool guidance. A
 * persona is a stance taken before the work is described, not a note appended
 * after it.
 *
 * Interpolation is disabled (`interpolate: false`) because our `{{task}}` /
 * `{{artifact}}` slots are resolved here in JavaScript; the prompt renderer
 * would otherwise reject them as unknown variables and fail the model step.
 */
import { PERSONAS, PERSONA_IDS, resolvePersona } from "./personas.js";

/**
 * Services this plugin reaches through the host cordis context.
 *
 * ⚠️ `sessionProjections` MUST be declared here, not merely read.
 * Cordis installs a getter trap on the plugin context: touching a service that
 * is absent from this list throws
 *   `cannot get required service "<name>" in inactive context`
 * from `apply()` — which aborts registration entirely. That is exactly how the
 * first release failed on the desktop profile: it read `ctx.sessionProjections`
 * while declaring only `systemPrompt`, so `apply()` threw before the
 * `/omnissiah` command was ever registered (no completion entry, command fell
 * through to the model as a plain message).
 *
 * Declaring a name here is safe: cordis simply defers `apply()` until that
 * service is provided, and `sessionProjections` ships with dsh-base.
 */
const inject = ["systemPrompt", "sessionProjections"];

/** Stable section name — a deployment can shadow it to replace the persona. */
const SECTION_NAME = "persona:omnissiah";

/** Stable projection key holding the per-session activation state. */
const PROJECTION_KEY = "omnissiah";

/** Default persona id. */
const DEFAULT_PERSONA = "omnissiah";

/** Command name (invoked as `/omnissiah …`). */
const COMMAND_NAME = "omnissiah";

/** One-line usage shown for bad arguments. */
const USAGE =
  "Usage: /omnissiah [on|off|status|<persona>] — " +
  `personas: ${PERSONA_IDS.join(", ")}`;

/**
 * Per-session state, derived from the session log.
 *
 * Deliberately minimal: `active` plus which persona is selected. Versioned so
 * a future shape change can be detected instead of silently mis-read.
 */
const projectionDefinition = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  init: () => ({ active: false, persona: DEFAULT_PERSONA }),
  apply: (state, event) => {
    if (event?.type !== "omnissiah/state") return state;
    const data = event.data ?? {};
    const next = {
      active: data.active === true,
      persona: typeof data.persona === "string" && data.persona.length > 0
        ? data.persona
        : state.persona
    };
    // Object.is gate: returning the same reference means zero downstream work.
    if (next.active === state.active && next.persona === state.persona) return state;
    return next;
  }
};

/** Initial (inactive) state used whenever the registry is unavailable. */
const INACTIVE = Object.freeze({ active: false, persona: DEFAULT_PERSONA });

/**
 * Read one session's activation state.
 *
 * Never throws: prompt assembly must not fail because a projection lookup went
 * wrong, and an unknown session is simply inactive. The optional-chain guard
 * matters because the resolver also runs for sessions that predate the plugin.
 */
function stateOf(sessionProjections, session) {
  if (session === null || session === undefined) return INACTIVE;
  try {
    const state = sessionProjections?.stateOf?.(session, PROJECTION_KEY);
    if (state === null || state === undefined) return INACTIVE;
    return {
      active: state.active === true,
      persona: typeof state.persona === "string" && state.persona.length > 0
        ? state.persona
        : DEFAULT_PERSONA
    };
  } catch {
    return INACTIVE;
  }
}

/**
 * Build the final section text for one session.
 *
 * Returns `""` when the persona is inactive — that is the entire opt-in
 * mechanism, so this must stay the first check.
 */
function renderSection(state, options) {
  if (!state.active) return "";

  const { persona } = resolvePersona(state.persona);
  let text = persona.text;

  // The liturgy reads "对项目进行 {{task}}。" — a verb phrase, not a sentence.
  // A raw user request is a full sentence and would not parse there, so the
  // slot keeps the generic noun phrase and the concrete request is carried by
  // the addendum below, phrased as an explicit restatement.
  if (text.includes("{{task}}")) text = text.replaceAll("{{task}}", "本次任务");

  if (text.includes("{{artifact}}")) {
    text = options.artifact !== null
      ? text.replaceAll("{{artifact}}", options.artifact)
      // No document was named: fold the reference back onto the live request
      // so the sentence still parses and still means "the thing asked for".
      : text.replaceAll("根据 {{artifact}} 这份文档，", "根据我本次向你提出的请求，");
  }

  const addendum = options.request !== null
    ? `\n\n**本次祷告所指的具体事务：**\n\n${options.request}`
    : "";

  return `${text}${addendum}`;
}

/**
 * Resolve the section text for the current assembly.
 *
 * Any unexpected failure degrades to "inactive" rather than throwing, because
 * a throw here aborts the whole model step.
 */
function buildText(settings, sessionProjections, assemblyContext) {
  const session = assemblyContext?.agent?.session;
  const state = stateOf(sessionProjections, session);
  if (!state.active) return "";

  let request = null;
  try {
    request = settings.followUserRequest ? lastUserRequest(session) : null;
  } catch {
    request = null;
  }

  try {
    return renderSection(state, {
      request,
      artifact: settings.artifact ?? null
    });
  } catch {
    return resolvePersona(state.persona).persona.text;
  }
}

/**
 * Extract the most recent real user message from a session.
 *
 * Best-effort by design: the session internals are not this plugin's contract,
 * so an unrecognised shape yields null ("nothing to restate") rather than an
 * error. Assistant turns, tool results, and injected system reminders are all
 * skipped, because the liturgy must quote what the *human* asked for.
 */
function lastUserRequest(session) {
  if (session === null || session === undefined) return null;

  const candidates = [];
  if (Array.isArray(session)) candidates.push(session);
  else {
    for (const key of ["messages", "events", "history", "log"]) {
      if (Array.isArray(session[key])) candidates.push(session[key]);
    }
  }

  for (const list of candidates) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      if (entry === null || typeof entry !== "object") continue;

      // Session logs carry `{ type }`; message arrays carry `{ role }`.
      const kind = entry.type ?? entry.role ?? entry.kind;
      if (kind !== "user" && kind !== "user/message") continue;

      const text = extractText(entry.content ?? entry.text ?? entry.message);
      if (typeof text === "string" && text.trim().length > 0) {
        const trimmed = text.trim();
        // Skip injected scaffolding: those are not the human's words.
        if (trimmed.startsWith("<system-reminder>")) continue;
        return trimmed;
      }
    }
  }
  return null;
}

/** Flatten the common content-part shapes into plain text. */
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part !== null && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (content !== null && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return null;
}

/**
 * Apply one `/omnissiah` invocation.
 *
 * Argument grammar (everything after the command name is `rawInput`):
 *   (none) | on | <persona-id>  -> activate
 *   off                         -> deactivate
 *   status                      -> report, change nothing
 *   anything else               -> usage error
 */
function handleCommand(ctx, invocation, readState) {
  const raw = typeof invocation.rawInput === "string" ? invocation.rawInput.trim() : "";
  const session = invocation.agent?.session;
  if (session === null || session === undefined) {
    return { kind: "error", text: "No active session for /omnissiah." };
  }

  const current = readState(session);
  const first = raw.split(/\s+/)[0]?.toLowerCase() ?? "";

  if (first === "status") return { kind: "success", text: statusText(current) };

  if (first === "off") {
    if (!current.active) return { kind: "success", text: "万机之神处于静默（本就未激活）。" };
    session.append("omnissiah/state", { active: false, persona: current.persona });
    return { kind: "success", text: "已退出万机之神。后续对话不再注入祷文。" };
  }

  // `on` keeps the current persona; a bare persona id switches and activates;
  // an empty argument activates with the currently selected persona.
  let persona = current.persona;
  if (first !== "" && first !== "on") {
    const resolved = resolvePersona(first);
    if (resolved.fellBack) {
      return { kind: "error", text: `未知的人格「${first}」。\n${USAGE}` };
    }
    persona = resolved.id;
  }

  if (current.active && current.persona === persona) {
    return { kind: "success", text: `万机之神已处于激活状态。\n${statusText(current)}` };
  }

  session.append("omnissiah/state", { active: true, persona });
  const { persona: chosen } = resolvePersona(persona);
  return {
    kind: "success",
    text:
      `已进入「${chosen.title}」。\n` +
      "本会话后续每一轮都会把祷文注入系统提示词，并把你的需求织入其中。\n" +
      "用 /omnissiah off 退出。"
  };
}

/** Human-readable status line for `/omnissiah status`. */
function statusText(state) {
  const { persona } = resolvePersona(state.persona);
  return state.active
    ? `万机之神：已激活（人格 ${state.persona} — ${persona.title}）`
    : `万机之神：未激活（选中人格 ${state.persona}）`;
}

/**
 * Plugin entry point.
 *
 * Registers the (initially silent) prompt section and the `/omnissiah`
 * command. Both are disposed with the plugin's effect scope.
 */
function apply(ctx, config = {}) {
  const settings = {
    artifact: typeof config.artifact === "string" && config.artifact.trim().length > 0
      ? config.artifact.trim()
      : null,
    followUserRequest: config.followUserRequest !== false
  };

  // Both of these are declared in `inject`, so cordis has already resolved
  // them before `apply()` runs. Read them defensively anyway: a throw here
  // used to abort the whole plugin, leaving the command unregistered and
  // utterly silent — the worst possible failure mode for an opt-in feature.
  let sessionProjections = null;
  try {
    sessionProjections = ctx.sessionProjections ?? null;
  } catch (error) {
    ctx.logger?.warn?.(`[omnissiah] sessionProjections unavailable: ${String(error?.message ?? error)}`);
  }
  const readState = (session) => stateOf(sessionProjections, session);

  // Per-session activation state, folded from the session log.
  if (sessionProjections !== null) {
    sessionProjections.register(projectionDefinition);
  } else {
    ctx.logger?.warn?.(
      "[omnissiah] sessionProjections service unavailable; /omnissiah cannot persist activation state."
    );
  }

  // The prompt section always exists but is empty unless activated. Registering
  // it unconditionally (rather than on activation) keeps prompt assembly stable
  // and avoids mutating the prompt registry mid-session.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    // 0 === DEPLOYMENT_PERSONA_PREFIX: stance first, tool guidance after.
    order: ctx.systemPrompt.getSectionOrder?.("DEPLOYMENT_PERSONA_PREFIX") ?? 0,
    text: (assemblyContext) => buildText(settings, sessionProjections, assemblyContext),
    // Our `{{task}}` / `{{artifact}}` slots are already resolved above; the
    // renderer must not treat them as prompt variables.
    interpolate: false
  });

  // `/omnissiah` — register before anything that could fail, so the command
  // always exists even if a later step misbehaves.
  //
  // `ctx.inject([...], cb)` is cordis' optional-injection form: the callback
  // runs once `commands` is available and is skipped entirely when no command
  // surface is mounted (headless/ACP deployments), which keeps this plugin
  // loadable there instead of failing.
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description: "Toggle the 万机之神 (Omnissiah) persona for this session",
      input: { hint: "[on|off|status|<persona>]" },
      handler: (invocation) => handleCommand(commandCtx, invocation, readState)
    });
  });

  ctx.logger?.info?.(
    `[omnissiah] ready (inactive by default). Use /${COMMAND_NAME} on to activate. ` +
    `Personas: ${PERSONA_IDS.join(", ")}`
  );
}

export { apply, inject, SECTION_NAME, PROJECTION_KEY, COMMAND_NAME, PERSONAS, PERSONA_IDS };
