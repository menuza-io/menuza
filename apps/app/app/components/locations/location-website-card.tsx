import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cuisineLabel } from '@repo/common/cuisines'
import { getSiteLocaleNativeLabel } from '@repo/common/site-locales'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import { CuisinePriceFields } from '#app/components/seo/cuisine-price-fields.tsx'

export type LocationWebsiteData = {
	cuisines: string[]
	priceRange: number | null
	organizationCuisines: string[]
	organizationPriceRange: number | null
	currency: string
	pageEnabled: boolean
	intro: Record<string, string>
	seoTitle: string
	seoDescription: string
	locales: string[]
}

/**
 * Settings, Locations, one location: its website page `/locations/<slug>`
 * (#137: switch, intro per language, title and description) and its cuisine
 * and price range override (#182). Saved to its own action route.
 */
export function LocationWebsiteCard({
	orgSlug,
	locationId,
	locationSlug,
	website,
}: {
	orgSlug: string
	locationId: string
	locationSlug: string
	website: LocationWebsiteData
}) {
	const { _, i18n } = useLingui()
	const action = `/${orgSlug}/settings/locations/${locationId}/website`
	const pageFetcher = useFetcher<{ ok: boolean; error?: string }>()
	const cuisineFetcher = useFetcher<{ ok: boolean; error?: string }>()
	const [enabled, setEnabled] = useState(website.pageEnabled)
	const [cuisines, setCuisines] = useState(website.cuisines)
	const [priceRange, setPriceRange] = useState(
		website.priceRange ? String(website.priceRange) : '',
	)
	const inherited = website.organizationCuisines
		.map((key) => cuisineLabel(key, i18n.locale))
		.join(', ')
	return (
		<Card data-testid="location-website-card">
			<CardHeader>
				<CardTitle className="text-base">
					<Trans>Website page</Trans>
				</CardTitle>
				<CardDescription>
					<span dir="ltr" className="font-mono text-xs">
						/locations/{locationSlug}
					</span>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-8">
				<pageFetcher.Form method="POST" action={action} className="space-y-4">
					<input type="hidden" name="intent" value="update-location-page" />
					<input type="hidden" name="pageEnabled" value={String(enabled)} />
					<div className="flex items-center gap-3">
						<Switch
							id={`page-enabled-${locationId}`}
							checked={enabled}
							onCheckedChange={setEnabled}
						/>
						<Label htmlFor={`page-enabled-${locationId}`}>
							<Trans>Show a page for this location on the website</Trans>
						</Label>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor={`seo-title-${locationId}`}>
								<Trans>Title for search engines</Trans>
							</Label>
							<Input
								id={`seo-title-${locationId}`}
								name="seoTitle"
								maxLength={120}
								defaultValue={website.seoTitle}
								placeholder={_(msg`Generated from the name, cuisine and area`)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`seo-description-${locationId}`}>
								<Trans>Description for search engines</Trans>
							</Label>
							<Input
								id={`seo-description-${locationId}`}
								name="seoDescription"
								maxLength={300}
								defaultValue={website.seoDescription}
							/>
						</div>
					</div>
					{website.locales.map((locale) => {
						const language = getSiteLocaleNativeLabel(locale)
						return (
							<div key={locale} className="space-y-1.5">
								<Label htmlFor={`intro-${locationId}-${locale}`}>
									<Trans>Introduction ({language})</Trans>
								</Label>
								<Textarea
									id={`intro-${locationId}-${locale}`}
									name={`intro.${locale}`}
									dir={locale === 'ar' ? 'rtl' : undefined}
									maxLength={2000}
									rows={3}
									defaultValue={website.intro[locale] ?? ''}
								/>
							</div>
						)
					})}
					{pageFetcher.data?.error ? (
						<p role="alert" className="text-destructive text-sm">
							{pageFetcher.data.error}
						</p>
					) : null}
					<Button
						type="submit"
						variant="outline"
						disabled={pageFetcher.state !== 'idle'}
					>
						<Trans>Save website page</Trans>
					</Button>
				</pageFetcher.Form>

				<cuisineFetcher.Form
					method="POST"
					action={action}
					className="space-y-4"
				>
					<input type="hidden" name="intent" value="update-location-cuisine" />
					<CuisinePriceFields
						cuisines={cuisines}
						onCuisinesChange={setCuisines}
						priceRange={priceRange}
						onPriceRangeChange={setPriceRange}
						currency={website.currency}
						locale={i18n.locale}
						inheritLabel={_(msg`Same as the organization`)}
					/>
					{inherited && !cuisines.length ? (
						<p className="text-muted-foreground text-xs">
							<Trans>
								No cuisines chosen: the organization's are used ({inherited}).
							</Trans>
						</p>
					) : null}
					{cuisineFetcher.data?.error ? (
						<p role="alert" className="text-destructive text-sm">
							{cuisineFetcher.data.error}
						</p>
					) : null}
					<Button
						type="submit"
						variant="outline"
						disabled={cuisineFetcher.state !== 'idle'}
					>
						<Trans>Save cuisine and price</Trans>
					</Button>
				</cuisineFetcher.Form>
			</CardContent>
		</Card>
	)
}
