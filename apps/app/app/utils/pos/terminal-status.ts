import { STATION_OFFLINE_AFTER_MS } from '@repo/common/operator-alerts'

/**
 * What the Terminals page says about a tablet (#190): "Online" while it checked
 * in within the last five minutes, "Offline since <time>" after that, and
 * "Never connected" for one that has not yet. The five minutes are the same the
 * offline alert waits.
 */
export type TerminalStatus =
	| { state: 'never' }
	| { state: 'online'; lastSeenAt: number }
	| { state: 'offline'; since: number }

export function terminalStatus(
	lastSeenAt: number | null,
	now: number,
): TerminalStatus {
	if (lastSeenAt === null) return { state: 'never' }
	return now - lastSeenAt < STATION_OFFLINE_AFTER_MS
		? { state: 'online', lastSeenAt }
		: { state: 'offline', since: lastSeenAt }
}
