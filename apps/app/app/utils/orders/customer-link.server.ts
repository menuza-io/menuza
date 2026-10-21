import { requirePeopleAccess } from '#app/utils/people/people-access.server.ts'

export type OrderCustomerLinkAccess = {
	/** The member may open Customers: customer profile links are shown. */
	linkCustomers: boolean
	/** The member holds a reservation guest grant: guest profile links too. */
	linkGuests: boolean
}

/**
 * What person pages the member may open from an order. Same rule as the
 * Customers screen (`requirePeopleAccess`); a member with no people access gets
 * no links, and the regional API then returns no `customerKey` at all.
 */
export async function getOrderCustomerLinkAccess(
	request: Request,
	orgSlug: string,
): Promise<OrderCustomerLinkAccess> {
	try {
		const { access } = await requirePeopleAccess(request, orgSlug)
		return {
			linkCustomers: access.customers,
			linkGuests: access.dining !== 'none',
		}
	} catch {
		return { linkCustomers: false, linkGuests: false }
	}
}
