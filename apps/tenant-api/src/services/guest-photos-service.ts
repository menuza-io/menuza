import {
	GUEST_PHOTO_CONSENT_TEXT,
	GUEST_PHOTO_CONSENT_VERSION,
	GUEST_PHOTO_ELIGIBILITY_DAYS,
	GUEST_PHOTO_MAX_BYTES,
	GUEST_PHOTO_MAX_PER_DISH_ORDER,
	GUEST_PHOTO_MAX_PER_GUEST_DAY,
	GUEST_PHOTO_REJECTED_RETENTION_DAYS,
	GUEST_PHOTO_STAGED_RETENTION_HOURS,
	GUEST_PHOTO_STATUSES,
	type GuestPhotoSubmission,
	type GuestPhotoSubmitInput,
	type GuestPhotoListQuery,
} from '@repo/common/guest-photos'
import {
	RESTAURANT_ACTIVE_ORDER_STATUSES,
	type PricedOrderLine,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	guestPhotoSubmissions,
	listTenantOrgIds,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	ne,
	or,
} from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { HttpError, notFound } from '../lib/http.ts'
import {
	GuestPhotoImageError,
	type HeicConverterAdapter,
	stripAndReencodeGuestPhoto,
} from '../lib/image-reencode.ts'
import {
	deleteRecordingObject,
	headStorageObject,
	organizationGuestPhotoPrefix,
	presignObjectRead,
	putStorageObject,
} from '../lib/recording-storage.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const ACTIVE_ORDER_STATUS_SET = new Set<string>(
	RESTAURANT_ACTIVE_ORDER_STATUSES,
)

export type GuestPhotoStorageAdapter = {
	putObject: typeof putStorageObject
	headObject: typeof headStorageObject
	deleteObject: typeof deleteRecordingObject
	presignRead: typeof presignObjectRead
}

const defaultStorageAdapter: GuestPhotoStorageAdapter = {
	putObject: putStorageObject,
	headObject: headStorageObject,
	deleteObject: deleteRecordingObject,
	presignRead: presignObjectRead,
}

export class GuestPhotosError extends HttpError {
	constructor(
		status: number,
		code: string,
		message: string,
		extra?: Record<string, unknown>,
	) {
		super(status, code, message, extra)
		this.name = 'GuestPhotosError'
	}
}

export type EligibleDishSummary = {
	itemId: string
	itemName: string
	submittedCount: number
	remainingForDish: number
	eligible: boolean
}

export type GuestPhotoEligibilityResult = {
	eligible: true
	orderId: string
	orderCreatedAt: string
	windowDays: number
	maxPerDishOrder: number
	maxPerGuestDay: number
	dailyUsed: number
	dailyRemaining: number
	dishes: EligibleDishSummary[]
}

export type OperatorGuestPhotoView = GuestPhotoSubmission & {
	previewUrl: string | null
}

type SubmissionRow = typeof guestPhotoSubmissions.$inferSelect
type OrderRow = typeof restaurantOrders.$inferSelect

function serializeForOperator(row: SubmissionRow): GuestPhotoSubmission {
	return {
		id: row.id,
		orgId: row.orgId,
		// Customer/order links may be nulled after person erasure; never expose customerId.
		orderId: row.orderId ?? 'unlinked',
		itemId: row.itemId,
		objectKey: row.objectKey,
		contentType: row.contentType,
		byteSize: row.byteSize,
		status: row.status as GuestPhotoSubmission['status'],
		consentText: row.consentText ?? GUEST_PHOTO_CONSENT_TEXT,
		consentVersion: row.consentVersion ?? null,
		consentedAt: (row.consentedAt ?? row.createdAt).toISOString(),
		decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
		decidedByUserId: row.decidedByUserId ?? null,
		addedAt: row.addedAt ? row.addedAt.toISOString() : null,
		createdAt: row.createdAt.toISOString(),
	}
}

