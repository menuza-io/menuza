import { useLingui } from '@lingui/react/macro'
import { type LoyaltyPublicProgram } from '@repo/loyalty'
import * as Linking from 'expo-linking'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import {
	describeEarning,
	describeReward,
	formatPoints,
} from '../../lib/loyalty/format'
import { type RewardView } from '../../lib/loyalty/wallet-view'
import { Button, Card, Text } from '../ui'
import { Section } from './notice-line'
import { useLoyaltyText } from './use-loyalty-text'

/** The rewards of the program; with `standings`, how far the member is from each. */
export function RewardsSection({
	program,
	standings,
}: {
	program: LoyaltyPublicProgram
	standings?: readonly RewardView[]
}) {
	const { i18n, label } = useLoyaltyText()
	const unit = program.unitLabel
	const notes =
		program.status === 'active'
			? program.redemptionEnabled
				? [label('rewardsHowToUse'), label('oneRewardPerOrder')]
				: [label('redemptionPaused')]
			: []
	return (
		<Section title={label('rewardsHeading')}>
			{program.rewards.length === 0 ? (
				<Text variant="muted">{label('rewardsEmpty')}</Text>
			) : null}
			{program.rewards.map((reward) => {
				const standing = standings?.find((view) => view.reward.id === reward.id)
				const description = describeReward(reward, i18n)
				return (
					<View
						key={reward.id}
						className="border-border bg-background gap-1 rounded-lg border p-3"
					>
						<Text variant="label">{reward.name}</Text>
						<Text>{description.value}</Text>
						<Text variant="muted">{description.scope}</Text>
						{description.cap ? (
							<Text variant="muted">{description.cap}</Text>
						) : null}
						{reward.description ? (
							<Text variant="muted">{reward.description}</Text>
						) : null}
						<Text variant="label">
							{`${label('rewardCost')}: ${formatPoints(reward.pointsCost, unit, i18n)}`}
						</Text>
						{standing ? (
							<Text variant="caption">
								{standing.affordable
									? label('rewardAffordable')
									: label('rewardNeedMore', {
											amount: formatPoints(standing.pointsNeeded, unit, i18n),
										})}
							</Text>
						) : null}
					</View>
				)
			})}
			{notes.map((note) => (
				<Text key={note} variant="caption">
					{note}
				</Text>
			))}
		</Section>
	)
}

export function EarningSection({ program }: { program: LoyaltyPublicProgram }) {
	const { i18n, label } = useLoyaltyText()
	const lines = describeEarning(program, i18n)
	if (lines.length === 0) return null
	return (
		<Section title={label('earnHeading')}>
			{lines.map((line) => (
				<Text key={line}>{line}</Text>
			))}
		</Section>
	)
}

/**
 * The program terms as read-only text, folded away until opened. Nothing is
 * accepted here: the terms are information, not a gate.
 */
export function TermsDetails({ program }: { program: LoyaltyPublicProgram }) {
	const { label } = useLoyaltyText()
	const [open, setOpen] = useState(false)
	if (!program.terms?.trim()) return null
	return (
		<Card className="gap-3">
			<Pressable
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
				accessibilityLabel={label('termsHeading')}
				onPress={() => setOpen((value) => !value)}
				className="flex-row items-center justify-between py-1"
			>
				<Text variant="label">{label('termsHeading')}</Text>
				<Text variant="muted">{open ? '−' : '+'}</Text>
			</Pressable>
			{open ? <Text>{program.terms}</Text> : null}
		</Card>
	)
}

/**
 * Ordering happens on the organization's website: the app has no cart. The
 * link is plain (no token or id); rewards are used at its checkout.
 */
export function WebsiteOrderLink({ url }: { url: string }) {
	const { t } = useLingui()
	return (
		<Card className="gap-2">
			<Button
				variant="outline"
				accessibilityRole="link"
				onPress={() => void Linking.openURL(url)}
			>
				{t`Order on the website`}
			</Button>
			<Text variant="caption">
				{t`Opens in your browser. Your points and rewards apply when you order there.`}
			</Text>
		</Card>
	)
}
