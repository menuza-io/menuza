import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { useAppSnapshot, useLoyalty } from '../../lib/app/use-app'
import { loyaltyErrorText } from '../../lib/loyalty/labels'
import {
	type LoyaltySnapshot,
	type LoyaltyStore,
} from '../../lib/loyalty/loyalty-store'
import { websiteOrderUrl } from '../../lib/loyalty/website-link'
import { useNow } from '../../lib/support/use-now'
import { Button, EmptyState, LoadingView, Screen, Text } from '../ui'
import { ApprovalsCard } from './approvals-card'
import { BalanceCard } from './balance-card'
import { HistorySection } from './history-section'
import { MemberCodeCard } from './member-code-card'
import { NoticeLine, StatusNote } from './notice-line'
import {
	EarningSection,
	RewardsSection,
	TermsDetails,
	WebsiteOrderLink,
} from './program-sections'
import { useLoyaltyActivity } from './use-loyalty-activity'
import { useLoyaltyText } from './use-loyalty-text'

/**
 * The rewards wallet, the app's port of the website's wallet page: points
 * and progress, the code for the counter, till approvals, rewards, earning,
 * history and the program terms. There is nothing to join: the customer's
 * points account opens when the wallet loads. Ordering (and choosing a
 * reward) happens on the website, through a plain link.
 */
export function RewardsScreen({ focused = true }: { focused?: boolean }) {
	const loyalty = useLoyalty()
	const { label } = useLoyaltyText()
	useLoyaltyActivity(loyalty?.store ?? null, focused)
	if (!loyalty) return <LoadingView label={label('loading')} />
	return <Wallet store={loyalty.store} snapshot={loyalty.snapshot} />
}

function Wallet({
	store,
	snapshot,
}: {
	store: LoyaltyStore
	snapshot: LoyaltySnapshot
}) {
	const { i18n, label } = useLoyaltyText()
	const { organization, configuration } = useAppSnapshot()
	const [pulling, setPulling] = useState(false)
	const orderUrl = useMemo(
		() =>
			organization
				? websiteOrderUrl({
						organization,
						siteAddress: configuration.siteAddress,
						brandDomain: configuration.brandDomain,
					})
				: null,
		[organization, configuration.siteAddress, configuration.brandDomain],
	)
	const ticking =
		snapshot.active &&
		(Boolean(snapshot.memberCode?.code) ||
			Boolean(
				snapshot.approvals?.items.some((item) => item.deadlineMs !== null),
			))
	const now = useNow(ticking)

	const onRefresh = () => {
		setPulling(true)
		void store.refresh().finally(() => setPulling(false))
	}
	const notice = snapshot.notice ? (
		<NoticeLine
			notice={snapshot.notice}
			onDismiss={() => store.dismissNotice()}
		/>
	) : null

	switch (snapshot.status) {
		case 'loading':
			return <LoadingView label={label('loading')} />
		case 'failed':
			return (
				<Screen>
					<View className="flex-1 items-start justify-center gap-3">
						<Text variant="error" accessibilityLiveRegion="polite">
							{loyaltyErrorText(i18n, snapshot.error?.code ?? 'unknown')}
						</Text>
						<Button variant="outline" onPress={() => void store.retry()}>
							{label('retry')}
						</Button>
					</View>
				</Screen>
			)
		case 'unavailable':
			return (
				<Screen scroll onRefresh={onRefresh} refreshing={pulling}>
					<View className="gap-4 py-5">
						{notice}
						<EmptyState
							title={label('unavailableTitle')}
							body={label('unavailableBody')}
						/>
					</View>
				</Screen>
			)
		case 'signedOut':
			// The app signs out too and its gate shows sign-in; this is the moment between.
			return (
				<Screen scroll>
					<View className="gap-4 py-5">
						{notice}
						<EmptyState
							title={label('signedOutTitle')}
							body={label('signedOutBody')}
						/>
						{snapshot.program ? <ProgramDetails snapshot={snapshot} /> : null}
					</View>
				</Screen>
			)
		case 'member': {
			const wallet = snapshot.member
			const abilities = snapshot.abilities
			if (!wallet || !abilities) return <LoadingView label={label('loading')} />
			const program = wallet.program
			return (
				<Screen scroll onRefresh={onRefresh} refreshing={pulling}>
					<View className="gap-4 py-5">
						{notice}
						{abilities.suspended ? (
							<StatusNote>{label('suspendedNotice')}</StatusNote>
						) : null}
						{abilities.paused ? (
							<StatusNote>{label('pausedNotice')}</StatusNote>
						) : null}
						<BalanceCard wallet={wallet} nextReward={snapshot.nextReward} />
						{snapshot.approvals ? (
							<ApprovalsCard
								state={snapshot.approvals}
								unit={program.unitLabel}
								now={now}
								onDecide={(id, decision) => void store.decide(id, decision)}
								onCheck={() => void store.checkApprovals()}
							/>
						) : null}
						{snapshot.memberCode ? (
							<MemberCodeCard
								state={snapshot.memberCode}
								now={now}
								onIssue={() => void store.issueMemberCode()}
							/>
						) : null}
						<RewardsSection program={program} standings={snapshot.rewards} />
						{orderUrl ? <WebsiteOrderLink url={orderUrl} /> : null}
						<EarningSection program={program} />
						{snapshot.history ? (
							<HistorySection
								state={snapshot.history}
								unit={program.unitLabel}
								onRetry={() => void store.loadHistory()}
								onMore={() => void store.loadMoreHistory()}
							/>
						) : null}
						<TermsDetails program={program} />
					</View>
				</Screen>
			)
		}
	}
}

/** What a signed-out visitor can still read about the program. */
function ProgramDetails({ snapshot }: { snapshot: LoyaltySnapshot }) {
	const { label } = useLoyaltyText()
	const program = snapshot.program
	if (!program) return null
	return (
		<>
			{program.status !== 'active' ? (
				<StatusNote>{label('errorProgramInactive')}</StatusNote>
			) : null}
			<EarningSection program={program} />
			<RewardsSection program={program} />
			<TermsDetails program={program} />
		</>
	)
}
