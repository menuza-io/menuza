import { DurableObject } from 'cloudflare:workers'
import {
	drizzle,
	type DrizzleSqliteDODatabase,
} from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import {
	schema,
	registerTenantDb,
	registerTenantDbTransactionRunner,
	runInTenantOrgScope,
	unregisterTenantDb,
	TENANT_ORG_ID_PATTERN,
	type TenantDatabase,
} from '@repo/tenant-db'
import { durableSqliteMigrations } from './migrations.generated.ts'
import { createTenantApiApp } from '../src/app.ts'
import { applyVarlockEnv } from '../src/lib/secrets.ts'
import {
	armForRequest,
	armOrgAlarm,
	handleOrgAlarm,
	ORG_ALARM_MAX_DELAY_MS,
	readAlarmOrgId,
	registerOrgTickModule,
} from '../src/lib/org-alarm.ts'
import { createLoyaltyTickModule } from '../src/lib/loyalty-alarm.ts'
import { createReservationsTickModule } from '../src/lib/reservations-alarm.ts'
import { createStaffTickModule } from '../src/lib/staff-alarm.ts'
import { runLoyaltyTickForOrg } from '../src/services/loyalty-tick-service.ts'
import { runReservationsTickForOrg } from '../src/services/rsv-tick-service.ts'
import {
	nextBroadcastWakeAt,
	startBroadcastTickForOrg,
} from '../src/services/broadcast-dispatch.ts'
import { runStaffTickForOrg } from '../src/services/staff-tick-service.ts'
import type { TenantApiWorkerEnv } from './bindings.ts'

export const TENANT_ORG_HEADER = 'X-Epic-Tenant-Org-Id'

registerOrgTickModule(
	createStaffTickModule((orgId) => runStaffTickForOrg(orgId)),
)
registerOrgTickModule(
	createReservationsTickModule((orgId, now) =>
		runReservationsTickForOrg(orgId, { deps: { now: () => now } }),
	),
)
registerOrgTickModule(
	createLoyaltyTickModule((orgId, now) => runLoyaltyTickForOrg(orgId, { now })),
)

/**
 * Written by `deprovision()` after the wipe and cleared only by `provision()`.
 * Without it, any later request (a queued event, a stale browser token, the
 * staff alarm) would run the migrations again and quietly rebuild an empty
 * database for an organization that was deleted or moved to another region.
 */
export const DEPROVISIONED_TOMBSTONE_KEY = 'tenant:deprovisioned'

export class TenantDbDeprovisionedError extends Error {
	constructor() {
		super('Tenant database is deprovisioned')
		this.name = 'TenantDbDeprovisionedError'
	}
}

export class TenantOrg extends DurableObject<TenantApiWorkerEnv> {
	private db: DrizzleSqliteDODatabase<typeof schema> | null = null
	private readonly app = createTenantApiApp()
	private orgId: string | null = null

	private getOrgId() {
		if (!this.orgId) {
			throw new Error('TenantOrg orgId is not set')
		}
		return this.orgId
	}

	private async ensureDb() {
		if (this.db) return this.db
		if (await this.ctx.storage.get(DEPROVISIONED_TOMBSTONE_KEY)) {
			throw new TenantDbDeprovisionedError()
		}

		const db = drizzle(this.ctx.storage, { schema })
		// Drizzle's `db.transaction` is `transactionSync` here and does not await
		// async callbacks, so multi-step writes use the async storage transaction.
		registerTenantDbTransactionRunner(db, (fn) =>
			this.ctx.storage.transaction(fn),
		)
		this.db = db
		await migrate(this.db, durableSqliteMigrations)
		return this.db
	}

	async provision() {
		await this.ctx.storage.delete(DEPROVISIONED_TOMBSTONE_KEY)
		await this.ensureDb()
	}

	async deprovision() {
		// `deleteAll` leaves a pending alarm in place, and a woken object would
		// then tick against a database that no longer exists.
		await this.ctx.storage.deleteAlarm()
		await this.ctx.storage.deleteAll()
		await this.ctx.storage.put(DEPROVISIONED_TOMBSTONE_KEY, Date.now())
		if (this.orgId && this.db) {
			unregisterTenantDb(this.orgId, this.db as unknown as TenantDatabase)
		}
		this.db = null
	}

