import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	deleteOrganizationRecordings,
	deleteRecordingsWithPrefix,
	headStorageObject,
	organizationInvoicePrefix,
	organizationRecordingPrefix,
	presignObjectRead,
	presignObjectUpload,
	presignRecordingUrl,
} from './recording-storage.ts'

const orgId = 'clw9x0a12000008l00storage1'
const prefix = organizationRecordingPrefix(orgId)
const recordingEnv = {
	RECORDING_S3_BUCKET: 'recordings',
	RECORDING_S3_ENDPOINT: 'https://s3.example.test',
	RECORDING_S3_ACCESS_KEY: 'access',
	RECORDING_S3_SECRET: 'secret',
}

function listing(keys: string[], nextToken?: string) {
	const contents = keys
		.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`)
		.join('')
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>recordings</Name>${contents}<IsTruncated>${nextToken ? 'true' : 'false'}</IsTruncated>${nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ''}</ListBucketResult>`,
		{ status: 200, headers: { 'Content-Type': 'application/xml' } },
	)
}

describe('recording prefix deletion', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		Object.assign(process.env, recordingEnv)
		fetchSpy = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		for (const key of Object.keys(recordingEnv)) process.env[key] = ''
		fetchSpy.mockRestore()
	})

	function requests() {
		return fetchSpy.mock.calls.map(([url, init]) => ({
			method: (init as RequestInit).method,
			url: String(url),
		}))
	}

	it('pages through the listing and deletes every key under the prefix', async () => {
		fetchSpy.mockImplementation(async (url, init) => {
			if ((init as RequestInit).method === 'DELETE') {
				return new Response(null, { status: 204 })
			}
			return new URL(String(url)).searchParams.get('continuation-token')
				? listing([`${prefix}c.ogg`])
				: listing(
						[
							`${prefix}a.ogg`,
							`${prefix}b.ogg`,
							// A store that ignores the prefix must not cost another org data.
							'voice-recordings/other-org/a.ogg',
						],
						'next/page+1',
					)
		})

		const result = await deleteRecordingsWithPrefix(prefix)
		expect(result).toEqual({ status: 'deleted', deleted: 3, failed: 0 })

		const lists = requests().filter((request) => request.method === 'GET')
		expect(lists.map((request) => request.url)).toEqual([
			`https://s3.example.test/recordings?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`,
			`https://s3.example.test/recordings?continuation-token=next%2Fpage%2B1&list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`,
		])
		const deletes = requests()
			.filter((request) => request.method === 'DELETE')
			.map((request) => request.url)
			.sort()
		expect(deletes).toEqual([
			`https://s3.example.test/recordings/${prefix}a.ogg`,
			`https://s3.example.test/recordings/${prefix}b.ogg`,
			`https://s3.example.test/recordings/${prefix}c.ogg`,
		])
		const [, init] = fetchSpy.mock.calls[0]!
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: expect.stringMatching(
				/^AWS4-HMAC-SHA256 Credential=access\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
			),
		})
	})

	it('reports failed deletes and listing failures', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		fetchSpy.mockImplementation(async (url, init) => {
			if ((init as RequestInit).method === 'DELETE') {
				return new Response(null, {
					status: String(url).endsWith('a.ogg') ? 500 : 204,
				})
			}
			return listing([`${prefix}a.ogg`, `${prefix}b.ogg`])
		})
		expect(await deleteRecordingsWithPrefix(prefix)).toEqual({
			status: 'failed',
			deleted: 1,
			failed: 1,
		})

		fetchSpy.mockResolvedValue(new Response('denied', { status: 403 }))
		expect(await deleteRecordingsWithPrefix(prefix)).toEqual({
			status: 'failed',
			deleted: 0,
			failed: 0,
		})
		errors.mockRestore()
	})

	it('does nothing without storage credentials', async () => {
		for (const key of Object.keys(recordingEnv)) process.env[key] = ''
		expect(await deleteRecordingsWithPrefix(prefix)).toEqual({
			status: 'not_configured',
			deleted: 0,
			failed: 0,
		})
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('finishes deprovision cleanup in the background once the budget runs out', async () => {
		fetchSpy.mockImplementation(async (_url, init) =>
			(init as RequestInit).method === 'DELETE'
				? new Response(null, { status: 204 })
				: listing([`${prefix}a.ogg`]),
		)
		const background: Array<Promise<void>> = []
		const status = await deleteOrganizationRecordings(orgId, {
			budgetMs: 0,
			runInBackground: (task) => background.push(task),
		})
		expect(status).toBe('incomplete')
		// One background task per prefix (call recordings, inventory invoices).
		expect(background).toHaveLength(2)
		await Promise.all(background)
		// The budgeted pass stopped before making any request; each background
		// pass lists once, and only the voice prefix has an object to delete.
		expect(
			requests()
				.map((request) => request.method)
				.sort(),
		).toEqual(['DELETE', 'GET', 'GET'])
	})

	it('deletes inventory invoice photos with the recordings when an organization is deprovisioned', async () => {
		const invoicePrefix = organizationInvoicePrefix(orgId)
		expect(invoicePrefix).toBe(`inventory-invoices/${orgId}/`)
		fetchSpy.mockImplementation(async (url, init) => {
			if ((init as RequestInit).method === 'DELETE') {
				return new Response(null, { status: 204 })
			}
			const listed = new URL(String(url)).searchParams.get('prefix')
			return listing(
				listed === invoicePrefix
					? [`${invoicePrefix}del_1/a.jpg`, `${invoicePrefix}del_2/b.png`]
					: [`${prefix}a.ogg`],
			)
		})
		const runInBackground = vi.fn()
		const status = await deleteOrganizationRecordings(orgId, {
			budgetMs: 5000,
			runInBackground,
		})
		expect(status).toBe('deleted')
		expect(runInBackground).not.toHaveBeenCalled()
		expect(
			requests()
				.filter((request) => request.method === 'DELETE')
				.map((request) => request.url)
				.sort(),
		).toEqual(
			[
				`https://s3.example.test/recordings/${prefix}a.ogg`,
				`https://s3.example.test/recordings/${invoicePrefix}del_1/a.jpg`,
				`https://s3.example.test/recordings/${invoicePrefix}del_2/b.png`,
			].sort(),
		)
	})

	it('logs, without retrying, when deprovision cleanup fails', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		fetchSpy.mockResolvedValue(new Response(null, { status: 500 }))
		const runInBackground = vi.fn()
		const status = await deleteOrganizationRecordings(orgId, {
			budgetMs: 5000,
			runInBackground,
		})
		expect(status).toBe('failed')
		expect(runInBackground).not.toHaveBeenCalled()
		expect(errors).toHaveBeenCalledWith(
			'Could not delete every recording of a deprovisioned org',
			expect.objectContaining({ orgId, prefix }),
		)
		expect(errors).toHaveBeenCalledWith(
			'Could not delete every recording of a deprovisioned org',
			expect.objectContaining({
				orgId,
				prefix: organizationInvoicePrefix(orgId),
			}),
		)
		errors.mockRestore()
	})
})

