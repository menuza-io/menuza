import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import {
	INVENTORY_POS_CONTRACT_HEADER,
	INVENTORY_POS_CONTRACT_VERSION,
	INVENTORY_POS_PATHS,
	stationCatalogSchema,
	stationCountEntriesResultSchema,
	stationCountEntriesSchema,
	stationCountSheetSchema,
	stationCountSummarySchema,
	stationDeliveryResultSchema,
	stationDeliverySchema,
	stationPhotoConfirmResultSchema,
	stationPhotoRequestSchema,
	stationPhotoUploadSchema,
	stationSendCountSchema,
	stationStartCountResultSchema,
	stationStartCountSchema,
	stationUndoWasteResultSchema,
	stationWasteResultSchema,
	stationWasteSchema,
	undoWasteSchema,
	confirmInvoicePhotoSchema,
	type StationCatalog,
} from '@repo/inventory'
import { type z } from 'zod'
import { noteServerDate } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { serversProblem } from '~/lib/pairing.ts'
import { type Session } from '~/lib/signin.ts'

/**
 * The Stock app's client for tenant-api's `/pos/inventory/*` (contract in
 * `packages/inventory/src/contract/station.ts`): the paired terminal's secret
 * plus the signed-in person's `Pos-Staff-Session`, straight from the browser
 * to the regional node. Requests are checked against the contract's strict
 * schemas before they leave (a request the region would refuse as
 * `invalid_request` never goes), responses are parsed with its schemas, and
 * every failure is a `StockApiError` the outbox can classify.
 */

export class StockApiError extends Error {
	constructor(
		readonly code: string,
		readonly status = 0,
	) {
		super(code)
		this.name = 'StockApiError'
	}
}

type Body<S extends z.ZodType> = z.input<S>

export type StockCatalogAnswer =
	{ status: 'ok'; catalog: StationCatalog } | { status: 'not_modified' }

/** Everything the app asks of the region. Demo mode implements the same shape in memory. */
export type StockApi = {
	catalog(
		locationId: string,
		version: string | null,
	): Promise<StockCatalogAnswer>
	startCount(
		body: Body<typeof stationStartCountSchema>,
	): Promise<z.infer<typeof stationStartCountResultSchema>>
	countSheet(id: string): Promise<z.infer<typeof stationCountSheetSchema>>
	countEntries(
		id: string,
		body: Body<typeof stationCountEntriesSchema>,
	): Promise<z.infer<typeof stationCountEntriesResultSchema>>
	sendCount(
		id: string,
		body: Body<typeof stationSendCountSchema>,
	): Promise<z.infer<typeof stationCountSummarySchema>>
	waste(
		body: Body<typeof stationWasteSchema>,
	): Promise<z.infer<typeof stationWasteResultSchema>>
	undoWaste(
		id: string,
		body: Body<typeof undoWasteSchema>,
	): Promise<z.infer<typeof stationUndoWasteResultSchema>>
	delivery(
		body: Body<typeof stationDeliverySchema>,
	): Promise<z.infer<typeof stationDeliveryResultSchema>>
	photoRequest(
		id: string,
		body: Body<typeof stationPhotoRequestSchema>,
	): Promise<z.infer<typeof stationPhotoUploadSchema>>
	/** Puts the bytes straight into the region's storage (not through tenant-api). */
	putPhoto(
		upload: z.infer<typeof stationPhotoUploadSchema>,
		blob: Blob,
	): Promise<void>
	photoConfirm(
		id: string,
		body: Body<typeof confirmInvoicePhotoSchema>,
	): Promise<void>
}

const TIMEOUT_MS = 15_000
const UPLOAD_TIMEOUT_MS = 60_000

/** Reads `{ error }` from a refusal, whatever else came back. */
async function refusalCode(response: Response): Promise<string> {
	const raw: unknown = await response.json().catch(() => null)
	if (raw && typeof raw === 'object' && 'error' in raw)
		return String((raw as { error: unknown }).error).slice(0, 64)
	return `http_${response.status}`
}

