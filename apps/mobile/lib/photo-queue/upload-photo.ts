import { UPLOAD_TIMEOUT_MS } from './backoff'
import { type UploadInput, type UploadOutcome } from './types'

export const MENU_PHOTOS_PATH = '/api/menu/photos'

interface UploadPhotoOptions extends UploadInput {
	baseUrl: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

/**
 * Turns an HTTP answer into what the queue should do. Only what can never
 * succeed on a retry is permanent: a retry of a 403 (no menu permission), 404
 * (dish gone), 413, 415 or 400 sends the same bytes to the same refusal.
 */
export function classifyResponse(status: number, body: unknown): UploadOutcome {
	const record =
		body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
	const code = typeof record.error === 'string' ? record.error : 'http_error'
	const message = typeof record.message === 'string' ? record.message : ''

	if (status >= 200 && status < 300) {
		const data = record.data as Record<string, unknown> | undefined
		if (
			record.success === true &&
			data &&
			typeof data.itemId === 'string' &&
			typeof data.assetId === 'string' &&
			typeof data.imageUrl === 'string'
		) {
			return {
				kind: 'ok',
				itemId: data.itemId,
				assetId: data.assetId,
				imageUrl: data.imageUrl,
			}
		}
		// A 2xx we cannot read: the photo may or may not be stored. The same
		// clientId makes the next try safe either way.
		return { kind: 'transient', status, code: 'bad_response', message }
	}
	if (status === 401) return { kind: 'unauthorized' }
	if (status === 408 || status === 429 || status >= 500) {
		return { kind: 'transient', status, code, message }
	}
	return { kind: 'refused', status, code, message }
}

/**
 * Sends one prepared photo. Plain `fetch` with `FormData`: not the JSON
 * `HttpClient` (it forces a JSON content type, times out at 10 s and retries
 * on its own, none of which suits a multi-megabyte upload that the queue
 * retries itself). The auth header is passed in by the queue so a 401 can be
 * answered with one refresh and one more try.
 */
export async function uploadPhoto({
	item,
	accessToken,
	baseUrl,
	fetchImpl = fetch,
	timeoutMs = UPLOAD_TIMEOUT_MS,
}: UploadPhotoOptions): Promise<UploadOutcome> {
	const form = new FormData()
	form.append('organizationId', item.organizationId)
	form.append('itemId', item.itemId)
	form.append('clientId', item.id)
	// React Native reads a file part from `{ uri, name, type }`.
	form.append('photo', {
		uri: item.fileUri,
		name: `${item.id}.jpg`,
		type: 'image/jpeg',
	} as unknown as Blob)

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetchImpl(
			`${baseUrl.replace(/\/$/, '')}${MENU_PHOTOS_PATH}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
					// No Content-Type: fetch sets the multipart boundary itself.
				},
				body: form,
				signal: controller.signal,
			},
		)
		const body = await response.json().catch(() => null)
		return classifyResponse(response.status, body)
	} catch (error) {
		return {
			kind: 'network',
			message: error instanceof Error ? error.message : 'Network error',
		}
	} finally {
		clearTimeout(timer)
	}
}
