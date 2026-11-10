import { describe, expect, it, vi } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	type EntryResult,
	type QueuedEntry,
} from '#app/utils/inventory/count-queue.ts'
import { sendCountEntries } from './use-count-entry-sync.ts'

function entry(clientId: string): QueuedEntry {
	return {
		clientId,
		itemId: `item-${clientId}`,
		areaId: null,
		amount: 1,
		unit: 'kg',
		queuedAt: 1,
	}
}

const acceptAll = (batch: QueuedEntry[]): EntryResult => ({
	accepted: batch.map((item) => ({ clientId: item.clientId })),
	duplicates: [],
	refused: [],
})

describe('sendCountEntries', () => {
	it('sends a batch in one request', async () => {
		const post = vi.fn(async (batch: QueuedEntry[]) => acceptAll(batch))
		const result = await sendCountEntries(post, [entry('a'), entry('b')])
		expect(post).toHaveBeenCalledTimes(1)
		expect(result.accepted).toHaveLength(2)
	})

	it('one unusable entry does not hold back the rest: the batch is split until it stands alone', async () => {
		const post = vi.fn(async (batch: QueuedEntry[]) => {
			if (batch.some((item) => item.clientId === 'bad')) {
				throw new OperatorRequestError('bad', 'invalid_request', 400)
			}
			return acceptAll(batch)
		})
		const result = await sendCountEntries(post, [
			entry('a'),
			entry('b'),
			entry('bad'),
			entry('c'),
		])
		expect(result.accepted.map((item) => item.clientId).sort()).toEqual([
			'a',
			'b',
			'c',
		])
		expect(result.refused).toEqual([
			{ clientId: 'bad', code: 'invalid_request' },
		])
	})

	it('a single refused entry is reported refused for good', async () => {
		const result = await sendCountEntries(async () => {
			throw new OperatorRequestError('bad', 'invalid_request', 400)
		}, [entry('only')])
		expect(result.refused).toEqual([
			{ clientId: 'only', code: 'invalid_request' },
		])
	})

	it('anything else (no signal, a 5xx, a 401) rejects so the queue keeps everything', async () => {
		await expect(
			sendCountEntries(async () => {
				throw new TypeError('Failed to fetch')
			}, [entry('a')]),
		).rejects.toThrow('Failed to fetch')
		await expect(
			sendCountEntries(async () => {
				throw new OperatorRequestError('down', 'inventory_unavailable', 503)
			}, [entry('a')]),
		).rejects.toThrow('down')
	})
})