function isOrderEligibleForPhotos(order: OrderRow, nowMs: number): boolean {
	if (!ACTIVE_ORDER_STATUS_SET.has(order.status)) return false
	if (order.paymentStatus === 'failed' || order.paymentStatus === 'expired') {
		return false
	}
	if (order.paymentMethod === 'online' && order.paymentStatus !== 'paid') {
		return false
	}
	if (!order.createdAt) return false
	const ageMs = nowMs - order.createdAt.getTime()
	if (ageMs < 0 || ageMs > GUEST_PHOTO_ELIGIBILITY_DAYS * DAY_MS) {
		return false
	}
	return true
}

function extractOrderDishes(
	order: OrderRow,
): Array<{ itemId: string; itemName: string }> {
	const rawLines = Array.isArray(order.lines)
		? (order.lines as PricedOrderLine[])
		: []
	const seen = new Map<string, string>()
	for (const line of rawLines) {
		if (!line || typeof line.itemId !== 'string' || !line.itemId.trim()) {
			continue
		}
		if (!seen.has(line.itemId)) {
			seen.set(
				line.itemId,
				typeof line.itemName === 'string' && line.itemName.trim()
					? line.itemName
					: line.itemId,
			)
		}
	}
	return [...seen.entries()].map(([itemId, itemName]) => ({ itemId, itemName }))
}

function isValidOrgGuestPhotoKey(orgId: string, objectKey: string): boolean {
	const prefix = organizationGuestPhotoPrefix(orgId)
	if (!objectKey.startsWith(prefix)) return false
	const suffix = objectKey.slice(prefix.length)
	return /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(suffix)
}

async function loadEligibleOrderAndDishes(
	db: Pick<TenantDatabase, 'select'>,
	orgId: string,
	customerId: string,
	orderId: string,
	itemId: string | undefined,
	nowMs: number,
) {
	const order = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.id, orderId),
				eq(restaurantOrders.orgId, orgId),
				eq(restaurantOrders.customerId, customerId),
			),
		)
		.get()

	if (!order || !isOrderEligibleForPhotos(order, nowMs)) {
		throw new GuestPhotosError(
			403,
			'not_eligible',
			'This order is not eligible for guest photo submissions.',
		)
	}

	const dishes = extractOrderDishes(order)
	if (dishes.length === 0) {
		throw new GuestPhotosError(
			403,
			'not_eligible',
			'This order has no eligible dishes.',
		)
	}

	if (itemId && !dishes.some((dish) => dish.itemId === itemId)) {
		throw new GuestPhotosError(
			403,
			'not_eligible',
			'You can only submit photos for dishes in your order.',
		)
	}

	return { order, dishes }
}

async function countSubmissionCaps(
	db: Pick<TenantDatabase, 'select'>,
	orgId: string,
	customerId: string,
	orderId: string,
	nowMs: number,
) {
	const dayAgo = new Date(nowMs - DAY_MS)
	const [orderRows, dailyResult] = await Promise.all([
		db
			.select({
				itemId: guestPhotoSubmissions.itemId,
			})
			.from(guestPhotoSubmissions)
			.where(
				and(
					eq(guestPhotoSubmissions.orgId, orgId),
					eq(guestPhotoSubmissions.orderId, orderId),
				),
			)
			.all(),
		db
			.select({ value: count() })
			.from(guestPhotoSubmissions)
			.where(
				and(
					eq(guestPhotoSubmissions.orgId, orgId),
					eq(guestPhotoSubmissions.customerId, customerId),
					gte(guestPhotoSubmissions.createdAt, dayAgo),
				),
			)
			.get(),
	])

	const perItem = new Map<string, number>()
	for (const row of orderRows) {
		perItem.set(row.itemId, (perItem.get(row.itemId) ?? 0) + 1)
	}
	const dailyUsed = Number(dailyResult?.value ?? 0)
	return { perItem, dailyUsed }
}

