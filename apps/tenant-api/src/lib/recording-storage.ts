import { createHash, createHmac } from 'node:crypto'
import { ENV } from 'varlock/env'
import { forEachWithBudget } from './concurrency.ts'
import { syncEnvFromProcess } from './secrets.ts'

/** S3 deletes in flight at once during purges and deprovisioning. */
export const RECORDING_DELETE_CONCURRENCY = 8

const STORAGE_REQUEST_TIMEOUT_MS = 10_000
/**
 * Batch deletes run under a deadline and still wait for requests in flight,
 * so each request is bounded tighter than a one-off delete.
 */
export const BUDGETED_REQUEST_TIMEOUT_MS = 5000

/**
 * App gives deprovisioning 15s: this budget plus one request in flight
 * (BUDGETED_REQUEST_TIMEOUT_MS) leaves time to destroy the database.
 */
export const DEPROVISION_RECORDING_BUDGET_MS = 7000

/** The only key the voice worker writes for a call (see voice-agent recording.ts). */
export function expectedRecordingKey(orgId: string, callId: string) {
	return `voice-recordings/${orgId}/${callId}.ogg`
}

/** The trailing slash keeps one org id from matching another that extends it. */
export function organizationRecordingPrefix(orgId: string) {
	return `voice-recordings/${orgId}/`
}

/**
 * Invoice photos (inventory) live in the same region bucket under their own
 * prefix, `inventory-invoices/<orgId>/<deliveryId>/<random>.<ext>`. The trailing
 * slash keeps one org id from matching another that extends it.
 */
export function organizationInvoicePrefix(orgId: string) {
	return `inventory-invoices/${orgId}/`
}

type RecordingStorageConfig = {
	bucket: string
	region: string
	endpoint: string | null
	accessKey: string
	secretKey: string
}

export function getRecordingStorageConfig(): RecordingStorageConfig | null {
	syncEnvFromProcess()
	const bucket = ENV.RECORDING_S3_BUCKET
	const accessKey = ENV.RECORDING_S3_ACCESS_KEY
	const secretKey = ENV.RECORDING_S3_SECRET
	if (!bucket || !accessKey || !secretKey) return null
	return {
		bucket,
		// R2 accepts us-east-1 as an alias for "auto"; AWS needs a real region.
		region: ENV.RECORDING_S3_REGION || 'us-east-1',
		endpoint: ENV.RECORDING_S3_ENDPOINT
			? ENV.RECORDING_S3_ENDPOINT.replace(/\/$/, '')
			: null,
		accessKey,
		secretKey,
	}
}

function hmac(key: string | Buffer, message: string) {
	return createHmac('sha256', key).update(message).digest()
}

function encodeKey(key: string) {
	return key
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/')
}

function encodeQueryValue(value: string) {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	)
}

/**
 * Same SigV4 scheme as @repo/storage, kept local so tenant-api does not pull
 * in that package's App-only dependencies. The voice worker uploads
 * path-style when a custom endpoint is set, virtual-hosted on AWS.
 */
function signedRequest(
	method: 'DELETE' | 'GET' | 'HEAD',
	key: string,
	config: RecordingStorageConfig,
	query: Record<string, string> = {},
) {
	const encodedKey = encodeKey(key)
	// SigV4 signs the query sorted by key, encoded exactly as it is sent.
	const canonicalQuery = Object.keys(query)
		.sort()
		.map(
			(name) => `${encodeQueryValue(name)}=${encodeQueryValue(query[name]!)}`,
		)
		.join('&')
	const base = config.endpoint
		? `${config.endpoint}/${config.bucket}${encodedKey ? `/${encodedKey}` : ''}`
		: `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedKey}`
	const url = canonicalQuery ? `${base}?${canonicalQuery}` : base
	const target = new URL(url)
	const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)
	const headers = [
		`host:${target.host}`,
		'x-amz-content-sha256:UNSIGNED-PAYLOAD',
		`x-amz-date:${amzDate}`,
	]
	const signedHeaders = headers.map((header) => header.split(':')[0]).join(';')
	const canonicalRequest = [
		method,
		target.pathname,
		canonicalQuery,
		`${headers.join('\n')}\n`,
		signedHeaders,
		'UNSIGNED-PAYLOAD',
	].join('\n')
	const scope = `${dateStamp}/${config.region}/s3/aws4_request`
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		scope,
		createHash('sha256').update(canonicalRequest).digest('hex'),
	].join('\n')
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), 's3'),
		'aws4_request',
	)
	const signature = createHmac('sha256', signingKey)
		.update(stringToSign)
		.digest('hex')
	return {
		url,
		headers: {
			'X-Amz-Date': amzDate,
			'X-Amz-Content-SHA256': 'UNSIGNED-PAYLOAD',
			Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		},
	}
}

