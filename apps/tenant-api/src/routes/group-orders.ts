import {
	GROUP_TOKEN_HEADER,
	createGroupSchema,
	groupLineSchema,
	joinGroupSchema,
	updateGroupSchema,
} from '@repo/common/group-orders'
import { getTenantDb } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'

import { errorLogFields } from '../lib/error-log.ts'
import {
	countOrderGuestCancelAttempt,
	type OrderGuestCancelBucket,
} from '../lib/order-guest-cancel-limits.ts'
import {
	addGroupLine,
	createGroup,
	endGroup,
	joinGroup,
	leaveGroup,
	readGroupView,
	removeGroupLine,
	setGroupDone,
	updateGroup,
	type GroupResult,
} from '../services/group-orders-service.ts'
import { authenticateCustomer } from './auth.ts'
import {
	clientBucket,
	noStoreHeaders,
	orderFailureResponse,
	resolveOrderingOrganization,
} from './orders.ts'

/**
 * `/orders/group/*` (#170): group orders. Mounted before `/orders`, so a group
 * id is never read as an order id. The organization is the one the browser's
 * Origin names (plus slug or host hints), never a client id; the host starts a
 * group with their customer token, everyone else holds a token in the
 * `X-Group-Token` header (from a URL fragment). Every refusal of a token, a
 * missing group or another organization's group is the uniform 404
 * `group_not_found`. Reads are polled every 5 seconds, so they have generous but
 * durable limits; writes and joins have their own.
 */
export const groupOrderRoutes = new Hono()

const MAX_GROUP_BODY_BYTES = 20_000

const identitySchema = z.object({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
})

function rateLimited(retryAfterSeconds: number) {
	return Response.json(
		{
			error: 'rate_limit_exceeded',
			message: 'Too many requests. Please try again later.',
			retryAfterSeconds,
		},
		{
			status: 429,
			headers: {
				...noStoreHeaders(),
				'Retry-After': String(Math.max(1, retryAfterSeconds)),
			},
		},
	)
}

async function limit(
	c: Context,
	orgId: string,
	groupId: string | null,
	buckets: { group?: OrderGuestCancelBucket; address: OrderGuestCancelBucket },
): Promise<Response | null> {
	const db = await getTenantDb(orgId)
	if (groupId && buckets.group) {
		const perGroup = await countOrderGuestCancelAttempt(
			db,
			buckets.group,
			`${orgId}:${groupId}`,
		)
		if (!perGroup.ok) return rateLimited(perGroup.retryAfterSeconds)
	}
	const address = clientBucket(c)
	if (address) {
		const perAddress = await countOrderGuestCancelAttempt(
			db,
			buckets.address,
			`${orgId}:${address}`,
		)
		if (!perAddress.ok) return rateLimited(perAddress.retryAfterSeconds)
	}
	return null
}

function groupToken(c: Context): string | null {
	return c.req.header(GROUP_TOKEN_HEADER)?.trim() || null
}

function answer<T>(c: Context, result: GroupResult<T>, status = 200) {
	if (!result.ok) return orderFailureResponse(result.failure)
	return c.json(result.data, status as 200 | 201, noStoreHeaders())
}

/** Reads a small JSON body once: its identity (slug or host) and the rest. */
async function readBody(c: Context) {
	const contentLength = Number(c.req.header('content-length') ?? 0)
	if (contentLength > MAX_GROUP_BODY_BYTES) {
		return {
			error: c.json({ error: 'Payload too large' }, 413, noStoreHeaders()),
		}
	}
	const raw = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<
		string,
		unknown
	>
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return {
			error: c.json({ error: 'invalid_request' }, 400, noStoreHeaders()),
		}
	}
	const { slug, host, ...rest } = raw
	const identity = identitySchema.safeParse({
		slug: typeof slug === 'string' ? slug : c.req.query('slug'),
		host: typeof host === 'string' ? host : c.req.query('host'),
	})
	if (!identity.success) {
		return {
			error: c.json({ error: 'Organization not found' }, 404, noStoreHeaders()),
		}
	}
	return { identity: identity.data, rest }
}

function invalid(c: Context) {
	return c.json(
		{
			error: 'invalid_request',
			message: 'That group order request is not valid.',
		},
		400,
		noStoreHeaders(),
	)
}

async function organizationOf(
	c: Context,
	identity: { slug?: string; host?: string },
) {
	const found = await resolveOrderingOrganization(c, identity)
	if ('error' in found) return { error: found.error }
	return { orgId: found.organization.id, organization: found.organization }
}

function crash(c: Context, what: string, orgId: string, error: unknown) {
	console.error(`Failed to ${what} for org ${orgId}:`, errorLogFields(error))
	return c.json(
		{
			error: 'internal_error',
			message: 'We could not do that. Please try again.',
		},
		500,
		noStoreHeaders(),
	)
}

