import { type LoyaltyPublicProgram } from '@repo/loyalty'
import { siteCardClass } from '~/lib/form-classes'
import {
	describeEarning,
	describeReward,
	formatPoints,
} from '~/lib/loyalty/format'
import { type LoyaltyLabels } from '~/lib/loyalty/labels'
import { type LoyaltyClient } from '~/lib/loyalty-client'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'
import { formatMinor } from '~/lib/reservations/money'

export type RewardsBlockConfig = {
	heading?: string
	body?: string
	ctaLabel?: string
	showRewards?: boolean
	showTiers?: boolean
}

export type RewardsBlockDeps = {
	client: Pick<LoyaltyClient, 'program'> & {
		wallet?: LoyaltyClient['wallet']
	}
	labels: LoyaltyLabels
	locale: string
	signedIn: () => boolean
	loginHref: string
	walletHref: string
	config?: RewardsBlockConfig
}

export async function initRewardsBlock(
	root: HTMLElement,
	deps: RewardsBlockDeps,
): Promise<void> {
	const { client, labels, locale, signedIn, loginHref, walletHref } = deps
	const config = deps.config ?? {}
	let program: LoyaltyPublicProgram | null = null
	let memberAvailable: number | null = null
	let isMember = signedIn()
	if (isMember && client.wallet) {
		try {
			const wallet = await client.wallet()
			if (wallet && wallet.program.status === 'active') {
				program = wallet.program
				if (wallet.member && wallet.balance) {
					memberAvailable = wallet.balance.available
				} else {
					isMember = false
				}
			}
		} catch {
			// Fall back to anonymous public program read if session expired or failed.
			isMember = false
		}
	}
	if (!program) {
		try {
			program = await client.program()
		} catch {
			root.hidden = true
			return
		}
	}
	if (!program || program.status !== 'active') {
		root.hidden = true
		return
	}

	const container = el('div', 'mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8')
	const card = el('div', `${siteCardClass} flex flex-col gap-6`)

	// Header + CTA
	const headerRow = el(
		'div',
		'flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between',
	)
	const headerCopy = el('div', 'flex flex-col gap-1.5')
	const headingText = config.heading?.trim() || program.name
	const h2 = el(
		'h2',
		'font-heading text-2xl font-bold text-foreground sm:text-3xl',
		headingText,
	)
	headerCopy.append(h2)
	if (config.body?.trim()) {
		headerCopy.append(
			el('p', 'text-sm text-muted-foreground sm:text-base', config.body.trim()),
		)
	}
	if (isMember && memberAvailable !== null) {
		const balanceBadge = el(
			'p',
			'text-sm font-semibold text-foreground',
			`${labels.balanceHeading}: ${formatPoints(memberAvailable, program.unitLabel, labels, locale)}`,
		)
		balanceBadge.dataset.loyaltyBlockBalance = String(memberAvailable)
		headerCopy.append(balanceBadge)
	}
	const ctaText = isMember
		? labels.blockView
		: config.ctaLabel?.trim() || labels.blockJoin
	const cta = el('a', 'btn-cta shrink-0 self-start sm:self-center', ctaText)
	cta.href = isMember ? walletHref : loginHref
	cta.dataset.loyaltyBlockCta = ''
	headerRow.append(headerCopy, cta)
	card.append(headerRow)

	// Welcome bonus callout
	if (
		program.welcomeBonus &&
		program.welcomeBonus.enabled &&
		program.welcomeBonus.points > 0
	) {
		const pts = formatPoints(
			program.welcomeBonus.points,
			program.unitLabel,
			labels,
			locale,
		)
		const noteText = program.welcomeBonus.afterFirstPaidOrder
			? fillTemplate(labels.welcomeFirstOrder, { points: pts })
			: fillTemplate(labels.welcomeGranted, { points: pts })
		const welcomeNote = el(
			'p',
			'rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground',
			noteText,
		)
		welcomeNote.dataset.loyaltyBlockWelcome = ''
		card.append(welcomeNote)
	}

	// How earning works
	const earnLines = describeEarning(program, labels, locale)
	if (earnLines.length > 0) {
		const earnBox = el('div', 'flex flex-col gap-1.5')
		earnBox.append(
			el(
				'h3',
				'text-xs font-semibold tracking-wider text-muted-foreground uppercase',
				labels.howYouEarn,
			),
		)
		for (const line of earnLines) {
			earnBox.append(el('p', 'text-sm text-foreground', line))
		}
		card.append(earnBox)
	}

	// Tiers preview
	const showTiers = config.showTiers !== false
	if (showTiers && program.tiers && program.tiers.levels.length > 0) {
		const tiersBox = el('div', 'flex flex-col gap-2.5')
		tiersBox.dataset.loyaltyBlockTiers = ''
		tiersBox.append(
			el(
				'h3',
				'text-xs font-semibold tracking-wider text-muted-foreground uppercase',
				labels.blockTiersHeading,
			),
		)
		const tierGrid = el('ul', 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4')
		for (const level of program.tiers.levels) {
			const li = el(
				'li',
				'rounded-lg border border-border bg-background p-3.5 flex flex-col gap-1',
			)
			li.append(el('p', 'font-semibold text-foreground', level.name))
			const thresholdText =
				program.tiers.metric === 'spend_minor'
					? formatMinor(level.threshold, program.currency, locale)
					: formatPoints(level.threshold, program.unitLabel, labels, locale)
			li.append(el('p', 'text-xs text-muted-foreground', thresholdText))
			if (level.multiplierBp > 10_000) {
				const mult = (level.multiplierBp / 10_000)
					.toFixed(2)
					.replace(/\.00$/, '')
				li.append(el('p', 'text-xs font-medium text-foreground', `${mult}×`))
			}
			tierGrid.append(li)
		}
		tiersBox.append(tierGrid)
		card.append(tiersBox)
	}

	// Rewards preview
	const showRewards = config.showRewards !== false
	if (showRewards && program.rewards.length > 0) {
		const rewardsBox = el('div', 'flex flex-col gap-2.5')
		rewardsBox.dataset.loyaltyBlockRewards = ''
		rewardsBox.append(
			el(
				'h3',
				'text-xs font-semibold tracking-wider text-muted-foreground uppercase',
				labels.rewardsHeading,
			),
		)
		const grid = el('ul', 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3')
		for (const reward of program.rewards) {
			const li = el(
				'li',
				'rounded-lg border border-border bg-background p-4 flex flex-col justify-between gap-2',
			)
			const top = el('div', 'flex items-start justify-between gap-2')
			top.append(el('p', 'font-semibold text-foreground', reward.name))
			top.append(
				el(
					'span',
					'shrink-0 text-xs font-medium text-muted-foreground',
					formatPoints(reward.pointsCost, program.unitLabel, labels, locale),
				),
			)
			li.append(top)
			const desc = describeReward(reward, labels, locale)
			li.append(el('p', 'text-xs text-muted-foreground', desc.value))
			if (reward.minTierName) {
				li.append(
					el(
						'p',
						'text-xs font-medium text-muted-foreground',
						fillTemplate(labels.rewardTierLocked, {
							tier: reward.minTierName,
						}),
					),
				)
			}
			grid.append(li)
		}
		rewardsBox.append(grid)
		card.append(rewardsBox)
	}

	container.append(card)
	root.replaceChildren(container)
	root.hidden = false
}
