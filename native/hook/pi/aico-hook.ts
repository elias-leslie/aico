/**
 * aico-hook for Pi: the guard, file leases and session start, as for Claude Code and Codex (contracts/hook-payloads.schema.json).
 *
 * Pi has no command hooks, so this sends the Claude-style payload to `aico-hook pi` (next to this file, else on PATH):
 *   session_start           -> SessionStart (PI_SESSION_ID for shells; its lines go into the next system prompt once)
 *   tool_call bash, mcp__*  -> PreToolUse  (a guard deny blocks the call with its reason)
 *   tool_call edit, write   -> PreToolUse  (auto-lease; a foreign-lease WARNING is added to the tool result;
 *                                           blocks only under a live acceptance or deploy)
 *   tool_result bash        -> PostToolUse (one line on a shell write that overlaps another agent)
 * The guard fails closed: when aico-hook does not start, exits non-zero, is killed (timeout) or prints something
 * unreadable, a bash or connector call is refused. An edit goes ahead and its result says it went unchecked.
 * The coordination inbox stays on SummitFlow's coord-inbox hook (turn pi) until the sessions rebuild (M10a).
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 10_000;
const CONNECTOR = /^mcp__.*(?:github|git).*/;
const INBOX = `${process.env.HOME}/.claude/hooks/coord-inbox.sh`;

type Answer = { deny?: string; context?: string; fault?: string };

function binary(): string {
	try {
		const here = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "aico-hook");
		if (existsSync(here)) return here;
	} catch {}
	return "aico-hook";
}

function run(argv: string[], payload: Record<string, unknown>, cmd = binary()): Promise<Answer> {
	return new Promise((resolve) => {
		const out: Buffer[] = [];
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			return resolve({ fault: "aico-hook did not start" });
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stdin?.on("error", () => {});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ fault: "aico-hook did not start" });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (signal) return resolve({ fault: `aico-hook was killed by ${signal}` });
			if (code !== 0) return resolve({ fault: `aico-hook exited ${code}` });
			const text = Buffer.concat(out).toString("utf8").trim();
			if (!text) return resolve({});
			try {
				const spec = JSON.parse(text).hookSpecificOutput;
				if (spec?.permissionDecision === "deny") return resolve({ deny: String(spec.permissionDecisionReason || "Blocked by aico-hook.") });
				return resolve({ context: spec?.additionalContext });
			} catch {
				return resolve({ fault: "aico-hook printed something unreadable" });
			}
		});
		child.stdin?.end(JSON.stringify(payload));
	});
}

const unchecked = (fault: string) => `${fault}: this call was not checked by the guard or the lease hook. Tell the owner.`;
const refused = (fault: string) => `aico-hook could not check this call (${fault}); execution refused. Tell the owner.`;

export default function (pi: ExtensionAPI) {
	let notice: string | undefined;
	let inboxTimer: NodeJS.Timeout | undefined;
	let inboxBusy = false;
	let generation = 0;
	const pending = new Map<string, string[]>();

	const base = (ctx: ExtensionContext) => ({ session_id: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd() });
	const later = (id: string, text: string | undefined) => {
		if (text) pending.set(id, [...(pending.get(id) ?? []), text]);
	};

	const checkInbox = async (ctx: ExtensionContext, gen: number) => {
		if (inboxBusy || !ctx.isIdle() || gen !== generation) return;
		inboxBusy = true;
		try {
			const { context } = await run([INBOX, "turn", "pi"], { ...base(ctx), hook_event_name: "PiIdle" }, "bash");
			if (context && gen === generation) pi.sendUserMessage(context, { deliverAs: "followUp" });
		} catch {
			// A coordination check never interrupts the current turn.
		} finally {
			inboxBusy = false;
		}
	};

	pi.on("session_start", async (event, ctx) => {
		if (inboxTimer) clearInterval(inboxTimer);
		generation += 1;
		process.env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const answer = await run(["pi"], { ...base(ctx), hook_event_name: "SessionStart", source: event.reason === "new" ? "clear" : event.reason });
		notice = answer.context ?? (answer.fault ? `${answer.fault}: session start (leases, startup brief) did not run.` : undefined);
		const gen = generation;
		inboxTimer = setInterval(() => void checkInbox(ctx, gen), 15_000);
		inboxTimer.unref();
		void checkInbox(ctx, gen);
	});
	pi.on("agent_end", async (_event, ctx) => checkInbox(ctx, generation));
	pi.on("agent_settled", async (_event, ctx) => checkInbox(ctx, generation));
	pi.on("session_shutdown", () => {
		if (inboxTimer) clearInterval(inboxTimer);
		inboxTimer = undefined;
	});
	pi.on("before_agent_start", async (event) => {
		if (!notice) return;
		const line = notice;
		notice = undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${line}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		let payload: Record<string, unknown>;
		const guarded = event.toolName === "bash" || CONNECTOR.test(event.toolName);
		if (guarded) {
			payload = { tool_name: event.toolName === "bash" ? "Bash" : event.toolName, tool_input: event.input };
		} else if (event.toolName === "edit" || event.toolName === "write") {
			payload = { tool_name: "Edit", tool_input: { file_path: input.path } };
		} else return undefined;
		const answer = await run(["pi"], { ...base(ctx), hook_event_name: "PreToolUse", tool_use_id: event.toolCallId, ...payload });
		if (answer.deny) return { block: true, reason: answer.deny };
		if (answer.fault && guarded) return { block: true, reason: refused(answer.fault) };
		later(event.toolCallId, answer.context ?? (answer.fault && unchecked(answer.fault)));
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "bash") {
			const answer = await run(["pi"], {
				...base(ctx),
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: event.toolCallId,
				tool_input: event.input,
				tool_response: event.content,
			});
			later(event.toolCallId, answer.context);
		}
		const inbox = await run([INBOX, "turn", "pi"], { ...base(ctx), hook_event_name: "PostToolUse" }, "bash");
		later(event.toolCallId, inbox.context);
		const lines = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (lines?.length) return { content: [...event.content, ...lines.map((text) => ({ type: "text" as const, text }))] };
	});
}