	/**
	 * Registers this object's database for its org so `getTenantDb(orgId)`
	 * resolves it. The registration is per org and outlives the request, so
	 * work queued after the response (message delivery, journey emission)
	 * still finds the database, and other objects in the same isolate never
	 * see or clear it.
	 */
	private useTenantDb<T>(
		orgId: string,
		db: DrizzleSqliteDODatabase<typeof schema>,
		fn: () => Promise<T>,
	): Promise<T> {
		registerTenantDb(orgId, db as unknown as TenantDatabase)
		return runInTenantOrgScope(orgId, fn)
	}

	async fetch(request: Request): Promise<Response> {
		applyVarlockEnv(this.env)

		const orgId = request.headers.get(TENANT_ORG_HEADER)
		if (!orgId || !TENANT_ORG_ID_PATTERN.test(orgId)) {
			return Response.json(
				{ error: 'Invalid tenant org routing' },
				{ status: 400 },
			)
		}
		this.orgId = orgId

		let db: DrizzleSqliteDODatabase<typeof schema>
		try {
			db = await this.ensureDb()
		} catch (error) {
			if (error instanceof TenantDbDeprovisionedError) {
				return Response.json({ error: 'org_not_provisioned' }, { status: 404 })
			}
			throw error
		}
		const response = await this.useTenantDb(orgId, db, async () =>
			this.app.fetch(request, this.env),
		)
		await this.maybeArmAlarm(request, response, orgId, db)
		return response
	}

	/**
	 * Arms the shared sub-hourly alarm (see `src/lib/org-alarm.ts`) when a
	 * successful request shows the organization is using a module that wants
	 * sub-hourly timing, or when a module's own tick reports something still
	 * worth watching. Never throws: a failure here must not fail the request it
	 * rode on.
	 * A new campaign or the hourly staff tick also arms it for the next
	 * broadcast work (a scheduled send, or resuming a throttled one) when that
	 * is within the alarm's reach, so it does not wait for the next hourly cron.
	 */
	private async maybeArmAlarm(
		request: Request,
		response: Response,
		orgId: string,
		db: DrizzleSqliteDODatabase<typeof schema>,
	) {
		try {
			if (response.status >= 400) return
			const { pathname } = new URL(request.url)
			const isTick =
				pathname === '/api/staff/tick' ||
				pathname === '/api/reservations/tick' ||
				pathname === '/api/loyalty/tick'
			const body = isTick
				? ((await response
						.clone()
						.json()
						.catch(() => null)) as {
						result?: { needsFollowUp?: boolean; nextDueAt?: number | null }
					} | null)
				: null
			await armForRequest({
				storage: this.ctx.storage,
				orgId,
				now: Date.now(),
				pathname,
				tickResult: body?.result ?? null,
			})
			if (
				pathname === '/api/staff/tick' ||
				(request.method === 'POST' &&
					pathname === '/operator/marketing/campaigns')
			) {
				await this.armForBroadcasts(
					orgId,
					await nextBroadcastWakeAt(
						db as unknown as TenantDatabase,
						Date.now(),
					),
				)
			}
		} catch (error) {
			console.error(
				'Org alarm arming failed',
				error instanceof Error ? error.name : 'unknown',
			)
		}
	}

	/**
	 * The sub-hourly tick: claims due broadcasts first (they send after the
	 * alarm returns, so a large one does not hold the module ticks), runs every
	 * registered module, then re-arms for the earliest follow-up, including the
	 * next broadcast work.
	 */
	async alarm() {
		applyVarlockEnv(this.env)
		const storage = this.ctx.storage
		const orgId = await readAlarmOrgId(storage)
		if (!orgId) return
		this.orgId = orgId
		// A deprovisioned object has no alarm left; if one fires anyway it
		// fails here instead of rebuilding the database.
		const db = await this.ensureDb()
		await this.useTenantDb(orgId, db, async () => {
			// Never throws, so a broadcast failure cannot stop the module ticks.
			const broadcasts = await startBroadcastTickForOrg(orgId, {
				runDetached: (task) => this.ctx.waitUntil(task),
			})
			await handleOrgAlarm({ storage, now: Date.now() })
			await this.armForBroadcasts(orgId, broadcasts?.nextAt ?? null)
		})
	}

	/**
	 * Arms the alarm for broadcast work due within the alarm's reach (an hour).
	 * Work further out is armed by a later hourly staff tick, so a campaign
	 * scheduled for next week does not wake the object every hour until then.
	 */
	private async armForBroadcasts(orgId: string, nextAt: number | null) {
		const now = Date.now()
		if (nextAt === null || nextAt > now + ORG_ALARM_MAX_DELAY_MS) return
		await armOrgAlarm(this.ctx.storage, orgId, now, nextAt)
	}
}
