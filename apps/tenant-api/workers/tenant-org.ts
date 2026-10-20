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
	armStaffAlarm,
	handleStaffAlarm,
	isStaffActivityPath,
} from '../src/lib/staff-alarm.ts'
import { runStaffTickForOrg } from '../src/services/staff-tick-service.ts'
import type { TenantApiWorkerEnv } from './bindings.ts'

export const TENANT_ORG_HEADER = 'X-Epic-Tenant-Org-Id'

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
		await this.maybeArmStaffAlarm(request, response, orgId)
		return response
	}

	/**
	 * Arms the sub-hourly staff tick (see `src/lib/staff-alarm.ts`) when a
	 * successful request shows the organization is using the staff features, or
	 * when the hourly tick reports something still worth watching. Never throws:
	 * a failure here must not fail the request it rode on.
	 */
	private async maybeArmStaffAlarm(
		request: Request,
		response: Response,
		orgId: string,
	) {
		try {
			if (response.status >= 400) return
			const { pathname } = new URL(request.url)
			if (pathname === '/api/staff/tick') {
				const body = (await response
					.clone()
					.json()
					.catch(() => null)) as {
					result?: { needsFollowUp?: boolean }
				} | null
				if (!body?.result?.needsFollowUp) return
			} else if (!isStaffActivityPath(pathname)) {
				return
			}
			await armStaffAlarm(this.ctx.storage, orgId, Date.now())
		} catch (error) {
			console.error(
				'Staff alarm arming failed',
				error instanceof Error ? error.name : 'unknown',
			)
		}
	}

	/** The sub-hourly staff tick: runs next to the data, then re-arms if needed. */
	async alarm() {
		applyVarlockEnv(this.env)
		await handleStaffAlarm({
			storage: this.ctx.storage,
			now: Date.now(),
			runTick: async (orgId) => {
				this.orgId = orgId
				const db = await this.ensureDb()
				return this.withTenantDb(orgId, db, () => runStaffTickForOrg(orgId))
			},
		})
	}
}
