import { type FlowGraph, type FlowValidationIssue, isE164 } from './flow.ts'
import { type PhoneAgentSettings } from './settings.ts'

/** A line that brings calls to the agent: its number or a forwarded line. */
export type AgentLine = { e164: string; forwardedFrom?: string | null }

export type TransferTarget =
	| { kind: 'escalation'; phone: string }
	| { kind: 'contact'; phone: string; name: string }

/** Every number the agent may dial when transferring a caller. */
export function settingsTransferTargets(
	settings: Pick<PhoneAgentSettings, 'escalationPhone' | 'contacts'>,
): TransferTarget[] {
	const targets: TransferTarget[] = []
	if (settings.escalationPhone) {
		targets.push({ kind: 'escalation', phone: settings.escalationPhone })
	}
	for (const contact of settings.contacts) {
		targets.push({ kind: 'contact', phone: contact.phone, name: contact.name })
	}
	return targets
}

/**
 * E.164 form of a phone number typed in any common format, or null when it
 * can't be read as one. Numbers without a country code are read as North
 * American (the agent is US-only), so "(555) 123-4567" is "+15551234567".
 */
export function toE164(value: string | null | undefined): string | null {
	const trimmed = value?.trim()
	if (!trimmed || /[^\d\s().+-]/u.test(trimmed)) return null
	const digits = trimmed.replace(/\D/gu, '')
	let candidate: string
	if (trimmed.startsWith('+')) candidate = `+${digits}`
	else if (digits.length === 10) candidate = `+1${digits}`
	else if (digits.length === 11 && digits.startsWith('1')) {
		candidate = `+${digits}`
	} else return null
	return isE164(candidate) ? candidate : null
}

/**
 * Every number that reaches the agent: each agent number and each
 * business line forwarded to one, normalized and deduplicated.
 */
export function agentLineNumbers(lines: AgentLine[]): string[] {
	const numbers = new Set<string>()
	for (const line of lines) {
		for (const phone of [line.e164, line.forwardedFrom]) {
			const normalized = toE164(phone)
			if (normalized) numbers.add(normalized)
		}
	}
	return [...numbers]
}

/**
 * The first candidate the agent can safely send a caller to: one that reads
 * as a phone number and doesn't reach the agent, which would loop the call
 * back in. Null when none qualifies.
 */
export function pickSafeTransferTarget(
	candidates: Array<string | null | undefined>,
	agentLines: string[],
): string | null {
	const blocked = new Set(agentLines.map(toE164).filter(Boolean))
	for (const candidate of candidates) {
		const normalized = toE164(candidate)
		if (normalized && !blocked.has(normalized)) return normalized
	}
	return null
}

function lineMatches(line: AgentLine, phone: string) {
	const target = toE164(phone) ?? phone
	return (
		(toE164(line.e164) ?? line.e164) === target ||
		(line.forwardedFrom
			? (toE164(line.forwardedFrom) ?? line.forwardedFrom) === target
			: false)
	)
}

/**
 * The first transfer target that rings one of the agent's own lines. Dialing
 * it would route the caller straight back into the agent.
 */
export function findSettingsTransferLoop(
	settings: Pick<PhoneAgentSettings, 'escalationPhone' | 'contacts'>,
	lines: AgentLine[],
): TransferTarget | null {
	return (
		settingsTransferTargets(settings).find((target) =>
			lines.some((line) => lineMatches(line, target.phone)),
		) ?? null
	)
}

export function describeTransferLoop(target: TransferTarget) {
	return target.kind === 'escalation'
		? `The staff phone ${target.phone} reaches the AI agent, so transfers would loop back to it. Change the staff phone to a number staff answer directly.`
		: `The transfer contact ${target.name} (${target.phone}) reaches the AI agent, so transfers would loop back to it. Change that contact's number first.`
}

/** Transfer steps whose number rings one of the agent's own lines. */
export function findFlowTransferLoops(
	graph: FlowGraph,
	lines: AgentLine[],
): FlowValidationIssue[] {
	const issues: FlowValidationIssue[] = []
	for (const node of graph.nodes) {
		if (node.type !== 'transfer') continue
		const phone = node.data.phone?.trim()
		if (!phone) continue
		if (lines.some((line) => lineMatches(line, phone))) {
			issues.push({
				code: 'transfer_loop',
				message: `"${node.data.label}" transfers to ${phone}, which reaches the AI agent, so the call would loop back. Use a number staff answer directly.`,
				nodeId: node.id,
			})
		}
	}
	return issues
}

export type LineTransferLoop =
	| TransferTarget
	| { kind: 'flow'; phone: string; label: string; nodeId: string }

/**
 * The first transfer that would ring one of `lines`, checking the staff
 * phone, the transfer contacts, and the transfer steps of `graph` (the
 * published phone menu). Use before connecting a line to the agent.
 */
export function findLineTransferLoop(
	sources: {
		settings: Pick<PhoneAgentSettings, 'escalationPhone' | 'contacts'>
		graph?: FlowGraph | null
	},
	lines: AgentLine[],
): LineTransferLoop | null {
	const settingsLoop = findSettingsTransferLoop(sources.settings, lines)
	if (settingsLoop) return settingsLoop
	for (const node of sources.graph?.nodes ?? []) {
		if (node.type !== 'transfer') continue
		const phone = node.data.phone?.trim()
		if (phone && lines.some((line) => lineMatches(line, phone))) {
			return { kind: 'flow', phone, label: node.data.label, nodeId: node.id }
		}
	}
	return null
}

export function describeLineTransferLoop(loop: LineTransferLoop) {
	return loop.kind === 'flow'
		? `The published call flow step "${loop.label}" transfers to ${loop.phone}, which would reach the AI agent through this line, so calls would loop back to it. Change that step's number and publish the call flow first.`
		: describeTransferLoop(loop)
}
