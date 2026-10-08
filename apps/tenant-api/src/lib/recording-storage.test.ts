import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	deleteOrganizationRecordings,
	deleteRecordingsWithPrefix,
	organizationRecordingPrefix,
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
		expect(background).toHaveLength(1)
		await background[0]
		// One listing in total: the budgeted pass stopped before making any request.
		expect(requests().map((request) => request.method)).toEqual([
			'GET',
			'DELETE',
		])
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
		errors.mockRestore()
	})
})
