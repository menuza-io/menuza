import { and, db, eq, UserOrganization } from '@repo/database'
import {
	SALES_BASIS_VALUES,
	type SalesBasis,
} from '@repo/common/sales-report-facts'

export async function getReportSalesBasis(
	userId: string,
	organizationId: string,
): Promise<SalesBasis> {
	const [row] = await db
		.select({ reportSalesBasis: UserOrganization.reportSalesBasis })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)
	const value = row?.reportSalesBasis
	return (SALES_BASIS_VALUES as readonly string[]).includes(value ?? '')
		? (value as SalesBasis)
		: 'net'
}

export async function setReportSalesBasis(
	userId: string,
	organizationId: string,
	basis: SalesBasis,
): Promise<void> {
	await db
		.update(UserOrganization)
		.set({ reportSalesBasis: basis })
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
}
