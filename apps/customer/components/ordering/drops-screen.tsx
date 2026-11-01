import { useLingui } from '@lingui/react/macro'
import {
	DROP_STATUSES,
	type DropStatus,
	getDropDisplayStatus,
} from '@repo/common/menu-types'
import { useEffect, useState } from 'react'
import {
	Image,
	Pressable,
	RefreshControl,
	ScrollView,
	View,
} from 'react-native'
import { useAppSnapshot } from '../../lib/app/use-app'
import { websitePageUrl } from '../../lib/loyalty/website-link'
import {
	fetchPublishedDrops,
	isMissingCatalog,
	type PublishedDrop,
	presentDrops,
} from '../../lib/ordering/catalog'
import { openWebsitePage } from '../../lib/ordering/open-site'
import { Button, EmptyState, LoadingView, Screen, Text } from '../ui'
import { SiteCheckoutBar } from './site-checkout'

type LoadDrops = typeof fetchPublishedDrops
type DropPhase = 'live' | 'upcoming' | 'ended'

const KNOWN_STATUS = new Set<string>(DROP_STATUSES)

/**
 * Published drops. A live or upcoming drop opens its page on the website,
 * which is where that drop's order is placed and checked out.
 */
export function DropsScreen({
	loadDrops = fetchPublishedDrops,
	openPage = openWebsitePage,
	now = () => new Date(),
}: {
	loadDrops?: LoadDrops
	openPage?: (url: string) => void
	now?: () => Date
} = {}) {
	const { t } = useLingui()
	const { configuration, organization } = useAppSnapshot()
	const [drops, setDrops] = useState<PublishedDrop[] | null>(null)
	const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(
		'loading',
	)
	const [pulling, setPulling] = useState(false)

	const apply = (payload: unknown) => {
		setDrops(presentDrops(payload))
		setStatus('ready')
	}

	useEffect(() => {
		let cancelled = false
		setStatus('loading')
		void loadDrops(configuration)
			.then((payload) => {
				if (!cancelled) apply(payload)
			})
			.catch((error: unknown) => {
				if (cancelled) return
				if (isMissingCatalog(error)) {
					setDrops([])
					setStatus('ready')
					return
				}
				setStatus('failed')
			})
		return () => {
			cancelled = true
		}
	}, [configuration, loadDrops])

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
		void loadDrops(configuration)
			.then(apply)
			.catch((error: unknown) => {
				if (isMissingCatalog(error)) {
					setDrops([])
					setStatus('ready')
					return
				}
				setStatus('failed')
			})
			.finally(() => setPulling(false))
	}

	if (status === 'loading' && !drops) {
		return <LoadingView label={t`Loading drops`} />
	}
	if (status === 'failed') {
		return (
			<Screen>
				<View className="flex-1 items-start justify-center gap-3">
					<Text variant="error">{t`Drops could not be loaded.`}</Text>
					<Button variant="outline" onPress={onRefresh}>
						{t`Try again`}
					</Button>
				</View>
			</Screen>
		)
	}

	const moment = now()
	const grouped: Record<DropPhase, PublishedDrop[]> = {
		live: [],
		upcoming: [],
		ended: [],
	}
	for (const drop of drops ?? []) grouped[dropPhase(drop, moment)].push(drop)

	const sections = [
		{ key: 'live' as const, title: t`Ordering now`, drops: grouped.live },
		{
			key: 'upcoming' as const,
			title: t`Coming up`,
			drops: grouped.upcoming,
		},
		{ key: 'ended' as const, title: t`Past drops`, drops: grouped.ended },
	].filter((section) => section.drops.length > 0)

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
						<Text variant="title">{t`Drops`}</Text>
						<Text variant="muted">
							{t`Limited menus you pre-order for a pickup window.`}
						</Text>
					</View>
					{sections.length === 0 ? (
						<EmptyState
							title={t`No drops right now.`}
							body={t`Check the menu for what we are serving today.`}
						/>
					) : (
						sections.map((section) => (
							<View key={section.key} className="gap-3">
								<Text variant="heading">{section.title}</Text>
								{section.drops.map((drop) => (
									<DropCard
										key={drop.slug}
										drop={drop}
										phase={section.key}
										href={
											pageInput
												? websitePageUrl({
														...pageInput,
														page: 'drop',
														slug: drop.slug,
													})
												: null
										}
										openPage={openPage}
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

function DropCard({
	drop,
	phase,
	href,
	openPage,
}: {
	drop: PublishedDrop
	phase: DropPhase
	href: string | null
	openPage: (url: string) => void
}) {
	const { t, i18n } = useLingui()
	const title = drop.title
	const phaseLabel =
		phase === 'live'
			? t`Ordering now`
			: phase === 'upcoming'
				? t`Coming up`
				: t`Past drop`
	const places = drop.pickupLocationNames.join(', ')
	const when = formatPickupDate(drop.pickupDates[0], i18n.locale)
	const details = [when, places].filter(Boolean).join(' · ')
	const body = (
		<View className="border-border bg-card gap-2 overflow-hidden rounded-xl border">
			{drop.coverImageUrl ? (
				<Image
					source={{ uri: drop.coverImageUrl }}
					accessibilityIgnoresInvertColors
					style={{ width: '100%', height: 140 }}
				/>
			) : null}
			<View className="gap-1 p-4">
				<Text variant="caption">{phaseLabel}</Text>
				<Text variant="heading">{title}</Text>
				{drop.description ? (
					<Text variant="muted">{drop.description}</Text>
				) : null}
				{details ? <Text variant="caption">{details}</Text> : null}
			</View>
		</View>
	)
	if (!href) return body
	return (
		<Pressable
			accessibilityRole="link"
			accessibilityLabel={[title, phaseLabel, details]
				.filter(Boolean)
				.join(', ')}
			accessibilityHint={t`Opens the website`}
			onPress={() => openPage(href)}
		>
			{body}
		</Pressable>
	)
}

function dropPhase(drop: PublishedDrop, now: Date): DropPhase {
	const status: DropStatus = KNOWN_STATUS.has(drop.status)
		? (drop.status as DropStatus)
		: 'closed'
	const display = getDropDisplayStatus(
		status,
		drop.ordersOpenAt,
		drop.ordersCloseAt,
		now,
	)
	if (display === 'scheduled') return 'upcoming'
	if (display === 'live') return 'live'
	return 'ended'
}

/** A `YYYY-MM-DD` pickup date in the guest's language; anything else as sent. */
function formatPickupDate(raw: string | undefined, locale: string): string {
	if (!raw) return ''
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
	const date = new Date(`${raw}T00:00:00Z`)
	if (Number.isNaN(date.getTime())) return raw
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'medium',
		timeZone: 'UTC',
	}).format(date)
}
