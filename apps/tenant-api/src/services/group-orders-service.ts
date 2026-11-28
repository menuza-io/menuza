import crypto from 'node:crypto'

import {
	GROUP_FIRST_NAME_MAX,
	GROUP_INACTIVE_PURGE_MS,
	GROUP_MAX_LINES,
	GROUP_MAX_OPEN_PER_HOST,
	GROUP_MAX_PEOPLE,
	GROUP_PERSON_TOKEN_PREFIX,
	GROUP_SHARE_TOKEN_PREFIX,
	groupAcceptsEdits,
	groupDeadlineError,
	groupLimitBreak,
	groupLineLabel,
	groupShareTokenMessage,
	type CreateGroupRequest,
	type GroupJoined,
	type GroupLineRequest,
	type GroupView,
	type JoinGroupRequest,
	type UpdateGroupRequest,
} from '@repo/common/group-orders'
import { readGuestOrderingFeatures } from '@repo/common/guest-ordering'
import {
	type RestaurantOrderContext,
	type RestaurantOrderQuoteRequest,
} from '@repo/common/restaurant-orders'
import { priceRestaurantOrder } from '@repo/common/restaurant-orders'
import {
	customers,
	getTenantDb,
	groupCartLines,
	groupCartPeople,
	groupCarts,
	restaurantOrders,
	runTenantTransaction,
	type GroupCart,
	type GroupCartLine,
	type GroupCartPerson,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm'

import { hmacHash, timingSafeEqualString } from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	derivePublicOrderChannel,
	fetchOrderContext,
	orderFailure,
	runExclusive,
	type OrderServiceResult,
} from './order-service.ts'

/**
 * Group orders (#170): a signed-in host starts a shared order, friends open a
 * link and add their own dishes by first name, and the host checks out once with
 * the normal `POST /orders` (`groupId`, `groupVersion`).
 *
 * The group lives in this region only: first names are guest data, and nothing
 * here reaches Sites SSR or the App. Two capabilities, both in headers and URL
 * fragments, never in a path or query: the link's share token (an HMAC of the
 * group and its share version, so bumping the version burns every link) lets a
 * friend look at the group and join; a person's own token (256 random bits, only
 * its hash stored) is what lets them change their own dishes, and the host's is
 * what lets one place the order. Every refusal of a token is the uniform
 * `group_not_found`.
 *
 * Writes run under the organization lock in one transaction, bump the group's
 * `version`, and touch `updated_at` (a group untouched for seven days is purged).
 */

export type GroupResult<T> = OrderServiceResult<T>

export function deriveGroupShareToken(
	orgId: string,
	groupId: string,
	version: number,
): string {
	return `${GROUP_SHARE_TOKEN_PREFIX}${hmacHash(groupShareTokenMessage(orgId, groupId, version))}`
}

function sha256Hex(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex')
}

function newPersonToken(): string {
	return `${GROUP_PERSON_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`
}

const TOKEN_PATTERN = /^(gs1|gp1)\.[0-9a-f]{64}$/

export type GroupCaller =
	{ kind: 'person'; person: GroupCartPerson } | { kind: 'share' }

/** Group not found: the one answer for a missing group and any bad token. */
function notFound(): {
	ok: false
	failure: ReturnType<typeof orderFailure>['failure']
} {
	return orderFailure(404, 'group_not_found', 'Group not found.')
}

function failure(
	status: number,
	code: string,
	message: string,
	details?: Record<string, unknown>,
) {
	return orderFailure(status, code, message, details ? { details } : undefined)
}

const MESSAGES = {
	group_locked: 'The host has locked this group order.',
	group_deadline_passed: 'The deadline for this group order has passed.',
	group_already_ordered: 'This group order was already placed.',
} as const

// ---------------------------------------------------------------------------
// The flag, and the menu a line is checked against
// ---------------------------------------------------------------------------

const CONTEXT_TTL_MS = 30_000
const CONTEXT_MAX = 200
const contextCache = new Map<
	string,
	{ context: RestaurantOrderContext | null; expiresAt: number }
>()

const pricedCache = new Map<
	string,
	{
		version: number
		context: RestaurantOrderContext
		availability: Map<string, boolean>
		priced: Map<string, PricedLine>
		expiresAt: number
	}
>()

/** Tests: forget the menu a group was last checked against. */
export function clearGroupContextCacheForTest(): void {
	contextCache.clear()
	pricedCache.clear()
}

async function groupContext(
	orgId: string,
	locationId: string,
	options: { fresh?: boolean; now?: number } = {},
): Promise<RestaurantOrderContext | null> {
	const now = options.now ?? Date.now()
	const key = `${orgId}\u0000${locationId}`
	if (!options.fresh) {
		const hit = contextCache.get(key)
		if (hit && hit.expiresAt > now) return hit.context
	}
	const fetched = await fetchOrderContext(orgId, locationId, null)
	const context = fetched.ok ? fetched.data : null
	if (contextCache.size >= CONTEXT_MAX) contextCache.clear()
	contextCache.set(key, { context, expiresAt: now + CONTEXT_TTL_MS })
	return context
}

