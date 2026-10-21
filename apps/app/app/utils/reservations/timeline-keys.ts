/**
 * What a key does on a Timeline booking bar. A bar is one tab stop, so the
 * keyboard must reach both of its jobs:
 *
 * - Enter opens the booking (the click action), for everyone;
 * - Space or `M` picks the booking up to move it (managers); while it is
 *   picked up, Enter or Space drops it, Escape cancels, arrows move it.
 *
 * A key pressed on a control inside the bar (lock, +-15 min) belongs to that
 * control: the bar ignores it, so Space on "lock" never starts a move.
 */
export type BarKeyAction =
	'open' | 'grab' | 'drop' | 'cancel' | 'ignore' | 'move'

export function barKeyAction(input: {
	key: string
	grabbed: boolean
	canManage: boolean
	/** The event came from the bar itself, not from a control inside it. */
	onBar: boolean
}): BarKeyAction {
	if (!input.onBar) return 'ignore'
	const { key } = input
	if (input.grabbed) {
		if (key === 'Enter' || key === ' ') return 'drop'
		if (key === 'Escape') return 'cancel'
		if (key.startsWith('Arrow')) return 'move'
		return 'ignore'
	}
	if (key === 'Enter') return 'open'
	if (key === ' ') return input.canManage ? 'grab' : 'open'
	if ((key === 'm' || key === 'M') && input.canManage) return 'grab'
	return 'ignore'
}
