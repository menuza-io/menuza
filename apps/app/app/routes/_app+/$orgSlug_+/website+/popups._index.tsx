import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { parseLocalizedString, pickLocalized } from '@repo/common/site-locales'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Link, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { listPopups, popupsEnabled } from '#app/utils/popups/popups.server.ts'

/**
 * Website, Popups (#132): promotional popups, optionally linked to a coupon.
 * Behind the `website.popups` flag (404 while off). This is not the
 * announcement banner and not an A/B test.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		siteDefaultLocale: true,
	})
	if (!(await popupsEnabled(organization.id))) {
		throw new Response('Not found', { status: 404 })
	}
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const popups = await listPopups(organization.id)
	return {
		popups: popups.map((popup) => ({
			id: popup.id,
			name: popup.name,
			title: pickLocalized(
				parseLocalizedString(popup.title, defaultLocale),
				defaultLocale,
				defaultLocale,
			),
			status: popup.status,
			trigger: popup.trigger,
			hasCoupon: Boolean(popup.discountId),
			pages: popup.pages,
			updatedAt: popup.updatedAt.toISOString(),
		})),
	}
}

export default function WebsitePopupsRoute() {
	const { popups } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-muted-foreground max-w-xl text-sm">
					<Trans>
						Show a message to visitors after a delay, when they scroll, or when
						they are about to leave. Link it to a coupon so the button fills it
						in at the cart.
					</Trans>
				</p>
				<Button render={<Link to="new" />}>
					<Icon name="plus" className="size-4" />
					<Trans>New popup</Trans>
				</Button>
			</div>
			{popups.length === 0 ? (
				<EmptyState
					title={<Trans>No popups yet</Trans>}
					description={
						<Trans>
							A “10% off your first online order” popup is the usual start.
						</Trans>
					}
				/>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Popup</Trans>
							</TableHead>
							<TableHead>
								<Trans>When</Trans>
							</TableHead>
							<TableHead>
								<Trans>Status</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{popups.map((popup) => (
							<TableRow key={popup.id}>
								<TableCell>
									<Link
										to={popup.id}
										className="hover:text-primary font-medium"
									>
										{popup.name}
									</Link>
									<p className="text-muted-foreground text-xs">{popup.title}</p>
								</TableCell>
								<TableCell className="text-muted-foreground text-sm">
									{popup.trigger === 'delay'
										? _(t`After a delay`)
										: popup.trigger === 'scroll'
											? _(t`On scroll`)
											: _(t`On exit (desktop)`)}
									{popup.hasCoupon ? (
										<Badge variant="outline" className="ms-2">
											<Icon name="tag" className="size-3" />
											<Trans>Coupon</Trans>
										</Badge>
									) : null}
								</TableCell>
								<TableCell>
									<Badge
										variant={
											popup.status === 'published' ? 'default' : 'outline'
										}
									>
										{popup.status === 'published' ? (
											<Trans>Published</Trans>
										) : (
											<Trans>Draft</Trans>
										)}
									</Badge>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	)
}