/** How long a playback link works; the player asks for a new one after. */
export const RECORDING_URL_TTL_SECONDS = 300

/**
 * A query-signed GET for one recording, so the operator's browser streams it
 * straight from the bucket and the audio never passes through App or Sites.
 * Anyone holding the URL can fetch the object until it expires.
 */
export function presignRecordingUrl(
	key: string,
	expiresInSeconds = RECORDING_URL_TTL_SECONDS,
	now = new Date(),
) {
	const config = getRecordingStorageConfig()
	if (!config) return null
	const encodedKey = encodeKey(key)
	const base = config.endpoint
		? `${config.endpoint}/${config.bucket}/${encodedKey}`
		: `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedKey}`
	const target = new URL(base)
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)
	const scope = `${dateStamp}/${config.region}/s3/aws4_request`
	const query: Record<string, string> = {
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': `${config.accessKey}/${scope}`,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': String(expiresInSeconds),
		'X-Amz-SignedHeaders': 'host',
		// Egress may store the object with a generic type; players need this.
		'response-content-type': 'audio/ogg',
		'response-cache-control': 'private, no-store',
	}
	const canonicalQuery = Object.keys(query)
		.sort()
		.map(
			(name) => `${encodeQueryValue(name)}=${encodeQueryValue(query[name]!)}`,
		)
		.join('&')
	const canonicalRequest = [
		'GET',
		target.pathname,
		canonicalQuery,
		`host:${target.host}\n`,
		'host',
		'UNSIGNED-PAYLOAD',
	].join('\n')
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		scope,
		createHash('sha256').update(canonicalRequest).digest('hex'),
	].join('\n')
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), 's3'),
		'aws4_request',
	)
	const signature = createHmac('sha256', signingKey)
		.update(stringToSign)
		.digest('hex')
	return {
		url: `${base}?${canonicalQuery}&X-Amz-Signature=${signature}`,
		expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
	}
}

function objectBase(key: string, config: RecordingStorageConfig): string {
	const encodedKey = encodeKey(key)
	return config.endpoint
		? `${config.endpoint}/${config.bucket}/${encodedKey}`
		: `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedKey}`
}

/**
 * A query-signed URL for one object (SigV4 presign). `signedHeaders` are
 * request headers the caller must send with exactly these values (lowercase
 * names), e.g. the content type and length of an upload. `null` when the node
 * has no object storage configured.
 */
function presignObjectUrl(
	method: 'GET' | 'PUT',
	key: string,
	options: {
		expiresInSeconds: number
		signedHeaders?: Record<string, string>
		query?: Record<string, string>
		now?: Date
	},
) {
	const config = getRecordingStorageConfig()
	if (!config) return null
	const now = options.now ?? new Date()
	const base = objectBase(key, config)
	const target = new URL(base)
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)
	const scope = `${dateStamp}/${config.region}/s3/aws4_request`
	const headerValues: Record<string, string> = {
		host: target.host,
		...options.signedHeaders,
	}
	const headerNames = Object.keys(headerValues).sort()
	const signedHeaders = headerNames.join(';')
	const query: Record<string, string> = {
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': `${config.accessKey}/${scope}`,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': String(options.expiresInSeconds),
		'X-Amz-SignedHeaders': signedHeaders,
		...options.query,
	}
	const canonicalQuery = Object.keys(query)
		.sort()
		.map(
			(name) => `${encodeQueryValue(name)}=${encodeQueryValue(query[name]!)}`,
		)
		.join('&')
	const canonicalHeaders = headerNames
		.map((name) => `${name}:${headerValues[name]}\n`)
		.join('')
	const canonicalRequest = [
		method,
		target.pathname,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		'UNSIGNED-PAYLOAD',
	].join('\n')
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		scope,
		createHash('sha256').update(canonicalRequest).digest('hex'),
	].join('\n')
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), 's3'),
		'aws4_request',
	)
	const signature = createHmac('sha256', signingKey)
		.update(stringToSign)
		.digest('hex')
	return {
		url: `${base}?${canonicalQuery}&X-Amz-Signature=${signature}`,
		expiresAt: now.getTime() + options.expiresInSeconds * 1000,
	}
}

