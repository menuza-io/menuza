import { INVENTORY_PERMISSIONS as P } from '@repo/inventory'
import { data, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { ensureInvoiceInboxCode } from '#app/utils/inventory/invoice-inbox.server.ts'

const querySchema = z.object({ locationId: z.string().min(1).max(100) })

/**
 * The code in a location's supplier invoice address (#503):
 * `GET /:orgSlug/inventory-invoice-address?locationId=`. Made on first use and
 * kept in the control plane, which holds nothing else about the feature: the
 * region receives and stores the mail. The page shows
 * `invoices+<code>@<domain>`, the domain coming from the region.
 *
 * Note: this GET writes the code the first time a location asks (idempotent:
 * one compare-and-set, the same code every time after). It is deliberately open
 * to a reader, because anyone who may see Purchasing may see where invoices go.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [P.READ_INVENTORY],
	})
	if (!access.features.invoiceInbox) {
		throw data({ error: 'Not found' }, { status: 404 })
	}
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		throw data({ error: 'Invalid location' }, { status: 400 })
	}
	const { locationId } = parsed.data
	if (access.locationIds !== null && !access.locationIds.includes(locationId)) {
		throw data({ error: 'Not found' }, { status: 404 })
	}
	const code = await ensureInvoiceInboxCode({
		organizationId: access.organizationId,
		locationId,
	})
	if (!code) throw data({ error: 'Not found' }, { status: 404 })
	return data({ code }, { headers: { 'Cache-Control': 'private, no-store' } })
}
