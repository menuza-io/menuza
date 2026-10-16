import type * as CommonModule from '@repo/common'
import type * as DatabaseModule from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { loader } from './images.tsx'

const SIGNED_URL =
	'https://storage.example.com/bucket/orgs/org-1/media/images/1792072957921-abc.webp'
const SIGNED_HEADERS = { Authorization: 'AWS4-HMAC-SHA256 signed' }

vi.mock('@repo/common', async (importOriginal) => {
	const actual = await importOriginal<typeof CommonModule>()
	return { ...actual, isCloudflareWorkerRuntime: () => true }
})

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		OrganizationMediaAsset: drizzleTable,
		UserOrganization: drizzleTable,
		and: drizzleOperator,
		eq: drizzleOperator,
	}
})

vi.mock('#app/utils/storage.server.ts', () => ({
	getSignedGetRequestInfoAsync: vi.fn(async () => ({
		url: SIGNED_URL,
		headers: SIGNED_HEADERS,
	})),
	getSignedHeadRequestInfoAsync: vi.fn(),
}))

describe('resources/images on the Workers runtime', () => {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			// Throws on an invalid URL, like the real fetch and the Workers dev S3
			// mock. The returned Response is constructed, so its `url` is empty.
			new Request(input, init)
			return new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { 'Content-Type': 'image/webp' },
			})
		},
	)

	beforeEach(() => {
		resetMockDb()
		fetchMock.mockClear()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('resizes a stored image by repeating the signed storage request', async () => {
		const objectKey = 'orgs/org-1/media/images/1792072957921-abc.webp'
		const request = new Request(
			`http://localhost/resources/images?objectKey=${encodeURIComponent(objectKey)}&w=640&h=384&fit=cover`,
		)

		const response = await loader({ request, params: {}, context: {} } as any)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('image/webp')
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [transformUrl, transformInit] = fetchMock.mock.calls[1]!
		expect(transformUrl).toBe(SIGNED_URL)
		expect(transformInit?.headers).toEqual(SIGNED_HEADERS)
		expect((transformInit as { cf?: { image: unknown } }).cf?.image).toEqual({
			width: 640,
			height: 384,
			fit: 'cover',
		})
	})
})