/** How long an upload link works. */
export const OBJECT_UPLOAD_TTL_SECONDS = 600

/**
 * A one-time upload target: the browser `PUT`s the bytes straight to the
 * bucket with `headers` (the content type and length are signed, so the
 * object cannot be another type or size than announced). No byte passes
 * through App or Sites. `null` when storage is not configured on the node.
 */
export function presignObjectUpload(
	key: string,
	input: { contentType: string; sizeBytes: number },
	now = new Date(),
) {
	const signed = presignObjectUrl('PUT', key, {
		expiresInSeconds: OBJECT_UPLOAD_TTL_SECONDS,
		signedHeaders: {
			'content-length': String(input.sizeBytes),
			'content-type': input.contentType,
		},
		now,
	})
	if (!signed) return null
	return {
		method: 'PUT' as const,
		url: signed.url,
		headers: {
			'Content-Type': input.contentType,
			'Content-Length': String(input.sizeBytes),
		},
		expiresAt: signed.expiresAt,
		maxBytes: input.sizeBytes,
	}
}

/** A short-lived read link for one stored object (the browser fetches it directly). */
export function presignObjectRead(
	key: string,
	options: { contentType: string; expiresInSeconds?: number; now?: Date },
) {
	const expiresInSeconds = options.expiresInSeconds ?? RECORDING_URL_TTL_SECONDS
	const signed = presignObjectUrl('GET', key, {
		expiresInSeconds,
		query: {
			'response-content-type': options.contentType,
			'response-cache-control': 'private, no-store',
		},
		now: options.now,
	})
	return signed ? { url: signed.url, expiresAt: signed.expiresAt } : null
}

export type ObjectHead =
	| { status: 'found'; sizeBytes: number; contentType: string | null }
	| { status: 'missing' }
	| { status: 'not_configured' }
	| { status: 'failed' }

/** Size and type of a stored object, without downloading it. */
export async function headStorageObject(key: string): Promise<ObjectHead> {
	const config = getRecordingStorageConfig()
	if (!config) return { status: 'not_configured' }
	const request = signedRequest('HEAD', key, config)
	try {
		const response = await fetch(request.url, {
			method: 'HEAD',
			headers: request.headers,
			signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
		})
		if (response.status === 404) return { status: 'missing' }
		if (!response.ok) return { status: 'failed' }
		const length = Number(response.headers.get('content-length'))
		return {
			status: 'found',
			sizeBytes: Number.isFinite(length) ? length : -1,
			contentType: response.headers.get('content-type'),
		}
	} catch {
		return { status: 'failed' }
	}
}

export type RecordingDeleteResult = 'deleted' | 'not_configured' | 'failed'

/** Deletes a call recording object. A missing object counts as deleted. */
export async function deleteRecordingObject(
	key: string,
	timeoutMs = STORAGE_REQUEST_TIMEOUT_MS,
): Promise<RecordingDeleteResult> {
	const config = getRecordingStorageConfig()
	if (!config) return 'not_configured'
	const request = signedRequest('DELETE', key, config)
	try {
		const response = await fetch(request.url, {
			method: 'DELETE',
			headers: request.headers,
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (response.ok || response.status === 404) return 'deleted'
		console.error(`Recording delete failed with ${response.status}`)
		return 'failed'
	} catch (error) {
		console.error('Recording delete failed', error)
		return 'failed'
	}
}

function decodeXml(value: string) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
}

type RecordingPage = { keys: string[]; nextToken: string | null }

/** One ListObjectsV2 page under `prefix`; null when listing fails. */
async function listRecordingPage(
	prefix: string,
	continuationToken: string | null,
	config: RecordingStorageConfig,
): Promise<RecordingPage | null> {
	const request = signedRequest('GET', '', config, {
		'list-type': '2',
		prefix,
		'max-keys': '1000',
		...(continuationToken ? { 'continuation-token': continuationToken } : {}),
	})
	try {
		const response = await fetch(request.url, {
			method: 'GET',
			headers: request.headers,
			signal: AbortSignal.timeout(BUDGETED_REQUEST_TIMEOUT_MS),
		})
		if (!response.ok) {
			console.error(`Recording list failed with ${response.status}`)
			return null
		}
		const xml = await response.text()
		const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)]
			.map((match) => decodeXml(match[1]!))
			// Never trust the store to have honored the prefix.
			.filter((key) => key.startsWith(prefix))
		const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
		const token =
			/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1]
		return {
			keys,
			nextToken: truncated && token ? decodeXml(token) : null,
		}
	} catch (error) {
		console.error('Recording list failed', error)
		return null
	}
}

