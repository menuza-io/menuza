import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	foldQrOrderingFeatures,
	QR_ORDERING_FLAG_KEYS,
	type QrTableView,
} from '@repo/common/qr-ordering'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/**
 * Table codes for printing. The table token lives only in the regional
 * tenant-api (HMAC of its secret), so the App server asks for it with a
 * short-lived writer token it never hands to the browser. Labels and tokens
 * carry no guest data. Table cards need QR dine-in on for the org.
 */

export async function isQrDineInOn(organizationId: string) {
	const [enabled, dineIn] = await Promise.all([
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.dineIn, { organizationId }),
	])
	return foldQrOrderingFeatures({ enabled, dineIn }).dineIn
}

export type PrintTable = QrTableView & { token: string }

export async function fetchQrTablesForPrint(
	request: Request,
	orgSlug: string,
	tableIds?: string[],
): Promise<PrintTable[]> {
	const client = await getOperatorTenantClient(request, orgSlug, {
		scope: 'qr:write',
		expiresIn: '5m',
	})
	if (!(await isQrDineInOn(client.orgId))) return []
	const response = await client.fetchTenant('/operator/qr/tables')
	if (!response.ok) {
		throw new Response('Tables are unavailable right now', { status: 503 })
	}
	const body = (await response.json()) as { tables?: QrTableView[] }
	const tables = (body.tables ?? []).filter(
		(table): table is PrintTable =>
			typeof table.token === 'string' && table.archivedAt === null,
	)
	if (!tableIds) return tables
	const wanted = new Set(tableIds)
	return tables.filter((table) => wanted.has(table.id))
}