export async function checkGuestPhotoEligibility(
	db: TenantDatabase,
	orgId: string,
	customerId: string,
	query: { orderId: string; itemId?: string },
	nowMs = Date.now(),
): Promise<GuestPhotoEligibilityResult> {
	const { order, dishes } = await loadEligibleOrderAndDishes(
		db,
		orgId,
		customerId,
		query.orderId,
		query.itemId,
		nowMs,
	)
	const { perItem, dailyUsed } = await countSubmissionCaps(
		db,
		orgId,
		customerId,
		order.id,
		nowMs,
	)
	const dailyRemaining = Math.max(0, GUEST_PHOTO_MAX_PER_GUEST_DAY - dailyUsed)
	const filteredDishes = query.itemId
		? dishes.filter((d) => d.itemId === query.itemId)
		: dishes

	return {
		eligible: true,
		orderId: order.id,
		orderCreatedAt: order.createdAt!.toISOString(),
		windowDays: GUEST_PHOTO_ELIGIBILITY_DAYS,
		maxPerDishOrder: GUEST_PHOTO_MAX_PER_DISH_ORDER,
		maxPerGuestDay: GUEST_PHOTO_MAX_PER_GUEST_DAY,
		dailyUsed,
		dailyRemaining,
		dishes: filteredDishes.map((dish) => {
			const submittedCount = perItem.get(dish.itemId) ?? 0
			const remainingForDish = Math.max(
				0,
				GUEST_PHOTO_MAX_PER_DISH_ORDER - submittedCount,
			)
			return {
				itemId: dish.itemId,
				itemName: dish.itemName,
				submittedCount,
				remainingForDish,
				eligible: remainingForDish > 0 && dailyRemaining > 0,
			}
		}),
	}
}

export async function uploadGuestPhoto(
	db: TenantDatabase,
	orgId: string,
	customerId: string,
	input: {
		orderId: string
		itemId: string
		rawBytes: Uint8Array
	},
	options: {
		now?: number
		storage?: GuestPhotoStorageAdapter
		heicConverter?: HeicConverterAdapter
	} = {},
): Promise<{
	objectKey: string
	contentType: 'image/jpeg' | 'image/png' | 'image/webp'
	byteSize: number
}> {
	const nowMs = options.now ?? Date.now()
	const storage = options.storage ?? defaultStorageAdapter

	const eligibility = await checkGuestPhotoEligibility(
		db,
		orgId,
		customerId,
		{ orderId: input.orderId, itemId: input.itemId },
		nowMs,
	)
	if (eligibility.dailyRemaining <= 0) {
		throw new GuestPhotosError(
			429,
			'daily_limit_reached',
			'Daily guest photo upload limit reached.',
		)
	}
	const dish = eligibility.dishes[0]
	if (!dish || dish.remainingForDish <= 0) {
		throw new GuestPhotosError(
			429,
			'dish_order_limit_reached',
			'Maximum photos for this dish on this order reached.',
		)
	}

	let cleaned
	try {
		cleaned = await stripAndReencodeGuestPhoto(input.rawBytes, {
			maxBytes: GUEST_PHOTO_MAX_BYTES,
			heicConverter: options.heicConverter,
		})
	} catch (error) {
		if (error instanceof GuestPhotoImageError) {
			throw new GuestPhotosError(error.status, error.code, error.message)
		}
		throw error
	}

	const objectKey = `${organizationGuestPhotoPrefix(orgId)}${randomUUID()}.${cleaned.extension}`
	const putResult = await storage.putObject(
		objectKey,
		cleaned.bytes,
		cleaned.contentType,
	)
	if (putResult === 'not_configured') {
		throw new GuestPhotosError(
			503,
			'upload_not_configured',
			'Photo storage is not configured on this node.',
		)
	}
	if (putResult === 'failed') {
		throw new GuestPhotosError(
			502,
			'storage_upload_failed',
			'Failed to store cleaned photo.',
		)
	}

	try {
		await withSetupWrite(
			db,
			async (tx) => {
				await loadEligibleOrderAndDishes(
					tx,
					orgId,
					customerId,
					input.orderId,
					input.itemId,
					nowMs,
				)
				// Includes 'staged' upload reservations so parallel/unsubmitted uploads
				// count toward the 3/dish/order and 10/guest/day caps.
				const { perItem, dailyUsed } = await countSubmissionCaps(
					tx,
					orgId,
					customerId,
					input.orderId,
					nowMs,
				)
				if (dailyUsed >= GUEST_PHOTO_MAX_PER_GUEST_DAY) {
					throw new GuestPhotosError(
						429,
						'daily_limit_reached',
						'Daily guest photo upload limit reached.',
					)
				}
				if (
					(perItem.get(input.itemId) ?? 0) >= GUEST_PHOTO_MAX_PER_DISH_ORDER
				) {
					throw new GuestPhotosError(
						429,
						'dish_order_limit_reached',
						'Maximum photos for this dish on this order reached.',
					)
				}
				await tx.insert(guestPhotoSubmissions).values({
					id: randomUUID(),
					orgId,
					customerId,
					orderId: input.orderId,
					itemId: input.itemId,
					objectKey,
					contentType: cleaned.contentType,
					byteSize: cleaned.bytes.byteLength,
					status: 'staged',
					consentText: null,
					consentVersion: null,
					consentedAt: null,
					createdAt: new Date(nowMs),
				})
			},
			orgId,
		)
	} catch (error) {
		await storage.deleteObject(objectKey).catch(() => {})
		throw error
	}

	return {
		objectKey,
		contentType: cleaned.contentType,
		byteSize: cleaned.bytes.byteLength,
	}
}

