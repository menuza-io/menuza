import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	deleteFromStorage,
	testS3Connection,
	uploadToStorage,
} from './client.ts'

const config = {
	endpoint: 'https://s3.example.com',
	bucket: 'bucket',
	accessKey: 'AKIADUMMY',
	secretKey: 'dummy-secret',
	region: 'us-east-1',
}

// The org-supplied endpoint is validated when it is saved; a redirect it
// answers with points somewhere that never was. A 307/308 must not be
// replayed (method, body and signed headers) against that target.
describe('org S3 requests never follow redirects', () => {
	afterEach(() => vi.unstubAllGlobals())

	function stubRedirect() {
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
			expect(init?.redirect).toBe('manual')
			return new Response(null, {
				status: 307,
				headers: { Location: 'http://169.254.169.254/latest' },
			})
		})
		vi.stubGlobal('fetch', fetchMock)
		return fetchMock
	}

	it('upload fails on a redirect', async () => {
		const fetchMock = stubRedirect()
		const file = new File(['x'], 'x.txt', { type: 'text/plain' })
		await expect(
			uploadToStorage(file, 'orgs/o/x.txt', config),
		).rejects.toThrow()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('delete fails on a redirect', async () => {
		stubRedirect()
		await expect(deleteFromStorage('orgs/o/x.txt', config)).rejects.toThrow()
	})

	it('connection test reports failure on a redirect', async () => {
		const fetchMock = stubRedirect()
		const result = await testS3Connection(config)
		expect(result.success).toBe(false)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})