function groupEnabled(context: RestaurantOrderContext | null): boolean {
	return context
		? readGuestOrderingFeatures(
				(context as { guestOrdering?: unknown }).guestOrdering,
			).group
		: false
}

type PricedLine = {
	ok: true
	itemName: string
	variantNames: string[]
	options: GroupView['lines'][number]['options']
	amountMinor: number
	currency: string
}

/**
 * Prices one dish against the menu as it is now, with the order engine and the
 * walk-in gates (opening hours and the pickup switch belong to the checkout,
 * not to adding a dish): an unknown, sold out or off-channel dish, a bad
 * variant or a bad modifier is refused the way an order would be.
 */
function priceGroupLine(
	context: RestaurantOrderContext,
	locationId: string,
	line: GroupLineRequest['line'],
	now: Date,
): PricedLine | { ok: false; status: number; code: string; message: string } {
	const priced = priceRestaurantOrder(
		context,
		{
			locationId,
			fulfillment: 'pickup',
			paymentMethod: 'handoff',
			locale: 'en',
			tipPercent: 0,
			lines: [line],
		} as unknown as RestaurantOrderQuoteRequest,
		{
			now,
			walkIn: true,
			channel: derivePublicOrderChannel({
				fulfillment: 'pickup',
				client: null,
			}),
		},
	)
	if (!priced.ok) {
		return {
			ok: false,
			status: priced.error.status,
			code:
				priced.error.code === 'item_unavailable'
					? 'invalid_line'
					: priced.error.code,
			message: priced.error.message,
		}
	}
	const first = priced.result.lines[0]
	if (!first) {
		return {
			ok: false,
			status: 422,
			code: 'invalid_line',
			message: 'That dish cannot be added.',
		}
	}
	return {
		ok: true,
		itemName: first.itemName,
		variantNames: first.variantNames ?? [],
		options: (first.options ?? []).map((option) => ({
			groupId: option.groupId,
			groupName: option.groupName,
			optionId: option.optionId,
			optionName: option.optionName,
			half: option.half,
			quantity: option.quantity,
			priceDelta: option.totalCents / 100,
		})),
		amountMinor: first.totalCents,
		currency: priced.result.currency,
	}
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

async function readGroup(db: TenantDatabase, groupId: string) {
	const [group] = await db
		.select()
		.from(groupCarts)
		.where(eq(groupCarts.id, groupId))
		.limit(1)
	return group ?? null
}

/**
 * Who holds this token for this group. A person's token must hash to one of the
 * group's people; the share token must be the current one for the group's share
 * version. Nothing is read from the database for a token that is not shaped
 * like one.
 */
export async function identifyGroupCaller(
	db: TenantDatabase,
	orgId: string,
	group: GroupCart,
	token: string | null | undefined,
): Promise<GroupCaller | null> {
	if (!token || !TOKEN_PATTERN.test(token)) return null
	if (token.startsWith(GROUP_SHARE_TOKEN_PREFIX)) {
		const expected = deriveGroupShareToken(
			orgId,
			group.id,
			group.shareTokenVersion,
		)
		return timingSafeEqualString(token, expected) ? { kind: 'share' } : null
	}
	const [person] = await db
		.select()
		.from(groupCartPeople)
		.where(
			and(
				eq(groupCartPeople.tokenHash, sha256Hex(token)),
				eq(groupCartPeople.groupId, group.id),
			),
		)
		.limit(1)
	return person ? { kind: 'person', person } : null
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export async function buildGroupView(
	orgId: string,
	db: TenantDatabase,
	group: GroupCart,
	caller: GroupCaller,
	options: { now?: number } = {},
): Promise<GroupView> {
	const now = options.now ?? Date.now()
	const people = await db
		.select()
		.from(groupCartPeople)
		.where(eq(groupCartPeople.groupId, group.id))
		.orderBy(asc(groupCartPeople.createdAt), asc(groupCartPeople.id))
	const lines = await db
		.select()
		.from(groupCartLines)
		.where(eq(groupCartLines.groupId, group.id))
		.orderBy(asc(groupCartLines.createdAt), asc(groupCartLines.id))
	const you = caller.kind === 'person' ? caller.person : null
	const totalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0)
	const context = await groupContext(orgId, group.locationId, { now })
	const currency =
		context?.menu.locations.find((l) => l.id === group.locationId)?.currency ??
		context?.menu.organization.currency ??
		null
	let availability = new Map<string, boolean>()
	let priced = new Map<string, PricedLine>()
	if (context && you) {
		// Pricing up to 100 dishes is the costly part of a poll: reuse it while
		// the group's version (any change to its dishes) and the menu are the same.
		const cacheKey = `${orgId}\u0000${group.id}`
		const hit = pricedCache.get(cacheKey)
		if (
			hit &&
			hit.version === group.version &&
			hit.context === context &&
			hit.expiresAt > now
		) {
			availability = hit.availability
			priced = hit.priced
		} else {
			for (const line of lines) {
				const parsed = line.line as GroupLineRequest['line']
				const result = priceGroupLine(
					context,
					group.locationId,
					parsed,
					new Date(now),
				)
				availability.set(line.id, result.ok)
				if (result.ok) priced.set(line.id, result)
			}
			if (pricedCache.size >= CONTEXT_MAX) pricedCache.clear()
			pricedCache.set(cacheKey, {
				version: group.version,
				context,
				availability,
				priced,
				expiresAt: now + CONTEXT_TTL_MS,
			})
		}
	}
	const [order] = group.orderId
		? await db
				.select({
					id: restaurantOrders.id,
					number: restaurantOrders.number,
					status: restaurantOrders.status,
				})
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, group.orderId))
				.limit(1)
		: []
	const edits = groupAcceptsEdits(
		{ status: group.status, deadlineAt: group.deadlineAt },
		now,
	)
	return {
		id: group.id,
		status: group.status,
		locationId: group.locationId,
		hostFirstName: group.hostFirstName,
		deadlineAt: group.deadlineAt,
		perPersonLimitMinor: group.perPersonLimitMinor,
		totalLimitMinor: group.totalLimitMinor,
		totalMinor: you ? totalMinor : 0,
		currency,
		version: group.version,
		people: people.map((person) => {
			const own = lines.filter((line) => line.personId === person.id)
			return {
				id: person.id,
				firstName: person.firstName,
				isHost: person.isHost,
				isYou: you?.id === person.id,
				done: person.doneAt != null,
				lineCount: you ? own.length : 0,
				subtotalMinor: you
					? own.reduce((sum, line) => sum + line.amountMinor, 0)
					: 0,
			}
		}),
		// Someone who only holds the link sees who is in, not what they chose.
		lines: you
			? lines.map((line) => ({
					id: line.id,
					personId: line.personId,
					line: line.line as GroupView['lines'][number]['line'],
					itemName: line.itemName,
					variantNames: priced.get(line.id)?.variantNames ?? [],
					options: priced.get(line.id)?.options ?? [],
					amountMinor: line.amountMinor,
					available: availability.get(line.id) ?? true,
					canRemove:
						group.status !== 'ordered' &&
						(you.isHost || (line.personId === you.id && edits === 'open')),
				}))
			: [],
		you: you ? { personId: you.id, isHost: you.isHost } : null,
		order: order ?? null,
		canAdd: Boolean(you) && edits === 'open',
		serverNow: now,
	}
}

