import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import { CuisinePriceFields } from '#app/components/seo/cuisine-price-fields.tsx'

/** Settings, Organization: what the restaurant serves and costs (#182). */
export function CuisinePriceCard({
	organization,
}: {
	organization: {
		cuisines: string[]
		priceRange: number | null
		currency: string
	}
}) {
	const { i18n } = useLingui()
	const fetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const [cuisines, setCuisines] = useState(organization.cuisines)
	const [priceRange, setPriceRange] = useState(
		organization.priceRange ? String(organization.priceRange) : '',
	)
	return (
		<fetcher.Form method="POST">
			<input type="hidden" name="intent" value="update-cuisine" />
			<Card data-testid="cuisine-price-card">
				<CardHeader className="pb-3">
					<CardTitle className="text-base">
						<Trans>Cuisine and price range</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Shown to search engines and AI assistants on your website. Each
							location can override them.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4 pt-0">
					<CuisinePriceFields
						cuisines={cuisines}
						onCuisinesChange={setCuisines}
						priceRange={priceRange}
						onPriceRangeChange={setPriceRange}
						currency={organization.currency}
						locale={i18n.locale}
					/>
					{fetcher.data?.error ? (
						<p role="alert" className="text-destructive text-sm">
							{fetcher.data.error}
						</p>
					) : null}
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Save</Trans>
					</Button>
				</CardContent>
			</Card>
		</fetcher.Form>
	)
}
