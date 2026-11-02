import type * as CommonModule from '@repo/common'
import type * as DatabaseModule from '@repo/database'
import type * as SecurityModule from '@repo/security'
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

// The real guard resolves DNS and rejects localhost; these tests only need it
// to reach `fetch` without following redirects.
vi.mock('@repo/security', async (importOriginal) => {
	const actual = await importOriginal<typeof SecurityModule>()
	return {
		...actual,
		ssrfSafeFetch: vi.fn((url: string | URL, init?: RequestInit) =>
			fetch(url, { ...init, redirect: 'error' }),
		),
	}
})

const mediaAccess = vi.hoisted(() => ({
	authorizeRegisteredObject: vi.fn(async () => null),
	requireOrganizationMember: vi.fn(async () => 'user-1'),
}))
vi.mock('#app/utils/media-access.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...mediaAccess,
}))

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
		mediaAccess.requireOrganizationMember.mockClear()
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
		expect(transformInit?.redirect).toBe('manual')
		expect((transformInit as { cf?: { image: unknown } }).cf?.image).toEqual({
			width: 640,
			height: 384,
			fit: 'cover',
		})
	})

	it('derives the organization from a private key and requires membership of it', async () => {
		const objectKey = 'orgs/org-1/media/images/1792072957921-abc.webp'
		await loader({
			request: new Request(
				`http://localhost/resources/images?objectKey=${encodeURIComponent(objectKey)}&organizationId=attacker-org`,
			),
			params: {},
			context: {},
		} as any)
		// The membership check names the key's organization, not the query's.
		expect(mediaAccess.requireOrganizationMember).toHaveBeenCalledWith(
			expect.anything(),
			'org-1',
		)
	})

	it('answers 401 for a private key when nobody is signed in', async () => {
		mediaAccess.requireOrganizationMember.mockRejectedValueOnce(
			new Response('Unauthorized', { status: 401 }),
		)
		const objectKey = 'orgs/org-1/media/images/1792072957921-abc.webp'
		await expect(
			loader({
				request: new Request(
					`http://localhost/resources/images?objectKey=${encodeURIComponent(objectKey)}`,
				),
				params: {},
				context: {},
			} as any),
		).rejects.toMatchObject({ status: 401 })
	})

	it('refuses to serve a stored object that is not a raster image', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response('<script>alert(1)</script>', {
				headers: { 'Content-Type': 'text/html' },
			}),
		)
		const objectKey = 'orgs/org-1/media/images/1792072957921-abc.webp'
		await expect(
			loader({
				request: new Request(
					`http://localhost/resources/images?objectKey=${encodeURIComponent(objectKey)}`,
				),
				params: {},
				context: {},
			} as any),
		).rejects.toMatchObject({ status: 415 })
	})

	it('resizes a local asset without forwarding storage headers', async () => {
		const request = new Request(
			'http://localhost/resources/images?src=%2Fimg%2Fhero.webp&w=320',
		)

		const response = await loader({ request, params: {}, context: {} } as any)

		expect(response.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [transformUrl, transformInit] = fetchMock.mock.calls[1]!
		expect(transformUrl).toBe('http://localhost/img/hero.webp')
		expect(transformInit?.headers).toBeUndefined()
	})

	it('falls back to the source URL when the response URL is empty', async () => {
		const src = 'http://localhost/img/hero.webp'
		const request = new Request(
			`http://localhost/resources/images?src=${encodeURIComponent(src)}&w=320`,
		)

		const response = await loader({ request, params: {}, context: {} } as any)

		expect(response.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [transformUrl, transformInit] = fetchMock.mock.calls[1]!
		expect(transformUrl).toBe(src)
		expect(transformInit?.headers).toBeUndefined()
	})

	it.each([
		'//evil.example/a.png',
		'\\\\evil.example\\a.png',
		'/..//evil.example/a.png',
	])(
		'rejects a relative src that resolves to another host (%s)',
		async (src) => {
			const request = new Request(
				`http://localhost/resources/images?src=${encodeURIComponent(src)}&w=320`,
			)

			const result = await loader({
				request,
				params: {},
				context: {},
			} as any).catch((error: unknown) => error)

			expect(result).toBeInstanceOf(Response)
			expect((result as Response).status).toBe(400)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it('serves the original when the transform fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { 'Content-Type': 'image/png' },
				}),
		)
		fetchMock.mockImplementationOnce(
			async () => new Response('bad', { status: 502 }),
		)
		const request = new Request(
			'http://localhost/resources/images?src=%2Fimg%2Fhero.png&w=320',
		)

		const response = await loader({ request, params: {}, context: {} } as any)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('image/png')
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3]),
		)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('502'))
		warn.mockRestore()
	})
})