export async function submitGuestPhoto(
	db: TenantDatabase,
	orgId: string,
	customerId: string,
	input: GuestPhotoSubmitInput,
	options: {
		now?: number
		storage?: GuestPhotoStorageAdapter
	} = {},
): Promise<GuestPhotoSubmission> {
	const nowMs = options.now ?? Date.now()
	const storage = options.storage ?? defaultStorageAdapter

	if (!isValidOrgGuestPhotoKey(orgId, input.objectKey)) {
		throw new GuestPhotosError(
			400,
			'invalid_object_key',
			'Invalid guest photo object key.',
		)
	}

	const head = await storage.headObject(input.objectKey)
	if (head.status === 'not_configured') {
		throw new GuestPhotosError(
			503,
			'upload_not_configured',
			'Photo storage is not configured on this node.',
		)
	}
	if (head.status === 'missing') {
		throw new GuestPhotosError(
			400,
			'upload_not_found',
			'Uploaded photo object was not found.',
		)
	}
	if (head.status === 'failed') {
		throw new GuestPhotosError(
			502,
			'storage_check_failed',
			'Could not verify uploaded photo.',
		)
	}
	if (head.sizeBytes <= 0 || head.sizeBytes > GUEST_PHOTO_MAX_BYTES) {
		throw new GuestPhotosError(
			400,
			'invalid_upload_size',
			'Uploaded photo size is outside allowed bounds.',
		)
	}

	const created = await withSetupWrite(
		db,
		async (tx) => {
			await loadEligibleOrderAndDishes(
				tx,
				orgId,
				customerId,
				input.orderId,
				input.itemId,
				nowMs,
			)

			const existing = await tx
				.select()
				.from(guestPhotoSubmissions)
				.where(eq(guestPhotoSubmissions.objectKey, input.objectKey))
				.get()
			if (existing) {
				if (
					existing.orgId !== orgId ||
					existing.customerId !== customerId ||
					existing.orderId !== input.orderId ||
					existing.itemId !== input.itemId
				) {
					throw new GuestPhotosError(
						403,
						'not_eligible',
						'This photo is not eligible for this order or dish.',
					)
				}
				if (existing.status !== 'staged') {
					throw new GuestPhotosError(
						409,
						'duplicate_submission',
						'This photo has already been submitted.',
					)
				}
				const nowDate = new Date(nowMs)
				const [promoted] = await tx
					.update(guestPhotoSubmissions)
					.set({
						status: 'pending',
						contentType: head.contentType || input.contentType,
						byteSize: head.sizeBytes,
						consentText: GUEST_PHOTO_CONSENT_TEXT,
						consentVersion: GUEST_PHOTO_CONSENT_VERSION,
						consentedAt: nowDate,
					})
					.where(
						and(
							eq(guestPhotoSubmissions.id, existing.id),
							eq(guestPhotoSubmissions.orgId, orgId),
							eq(guestPhotoSubmissions.status, 'staged'),
						),
					)
					.returning()
				if (!promoted) {
					throw new GuestPhotosError(
						409,
						'duplicate_submission',
						'This photo has already been submitted.',
					)
				}
				return promoted
			}

			const { perItem, dailyUsed } = await countSubmissionCaps(
				tx,
				orgId,
				customerId,
				input.orderId,
				nowMs,
			)
			if (dailyUsed >= GUEST_PHOTO_MAX_PER_GUEST_DAY) {
				throw new GuestPhotosError(
					429,
					'daily_limit_reached',
					'Daily guest photo upload limit reached.',
				)
			}
			if ((perItem.get(input.itemId) ?? 0) >= GUEST_PHOTO_MAX_PER_DISH_ORDER) {
				throw new GuestPhotosError(
					429,
					'dish_order_limit_reached',
					'Maximum photos for this dish on this order reached.',
				)
			}

			const nowDate = new Date(nowMs)
			const [inserted] = await tx
				.insert(guestPhotoSubmissions)
				.values({
					id: randomUUID(),
					orgId,
					customerId,
					orderId: input.orderId,
					itemId: input.itemId,
					objectKey: input.objectKey,
					contentType: head.contentType || input.contentType,
					byteSize: head.sizeBytes,
					status: 'pending',
					consentText: GUEST_PHOTO_CONSENT_TEXT,
					consentVersion: GUEST_PHOTO_CONSENT_VERSION,
					consentedAt: nowDate,
					createdAt: nowDate,
				})
				.returning()

			return inserted!
		},
		orgId,
	)

	return serializeForOperator(created)
}

