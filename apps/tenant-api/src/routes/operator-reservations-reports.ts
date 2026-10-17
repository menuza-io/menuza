import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { z } from 'zod'
import { handleRouteError, json, readQuery } from '../lib/http.ts'
import { requireReservationsLocation } from '../lib/reservations-auth.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import { getLocationBusinessDate } from '../services/rsv-business-date.ts'
import {
	auditReportRun,
	buildReport,
	listReportServices,
	REPORT_KINDS,
	REPORT_MAX_DAYS,
	rangeDays,
	type ReportKind,
} from '../services/rsv-report-service.ts'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const reportQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	from: z.string().regex(DATE_RE).optional(),
	to: z.string().regex(DATE_RE).optional(),
	serviceId: z.string().trim().min(1).max(128).optional(),
})

export const operatorReservationsReportsRoutes = new Hono()

for (const kind of REPORT_KINDS) {
	operatorReservationsReportsRoutes.get(
		`/${kind}`,
		rsvGuard({
			scope: 'reports',
			grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT,
		}),
		async (c) => {
			const ctx = getRsvAuth(c)
			const orgErr = await ensureActiveOrgInNodeRegion(ctx)
			if (orgErr) return orgErr

			const query = readQuery(c, reportQuerySchema)
			if ('error' in query) return query.error

			const location = requireReservationsLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response

			try {
				const db = await getTenantDb(ctx.orgId)
				const now = Date.now()
				const today = await getLocationBusinessDate(
					db,
					location.locationId,
					now,
				)
				const to = query.data.to ?? query.data.from ?? today
				const from = query.data.from ?? to
				if (from > to) {
					return json(
						{
							error: 'invalid_range',
							message: '`from` must be on or before `to`',
						},
						400,
					)
				}
				if (rangeDays(from, to) > REPORT_MAX_DAYS) {
					return json(
						{
							error: 'range_too_long',
							message: `A report covers at most ${REPORT_MAX_DAYS} days`,
						},
						400,
					)
				}
				const range = {
					locationId: location.locationId,
					from,
					to,
					serviceId: query.data.serviceId ?? null,
				}
				await auditReportRun(db, {
					actorId: ctx.userId,
					kind: kind as ReportKind,
					range,
					now,
				})
				const [report, services] = await Promise.all([
					buildReport(db, kind as ReportKind, range),
					listReportServices(db, location.locationId),
				])
				return json({
					ok: true,
					orgId: ctx.orgId,
					report: kind,
					range,
					services,
					...report,
				})
			} catch (error) {
				return handleRouteError(error)
			}
		},
	)
}