/**
 * Whether the token is a valid capability of this existing group. The routes
 * ask before counting the per-group rate budget, so a made-up group id or a
 * wrong token writes no counter row.
 */
export async function groupCapabilityHolds(
	orgId: string,
	groupId: string,
	token: string | null,
): Promise<boolean> {
	if (!token || !TOKEN_PATTERN.test(token)) return false
	const db = await getTenantDb(orgId)
	const group = await readGroup(db, groupId)
	if (!group) return false
	return (await identifyGroupCaller(db, orgId, group, token)) !== null
}

/** `GET /orders/group/:id` for a caller who already proved a token. */
export async function readGroupView(
	orgId: string,
	groupId: string,
	token: string | null,
	now?: number,
): Promise<GroupResult<GroupView>> {
	const db = await getTenantDb(orgId)
	const group = await readGroup(db, groupId)
	if (!group) return notFound()
	const caller = await identifyGroupCaller(db, orgId, group, token)
	if (!caller) return notFound()
	return {
		ok: true,
		data: await buildGroupView(orgId, db, group, caller, { now }),
	}
}

// ---------------------------------------------------------------------------
// Create, join, leave, end
// ---------------------------------------------------------------------------

function firstNameOf(value: string | null | undefined): string {
	const first = (value ?? '').trim().split(/\s+/)[0] ?? ''
	return first.slice(0, GROUP_FIRST_NAME_MAX)
}