type ListCursor = { t: number; id: string }

function encodeListCursor(cursor: ListCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeListCursor(raw: string | undefined): ListCursor | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
		if (
			parsed &&
			typeof parsed.t === 'number' &&
			Number.isFinite(parsed.t) &&
			typeof parsed.id === 'string' &&
			parsed.id.length <= 128
		) {
			return { t: parsed.t, id: parsed.id }
		}
	} catch {
		// fall through
	}
	throw new GuestPhotosError(
		400,
		'invalid_cursor',
		'Invalid pagination cursor.',
	)
}

export async function listOperatorGuestPhotos(
	db: TenantDatabase,
	orgId: string,
	query: GuestPhotoListQuery,
	options: { storage?: GuestPhotoStorageAdapter } = {},
): Promise<{
	submissions: OperatorGuestPhotoView[]
	nextCursor: string | null
}> {
	const storage = options.storage ?? defaultStorageAdapter
	const cursor = decodeListCursor(query.cursor)

	const conditions = [eq(guestPhotoSubmissions.orgId, orgId)]
	if (query.status) {
		conditions.push(eq(guestPhotoSubmissions.status, query.status))
	} else {
		conditions.push(
			inArray(guestPhotoSubmissions.status, [...GUEST_PHOTO_STATUSES]),
		)
	}
	if (query.itemId) {
		conditions.push(eq(guestPhotoSubmissions.itemId, query.itemId))
	}
	if (cursor) {
		const cursorDate = new Date(cursor.t)
		conditions.push(
			or(
				lt(guestPhotoSubmissions.createdAt, cursorDate),
				and(
					eq(guestPhotoSubmissions.createdAt, cursorDate),
					lt(guestPhotoSubmissions.id, cursor.id),
				),
			)!,
		)
	}

	const rows = await db
		.select()
		.from(guestPhotoSubmissions)
		.where(and(...conditions))
		.orderBy(
			desc(guestPhotoSubmissions.createdAt),
			desc(guestPhotoSubmissions.id),
		)
		.limit(query.limit + 1)
		.all()

	const page = rows.slice(0, query.limit)
	const last = page[page.length - 1]
	const nextCursor =
		rows.length > query.limit && last
			? encodeListCursor({
					t: last.createdAt.getTime(),
					id: last.id,
				})
			: null

	return {
		submissions: page.map((row) => ({
			...serializeForOperator(row),
			previewUrl:
				storage.presignRead(row.objectKey, {
					contentType: row.contentType,
					expiresInSeconds: 300,
				})?.url ?? null,
		})),
		nextCursor,
	}
}

