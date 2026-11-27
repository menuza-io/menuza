import { db, eq, Organization } from '@repo/database'
import { type LoaderFunctionArgs } from 'react-router'
import {
	fetchRegionalAccountingDays,
	fullJournalCsv,
	isAccountingEnabled,
	loadAccountMapping,
	loadProviderAccountingDays,
	mergeAccountingDays,
	verifyAccountingLink,
} from '#app/utils/reports/accounting.server.ts'
import { defaultReportingTimeZone } from '#app/utils/reports/schedules.server.ts'

/**
 * The bookkeeper's file (#189): the link in the weekly email carries a signed
 * token (organization, range, layout, expiry) and needs no login. It rebuilds
 * the journal as it stands now from the region's totals and the payout data,
 * records nothing and never touches the export history. Anything forged,
 * expired or for an organization that switched the export off answers 404.
 */
const NOT_FOUND = () =>
	new Response('Not found', {
		status: 404,
		headers: { 'Cache-Control': 'private, no-store' },
	})

export async function loader({ request }: LoaderFunctionArgs) {
	const token = new URL(request.url).searchParams.get('token')
	const link = token ? verifyAccountingLink(token) : null
	if (!link) return NOT_FOUND()
	const [org] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			dataRegion: Organization.dataRegion,
			shopPaymentProvider: Organization.shopPaymentProvider,
			stripeConnectAccountId: Organization.stripeConnectAccountId,
			checkoutSubEntityId: Organization.checkoutSubEntityId,
			hasProvisionedDb: Organization.hasProvisionedDb,
		})
		.from(Organization)
		.where(eq(Organization.id, link.organizationId))
		.limit(1)
	if (!org || !org.hasProvisionedDb || !(await isAccountingEnabled(org.id))) {
		return NOT_FOUND()
	}
	try {
		const timeZone = await defaultReportingTimeZone(org.id)
		const regional = await fetchRegionalAccountingDays({
			org,
			from: link.from,
			to: link.to,
		})
		const provider = await loadProviderAccountingDays({
			org,
			from: link.from,
			to: link.to,
			timeZone,
		}).catch(() => [])
		const csv = fullJournalCsv(
			mergeAccountingDays(regional, provider),
			await loadAccountMapping(org.id),
			link.layout,
		)
		return new Response(csv, {
			headers: {
				'Cache-Control': 'private, no-store',
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="journal-${link.from}-${link.to}.csv"`,
			},
		})
	} catch {
		return NOT_FOUND()
	}
}