describe('presignRecordingUrl', () => {
	const r2Env = {
		RECORDING_S3_BUCKET: 'recordings',
		RECORDING_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
		RECORDING_S3_ACCESS_KEY: 'AKID',
		RECORDING_S3_SECRET: 'sekret',
		RECORDING_S3_REGION: '',
	}
	const now = new Date('2026-10-14T12:00:00.000Z')

	afterEach(() => {
		for (const key of Object.keys(r2Env)) process.env[key] = ''
	})

	it('returns null without storage credentials', () => {
		expect(presignRecordingUrl('voice-recordings/org/call.ogg')).toBeNull()
	})

	// The expected signature was cross-checked against @smithy/signature-v4
	// (the AWS SDK signer) presigning the same request with UNSIGNED-PAYLOAD.
	it('signs a path-style GET the way the AWS SDK does', () => {
		Object.assign(process.env, r2Env)
		const signed = presignRecordingUrl(
			'voice-recordings/org_1/call 1.ogg',
			300,
			now,
		)!
		const url = new URL(signed.url)
		expect(`${url.origin}${url.pathname}`).toBe(
			'https://acct.r2.cloudflarestorage.com/recordings/voice-recordings/org_1/call%201.ogg',
		)
		expect(Object.fromEntries(url.searchParams)).toEqual({
			'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
			'X-Amz-Credential': 'AKID/20261014/us-east-1/s3/aws4_request',
			'X-Amz-Date': '20261014T120000Z',
			'X-Amz-Expires': '300',
			'X-Amz-SignedHeaders': 'host',
			'response-cache-control': 'private, no-store',
			'response-content-type': 'audio/ogg',
			'X-Amz-Signature':
				'5cbb76c1de4803488afe42bca53a460fed5d56e5f37da7211e511b7ed1fdfffc',
		})
		expect(signed.expiresAt.toISOString()).toBe('2026-10-14T12:05:00.000Z')
	})
})

