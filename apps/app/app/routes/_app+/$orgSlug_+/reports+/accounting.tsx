import {
	createForbiddenResponse,
	requireUserId,
	userHasOrganizationPermission,
} from '@repo/auth'
import { ACCOUNTING_LAYOUTS, type AccountingLayout } from '@repo/reports'
import { localDateKey } from '@repo/reports/schedule'
import { data, useLoaderData } from 'react-router'
import { z } from 'zod'
import { AccountingScreen } from '#app/components/reports/accounting-screen.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	fetchRegionalAccountingDays,
	isAccountingEnabled,
	loadAccountMapping,
	loadAccountingSettings,
	loadProviderAccountingDays,
	mergeAccountingDays,
	prepareAccountingExport,
	saveAccountMapping,
	saveAccountingSettings,
} from '#app/utils/reports/accounting.server.ts'
import { defaultReportingTimeZone } from '#app/utils/reports/schedules.server.ts'
import { resolveReportTokenGrants } from '#app/utils/reports/token-grants.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/accounting.ts'

async function requireAccounting(
	request: Request,
	orgSlug: string | undefined,
) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		name: true,
		slug: true,
		dataRegion: true,
		hasProvisionedDb: true,
		shopPaymentProvider: true,
		stripeConnectAccountId: true,
		checkoutSubEntityId: true,
	})
	// Flag off: the page does not exist.
	if (!(await isAccountingEnabled(organization.id))) {
		throw new Response('Not Found', { status: 404 })
	}
	const grants = await resolveReportTokenGrants({
		request,
		userId,
		organizationId: organization.id,
	})
	if (!grants.subjects.includes('accounting_daily')) {
		throw createForbiddenResponse(ORG_PERMISSIONS.READ_ANALYTICS_ANY)
	}
	const canReadPayments = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.READ_PAYMENTS_ANY,
	)
	return { userId, organization, grants, canReadPayments }
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const { organization, canReadPayments } = await requireAccounting(
		request,
		params.orgSlug,
	)
	const [mapping, settings, timeZone] = await Promise.all([
		loadAccountMapping(organization.id),
		loadAccountingSettings(organization.id),
		defaultReportingTimeZone(organization.id),
	])
	const today = localDateKey(new Date(), timeZone)
	const shift = (days: number) => {
		const d = new Date(`${today}T00:00:00Z`)
		d.setUTCDate(d.getUTCDate() + days)
		return d.toISOString().slice(0, 10)
	}
	return data({
		orgSlug: organization.slug,
		mapping,
		settings,
		timeZone,
		canReadPayments,
		defaultFrom: shift(-7),
		defaultTo: shift(-1),
		tokenUrl: `/${organization.slug}/reports/token`,
		tenantApiUrl: organization.hasProvisionedDb
			? resolveRegionalTenantApiUrls(organization.dataRegion).tenantApiUrl
			: '',
	})
}

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const rangeSchema = z.object({ from: dateField, to: dateField })
const layoutSchema = z.enum(ACCOUNTING_LAYOUTS)

export async function action({ request, params }: Route.ActionArgs) {
	const { userId, organization, grants, canReadPayments } =
		await requireAccounting(request, params.orgSlug)
	const body = (await request.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	const intent = typeof body?.intent === 'string' ? body.intent : ''
	const timeZone = await defaultReportingTimeZone(organization.id)

	if (intent === 'provider' || intent === 'export') {
		const range = rangeSchema.safeParse(body)
		const span = range.success
			? (Date.parse(range.data.to) - Date.parse(range.data.from)) / 86_400_000
			: NaN
		if (!range.success || !(span >= 0) || span + 1 > 62) {
			return data({ ok: false, error: 'invalid_range' }, { status: 400 })
		}
		// The payout line needs the payments grant; without it the journal has none.
		const provider = canReadPayments
			? await loadProviderAccountingDays({
					org: organization,
					...range.data,
					timeZone,
				}).catch(() => [])
			: []
		if (intent === 'provider') {
			return data({ ok: true, provider, payoutsHidden: !canReadPayments })
		}
		const layout = layoutSchema.safeParse(body?.layout)
		if (!layout.success) {
			return data({ ok: false, error: 'invalid_layout' }, { status: 400 })
		}
		let regional
		try {
			regional = await fetchRegionalAccountingDays({
				org: organization,
				...range.data,
				locationIds: grants.locationIds ?? [],
			})
		} catch {
			return data({ ok: false, error: 'region_unavailable' }, { status: 502 })
		}
		const prepared = await prepareAccountingExport({
			organizationId: organization.id,
			userId,
			days: mergeAccountingDays(regional, provider),
			mapping: await loadAccountMapping(organization.id),
			layout: layout.data,
			record: true,
		})
		await saveAccountingSettings(organization.id, {
			...(await loadAccountingSettings(organization.id)),
			layout: layout.data,
		})
		return data({
			ok: true,
			csv: prepared.csv,
			filename: `journal-${range.data.from}-${range.data.to}.csv`,
			unchanged: prepared.unchanged,
			adjustments: prepared.adjustments,
			provisional: prepared.provisional,
			outOfBalance: prepared.outOfBalance,
			entries: prepared.entries.length,
		})
	}

	// Mapping and the bookkeeper email change what leaves the company: settings access.
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	if (intent === 'save-mapping') {
		const parsed = z
			.object({
				rows: z
					.array(
						z.object({
							lineKey: z.string().max(80),
							accountCode: z.string().max(40),
							accountName: z.string().max(120),
						}),
					)
					.max(200),
			})
			.safeParse(body)
		if (!parsed.success)
			return data({ ok: false, error: 'invalid' }, { status: 400 })
		await saveAccountMapping(organization.id, parsed.data.rows)
		return data({ ok: true })
	}
	if (intent === 'save-settings') {
		const parsed = z
			.object({
				layout: layoutSchema,
				bookkeeperEmail: z
					.string()
					.trim()
					.max(254)
					.email()
					.nullable()
					.or(z.literal('')),
				weeklyEmail: z.boolean(),
			})
			.safeParse(body)
		if (!parsed.success)
			return data({ ok: false, error: 'invalid_email' }, { status: 400 })
		const email = parsed.data.bookkeeperEmail || null
		await saveAccountingSettings(organization.id, {
			layout: parsed.data.layout as AccountingLayout,
			bookkeeperEmail: email,
			// A weekly email needs somewhere to go.
			weeklyEmail: parsed.data.weeklyEmail && email !== null,
		})
		return data({ ok: true })
	}
	return data({ ok: false, error: 'invalid_request' }, { status: 400 })
}

export default function AccountingRoute() {
	return <AccountingScreen {...useLoaderData<typeof loader>()} />
}
