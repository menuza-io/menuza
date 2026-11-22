import { type QueueItem } from '../types'
import {
	MENU_PHOTOS_PATH,
	classifyResponse,
	uploadPhoto,
} from '../upload-photo'

const item: QueueItem = {
	id: 'client-123',
	organizationId: 'org-1',
	itemId: 'dish-1',
	itemName: 'Pasta',
	fileUri: 'file:///documents/dish-photos/client-123.jpg',
	status: 'uploading',
	attempts: 0,
	nextAttemptAt: 0,
	createdAt: 0,
	uploadStartedAt: 0,
	lastError: null,
}

function response(status: number, body: unknown) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body,
	} as unknown as Response
}

describe('classifyResponse', () => {
	it('reads the success body', () => {
		expect(
			classifyResponse(200, {
				success: true,
				data: { itemId: 'd', assetId: 'a', imageUrl: 'u' },
			}),
		).toEqual({ kind: 'ok', itemId: 'd', assetId: 'a', imageUrl: 'u' })
	})

	it('does not call an unreadable 200 a success', () => {
		expect(classifyResponse(200, { success: true }).kind).toBe('transient')
		expect(classifyResponse(200, null).kind).toBe('transient')
	})

	it.each([400, 403, 404, 413, 415])('%i is a permanent refusal', (status) => {
		expect(
			classifyResponse(status, { success: false, error: 'x' }),
		).toMatchObject({ kind: 'refused', status, code: 'x' })
	})

	it.each([408, 429, 500, 502, 503])('%i is retryable', (status) => {
		expect(classifyResponse(status, null).kind).toBe('transient')
	})

	it('401 asks for a refresh', () => {
		expect(classifyResponse(401, { error: 'unauthorized' })).toEqual({
			kind: 'unauthorized',
		})
	})
})

describe('uploadPhoto', () => {
	it('posts multipart with the four contract fields and a bearer token', async () => {
		const append = jest.spyOn(FormData.prototype, 'append')
		const fetchImpl = jest.fn(async () =>
			response(200, {
				success: true,
				data: { itemId: 'dish-1', assetId: 'a1', imageUrl: 'https://x/y.jpg' },
			}),
		)

		const outcome = await uploadPhoto({
			item,
			accessToken: 'tok',
			baseUrl: 'https://app.example/',
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		expect(outcome.kind).toBe('ok')
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe(`https://app.example${MENU_PHOTOS_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' })
		// fetch must set the multipart boundary itself.
		expect(Object.keys(init.headers as object)).not.toContain('Content-Type')

		const fields = Object.fromEntries(
			append.mock.calls.map(([key, value]) => [key, value]),
		)
		expect(fields).toMatchObject({
			organizationId: 'org-1',
			itemId: 'dish-1',
			clientId: 'client-123',
			photo: { uri: item.fileUri, type: 'image/jpeg' },
		})
		append.mockRestore()
	})

	it('reports a lost connection as a network outcome, not a throw', async () => {
		const outcome = await uploadPhoto({
			item,
			accessToken: 'tok',
			baseUrl: 'https://app.example',
			fetchImpl: (async () => {
				throw new TypeError('Network request failed')
			}) as unknown as typeof fetch,
		})
		expect(outcome).toEqual({
			kind: 'network',
			message: 'Network request failed',
		})
	})

	it('maps a 403 body to a refusal', async () => {
		const outcome = await uploadPhoto({
			item,
			accessToken: 'tok',
			baseUrl: 'https://app.example',
			fetchImpl: (async () =>
				response(403, {
					success: false,
					error: 'forbidden',
					message: 'No permission',
				})) as unknown as typeof fetch,
		})
		expect(outcome).toMatchObject({
			kind: 'refused',
			status: 403,
			code: 'forbidden',
		})
	})
})