export async function createGroup(
	orgId: string,
	input: { customerId: string; request: CreateGroupRequest; now?: number },
): Promise<GroupResult<GroupJoined>> {
	const now = input.now ?? Date.now()
	const { request } = input
	const context = await groupContext(orgId, request.locationId, {
		fresh: true,
		now,
	})
	if (!context) {
		return failure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}
	if (!groupEnabled(context)) {
		return failure(
			403,
			'group_disabled',
			'This restaurant does not take group orders.',
		)
	}
	if (!context.menu.locations.some((l) => l.id === request.locationId)) {
		return failure(404, 'location_not_found', 'That location is not available.')
	}
	let deadlineAt: number | null = null
	if (request.deadlineAt) {
		deadlineAt = Date.parse(request.deadlineAt)
		const bad = Number.isFinite(deadlineAt)
			? groupDeadlineError(deadlineAt, now)
			: 'group_deadline_too_soon'
		if (bad) {
			return failure(
				422,
				bad,
				bad === 'group_deadline_too_far'
					? 'The deadline can be at most 7 days ahead.'
					: 'The deadline must be at least 15 minutes ahead.',
			)
		}
	}
	const db = await getTenantDb(orgId)
	const [customer] = await db
		.select({ name: customers.name })
		.from(customers)
		.where(eq(customers.id, input.customerId))
		.limit(1)
	if (!customer) return notFound()
	const hostFirstName = groupLineLabel(firstNameOf(customer.name)) ?? 'Host'

	const groupId = crypto.randomUUID()
	const personToken = newPersonToken()
	const created = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const [open] = await tx
					.select({ n: count() })
					.from(groupCarts)
					.where(
						and(
							eq(groupCarts.hostCustomerId, input.customerId),
							inArray(groupCarts.status, ['open', 'locked']),
						),
					)
				if (Number(open?.n ?? 0) >= GROUP_MAX_OPEN_PER_HOST) {
					return failure(
						429,
						'group_host_limit',
						'You already have the most group orders open.',
					)
				}
				await tx.insert(groupCarts).values({
					id: groupId,
					locationId: request.locationId,
					hostCustomerId: input.customerId,
					hostFirstName,
					status: 'open',
					deadlineAt,
					perPersonLimitMinor: request.perPersonLimitMinor ?? null,
					totalLimitMinor: request.totalLimitMinor ?? null,
					createdAt: now,
					updatedAt: now,
				})
				await tx.insert(groupCartPeople).values({
					groupId,
					firstName: hostFirstName,
					isHost: true,
					tokenHash: sha256Hex(personToken),
					createdAt: now,
				})
				return { ok: true, data: true }
			}),
		),
	)
	if (!created.ok) return created
	const group = (await readGroup(db, groupId))!
	const [host] = await db
		.select()
		.from(groupCartPeople)
		.where(eq(groupCartPeople.groupId, groupId))
	return {
		ok: true,
		data: {
			groupId,
			personToken,
			shareToken: deriveGroupShareToken(
				orgId,
				groupId,
				group.shareTokenVersion,
			),
			view: await buildGroupView(
				orgId,
				db,
				group,
				{ kind: 'person', person: host! },
				{ now },
			),
		},
	}
}

export async function joinGroup(
	orgId: string,
	groupId: string,
	input: { token: string | null; request: JoinGroupRequest; now?: number },
): Promise<GroupResult<GroupJoined>> {
	const now = input.now ?? Date.now()
	const db = await getTenantDb(orgId)
	const group = await readGroup(db, groupId)
	if (!group) return notFound()
	const caller = await identifyGroupCaller(db, orgId, group, input.token)
	// Only the link joins: a person already in has a token of their own.
	if (!caller || caller.kind !== 'share') return notFound()
	const firstName = groupLineLabel(input.request.firstName)
	if (!firstName) {
		return failure(400, 'invalid_request', 'Enter your first name.')
	}
	const personToken = newPersonToken()
	const joined = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const current = await tx
					.select()
					.from(groupCarts)
					.where(eq(groupCarts.id, groupId))
					.limit(1)
					.then((rows) => rows[0])
				if (!current) return notFound()
				const edits = groupAcceptsEdits(current, now)
				if (edits !== 'open') return failure(409, edits, MESSAGES[edits])
				const [people] = await tx
					.select({ n: count() })
					.from(groupCartPeople)
					.where(eq(groupCartPeople.groupId, groupId))
				if (Number(people?.n ?? 0) >= GROUP_MAX_PEOPLE) {
					return failure(409, 'group_full', 'This group order is full.')
				}
				await tx.insert(groupCartPeople).values({
					groupId,
					firstName,
					isHost: false,
					tokenHash: sha256Hex(personToken),
					createdAt: now,
				})
				await tx
					.update(groupCarts)
					.set({ version: sql`${groupCarts.version} + 1`, updatedAt: now })
					.where(eq(groupCarts.id, groupId))
				return { ok: true, data: true }
			}),
		),
	)
	if (!joined.ok) return joined
	const fresh = (await readGroup(db, groupId))!
	const person = (await identifyGroupCaller(
		db,
		orgId,
		fresh,
		personToken,
	)) as Extract<GroupCaller, { kind: 'person' }>
	return {
		ok: true,
		data: {
			groupId,
			personToken,
			view: await buildGroupView(orgId, db, fresh, person, { now }),
		},
	}
}

