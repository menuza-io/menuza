import {
	SAVED_ADDRESS_LIMIT,
	createSavedAddressSchema,
	updateSavedAddressSchema,
} from '@repo/common/saved-addresses'
import { Hono, type Context } from 'hono'
import { z } from 'zod'

import {
	HttpError,
	NO_STORE,
	handleRouteError,
	readJsonBody,
} from '../lib/http.ts'
import {
	createSavedAddress,
	deleteSavedAddress,
	listSavedAddresses,
	updateSavedAddress,
} from '../services/customer-addresses-service.ts'
import { authenticateCustomer } from './auth.ts'

/**
 * The signed-in guest's saved delivery addresses (#113). Browser (or app) to
 * region with the customer token; the organization is the token's and every
 * read and write is filtered by the token's customer id, so another guest's
 * address id answers the same 404 as one that does not exist.
 *
 *   GET    /customer/addresses       the default first
 *   POST   /customer/addresses       { locationId, quoteToken, label, notes?, makeDefault? }
 *   PATCH  /customer/addresses/:id   rename, edit unit or notes, make default
 *   DELETE /customer/addresses/:id
 *
 * A saved address is never trusted for coverage or fees: checkout re-quotes it
 * with `POST /delivery/quote { addressId }`.
 */
export const customerAddressRoutes = new Hono()

type Auth = Awaited<ReturnType<typeof authenticateCustomer>>

async function authenticated(c: Context): Promise<Auth | Response> {
	try {
		return await authenticateCustomer(c)
	} catch (response) {
		if (response instanceof Response) return response
		throw response
	}
}

const idSchema = z.string().trim().min(1).max(128)
const BODY_LIMIT = 8 * 1024

customerAddressRoutes.get('/', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const addresses = await listSavedAddresses(auth.db, auth.customerId)
	return c.json({ addresses, limit: SAVED_ADDRESS_LIMIT }, 200, NO_STORE)
})

customerAddressRoutes.post('/', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const body = await readJsonBody(c, createSavedAddressSchema, {
		maxBytes: BODY_LIMIT,
	})
	if ('error' in body) return body.error
	try {
		const address = await createSavedAddress(
			auth.orgId,
			auth.db,
			auth.customerId,
			body.data,
		)
		return c.json({ address }, 201, NO_STORE)
	} catch (error) {
		return handleRouteError(error)
	}
})

customerAddressRoutes.patch('/:id', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const id = idSchema.safeParse(c.req.param('id'))
	if (!id.success) {
		return new HttpError(
			404,
			'address_not_found',
			'Address not found.',
		).toResponse()
	}
	const body = await readJsonBody(c, updateSavedAddressSchema, {
		maxBytes: BODY_LIMIT,
	})
	if ('error' in body) return body.error
	try {
		const address = await updateSavedAddress(
			auth.orgId,
			auth.db,
			auth.customerId,
			id.data,
			body.data,
		)
		return c.json({ address }, 200, NO_STORE)
	} catch (error) {
		return handleRouteError(error)
	}
})

customerAddressRoutes.delete('/:id', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const id = idSchema.safeParse(c.req.param('id'))
	if (!id.success) {
		return new HttpError(
			404,
			'address_not_found',
			'Address not found.',
		).toResponse()
	}
	try {
		await deleteSavedAddress(auth.orgId, auth.db, auth.customerId, id.data)
		return c.json({ ok: true }, 200, NO_STORE)
	} catch (error) {
		return handleRouteError(error)
	}
})