export async function getOperatorGuestPhoto(
	db: TenantDatabase,
	orgId: string,
	id: string,
	options: { storage?: GuestPhotoStorageAdapter } = {},
): Promise<OperatorGuestPhotoView> {
	const storage = options.storage ?? defaultStorageAdapter
	const row = await db
		.select()
		.from(guestPhotoSubmissions)
		.where(
			and(
				eq(guestPhotoSubmissions.id, id),
				eq(guestPhotoSubmissions.orgId, orgId),
				ne(guestPhotoSubmissions.status, 'staged'),
			),
		)
		.get()
	if (!row) throw notFound('Guest photo submission not found')

	return {
		...serializeForOperator(row),
		previewUrl:
			storage.presignRead(row.objectKey, {
				contentType: row.contentType,
				expiresInSeconds: 300,
			})?.url ?? null,
	}
}

export async function decideGuestPhoto(
	db: TenantDatabase,
	orgId: string,
	userId: string,
	id: string,
	decision: 'approve' | 'reject',
	nowMs = Date.now(),
): Promise<GuestPhotoSubmission> {
	const updated = await withSetupWrite(
		db,
		async (tx) => {
			const existing = await tx
				.select()
				.from(guestPhotoSubmissions)
				.where(
					and(
						eq(guestPhotoSubmissions.id, id),
						eq(guestPhotoSubmissions.orgId, orgId),
					),
				)
				.get()
			if (!existing || existing.status === 'staged') {
				throw notFound('Guest photo submission not found')
			}
			if (existing.status !== 'pending') {
				throw new GuestPhotosError(
					409,
					'already_decided',
					'This submission has already been decided.',
					{ status: existing.status },
				)
			}

			const nextStatus = decision === 'approve' ? 'approved' : 'rejected'
			const [row] = await tx
				.update(guestPhotoSubmissions)
				.set({
					status: nextStatus,
					decidedAt: new Date(nowMs),
					decidedByUserId: userId,
				})
				.where(
					and(
						eq(guestPhotoSubmissions.id, id),
						eq(guestPhotoSubmissions.orgId, orgId),
						eq(guestPhotoSubmissions.status, 'pending'),
					),
				)
				.returning()

			if (!row) {
				throw new GuestPhotosError(
					409,
					'already_decided',
					'This submission has already been decided.',
				)
			}
			return row
		},
		orgId,
	)

	return serializeForOperator(updated)
}

export async function getApprovedGuestPhotoSignedUrl(
	db: TenantDatabase,
	orgId: string,
	id: string,
	options: { storage?: GuestPhotoStorageAdapter; now?: Date } = {},
): Promise<{
	url: string
	expiresAt: string
	contentType: string
	itemId: string
	submissionId: string
}> {
	const storage = options.storage ?? defaultStorageAdapter
	const row = await db
		.select()
		.from(guestPhotoSubmissions)
		.where(
			and(
				eq(guestPhotoSubmissions.id, id),
				eq(guestPhotoSubmissions.orgId, orgId),
				ne(guestPhotoSubmissions.status, 'staged'),
			),
		)
		.get()
	if (!row || row.status === 'staged') {
		throw notFound('Guest photo submission not found')
	}
	if (row.status !== 'approved') {
		throw new GuestPhotosError(
			409,
			'not_approved',
			'Only approved submissions can be added to a dish.',
			{ status: row.status },
		)
	}

	const link = storage.presignRead(row.objectKey, {
		contentType: row.contentType,
		expiresInSeconds: 120,
		now: options.now,
	})
	if (!link) {
		throw new GuestPhotosError(
			503,
			'storage_not_configured',
			'Photo storage is not configured on this node.',
		)
	}

	return {
		url: link.url,
		expiresAt: new Date(link.expiresAt).toISOString(),
		contentType: row.contentType,
		itemId: row.itemId,
		submissionId: row.id,
	}
}