export function createStockApi(
	settings: Pick<PosSettings, 'tenantApiUrl' | 'deviceToken'>,
	session: Pick<Session, 'serverSession'> | null,
	fetchImpl: typeof fetch = (...args) => fetch(...args),
): StockApi {
	function base(): string {
		if (!settings.deviceToken) throw new StockApiError('invalid_device', 401)
		if (!settings.tenantApiUrl || serversProblem([settings.tenantApiUrl]))
			throw new StockApiError('invalid_server', 400)
		return settings.tenantApiUrl.replace(/\/+$/, '')
	}

	function headers(json: boolean, extra: Record<string, string> = {}) {
		return {
			Authorization: `Bearer ${settings.deviceToken}`,
			[INVENTORY_POS_CONTRACT_HEADER]: String(INVENTORY_POS_CONTRACT_VERSION),
			...(session?.serverSession
				? { [POS_STAFF_SESSION_HEADER]: session.serverSession.token }
				: {}),
			...(json ? { 'Content-Type': 'application/json' } : {}),
			...extra,
		}
	}

	async function send(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
		extra: Record<string, string> = {},
	): Promise<Response> {
		const root = base()
		const sentAt = Date.now()
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
		let response: Response
		try {
			response = await fetchImpl(`${root}${path}`, {
				method,
				cache: 'no-store',
				credentials: 'omit',
				headers: headers(body !== undefined, extra),
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				signal: controller.signal,
			})
		} catch {
			throw new StockApiError('connection_lost')
		} finally {
			clearTimeout(timer)
		}
		noteServerDate(response, sentAt)
		return response
	}

	async function call<S extends z.ZodType>(
		method: 'GET' | 'POST',
		path: string,
		answer: S,
		request?: { schema: z.ZodType; body: unknown },
	): Promise<z.infer<S>> {
		let body: unknown
		if (request) {
			const checked = request.schema.safeParse(request.body)
			// Never echo the rejected value: the region does not either.
			if (!checked.success) throw new StockApiError('invalid_request', 400)
			body = checked.data
		}
		const response = await send(method, path, body)
		if (!response.ok)
			throw new StockApiError(await refusalCode(response), response.status)
		const raw: unknown = await response.json().catch(() => null)
		const parsed = answer.safeParse(raw)
		if (!parsed.success) throw new StockApiError('invalid_response', 502)
		return parsed.data
	}

	return {
		async catalog(locationId, version) {
			const response = await send(
				'GET',
				`${INVENTORY_POS_PATHS.catalog}?locationId=${encodeURIComponent(locationId)}`,
				undefined,
				version ? { 'If-None-Match': `"${version}"` } : {},
			)
			if (response.status === 304) return { status: 'not_modified' }
			if (!response.ok)
				throw new StockApiError(await refusalCode(response), response.status)
			const parsed = stationCatalogSchema.safeParse(
				await response.json().catch(() => null),
			)
			if (!parsed.success) throw new StockApiError('invalid_response', 502)
			return { status: 'ok', catalog: parsed.data }
		},
		startCount: (body) =>
			call(
				'POST',
				INVENTORY_POS_PATHS.startCount,
				stationStartCountResultSchema,
				{ schema: stationStartCountSchema, body },
			),
		countSheet: (id) =>
			call(
				'GET',
				INVENTORY_POS_PATHS.count(encodeURIComponent(id)),
				stationCountSheetSchema,
			),
		countEntries: (id, body) =>
			call(
				'POST',
				INVENTORY_POS_PATHS.countEntries(encodeURIComponent(id)),
				stationCountEntriesResultSchema,
				{ schema: stationCountEntriesSchema, body },
			),
		sendCount: (id, body) =>
			call(
				'POST',
				INVENTORY_POS_PATHS.sendCount(encodeURIComponent(id)),
				stationCountSummarySchema,
				{ schema: stationSendCountSchema, body },
			),
		waste: (body) =>
			call('POST', INVENTORY_POS_PATHS.waste, stationWasteResultSchema, {
				schema: stationWasteSchema,
				body,
			}),
		undoWaste: (id, body) =>
			call(
				'POST',
				INVENTORY_POS_PATHS.undoWaste(encodeURIComponent(id)),
				stationUndoWasteResultSchema,
				{ schema: undoWasteSchema, body },
			),
		delivery: (body) =>
			call(
				'POST',
				INVENTORY_POS_PATHS.deliveries,
				stationDeliveryResultSchema,
				{
					schema: stationDeliverySchema,
					body,
				},
			),
		photoRequest: (id, body) =>
			call(
				'POST',
				INVENTORY_POS_PATHS.deliveryPhoto(encodeURIComponent(id)),
				stationPhotoUploadSchema,
				{ schema: stationPhotoRequestSchema, body },
			),
		async putPhoto(upload, blob) {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
			try {
				// Straight to the region's storage with the signed headers: no device secret, no cookies.
				const response = await fetchImpl(upload.uploadUrl, {
					method: upload.method,
					credentials: 'omit',
					headers: upload.headers,
					body: blob,
					signal: controller.signal,
				})
				if (!response.ok)
					throw new StockApiError('upload_failed', response.status)
			} catch (failure) {
				if (failure instanceof StockApiError) throw failure
				throw new StockApiError('connection_lost')
			} finally {
				clearTimeout(timer)
			}
		},
		async photoConfirm(id, body) {
			await call(
				'POST',
				INVENTORY_POS_PATHS.deliveryPhotoConfirm(encodeURIComponent(id)),
				stationPhotoConfirmResultSchema,
				{ schema: confirmInvoicePhotoSchema, body },
			)
		},
	}
}