// POST /orders/group: the signed-in host starts a group.
groupOrderRoutes.post('/', async (c) => {
	const body = await readBody(c)
	if ('error' in body) return body.error
	const org = await organizationOf(c, body.identity)
	if ('error' in org) return org.error
	let customerId: string
	try {
		const auth = await authenticateCustomer(c)
		if (auth.organization.id !== org.orgId) {
			return c.json(
				{ error: 'Customer token does not match this organization' },
				403,
				noStoreHeaders(),
			)
		}
		customerId = auth.customerId
	} catch (response) {
		return response as Response
	}
	const parsed = createGroupSchema.safeParse(body.rest)
	if (!parsed.success) return invalid(c)
	try {
		const limited = await limit(c, org.orgId, null, {
			address: 'groupWriteAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await createGroup(org.orgId, { customerId, request: parsed.data }),
			201,
		)
	} catch (error) {
		return crash(c, 'start a group order', org.orgId, error)
	}
})

// GET /orders/group/:groupId: the group as the token's holder may see it.
groupOrderRoutes.get('/:groupId', async (c) => {
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	const org = await organizationOf(c, identity.data)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupReadGroup',
			address: 'groupReadAddress',
		})
		if (limited) return limited
		return answer(c, await readGroupView(org.orgId, groupId, groupToken(c)))
	} catch (error) {
		return crash(c, 'read a group order', org.orgId, error)
	}
})

// POST /orders/group/:groupId/join: a friend with the link's token gives a first name.
groupOrderRoutes.post('/:groupId/join', async (c) => {
	const body = await readBody(c)
	if ('error' in body) return body.error
	const org = await organizationOf(c, body.identity)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	const parsed = joinGroupSchema.safeParse(body.rest)
	if (!parsed.success) return invalid(c)
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupWriteGroup',
			address: 'groupJoinAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await joinGroup(org.orgId, groupId, {
				token: groupToken(c),
				request: parsed.data,
			}),
			201,
		)
	} catch (error) {
		return crash(c, 'join a group order', org.orgId, error)
	}
})

// POST /orders/group/:groupId/lines: a person adds one of their own dishes.
groupOrderRoutes.post('/:groupId/lines', async (c) => {
	const body = await readBody(c)
	if ('error' in body) return body.error
	const org = await organizationOf(c, body.identity)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	const parsed = groupLineSchema.safeParse(body.rest)
	if (!parsed.success) return invalid(c)
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupWriteGroup',
			address: 'groupWriteAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await addGroupLine(org.orgId, groupId, {
				token: groupToken(c),
				request: parsed.data,
			}),
			201,
		)
	} catch (error) {
		return crash(c, 'add a group order dish', org.orgId, error)
	}
})

// DELETE /orders/group/:groupId/lines/:lineId: own dish (or any, for the host).
groupOrderRoutes.delete('/:groupId/lines/:lineId', async (c) => {
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	const org = await organizationOf(c, identity.data)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupWriteGroup',
			address: 'groupWriteAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await removeGroupLine(org.orgId, groupId, c.req.param('lineId'), {
				token: groupToken(c),
			}),
		)
	} catch (error) {
		return crash(c, 'remove a group order dish', org.orgId, error)
	}
})

// POST /orders/group/:groupId/done: "I'm done", or taking it back.
groupOrderRoutes.post('/:groupId/done', async (c) => {
	const body = await readBody(c)
	if ('error' in body) return body.error
	const org = await organizationOf(c, body.identity)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	const parsed = z.strictObject({ done: z.boolean() }).safeParse(body.rest)
	if (!parsed.success) return invalid(c)
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupWriteGroup',
			address: 'groupWriteAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await setGroupDone(org.orgId, groupId, {
				token: groupToken(c),
				done: parsed.data.done,
			}),
		)
	} catch (error) {
		return crash(c, 'mark a group order person done', org.orgId, error)
	}
})

// PATCH /orders/group/:groupId: the host's deadline, limits and lock.
groupOrderRoutes.patch('/:groupId', async (c) => {
	const body = await readBody(c)
	if ('error' in body) return body.error
	const org = await organizationOf(c, body.identity)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	const parsed = updateGroupSchema.safeParse(body.rest)
	if (!parsed.success) return invalid(c)
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupWriteGroup',
			address: 'groupWriteAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await updateGroup(org.orgId, groupId, {
				token: groupToken(c),
				request: parsed.data,
			}),
		)
	} catch (error) {
		return crash(c, 'change a group order', org.orgId, error)
	}
})

// DELETE /orders/group/:groupId/people/me: a friend leaves.
groupOrderRoutes.delete('/:groupId/people/me', async (c) => {
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	const org = await organizationOf(c, identity.data)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupWriteGroup',
			address: 'groupWriteAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await leaveGroup(org.orgId, groupId, { token: groupToken(c) }),
		)
	} catch (error) {
		return crash(c, 'leave a group order', org.orgId, error)
	}
})

// DELETE /orders/group/:groupId: the host ends the group (it is deleted).
groupOrderRoutes.delete('/:groupId', async (c) => {
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	const org = await organizationOf(c, identity.data)
	if ('error' in org) return org.error
	const groupId = c.req.param('groupId')
	try {
		const limited = await limit(c, org.orgId, groupId, {
			group: 'groupWriteGroup',
			address: 'groupWriteAddress',
		})
		if (limited) return limited
		return answer(
			c,
			await endGroup(org.orgId, groupId, { token: groupToken(c) }),
		)
	} catch (error) {
		return crash(c, 'end a group order', org.orgId, error)
	}
})