describe('object uploads and reads (inventory invoice photos)', () => {
	const r2Env = {
		RECORDING_S3_BUCKET: 'recordings',
		RECORDING_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
		RECORDING_S3_ACCESS_KEY: 'AKID',
		RECORDING_S3_SECRET: 'sekret',
		RECORDING_S3_REGION: '',
	}
	const now = new Date('2026-10-14T12:00:00.000Z')

	afterEach(() => {
		for (const key of Object.keys(r2Env)) process.env[key] = ''
	})

	it('has no upload target without storage credentials', () => {
		expect(
			presignObjectUpload('inventory-invoices/o/d/a.jpg', {
				contentType: 'image/jpeg',
				sizeBytes: 10,
			}),
		).toBeNull()
		expect(
			presignObjectRead('inventory-invoices/o/d/a.jpg', {
				contentType: 'image/jpeg',
			}),
		).toBeNull()
	})

	// The signature was cross-checked against @smithy/signature-v4 presigning
	// the same PUT (content-length, content-type and host signed, UNSIGNED-PAYLOAD).
	it('signs a PUT with the content type and length the way the AWS SDK does', () => {
		Object.assign(process.env, r2Env)
		const upload = presignObjectUpload(
			'inventory-invoices/org_1/del_1/abc.jpg',
			{ contentType: 'image/jpeg', sizeBytes: 12345 },
			now,
		)!
		const url = new URL(upload.url)
		expect(`${url.origin}${url.pathname}`).toBe(
			'https://acct.r2.cloudflarestorage.com/recordings/inventory-invoices/org_1/del_1/abc.jpg',
		)
		expect(Object.fromEntries(url.searchParams)).toEqual({
			'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
			'X-Amz-Credential': 'AKID/20261014/us-east-1/s3/aws4_request',
			'X-Amz-Date': '20261014T120000Z',
			'X-Amz-Expires': '600',
			'X-Amz-SignedHeaders': 'content-length;content-type;host',
			'X-Amz-Signature':
				'0d10f14f897d623d5be6501da5a3b9c8175bceaf36a32373148468b48cbcd0f6',
		})
		expect(upload.headers).toEqual({
			'Content-Type': 'image/jpeg',
			'Content-Length': '12345',
		})
		expect(upload.expiresAt).toBe(now.getTime() + 600_000)
		expect(upload.maxBytes).toBe(12345)
	})

	it('signs a short-lived read link that pins the content type', () => {
		Object.assign(process.env, r2Env)
		const link = presignObjectRead('inventory-invoices/org_1/del_1/abc.png', {
			contentType: 'image/png',
			now,
		})!
		const url = new URL(link.url)
		expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
		expect(url.searchParams.get('response-content-type')).toBe('image/png')
		expect(link.expiresAt).toBe(now.getTime() + 300_000)
	})

	it('reads size and type with a HEAD and tells missing from failed', async () => {
		Object.assign(process.env, r2Env)
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		fetchSpy.mockResolvedValueOnce(
			new Response(null, {
				status: 200,
				headers: { 'content-length': '2048', 'content-type': 'image/webp' },
			}),
		)
		expect(await headStorageObject('inventory-invoices/o/d/a.webp')).toEqual({
			status: 'found',
			sizeBytes: 2048,
			contentType: 'image/webp',
		})
		expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe('HEAD')
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }))
		expect(await headStorageObject('inventory-invoices/o/d/a.webp')).toEqual({
			status: 'missing',
		})
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }))
		expect(await headStorageObject('inventory-invoices/o/d/a.webp')).toEqual({
			status: 'failed',
		})
		fetchSpy.mockRestore()
		for (const key of Object.keys(r2Env)) process.env[key] = ''
		expect(await headStorageObject('inventory-invoices/o/d/a.webp')).toEqual({
			status: 'not_configured',
		})
	})
})