async function personOf(
	orgId: string,
	groupId: string,
	token: string | null,
): Promise<
	| { ok: true; db: TenantDatabase; group: GroupCart; person: GroupCartPerson }
	| { ok: false; failure: ReturnType<typeof orderFailure>['failure'] }
> {
	const db = await getTenantDb(orgId)
	const group = await readGroup(db, groupId)
	if (!group) return notFound()
	const caller = await identifyGroupCaller(db, orgId, group, token)
	if (!caller || caller.kind !== 'person') return notFound()
	return { ok: true, db, group, person: caller.person }
}

/** A person adds one of their own dishes. */
export async function addGroupLine(
	orgId: string,
	groupId: string,
	input: { token: string | null; request: GroupLineRequest; now?: number },
): Promise<GroupResult<GroupView>> {
	const now = input.now ?? Date.now()
	const who = await personOf(orgId, groupId, input.token)
	if (!who.ok) return who
	const { db, person } = who
	const context = await groupContext(orgId, who.group.locationId, {
		fresh: true,
		now,
	})
	if (!context) {
		return failure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}
	if (!groupEnabled(context)) {
		return failure(
			403,
			'group_disabled',
			'This restaurant does not take group orders.',
		)
	}
	const priced = priceGroupLine(
		context,
		who.group.locationId,
		input.request.line,
		new Date(now),
	)
	if (!priced.ok)
		return failure(
			priced.status === 404 ? 422 : priced.status,
			priced.code,
			priced.message,
		)

	const added = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const [group] = await tx
					.select()
					.from(groupCarts)
					.where(eq(groupCarts.id, groupId))
					.limit(1)
				if (!group) return notFound()
				// The person may have been removed (they left) since the token was read.
				const [stillThere] = await tx
					.select({ id: groupCartPeople.id })
					.from(groupCartPeople)
					.where(eq(groupCartPeople.id, person.id))
				if (!stillThere) return notFound()
				const edits = groupAcceptsEdits(group, now)
				if (edits !== 'open') return failure(409, edits, MESSAGES[edits])
				const lines = await tx
					.select({
						personId: groupCartLines.personId,
						amountMinor: groupCartLines.amountMinor,
					})
					.from(groupCartLines)
					.where(eq(groupCartLines.groupId, groupId))
				if (lines.length >= GROUP_MAX_LINES) {
					return failure(
						409,
						'group_lines_full',
						'This group order has the most dishes allowed.',
					)
				}
				const mine = lines
					.filter((line) => line.personId === person.id)
					.reduce((sum, line) => sum + line.amountMinor, 0)
				const all = lines.reduce((sum, line) => sum + line.amountMinor, 0)
				const broken = groupLimitBreak({
					personSubtotalMinor: mine,
					groupSubtotalMinor: all,
					amountMinor: priced.amountMinor,
					perPersonLimitMinor: group.perPersonLimitMinor,
					totalLimitMinor: group.totalLimitMinor,
				})
				if (broken) {
					return failure(
						409,
						broken,
						'That is over the limit set for this group order.',
						{
							perPersonLimitMinor: group.perPersonLimitMinor,
							totalLimitMinor: group.totalLimitMinor,
						},
					)
				}
				await tx.insert(groupCartLines).values({
					groupId,
					personId: person.id,
					line: input.request.line,
					itemName: priced.itemName,
					amountMinor: priced.amountMinor,
					createdAt: now,
				})
				// Adding dishes reopens "I'm done".
				await tx
					.update(groupCartPeople)
					.set({ doneAt: null })
					.where(eq(groupCartPeople.id, person.id))
				await tx
					.update(groupCarts)
					.set({ version: sql`${groupCarts.version} + 1`, updatedAt: now })
					.where(eq(groupCarts.id, groupId))
				return { ok: true, data: true }
			}),
		),
	)
	if (!added.ok) return added
	return readGroupView(orgId, groupId, input.token, now)
}

/** A person removes their own dish; the host removes anyone's until the order is placed. */
export async function removeGroupLine(
	orgId: string,
	groupId: string,
	lineId: string,
	input: { token: string | null; now?: number },
): Promise<GroupResult<GroupView>> {
	const now = input.now ?? Date.now()
	const who = await personOf(orgId, groupId, input.token)
	if (!who.ok) return who
	const { db, person } = who
	const removed = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const [group] = await tx
					.select()
					.from(groupCarts)
					.where(eq(groupCarts.id, groupId))
					.limit(1)
				if (!group) return notFound()
				const [line] = await tx
					.select()
					.from(groupCartLines)
					.where(
						and(
							eq(groupCartLines.id, lineId),
							eq(groupCartLines.groupId, groupId),
						),
					)
					.limit(1)
				if (!line)
					return failure(
						404,
						'group_line_not_found',
						'That dish is not in this group order.',
					)
				if (group.status === 'ordered') {
					return failure(
						409,
						'group_already_ordered',
						MESSAGES.group_already_ordered,
					)
				}
				if (!person.isHost) {
					// Nobody changes another person's dishes, and a friend only until the lock.
					if (line.personId !== person.id) {
						return failure(
							403,
							'forbidden',
							'You can only change your own dishes.',
						)
					}
					const edits = groupAcceptsEdits(group, now)
					if (edits !== 'open') return failure(409, edits, MESSAGES[edits])
				}
				await tx.delete(groupCartLines).where(eq(groupCartLines.id, lineId))
				await tx
					.update(groupCarts)
					.set({ version: sql`${groupCarts.version} + 1`, updatedAt: now })
					.where(eq(groupCarts.id, groupId))
				return { ok: true, data: true }
			}),
		),
	)
	if (!removed.ok) return removed
	return readGroupView(orgId, groupId, input.token, now)
}

