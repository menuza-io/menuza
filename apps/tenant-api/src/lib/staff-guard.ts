import { type Context } from 'hono'
import { type StaffingPermission, type StaffingScope } from '@repo/staffing'
import { getTenantDb, type TenantDatabase } from '@repo/tenant-db'
import { describeStaffError, hashClientIp } from '../services/staff-audit.ts'
import {
	authenticateStaffOperator,
	type ScopeAccess,
	requireGrant,
	requireWriteGrant,
	type StaffAuth,
	scopeToScopes,
	staffError,
} from './staff-auth.ts'

/**
 * The shared wrapper of the staffing operator routes: authenticate the
 * staffing token for one scope, check the grants the route needs, refuse
 * writes from impersonated sessions, open the organization's database, and
 * turn an unexpected failure into a log-safe 500 (a Drizzle error message
 * quotes every bound value, so it is never logged or returned).
 */
export type StaffRequirement = {
	/** Every grant in the list must be held (a stronger grant satisfies a read). */
	all: StaffingPermission[]
	/** The route changes data: `update:`/`create:` grants need the write check. */
	write?: boolean
}

export type StaffRouteContext = {
	db: TenantDatabase
	auth: StaffAuth
	scope: ScopeAccess
	ipHash: string | null
}

export type StaffRouteHandler = (
	ctx: StaffRouteContext,
	c: Context,
) => Promise<Response>

export function staffGuard(
	tokenScope: StaffingScope,
	label: string,
	requirement: StaffRequirement,
	handler: StaffRouteHandler,
) {
	return async (c: Context) => {
		const authed = await authenticateStaffOperator(c, tokenScope)
		if ('error' in authed) return authed.error
		const { auth } = authed

		for (const permission of requirement.all) {
			// Approving is a decision, not an edit: it is checked as a plain grant
			// (impersonated tokens never carry it) and the write refusal below
			// still applies.
			const denied =
				requirement.write &&
				(permission.startsWith('update:') || permission.startsWith('create:'))
					? requireWriteGrant(auth, permission)
					: requireGrant(auth, permission)
			if (denied) return denied
		}
		if (requirement.write && auth.impersonated) {
			return staffError(403, 'Impersonated sessions are read-only')
		}

		let db: TenantDatabase
		try {
			db = await getTenantDb(auth.orgId)
		} catch (error) {
			console.error(
				`${label}: tenant database unavailable`,
				describeStaffError(error),
			)
			return staffError(500, 'Tenant Database unavailable')
		}
		const ctx: StaffRouteContext = {
			db,
			auth,
			scope: scopeToScopes(auth),
			ipHash: hashClientIp(c),
		}
		try {
			return await handler(ctx, c)
		} catch (error) {
			console.error(
				`${label} route failed (${c.req.method} ${c.req.routePath})`,
				describeStaffError(error),
			)
			return staffError(500, 'Internal Server Error')
		}
	}
}
