import { useLingui } from '@lingui/react/macro'
import { View } from 'react-native'
import { Button, Text } from '../ui'

/**
 * The same two steps the website uses: the menu (where the cart is built)
 * and `/menu/checkout`. Both open in the browser. Nothing about the customer
 * is added to the URL.
 */
export function SiteCheckoutBar({
	menuUrl,
	checkoutUrl,
	openPage,
}: {
	menuUrl: string | null
	checkoutUrl: string | null
	openPage: (url: string) => void
}) {
	const { t } = useLingui()
	if (!menuUrl && !checkoutUrl) return null
	return (
		<View className="border-border bg-card gap-2 border-t px-5 py-4">
			{checkoutUrl ? (
				<Button accessibilityRole="link" onPress={() => openPage(checkoutUrl)}>
					{t`Checkout`}
				</Button>
			) : null}
			{menuUrl ? (
				<Button
					variant="outline"
					accessibilityRole="link"
					onPress={() => openPage(menuUrl)}
				>
					{t`Order on the menu`}
				</Button>
			) : null}
			<Text variant="caption">
				{t`Opens the website. Add items on the menu, then check out there. Coupons and rewards apply at checkout.`}
			</Text>
		</View>
	)
}
