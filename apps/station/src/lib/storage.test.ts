import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPersistentStorage, useStoragePersistence } from './storage.ts'

beforeEach(() => useStoragePersistence.setState({ persisted: null }))

describe('requestPersistentStorage', () => {
	it('records a refusal, so the till can say its orders may be evicted', async () => {
		const persist = vi.fn().mockResolvedValue(false)
		expect(
			await requestPersistentStorage({
				persist,
				persisted: vi.fn().mockResolvedValue(false),
			}),
		).toBe(false)
		expect(persist).toHaveBeenCalledOnce()
		expect(useStoragePersistence.getState().persisted).toBe(false)
	})

	it('does not ask again when storage is already persistent', async () => {
		const persist = vi.fn()
		expect(
			await requestPersistentStorage({
				persist,
				persisted: vi.fn().mockResolvedValue(true),
			}),
		).toBe(true)
		expect(persist).not.toHaveBeenCalled()
	})

	it('knows nothing (and shows nothing) without the API, or when it fails', async () => {
		expect(await requestPersistentStorage(undefined)).toBeNull()
		expect(
			await requestPersistentStorage({
				persist: vi.fn().mockRejectedValue(new Error('no')),
				persisted: vi.fn().mockResolvedValue(false),
			}),
		).toBeNull()
		expect(useStoragePersistence.getState().persisted).toBeNull()
	})
})
