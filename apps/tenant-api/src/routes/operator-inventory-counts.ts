import {
	approveCountSchema,
	countEntriesSchema,
	countPresenceSchema,
	createCountScheduleSchema,
	INVENTORY_PERMISSIONS,
	listCountRunsQuerySchema,
	listCountSchedulesQuerySchema,
	listCountsQuerySchema,
	resolveLateEntrySchema,
	settleSecondCheckSchema,
	skipSecondCheckSchema,
	startCountSchema,
	updateCountScheduleSchema,
	versionOnlySchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryDeny, inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	APPROVE_EXTRA_GRANT,
	clientIdempotency,
	idParam,
	inventoryCaller,
	respond,
	parseBody,
	parseQuery,
} from '../lib/inventory-route.ts'
import {
	archiveCountSchedule,
	createCountSchedule,
	listCountRuns,
	listCountSchedules,
	updateCountSchedule,
} from '../services/inventory-count-schedules-service.ts'
import {
	listLateEntries,
	resolveLateEntry,
} from '../services/inventory-count-late.ts'
import { locationBusinessDate } from '../services/inventory-common.ts'
import {
	addCountEntries,
	approveCount,
	finishSecondCheck,
	getCountReview,
	getCountSheet,
	getSecondCheck,
	listCounts,
	reportCountPresence,
	settleSecondCheck,
	skipSecondCheck,
	startCount,
	transitionCount,
} from '../services/inventory-counts-service.ts'

/**
 * Stock counts under `/operator/inventory`: start, the counting sheet,
 * entries from several people, send for review, review and approve. A count
 * belongs to one location; the location of a count addressed by id is checked
 * against the token inside the service.
 */
export const operatorInventoryCountsRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ })
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE })

operatorInventoryCountsRoutes.post('/counts', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, startCountSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await startCount(inventoryCaller(ctx), {
				...body.data,
				idempotency: clientIdempotency(
					ctx,
					'counts:start',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.get('/counts', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listCountsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await listCounts(await getTenantDb(ctx.orgId), {
				query: query.data,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.get('/counts/:id', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getCountSheet(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.post(
	'/counts/:id/entries',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, countEntriesSchema)
			if ('error' in body) return body.error
			const { device, ...rest } = body.data
			return respond(
				ctx,
				await addCountEntries(
					inventoryCaller(ctx),
					{ id, body: rest },
					device
						? {
								device: {
									id: device.id,
									name: device.name,
									kind: device.kind ?? 'app',
									unsent: device.unsent,
									done: device.done,
								},
							}
						: {},
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

for (const action of ['send', 'reopen', 'cancel'] as const) {
	operatorInventoryCountsRoutes.post(
		`/counts/:id/${action}`,
		writes(),
		async (c) => {
			try {
				const ctx = getInventoryAuth(c)
				const id = idParam(c)
				const body = await parseBody(c, versionOnlySchema)
				if ('error' in body) return body.error
				return respond(
					ctx,
					await transitionCount(inventoryCaller(ctx), {
						id,
						expectedVersion: body.data.expectedVersion,
						action,
					}),
				)
			} catch (error) {
				return inventoryErrorResponse(error)
			}
		},
	)
}

operatorInventoryCountsRoutes.get('/counts/:id/review', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getCountReview(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.post(
	'/counts/:id/approve',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			// Approving posts adjustments in money: it also needs the cost grant.
			const caller = inventoryCaller(ctx)
			if (!caller.cost) {
				return inventoryDeny(403, 'forbidden', {
					reason: 'grant',
					required: APPROVE_EXTRA_GRANT,
				})
			}
			const id = idParam(c)
			const body = await parseBody(c, approveCountSchema)
			if ('error' in body) return body.error
			return respond(ctx, await approveCount(caller, { id, body: body.data }))
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// ── Devices, late entries and the second check (#474, #525) ─────────────────

operatorInventoryCountsRoutes.post(
	'/counts/:id/presence',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, countPresenceSchema)
			if ('error' in body) return body.error
			const { device } = body.data
			return respond(
				ctx,
				await reportCountPresence(inventoryCaller(ctx), {
					id,
					device: {
						id: device.id,
						name: device.name,
						kind: device.kind ?? 'app',
						unsent: device.unsent,
						done: device.done,
					},
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryCountsRoutes.get(
	'/counts/:id/late-entries',
	reads(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			return respond(ctx, {
				entries: await listLateEntries(await getTenantDb(ctx.orgId), {
					countId: id,
					caller: inventoryCaller(ctx),
				}),
			})
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

for (const action of ['apply', 'dismiss'] as const) {
	operatorInventoryCountsRoutes.post(
		`/counts/:id/late-entries/:entryId/${action}`,
		writes(),
		async (c) => {
			try {
				const ctx = getInventoryAuth(c)
				const caller = inventoryCaller(ctx)
				// A correction posts stock in money, like approving does.
				if (action === 'apply' && !caller.cost) {
					return inventoryDeny(403, 'forbidden', {
						reason: 'grant',
						required: APPROVE_EXTRA_GRANT,
					})
				}
				const id = idParam(c)
				const entryId = idParam(c, 'entryId')
				const body = await parseBody(c, resolveLateEntrySchema)
				if ('error' in body) return body.error
				return respond(
					ctx,
					await resolveLateEntry(caller, {
						countId: id,
						entryId,
						action,
						note: body.data.note,
						idempotency: clientIdempotency(
							ctx,
							`counts:late:${action}`,
							body.data.clientId,
							{ id, entryId, ...body.data },
						),
					}),
				)
			} catch (error) {
				return inventoryErrorResponse(error)
			}
		},
	)
}

operatorInventoryCountsRoutes.get('/counts/:id/second', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const id = idParam(c)
		return respond(
			ctx,
			await getSecondCheck(await getTenantDb(ctx.orgId), {
				id,
				caller: inventoryCaller(ctx),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.post(
	'/counts/:id/second/finish',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, versionOnlySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await finishSecondCheck(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryCountsRoutes.post(
	'/counts/:id/second/settle',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, settleSecondCheckSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await settleSecondCheck(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
					resolutions: body.data.resolutions,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryCountsRoutes.post(
	'/counts/:id/second/skip',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, skipSecondCheckSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await skipSecondCheck(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
					reason: body.data.reason,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// ── Count schedules and the weekly plan (#490, #491) ────────────────────────

operatorInventoryCountsRoutes.get('/count-schedules', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listCountSchedulesQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(ctx, {
			schedules: await listCountSchedules(
				await getTenantDb(ctx.orgId),
				location.locationId,
			),
		})
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.post('/count-schedules', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, createCountScheduleSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await createCountSchedule(inventoryCaller(ctx), {
				body: body.data,
				idempotency: clientIdempotency(
					ctx,
					'counts:schedule:create',
					body.data.clientId,
					body.data,
				),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryCountsRoutes.patch(
	'/count-schedules/:id',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, updateCountScheduleSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await updateCountSchedule(inventoryCaller(ctx), {
					id,
					body: body.data,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryCountsRoutes.post(
	'/count-schedules/:id/archive',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, versionOnlySchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await archiveCountSchedule(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryCountsRoutes.get('/count-runs', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, listCountRunsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		const db = await getTenantDb(ctx.orgId)
		const now = Date.now()
		const date =
			query.data.date ??
			(await locationBusinessDate(db, location.locationId, now))
		return respond(ctx, {
			date,
			runs: await listCountRuns(db, {
				locationId: location.locationId,
				date,
				now,
			}),
		})
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})
