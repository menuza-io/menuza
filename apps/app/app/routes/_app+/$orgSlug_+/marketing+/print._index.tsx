import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getPrintSize } from '@repo/common/print-shop'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	PRINT_PRODUCT_LABELS,
	PRINT_STYLE_LABELS,
} from '#app/components/print/print-labels.ts'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import { listPrintDesigns } from '#app/utils/print/designs.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		shipping: access.features.shipping,
		designs: await listPrintDesigns(access.organization.id),
	}
}

export default function PrintShopIndexRoute() {
	const { _ } = useLingui()
	const { orgSlug, canWrite, shipping, designs } =
		useLoaderData<typeof loader>()
	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Print shop`)}
				description={
					shipping
						? _(
								msg`Design branded table cards, posters and flyers. Download a print-ready PDF for free, or have them printed and shipped.`,
							)
						: _(
								msg`Design branded table cards, posters and flyers, and download a print-ready PDF for free.`,
							)
				}
				actions={
					canWrite ? (
						<Button
							render={<Link to={`/${orgSlug}/marketing/print/new`} />}
							className="shrink-0 gap-2"
						>
							<Icon name="plus" className="size-4" />
							{_(msg`New print`)}
						</Button>
					) : null
				}
			/>
			{designs.length === 0 ? (
				<EmptyState
					title={_(msg`No prints yet`)}
					description={_(
						msg`Start with table QR cards so guests can order from their phone.`,
					)}
					icons={['printer', 'file-text', 'download']}
					action={
						canWrite
							? {
									label: _(msg`Create a print`),
									href: `/${orgSlug}/marketing/print/new`,
								}
							: undefined
					}
				/>
			) : (
				<ItemGroup>
					{designs.map((design) => {
						const size = getPrintSize(design.product, design.sizeKey)
						return (
							<Item
								key={design.id}
								variant="outline"
								size="sm"
								render={
									<Link to={`/${orgSlug}/marketing/print/${design.id}`} />
								}
							>
								<ItemContent>
									<ItemTitle className="wrap-anywhere">{design.name}</ItemTitle>
									<ItemDescription>
										{_(PRINT_PRODUCT_LABELS[design.product].name)}
										{' · '}
										<bdi>{size?.label ?? design.sizeKey}</bdi>
										{' · '}
										{_(PRINT_STYLE_LABELS[design.style])}
									</ItemDescription>
								</ItemContent>
								<ItemActions>
									{design.status === 'approved' ? (
										<Badge variant="success">{_(msg`Approved`)}</Badge>
									) : (
										<Badge variant="secondary">{_(msg`Draft`)}</Badge>
									)}
								</ItemActions>
							</Item>
						)
					})}
				</ItemGroup>
			)}
		</div>
	)
}