/** "I'm done" (or taking it back). Only the person's own mark. */
export async function setGroupDone(
	orgId: string,
	groupId: string,
	input: { token: string | null; done: boolean; now?: number },
): Promise<GroupResult<GroupView>> {
	const now = input.now ?? Date.now()
	const who = await personOf(orgId, groupId, input.token)
	if (!who.ok) return who
	const { db, person } = who
	const set = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const [group] = await tx
					.select()
					.from(groupCarts)
					.where(eq(groupCarts.id, groupId))
					.limit(1)
				if (!group) return notFound()
				if (group.status === 'ordered') {
					return failure(
						409,
						'group_already_ordered',
						MESSAGES.group_already_ordered,
					)
				}
				await tx
					.update(groupCartPeople)
					.set({ doneAt: input.done ? now : null })
					.where(eq(groupCartPeople.id, person.id))
				await tx
					.update(groupCarts)
					.set({ version: sql`${groupCarts.version} + 1`, updatedAt: now })
					.where(eq(groupCarts.id, groupId))
				return { ok: true, data: true }
			}),
		),
	)
	if (!set.ok) return set
	return readGroupView(orgId, groupId, input.token, now)
}

/** A friend leaves (their dishes go with them). The host cannot: they end the group. */
export async function leaveGroup(
	orgId: string,
	groupId: string,
	input: { token: string | null; now?: number },
): Promise<GroupResult<{ left: true }>> {
	const now = input.now ?? Date.now()
	const who = await personOf(orgId, groupId, input.token)
	if (!who.ok) return who
	const { db, person } = who
	if (person.isHost) {
		return failure(
			409,
			'host_cannot_leave',
			'The host cannot leave. End the group order instead.',
		)
	}
	const left = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const [group] = await tx
					.select()
					.from(groupCarts)
					.where(eq(groupCarts.id, groupId))
					.limit(1)
				if (!group) return notFound()
				if (group.status === 'ordered') {
					return failure(
						409,
						'group_already_ordered',
						MESSAGES.group_already_ordered,
					)
				}
				await tx
					.delete(groupCartPeople)
					.where(eq(groupCartPeople.id, person.id))
				await tx
					.update(groupCarts)
					.set({ version: sql`${groupCarts.version} + 1`, updatedAt: now })
					.where(eq(groupCarts.id, groupId))
				return { ok: true, data: true }
			}),
		),
	)
	if (!left.ok) return left
	return { ok: true, data: { left: true } }
}

/** The host's changes: deadline, limits, lock or unlock. */
export async function updateGroup(
	orgId: string,
	groupId: string,
	input: { token: string | null; request: UpdateGroupRequest; now?: number },
): Promise<GroupResult<GroupView>> {
	const now = input.now ?? Date.now()
	const who = await personOf(orgId, groupId, input.token)
	if (!who.ok) return who
	const { db, person } = who
	if (!person.isHost) {
		return failure(
			403,
			'forbidden',
			'Only the host can change the group order.',
		)
	}
	const { request } = input
	let deadlineAt: number | null | undefined
	if (request.deadlineAt === null) deadlineAt = null
	else if (request.deadlineAt) {
		deadlineAt = Date.parse(request.deadlineAt)
		const bad = Number.isFinite(deadlineAt)
			? groupDeadlineError(deadlineAt, now)
			: 'group_deadline_too_soon'
		if (bad) {
			return failure(
				422,
				bad,
				bad === 'group_deadline_too_far'
					? 'The deadline can be at most 7 days ahead.'
					: 'The deadline must be at least 15 minutes ahead.',
			)
		}
	}
	const updated = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const [group] = await tx
					.select()
					.from(groupCarts)
					.where(eq(groupCarts.id, groupId))
					.limit(1)
				if (!group) return notFound()
				if (group.status === 'ordered') {
					return failure(
						409,
						'group_already_ordered',
						MESSAGES.group_already_ordered,
					)
				}
				const set: Partial<typeof groupCarts.$inferInsert> = {
					updatedAt: now,
				}
				if (deadlineAt !== undefined) set.deadlineAt = deadlineAt
				if (request.perPersonLimitMinor !== undefined) {
					set.perPersonLimitMinor = request.perPersonLimitMinor
				}
				if (request.totalLimitMinor !== undefined) {
					set.totalLimitMinor = request.totalLimitMinor
				}
				if (request.locked !== undefined) {
					set.status = request.locked ? 'locked' : 'open'
				}
				await tx
					.update(groupCarts)
					.set({ ...set, version: sql`${groupCarts.version} + 1` })
					.where(eq(groupCarts.id, groupId))
				return { ok: true, data: true }
			}),
		),
	)
	if (!updated.ok) return updated
	return readGroupView(orgId, groupId, input.token, now)
}

