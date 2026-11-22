export type JourneyStepLabel = {
	nodeId: string
	/** `action_email`, `action_sms`, `action_push`, ... */
	type: string
	/** The subject, text or title a step sends, cut short; empty when it sends nothing. */
	summary: string
}

const SUMMARY_LENGTH = 48

function cut(value: unknown): string {
	if (typeof value !== 'string') return ''
	const text = value.replace(/\s+/g, ' ').trim()
	return text.length > SUMMARY_LENGTH
		? `${text.slice(0, SUMMARY_LENGTH - 1)}…`
		: text
}

/**
 * Names for the steps of an automation, read from its saved graph (#115): the
 * Runs page shows orders and revenue per step, and a step id alone says
 * nothing. A graph that cannot be read gives no labels.
 */
export function journeyStepLabels(graphJson: unknown): JourneyStepLabel[] {
	try {
		const graph =
			typeof graphJson === 'string' ? JSON.parse(graphJson) : graphJson
		const nodes = (graph as { nodes?: unknown })?.nodes
		if (!Array.isArray(nodes)) return []
		const labels: JourneyStepLabel[] = []
		for (const node of nodes) {
			const record = node as {
				id?: unknown
				type?: unknown
				data?: Record<string, unknown>
			}
			if (typeof record.id !== 'string' || typeof record.type !== 'string') {
				continue
			}
			const data = record.data ?? {}
			labels.push({
				nodeId: record.id,
				type: record.type,
				summary: cut(data.subject ?? data.messageText ?? data.title),
			})
		}
		return labels
	} catch {
		return []
	}
}