export type PrefixDeleteResult = {
	/** `incomplete` means the deadline passed before every object was tried. */
	status: 'deleted' | 'not_configured' | 'failed' | 'incomplete'
	deleted: number
	failed: number
}

// 1000 pages of 1000 keys; guards against a store that never ends a listing.
const MAX_LIST_PAGES = 1000

/** Lists and deletes every recording under `prefix`, page by page. */
export async function deleteRecordingsWithPrefix(
	prefix: string,
	options: { deadline?: number; concurrency?: number } = {},
): Promise<PrefixDeleteResult> {
	const config = getRecordingStorageConfig()
	if (!config) return { status: 'not_configured', deleted: 0, failed: 0 }
	const deadline = options.deadline ?? Number.POSITIVE_INFINITY
	let deleted = 0
	let failed = 0
	let token: string | null = null
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		if (Date.now() >= deadline) return { status: 'incomplete', deleted, failed }
		const listing = await listRecordingPage(prefix, token, config)
		if (!listing) return { status: 'failed', deleted, failed }
		const run = await forEachWithBudget(
			listing.keys,
			{
				concurrency: options.concurrency ?? RECORDING_DELETE_CONCURRENCY,
				deadline,
			},
			async (key) => {
				const result = await deleteRecordingObject(
					key,
					BUDGETED_REQUEST_TIMEOUT_MS,
				)
				if (result === 'deleted') deleted++
				else failed++
			},
		)
		if (run.skipped) return { status: 'incomplete', deleted, failed }
		if (!listing.nextToken) break
		token = listing.nextToken
	}
	return { status: failed ? 'failed' : 'deleted', deleted, failed }
}

/**
 * Deletes everything an organization keeps in the region bucket (call
 * recordings and inventory invoice photos) when its tenant database is being
 * destroyed. Deprovisioning never waits on storage for long (App gives the
 * whole command 15s): after `budgetMs` the rest continues through
 * `runInBackground`, and failures are only logged, because once the database
 * is gone nothing else would ever retry them. The answer is the worst status
 * over the prefixes.
 */
export async function deleteOrganizationRecordings(
	orgId: string,
	options: {
		budgetMs: number
		runInBackground: (task: Promise<void>) => void
	},
): Promise<PrefixDeleteResult['status']> {
	const deadline = Date.now() + options.budgetMs
	const severity: PrefixDeleteResult['status'][] = [
		'deleted',
		'not_configured',
		'incomplete',
		'failed',
	]
	let worst: PrefixDeleteResult['status'] = 'deleted'
	for (const prefix of [
		organizationRecordingPrefix(orgId),
		organizationInvoicePrefix(orgId),
	]) {
		const result = await deleteRecordingsWithPrefix(prefix, { deadline })
		if (result.status === 'failed') {
			console.error('Could not delete every recording of a deprovisioned org', {
				orgId,
				prefix,
				deleted: result.deleted,
				failed: result.failed,
			})
		}
		if (result.status === 'incomplete') {
			options.runInBackground(
				deleteRecordingsWithPrefix(prefix).then((rest) => {
					if (rest.status !== 'deleted') {
						console.error(
							'Could not delete every recording of a deprovisioned org',
							{ orgId, prefix, ...rest },
						)
					}
				}),
			)
		}
		if (severity.indexOf(result.status) > severity.indexOf(worst)) {
			worst = result.status
		}
	}
	return worst
}