/**
 * The host burns the link: the share version moves on, so every earlier link
 * stops working (people who already joined keep their own tokens) and the
 * answer carries the new link's token.
 */
export async function rotateGroupShare(
	orgId: string,
	groupId: string,
	input: { token: string | null; now?: number },
): Promise<GroupResult<{ shareToken: string; view: GroupView }>> {
	const now = input.now ?? Date.now()
	const who = await personOf(orgId, groupId, input.token)
	if (!who.ok) return who
	const { db, person } = who
	if (!person.isHost) {
		return failure(
			403,
			'forbidden',
			'Only the host can make a new link for the group order.',
		)
	}
	const rotated = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(
				db,
				async (tx): Promise<GroupResult<{ shareVersion: number }>> => {
					const [group] = await tx
						.update(groupCarts)
						.set({
							shareTokenVersion: sql`${groupCarts.shareTokenVersion} + 1`,
							version: sql`${groupCarts.version} + 1`,
							updatedAt: now,
						})
						.where(
							and(
								eq(groupCarts.id, groupId),
								sql`${groupCarts.status} != 'ordered'`,
							),
						)
						.returning({ shareVersion: groupCarts.shareTokenVersion })
					if (!group) {
						return failure(
							409,
							'group_already_ordered',
							MESSAGES.group_already_ordered,
						)
					}
					return { ok: true, data: { shareVersion: group.shareVersion } }
				},
			),
		),
	)
	if (!rotated.ok) return rotated
	const view = await readGroupView(orgId, groupId, input.token, now)
	if (!view.ok) return view
	return {
		ok: true,
		data: {
			shareToken: deriveGroupShareToken(
				orgId,
				groupId,
				rotated.data.shareVersion,
			),
			view: view.data,
		},
	}
}

/** The host ends the group: it is deleted, with every dish and name in it. */
export async function endGroup(
	orgId: string,
	groupId: string,
	input: { token: string | null },
): Promise<GroupResult<{ ended: true }>> {
	const who = await personOf(orgId, groupId, input.token)
	if (!who.ok) return who
	const { db, person } = who
	if (!person.isHost) {
		return failure(403, 'forbidden', 'Only the host can end the group order.')
	}
	const ended = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GroupResult<true>> => {
				const [group] = await tx
					.select()
					.from(groupCarts)
					.where(eq(groupCarts.id, groupId))
					.limit(1)
				if (!group) return notFound()
				if (group.status === 'ordered') {
					return failure(
						409,
						'group_already_ordered',
						MESSAGES.group_already_ordered,
					)
				}
				// Lines and people go with it (cascade); a link that held its token is dead.
				await tx.delete(groupCarts).where(eq(groupCarts.id, groupId))
				return { ok: true, data: true }
			}),
		),
	)
	if (!ended.ok) return ended
	return { ok: true, data: { ended: true } }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export type GroupCheckout = {
	group: GroupCart
	/** The group's dishes in the order they are priced and printed. */
	lines: GroupLineRequest['line'][]
	/** Whose dish each line is (the same order as `lines`). */
	labels: Array<string | null>
	/** The order was already placed with this group: only a replay may go on. */
	alreadyOrdered: boolean
}

/**
 * Before `placeOrder` prices anything: proves the caller is this group's host
 * (their own token, and the signed-in customer who started it), and that the
 * host saw the group as it is (`groupVersion`, 409 `group_changed`). The request's
 * own `lines` are only that anchor: the group's dishes are what is priced. A
 * dish that left the menu is listed (409 `group_items_unavailable`) so the host
 * removes it before paying.
 */
