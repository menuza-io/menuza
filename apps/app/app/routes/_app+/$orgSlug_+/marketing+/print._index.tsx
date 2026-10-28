import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { printCatalog } from '@repo/common/print-shop-catalog'
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
	printProductLabel,
	PRINT_STYLE_LABELS,
} from '#app/components/print/print-labels.ts'
import { printShopUi } from '#app/components/print/vertical-ui.tsx'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import { isCanvaConfigured } from '#app/utils/print/canva/env.server.ts'
import { listPrintDesigns } from '#app/utils/print/designs.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		shipping: access.features.shipping,
		canva: access.features.canva && access.canWrite && isCanvaConfigured(),
		designs: await listPrintDesigns(access.organization.id),
	}
}

export default function PrintShopIndexRoute() {
	const { _ } = useLingui()
	const { orgSlug, canWrite, shipping, canva, designs } =
		useLoaderData<typeof loader>()
	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Print shop`)}
				description={
					shipping
						? _(
								printShopUi.copy?.introWithShipping ??
									msg`Design branded posters, flyers and signs. Download a print-ready PDF for free, or have them printed and shipped.`,
							)
						: _(
								printShopUi.copy?.intro ??
									msg`Design branded posters, flyers and signs, and download a print-ready PDF for free.`,
							)
				}
				actions={
					<div className="flex flex-wrap gap-2">
						{shipping ? (
							<Button
								variant="outline"
								render={<Link to={`/${orgSlug}/marketing/print/orders`} />}
							>
								{_(msg`Print orders`)}
							</Button>
						) : null}
						{canva ? (
							<Button
								variant="outline"
								render={<Link to={`/${orgSlug}/marketing/print/canva`} />}
							>
								{_(msg`Import from Canva`)}
							</Button>
						) : null}
						{canWrite ? (
							<Button
								render={<Link to={`/${orgSlug}/marketing/print/new`} />}
								className="shrink-0 gap-2"
							>
								<Icon name="plus" className="size-4" />
								{_(msg`New print`)}
							</Button>
						) : null}
					</div>
				}
			/>
			{designs.length === 0 ? (
				<EmptyState
					title={_(msg`No prints yet`)}
					description={_(
						printShopUi.copy?.empty ??
							msg`Start with a poster for your door or window.`,
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
						const size = printCatalog.getSize(design.product, design.sizeKey)
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
										{_(printProductLabel(design.product).name)}
										{' · '}
										<bdi>{size?.label ?? design.sizeKey}</bdi>
										{' · '}
										{design.source === 'artwork'
											? _(msg`From Canva`)
											: _(PRINT_STYLE_LABELS[design.style])}
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