export async function markGuestPhotoAdded(
	db: TenantDatabase,
	orgId: string,
	id: string,
	nowMs = Date.now(),
): Promise<GuestPhotoSubmission> {
	const updated = await withSetupWrite(
		db,
		async (tx) => {
			const existing = await tx
				.select()
				.from(guestPhotoSubmissions)
				.where(
					and(
						eq(guestPhotoSubmissions.id, id),
						eq(guestPhotoSubmissions.orgId, orgId),
					),
				)
				.get()
			if (!existing || existing.status === 'staged') {
				throw notFound('Guest photo submission not found')
			}
			if (existing.status !== 'approved') {
				throw new GuestPhotosError(
					409,
					'not_approved',
					'Only approved submissions can be marked as added.',
					{ status: existing.status },
				)
			}

			const [row] = await tx
				.update(guestPhotoSubmissions)
				.set({
					status: 'added',
					addedAt: new Date(nowMs),
				})
				.where(
					and(
						eq(guestPhotoSubmissions.id, id),
						eq(guestPhotoSubmissions.orgId, orgId),
						eq(guestPhotoSubmissions.status, 'approved'),
					),
				)
				.returning()

			if (!row) {
				throw new GuestPhotosError(
					409,
					'not_approved',
					'Only approved submissions can be marked as added.',
				)
			}
			return row
		},
		orgId,
	)

	return serializeForOperator(updated)
}

export async function removeGuestPhotoAdded(
	db: TenantDatabase,
	orgId: string,
	id: string,
): Promise<GuestPhotoSubmission> {
	const updated = await withSetupWrite(
		db,
		async (tx) => {
			const existing = await tx
				.select()
				.from(guestPhotoSubmissions)
				.where(
					and(
						eq(guestPhotoSubmissions.id, id),
						eq(guestPhotoSubmissions.orgId, orgId),
					),
				)
				.get()
			if (!existing || existing.status === 'staged') {
				throw notFound('Guest photo submission not found')
			}
			if (existing.status !== 'added') {
				throw new GuestPhotosError(
					409,
					'not_added',
					'Only added submissions can be removed from a dish.',
					{ status: existing.status },
				)
			}

			const [row] = await tx
				.update(guestPhotoSubmissions)
				.set({
					status: 'approved',
					addedAt: null,
				})
				.where(
					and(
						eq(guestPhotoSubmissions.id, id),
						eq(guestPhotoSubmissions.orgId, orgId),
						eq(guestPhotoSubmissions.status, 'added'),
					),
				)
				.returning()

			if (!row) {
				throw new GuestPhotosError(
					409,
					'not_added',
					'Only added submissions can be removed from a dish.',
				)
			}
			return row
		},
		orgId,
	)

	return serializeForOperator(updated)
}

/**
 * Purges rejected guest photo submissions older than
 * `GUEST_PHOTO_REJECTED_RETENTION_DAYS` (30 days), deleting both their R2
 * object and database row. If R2 deletion fails, the row stays for retry on
 * the next tick.
 */
export async function purgeExpiredRejectedGuestPhotos(
	db: TenantDatabase,
	options: {
		now?: number
		limit?: number
		storage?: Pick<GuestPhotoStorageAdapter, 'deleteObject'>
	} = {},
): Promise<{ purged: number; failed: number }> {
	const nowMs = options.now ?? Date.now()
	const cutoff = new Date(nowMs - GUEST_PHOTO_REJECTED_RETENTION_DAYS * DAY_MS)
	const storage = options.storage ?? defaultStorageAdapter
	const batchLimit = Math.max(1, Math.min(500, options.limit ?? 200))

	const candidates = await db
		.select({
			id: guestPhotoSubmissions.id,
			objectKey: guestPhotoSubmissions.objectKey,
		})
		.from(guestPhotoSubmissions)
		.where(
			and(
				eq(guestPhotoSubmissions.status, 'rejected'),
				isNotNull(guestPhotoSubmissions.decidedAt),
				lt(guestPhotoSubmissions.decidedAt, cutoff),
			),
		)
		.limit(batchLimit)
		.all()

	let purged = 0
	let failed = 0
	for (const candidate of candidates) {
		const delResult = await storage.deleteObject(candidate.objectKey)
		if (delResult === 'failed') {
			failed += 1
			continue
		}
		await db
			.delete(guestPhotoSubmissions)
			.where(
				and(
					eq(guestPhotoSubmissions.id, candidate.id),
					eq(guestPhotoSubmissions.status, 'rejected'),
				),
			)
		purged += 1
	}

	return { purged, failed }
}

