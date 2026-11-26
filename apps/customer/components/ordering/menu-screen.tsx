import { useLingui } from '@lingui/react/macro'
import { type DietaryTag } from '@repo/common/menu-types'
import { menuItemSalePrice } from '@repo/discounts'
import { useEffect, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { useAppSnapshot } from '../../lib/app/use-app'
import { websitePageUrl } from '../../lib/loyalty/website-link'
import {
	dietaryTagsOnMenu,
	fetchPublishedMenu,
	filterSectionsByDiet,
	formatMenuPrice,
	isMissingCatalog,
	type MenuItemView,
	type MenuPromotionView,
	type PublishedMenu,
	presentMenu,
} from '../../lib/ordering/catalog'
import {
	bannerOffers,
	offersForItem,
	promotionsForScope,
} from '../../lib/ordering/offers'
import { openWebsitePage } from '../../lib/ordering/open-site'
import {
	Badge,
	Button,
	Chip,
	EmptyState,
	LoadingView,
	Screen,
	Text,
} from '../ui'
import { SiteCheckoutBar } from './site-checkout'

type LoadMenu = typeof fetchPublishedMenu

/**
 * The published menu, then the website's menu and checkout. Prices come from
 * the public catalog. The cart and payment stay on the website.
 */
export function MenuScreen({
	loadMenu = fetchPublishedMenu,
	openPage = openWebsitePage,
}: {
	loadMenu?: LoadMenu
	openPage?: (url: string) => void
} = {}) {
	const { t } = useLingui()
	const { configuration, organization, language } = useAppSnapshot()
	const [menu, setMenu] = useState<PublishedMenu | null>(null)
	const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(
		'loading',
	)
	const [pulling, setPulling] = useState(false)
	// #335: the guest's dietary choices; a dish shows only with every one.
	const [diet, setDiet] = useState<DietaryTag[]>([])
	const dietLabel = useDietaryLabel()
	const locale = language.code
	const defaultLocale = organization?.defaultLocale || 'en'

	const apply = (payload: unknown) => {
		setMenu(presentMenu(payload, locale, defaultLocale))
		setStatus('ready')
	}

	useEffect(() => {
		let cancelled = false
		setStatus('loading')
		void loadMenu(configuration)
			.then((payload) => {
				if (!cancelled) apply(payload)
			})
			.catch((error: unknown) => {
				if (cancelled) return
				if (isMissingCatalog(error)) {
					setMenu(null)
					setStatus('ready')
					return
				}
				setStatus('failed')
			})
		return () => {
			cancelled = true
		}
		// `apply` closes over the locale from this render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [configuration, defaultLocale, loadMenu, locale])

	const pageInput = organization
		? {
				organization,
				siteAddress: configuration.siteAddress,
				brandDomain: configuration.brandDomain,
			}
		: null
	const menuUrl = pageInput
		? websitePageUrl({ ...pageInput, page: 'menu' })
		: null
	const checkoutUrl = pageInput
		? websitePageUrl({ ...pageInput, page: 'checkout' })
		: null

	const onRefresh = () => {
		setPulling(true)
		void loadMenu(configuration)
			.then(apply)
			.catch((error: unknown) => {
				if (isMissingCatalog(error)) {
					setMenu(null)
					setStatus('ready')
					return
				}
				setStatus('failed')
			})
			.finally(() => setPulling(false))
	}

	if (status === 'loading' && !menu) {
		return <LoadingView label={t`Loading the menu`} />
	}
	if (status === 'failed') {
		return (
			<Screen>
				<View className="flex-1 items-start justify-center gap-3">
					<Text variant="error">{t`The menu could not be loaded.`}</Text>
					<Button variant="outline" onPress={onRefresh}>
						{t`Try again`}
					</Button>
				</View>
			</Screen>
		)
	}

	const allSections = menu?.sections ?? []
	const dietOptions = dietaryTagsOnMenu(allSections)
	const sections = filterSectionsByDiet(allSections, diet)
	const toggleDiet = (tag: DietaryTag) =>
		setDiet((current) =>
			current.includes(tag)
				? current.filter((entry) => entry !== tag)
				: [...current, tag],
		)
	// The offers that work at the website's location now; a page left open
	// re-checks the time on its next render.
	const livePromotions = menu
		? promotionsForScope(menu.promotions, menu.offerScope)
		: []
	const promotions = bannerOffers(livePromotions).shown
	const currency = menu?.currency || 'USD'

	return (
		<Screen padded={false}>
			<ScrollView
				className="flex-1"
				contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
				refreshControl={
					<RefreshControl refreshing={pulling} onRefresh={onRefresh} />
				}
			>
				<View className="gap-5 py-5">
					<View className="gap-1">
						<Text variant="title">{t`Menu`}</Text>
						<Text variant="muted">
							{t`What is on the menu today. Checkout is on the website.`}
						</Text>
					</View>
					{promotions.length > 0 ? (
						<View className="gap-2">
							{promotions.map((promotion) => (
								<OfferLine
									key={promotion.id}
									promotion={promotion}
									currency={currency}
									locale={locale}
								/>
							))}
						</View>
					) : null}
					{dietOptions.length > 0 ? (
						<View className="gap-2">
							<View
								className="flex-row flex-wrap gap-2"
								accessibilityLabel={t`Dietary preferences`}
							>
								{dietOptions.map((tag) => (
									<Chip
										key={tag}
										label={dietLabel(tag)}
										selected={diet.includes(tag)}
										onPress={() => toggleDiet(tag)}
									/>
								))}
							</View>
							<Text variant="caption">
								{t`Dietary tags are the restaurant's own description. Ask staff if you have an allergy.`}
							</Text>
						</View>
					) : null}
					{sections.length === 0 && diet.length > 0 ? (
						<EmptyState
							title={t`No dishes match these choices.`}
							body={t`Clear a choice to see more of the menu.`}
						/>
					) : sections.length === 0 ? (
						<EmptyState
							title={t`Nothing on the menu right now.`}
							body={t`Check back later, or open the website menu.`}
						/>
					) : (
						sections.map((section) => (
							<View key={section.id} className="gap-2">
								<Text variant="heading">{section.name}</Text>
								{section.items.map((item) => (
									<MenuItemRow
										key={item.id}
										item={item}
										currency={currency}
										locale={locale}
										promotions={livePromotions}
										onPress={menuUrl ? () => openPage(menuUrl) : undefined}
									/>
								))}
							</View>
						))
					)}
				</View>
			</ScrollView>
			<SiteCheckoutBar
				menuUrl={menuUrl}
				checkoutUrl={checkoutUrl}
				openPage={openPage}
			/>
		</Screen>
	)
}

function OfferLine({
	promotion,
	currency,
	locale,
}: {
	promotion: MenuPromotionView
	currency: string
	locale: string
}) {
	const { t } = useLingui()
	const offerLabel = useOfferLabeler(currency, locale)
	const { code } = promotion
	return (
		<View className="bg-muted gap-1 rounded-xl px-3 py-2">
			<View className="flex-row flex-wrap items-center gap-2">
				{/* A capped or limited offer says its limit next to its name (#273). */}
				<Text variant="label">
					{promotion.showName ? offerLabel(promotion) : promotion.name}
				</Text>
				{/* An offer shown by name has no value badge: the name says it. */}
				{promotion.showName ? null : <Badge>{offerLabel(promotion)}</Badge>}
			</View>
			{promotion.description ? (
				<Text variant="caption">{promotion.description}</Text>
			) : null}
			{code ? <Text variant="label">{t`Use code ${code}`}</Text> : null}
		</View>
	)
}

function MenuItemRow({
	item,
	currency,
	locale,
	promotions,
	onPress,
}: {
	item: MenuItemView
	currency: string
	locale: string
	promotions: MenuPromotionView[]
	onPress?: () => void
}) {
	const { t } = useLingui()
	const offerLabel = useOfferLabeler(currency, locale)
	// The region matches a category offer by the item's own category, which is
	// the last of the path.
	const directCategoryIds = item.categoryIds.slice(-1)
	const offers = item.soldOut
		? []
		: offersForItem(promotions, item.id, directCategoryIds, undefined, {
				excludeFromDiscounts: item.excludeFromDiscounts,
			})
	// A was/now price only when one plain offer is the single offer covering the
	// item. Display only: the quote at checkout decides what an order costs.
	const sale = item.soldOut
		? null
		: menuItemSalePrice(promotions, {
				id: item.id,
				directCategoryIds,
				priceMinor: Math.round(item.price * 100),
				currency,
				excludeFromDiscounts: item.excludeFromDiscounts,
			})
	const originalPrice = formatMenuPrice(item.price, currency, locale)
	const price = sale
		? formatMenuPrice(sale.saleMinor / 100, currency, locale)
		: originalPrice
	const name = item.name
	const dietLabel = useDietaryLabel()
	const deliveryPriceText =
		item.deliveryPrice !== undefined
			? formatMenuPrice(item.deliveryPrice, currency, locale)
			: ''
	// What a screen reader says for the row: the name alone would hide the
	// price, the offer and the description that sit inside it.
	const spoken = [
		name,
		sale ? t`${price}, was ${originalPrice}` : price,
		...offers.map(offerLabel),
		item.deliveryPrice !== undefined
			? t`Delivery price ${deliveryPriceText}`
			: null,
		...item.dietaryTags.map(dietLabel),
		item.description,
	]
		.filter(Boolean)
		.join(', ')
	const body = (
		<View className="border-border gap-1 border-b py-3">
			<View className="flex-row items-start justify-between gap-3">
				<Text variant="label" className="flex-1">
					{name}
				</Text>
				<View className="items-end">
					<Text variant="label">{item.soldOut ? t`Sold out` : price}</Text>
					{sale ? (
						<Text variant="caption" className="line-through">
							{originalPrice}
						</Text>
					) : null}
				</View>
			</View>
			{item.description ? (
				<Text variant="caption">{item.description}</Text>
			) : null}
			{item.calories ? (
				<Text variant="caption">{t`${item.calories} Cal`}</Text>
			) : null}
			{item.deliveryPrice !== undefined && !item.soldOut ? (
				<Text variant="caption">{t`Delivery price ${deliveryPriceText}`}</Text>
			) : null}
			{item.dietaryTags.length > 0 ? (
				<View className="flex-row flex-wrap gap-2">
					{item.dietaryTags.map((tag) => (
						<Badge key={tag}>{dietLabel(tag)}</Badge>
					))}
				</View>
			) : null}
			{offers.length > 0 ? (
				<View className="flex-row flex-wrap gap-2">
					{offers.map((offer) => (
						<Badge key={offer.id}>{offerLabel(offer)}</Badge>
					))}
				</View>
			) : null}
		</View>
	)
	if (!onPress || item.soldOut) return body
	return (
		<Pressable
			accessibilityRole="link"
			accessibilityLabel={spoken}
			accessibilityHint={t`Opens the website`}
			onPress={onPress}
		>
			{body}
		</Pressable>
	)
}

/**
 * The text of an offer's value badge. A set price, a cap, a deal or a ladder
 * has no one "20% off" to show, so those read as the discount's own name; a
 * plain percentage or amount reads as its value.
 */
function useOfferLabeler(
	currency: string,
	locale: string,
): (promotion: MenuPromotionView) => string {
	const { t } = useLingui()
	return (promotion) => {
		if (promotion.showName) {
			// A capped offer says its limit next to its name (#273).
			const name = promotion.name
			if (promotion.maxDiscountMinor) {
				const amount = formatMenuPrice(
					promotion.maxDiscountMinor / 100,
					promotion.currency || currency,
					locale,
				)
				return t`${name} (up to ${amount} off)`
			}
			if (promotion.maxUnits) {
				const count = promotion.maxUnits
				return t`${name} (limit ${count} per order)`
			}
			return name
		}
		if (promotion.valueType === 'percent' && promotion.percentBp) {
			const percentText = new Intl.NumberFormat(locale, {
				style: 'percent',
				maximumFractionDigits: 2,
			}).format(promotion.percentBp / 10_000)
			return t`${percentText} off`
		}
		if (promotion.valueType === 'fixed' && promotion.amountMinor) {
			const amount = formatMenuPrice(
				promotion.amountMinor / 100,
				promotion.currency || currency,
				locale,
			)
			return t`${amount} off`
		}
		if (promotion.valueType === 'fixed_price' && promotion.amountMinor) {
			const amount = formatMenuPrice(
				promotion.amountMinor / 100,
				promotion.currency || currency,
				locale,
			)
			return t`Set price ${amount}`
		}
		if (promotion.valueType === 'free_delivery') return t`Free delivery`
		return promotion.name
	}
}

/** Words for a dietary tag (#335). */
function useDietaryLabel(): (tag: DietaryTag) => string {
	const { t } = useLingui()
	return (tag) => {
		switch (tag) {
			case 'halal':
				return t`Halal`
			case 'vegan':
				return t`Vegan`
			case 'vegetarian':
				return t`Vegetarian`
			case 'gluten_free':
				return t`Gluten-free`
			case 'dairy_free':
				return t`Dairy-free`
			case 'nut_free':
				return t`Nut-free`
			case 'spicy':
				return t`Spicy`
		}
	}
}
