import { and, db, Discount, eq, ne } from '@repo/database'

/**
 * The discounts (#415) that are limited to a saved audience. An audience in
 * use is not deleted: removing it would leave those discounts with nobody to
 * give them to. The control plane keeps only the audience's id, so the check
 * reads it here; archived discounts do not apply and do not hold an audience.
 * Names and ids only.
 */
export async function discountsUsingAudience(
	organizationId: string,
	audienceId: string,
	limit = 5,
): Promise<Array<{ id: string; name: string }>> {
	return db
		.select({ id: Discount.id, name: Discount.name })
		.from(Discount)
		.where(
			and(
				eq(Discount.organizationId, organizationId),
				eq(Discount.audienceId, audienceId),
				ne(Discount.status, 'archived'),
			),
		)
		.limit(limit)
}
