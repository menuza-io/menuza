import { DurableObject } from 'cloudflare:workers'
import {
	drizzle,
	type DrizzleSqliteDODatabase,
} from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import {
	schema,
	setTenantDbResolver,
	TENANT_ORG_ID_PATTERN,
	type TenantDatabase,
} from '@repo/tenant-db'
import { durableSqliteMigrations } from './migrations.generated.ts'
import { createTenantApiApp } from '../src/app.ts'
import { applyVarlockEnv } from '../src/lib/secrets.ts'
import {
	armForRequest,
	handleOrgAlarm,
	readAlarmOrgId,
	registerOrgTickModule,
} from '../src/lib/org-alarm.ts'
import { createReservationsTickModule } from '../src/lib/reservations-alarm.ts'
import { createStaffTickModule } from '../src/lib/staff-alarm.ts'
import { runReservationsTickForOrg } from '../src/services/rsv-tick-service.ts'
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

export class TenantOrg extends DurableObject<TenantApiWorkerEnv> {
	private db: DrizzleSqliteDODatabase<typeof schema> | null = null
	private readonly app = createTenantApiApp()
	private orgId: string | null = null
	private resolverUsers = 0

	private getOrgId() {
		if (!this.orgId) {
			throw new Error('TenantOrg orgId is not set')
		}
		return this.orgId
	}

	private async ensureDb() {
		if (this.db) return this.db

		this.db = drizzle(this.ctx.storage, { schema })
		await migrate(this.db, durableSqliteMigrations)
		return this.db
	}

	async provision() {
		await this.ensureDb()
	}

	async deprovision() {
		// `deleteAll` leaves a pending alarm in place, and a woken object would
		// then tick against a database that no longer exists.
		await this.ctx.storage.deleteAlarm()
		await this.ctx.storage.deleteAll()
		this.db = null
	}

	/**
	 * Points the tenant database resolver at this object's database for the
	 * duration of `fn`. Several requests (and the alarm) can be in flight at
	 * once, because the object yields at every await, so the resolver is
	 * reference counted: the last one out clears it, never the first.
	 */
	private async withTenantDb<T>(
		orgId: string,
		db: DrizzleSqliteDODatabase<typeof schema>,
		fn: () => Promise<T>,
	): Promise<T> {
		if (this.resolverUsers === 0) {
			setTenantDbResolver(async (requestedOrgId) => {
				if (requestedOrgId !== orgId) {
					throw new Error('Tenant DB org mismatch')
				}
				return db as unknown as TenantDatabase
			})
		}
		this.resolverUsers++
		try {
			return await fn()
		} finally {
			this.resolverUsers--
			if (this.resolverUsers === 0) setTenantDbResolver(null)
		}
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

		const db = await this.ensureDb()
		const response = await this.withTenantDb(orgId, db, async () =>
			this.app.fetch(request, this.env),
		)
		await this.maybeArmAlarm(request, response, orgId)
		return response
	}

	/**
	 * Arms the shared sub-hourly alarm (see `src/lib/org-alarm.ts`) when a
	 * successful request shows the organization is using a module that wants
	 * sub-hourly timing, or when a module's own tick reports something still
	 * worth watching. Never throws: a failure here must not fail the request it
	 * rode on.
	 */
	private async maybeArmAlarm(
		request: Request,
		response: Response,
		orgId: string,
	) {
		try {
			if (response.status >= 400) return
			const { pathname } = new URL(request.url)
			const isTick =
				pathname === '/api/staff/tick' || pathname === '/api/reservations/tick'
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
		} catch (error) {
			console.error(
				'Org alarm arming failed',
				error instanceof Error ? error.name : 'unknown',
			)
		}
	}

	/** The sub-hourly tick for every registered module, then re-arm if needed. */
	async alarm() {
		applyVarlockEnv(this.env)
		const storage = this.ctx.storage
		const orgId = await readAlarmOrgId(storage)
		if (!orgId) return
		this.orgId = orgId
		const db = await this.ensureDb()
		await this.withTenantDb(orgId, db, () =>
			handleOrgAlarm({ storage, now: Date.now() }),
		)
	}
}
