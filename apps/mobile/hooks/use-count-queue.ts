import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import { countEntriesResultSchema } from '@repo/inventory'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import {
	createCountQueue,
	createKeyValueEntryStore,
	type CountQueue,
	type QueueState,
	queueStorageKey,
} from '../lib/inventory/count-queue'
import { getDeviceId } from '../lib/inventory/device-id'
import { type RegionClient } from '../lib/inventory/region-client'

/** How often a count with unsent entries tries again on its own. */
export const COUNT_RETRY_MS = 15_000

/**
 * The offline-safe entry queue of one count as React state: entries are written
 * to the phone before they are sent, go out as they are typed, and go again
 * when the connection returns, the app comes back to the front, or on a timer.
 */
export function useCountQueue(input: {
	client: RegionClient | null
	organizationId: string | null
	countId: string
	enabled: boolean
}): { queue: CountQueue; state: QueueState } {
	const { client, organizationId, countId, enabled } = input
	const queue = useMemo(
		() =>
			createCountQueue({
				store: createKeyValueEntryStore(
					AsyncStorage,
					queueStorageKey(organizationId ?? 'none', countId),
				),
				send: async (batch, unsent) => {
					if (!client) throw new Error('no_client')
					const device = await getDeviceId()
					const body = {
						entries: batch.map((entry) => ({
							clientId: entry.clientId,
							itemId: entry.itemId,
							areaId: entry.areaId,
							amount: entry.amount,
							unit: entry.unit,
						})),
						device: { id: device, name: 'Phone', kind: 'phone', unsent },
					}
					return countEntriesResultSchema.parse(
						await client.request(
							`/counts/${encodeURIComponent(countId)}/entries`,
							{
								method: 'POST',
								write: true,
								body,
							},
						),
					)
				},
			}),
		[client, organizationId, countId],
	)
	const state = useSyncExternalStore(
		queue.subscribe,
		queue.getState,
		queue.getState,
	)
	const waiting = state.pending.length > 0

	useEffect(() => {
		void queue.load().then(() => (enabled ? queue.flush() : undefined))
	}, [queue, enabled])

	useEffect(() => {
		if (!enabled) return
		const flush = () => void queue.flush()
		const net = NetInfo.addEventListener((netState) => {
			if (netState.isConnected) flush()
		})
		const app = AppState.addEventListener('change', (next) => {
			if (next === 'active') flush()
		})
		return () => {
			net()
			app.remove()
		}
	}, [enabled, queue])

	useEffect(() => {
		if (!enabled || !waiting) return
		const timer = setInterval(() => void queue.flush(), COUNT_RETRY_MS)
		return () => clearInterval(timer)
	}, [enabled, waiting, queue])

	return { queue, state }
}
