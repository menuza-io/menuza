import { useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { useAppSnapshot } from '../../lib/app/use-app'
import {
	fetchPublishedMenu,
	formatMenuPrice,
	presentMenu,
	type PublishedMenu,
} from '../../lib/ordering/catalog'
import {
	favoriteMenuItems,
	useFavorites,
} from '../../lib/ordering/use-favorites'
import { Badge, Button, Card, Text } from '../ui'

/**
 * Profile, Favorites (#158): every dish the guest favorited that is still on the
 * menu, newest first, with Sold out where it is. A dish that left the menu is
 * simply not listed.
 */
export function FavoritesSection({
	loadMenu = fetchPublishedMenu,
}: {
	loadMenu?: typeof fetchPublishedMenu
} = {}) {
	const { t } = useLingui()
	const { configuration, organization, language } = useAppSnapshot()
	const favorites = useFavorites()
	const [menu, setMenu] = useState<PublishedMenu | null>(null)
	const [menuFailed, setMenuFailed] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)
	const locale = language.code
	const defaultLocale = organization?.defaultLocale || 'en'

	useEffect(() => {
		let cancelled = false
		void loadMenu(configuration)
			.then((payload) => {
				if (!cancelled) setMenu(presentMenu(payload, locale, defaultLocale))
			})
			.catch(() => {
				if (!cancelled) setMenuFailed(true)
			})
		return () => {
			cancelled = true
		}
	}, [configuration, defaultLocale, loadMenu, locale])

	const rows = favoriteMenuItems(menu?.sections ?? [], favorites.favorites)
	const loading =
		!menuFailed && (menu === null || favorites.status === 'loading')

	return (
		<Card className="gap-3" testID="favorites-section">
			<Text variant="heading" accessibilityRole="header">
				{t`Your favorites`}
			</Text>
			{menuFailed || favorites.status === 'failed' ? (
				<View className="items-start gap-2">
					<Text variant="error">{t`Your favorites could not be loaded.`}</Text>
					<Button
						variant="outline"
						onPress={() => {
							setMenuFailed(false)
							void favorites.refresh()
						}}
					>
						{t`Try again`}
					</Button>
				</View>
			) : null}
			{!loading && !menuFailed && rows.length === 0 ? (
				<Text variant="muted">{t`No favorites yet. Tap the heart on a dish to keep it here.`}</Text>
			) : null}
			{rows.map(({ item, soldOut }) => (
				<View
					key={item.id}
					className="border-border flex-row items-center justify-between gap-3 border-t pt-3"
				>
					<View className="flex-1 gap-1">
						<Text variant="label">{item.name}</Text>
						{soldOut ? (
							<Badge>{t`Sold out`}</Badge>
						) : (
							<Text variant="muted">
								{formatMenuPrice(item.price, menu?.currency || 'USD', locale)}
							</Text>
						)}
					</View>
					<Button
						variant="outline"
						onPress={() => {
							setNotice(null)
							void favorites.toggle(item.id).then((outcome) => {
								if (outcome !== 'ok') {
									setNotice(t`We could not update your favorites. Try again.`)
								}
							})
						}}
					>
						{t`Remove`}
					</Button>
				</View>
			))}
			{notice ? <Text variant="error">{notice}</Text> : null}
		</Card>
	)
}