export async function prepareGroupCheckout(
	orgId: string,
	input: {
		groupId: string
		groupVersion: number | undefined
		token: string | null
		customerId: string | null
		locationId: string
		bodyLineCount: number
		context: RestaurantOrderContext
		now: Date
	},
): Promise<GroupResult<GroupCheckout>> {
	if (!groupEnabled(input.context)) {
		return failure(
			403,
			'group_disabled',
			'This restaurant does not take group orders.',
		)
	}
	const db = await getTenantDb(orgId)
	const group = await readGroup(db, input.groupId)
	if (!group) return notFound()
	const caller = await identifyGroupCaller(db, orgId, group, input.token)
	if (!caller || caller.kind !== 'person') return notFound()
	if (!caller.person.isHost || input.customerId !== group.hostCustomerId) {
		return failure(403, 'forbidden', 'Only the host can place the group order.')
	}
	if (group.locationId !== input.locationId) {
		return failure(
			422,
			'invalid_request',
			'The group order is for another location.',
		)
	}
	const rows = await db
		.select()
		.from(groupCartLines)
		.where(eq(groupCartLines.groupId, group.id))
		.orderBy(asc(groupCartLines.createdAt), asc(groupCartLines.id))
	const people = await db
		.select()
		.from(groupCartPeople)
		.where(eq(groupCartPeople.groupId, group.id))
	const nameOf = new Map(people.map((p) => [p.id, groupLineLabel(p.firstName)]))
	// The dishes of each person together, in the order people joined (the host
	// first): the receipt and the kitchen ticket read "For Sam" once, then Sam's dishes.
	const rank = new Map(
		[...people]
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
			.map((p, index) => [p.id, index]),
	)
	rows.sort(
		(a, b) =>
			(rank.get(a.personId) ?? 0) - (rank.get(b.personId) ?? 0) ||
			a.createdAt - b.createdAt ||
			a.id.localeCompare(b.id),
	)
	const checkout = (alreadyOrdered: boolean): GroupCheckout => ({
		group,
		lines: rows.map(
			(row: GroupCartLine) => row.line as GroupLineRequest['line'],
		),
		labels: rows.map((row) => nameOf.get(row.personId) ?? null),
		alreadyOrdered,
	})
	// A retry of a checkout that went through: the lines are frozen once ordered,
	// so the same request is rebuilt and the order's own replay answers it.
	if (group.status === 'ordered') return { ok: true, data: checkout(true) }
	if (
		input.groupVersion !== group.version ||
		input.bodyLineCount !== rows.length
	) {
		return failure(
			409,
			'group_changed',
			'The group order changed. Review it and check out again.',
			{
				version: group.version,
			},
		)
	}
	if (rows.length === 0)
		return failure(422, 'group_empty', 'Add a dish before checking out.')
	const gone = rows.filter(
		(row) =>
			!priceGroupLine(
				input.context,
				group.locationId,
				row.line as GroupLineRequest['line'],
				input.now,
			).ok,
	)
	if (gone.length > 0) {
		return failure(
			409,
			'group_items_unavailable',
			'Some dishes are no longer available. Remove them to continue.',
			{
				lineIds: gone.map((row) => row.id),
			},
		)
	}
	return { ok: true, data: checkout(false) }
}

/**
 * In the order's own transaction, right after it was inserted: the group is
 * claimed by compare-and-set on the version the host saw. A loss throws, so the
 * whole placement (order, discounts, queues) rolls back and nothing is half done.
 */
export class GroupClaimLostError extends Error {
	constructor() {
		super('group_claim_lost')
		this.name = 'GroupClaimLostError'
	}
}

export async function claimGroupForOrder(
	tx: Parameters<Parameters<typeof runTenantTransaction>[1]>[0],
	input: { groupId: string; version: number; orderId: string; now: number },
): Promise<void> {
	const [claimed] = await tx
		.update(groupCarts)
		.set({
			status: 'ordered',
			orderId: input.orderId,
			version: sql`${groupCarts.version} + 1`,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(groupCarts.id, input.groupId),
				inArray(groupCarts.status, ['open', 'locked']),
				eq(groupCarts.version, input.version),
			),
		)
		.returning({ id: groupCarts.id })
	if (!claimed) throw new GroupClaimLostError()
}

// ---------------------------------------------------------------------------
// The tick: a group with no activity for seven days is deleted
// ---------------------------------------------------------------------------

export async function runGroupOrdersTick(
	_orgId: string,
	db: TenantDatabase,
	now: number = Date.now(),
): Promise<{ purged: number; nextDueAt: number | null }> {
	const cutoff = now - GROUP_INACTIVE_PURGE_MS
	const stale = await db
		.select({ id: groupCarts.id })
		.from(groupCarts)
		.where(lt(groupCarts.updatedAt, cutoff))
		.limit(200)
	let purged = 0
	for (const row of stale) {
		await retryOnSqliteBusy(() =>
			db.delete(groupCarts).where(eq(groupCarts.id, row.id)),
		)
		purged += 1
	}
	const [next] = await db
		.select({ at: sql<number | null>`min(${groupCarts.updatedAt})` })
		.from(groupCarts)
	const nextDueAt =
		next?.at != null ? Number(next.at) + GROUP_INACTIVE_PURGE_MS : null
	return { purged, nextDueAt }
}