/**
 * Purges unsubmitted `'staged'` upload reservations older than
 * `GUEST_PHOTO_STAGED_RETENTION_HOURS` (24 hours), deleting both their R2
 * object and database row. If R2 deletion fails, the row stays for retry.
 */
export async function purgeStaleStagedGuestPhotos(
	db: TenantDatabase,
	options: {
		now?: number
		limit?: number
		storage?: Pick<GuestPhotoStorageAdapter, 'deleteObject'>
	} = {},
): Promise<{ purged: number; failed: number }> {
	const nowMs = options.now ?? Date.now()
	const cutoff = new Date(nowMs - GUEST_PHOTO_STAGED_RETENTION_HOURS * HOUR_MS)
	const storage = options.storage ?? defaultStorageAdapter
	const batchLimit = Math.max(1, Math.min(500, options.limit ?? 200))

	const candidates = await db
		.select({
			id: guestPhotoSubmissions.id,
			objectKey: guestPhotoSubmissions.objectKey,
		})
		.from(guestPhotoSubmissions)
		.where(
			and(
				eq(guestPhotoSubmissions.status, 'staged'),
				lt(guestPhotoSubmissions.createdAt, cutoff),
			),
		)
		.limit(batchLimit)
		.all()

	let purged = 0
	let failed = 0
	for (const candidate of candidates) {
		const delResult = await storage.deleteObject(candidate.objectKey)
		if (delResult === 'failed') {
			failed += 1
			continue
		}
		await db
			.delete(guestPhotoSubmissions)
			.where(
				and(
					eq(guestPhotoSubmissions.id, candidate.id),
					eq(guestPhotoSubmissions.status, 'staged'),
				),
			)
		purged += 1
	}

	return { purged, failed }
}

export type GuestPhotosTickResult = {
	purged: number
	failed: number
	errors: number
}

export async function runGuestPhotosTickForOrg(
	orgId: string,
	options: {
		now?: number
		storage?: Pick<GuestPhotoStorageAdapter, 'deleteObject'>
	} = {},
): Promise<GuestPhotosTickResult> {
	const db = await getTenantDb(orgId)
	const [rejected, staged] = await Promise.all([
		purgeExpiredRejectedGuestPhotos(db, options),
		purgeStaleStagedGuestPhotos(db, options),
	])
	const purged = rejected.purged + staged.purged
	const failed = rejected.failed + staged.failed
	return {
		purged,
		failed,
		errors: failed > 0 ? 1 : 0,
	}
}

export async function fanOutGuestPhotosTick(
	options: {
		orgIds?: readonly string[]
		run?: (orgId: string) => Promise<GuestPhotosTickResult | null>
		now?: number
		storage?: Pick<GuestPhotoStorageAdapter, 'deleteObject'>
	} = {},
): Promise<GuestPhotosTickResult> {
	const orgIds = options.orgIds ?? (await listTenantOrgIds())
	let purged = 0
	let failed = 0
	let errors = 0
	for (const orgId of orgIds) {
		try {
			const res = options.run
				? await options.run(orgId)
				: await runGuestPhotosTickForOrg(orgId, {
						now: options.now,
						storage: options.storage,
					})
			if (!res) {
				errors += 1
				continue
			}
			purged += res.purged
			failed += res.failed
			errors += res.errors
		} catch (error) {
			errors += 1
			console.error('Guest photos tick failed for org', { orgId, error })
		}
	}
	return { purged, failed, errors }
}
