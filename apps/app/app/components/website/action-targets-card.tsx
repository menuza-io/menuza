import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ACTION_KINDS,
	type ActionKind,
	type ActionTargets,
} from '@repo/common/action-targets'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { Input } from '@repo/ui/input'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'

export const actionTargetsActionIntent = 'update-action-targets'

type Mode = 'menuza' | 'external' | 'inherit'

export type ActionTargetsCardData = {
	organization: ActionTargets
	locations: Array<{ id: string; name: string; targets: ActionTargets }>
}

type Draft = Record<ActionKind, { mode: Mode; url: string }>

function draftOf(targets: ActionTargets, location: boolean): Draft {
	const draft = {} as Draft
	for (const kind of ACTION_KINDS) {
		const target = targets[kind]
		draft[kind] = target
			? target.mode === 'external'
				? { mode: 'external', url: target.url }
				: { mode: 'menuza', url: '' }
			: { mode: location ? 'inherit' : 'menuza', url: '' }
	}
	return draft
}

type SaveResult = {
	ok?: boolean
	error?: string
	kind?: ActionKind
}

/**
 * Website settings, "Where buttons go" (#318): for Order online, Gift cards
 * and Reservations, Menuza (the default) or another site with a link, for the
 * organization and, with several locations, for each one. One choice changes
 * every button and link for that action, and our own pages for it stop being
 * linked or indexed; switching back restores them.
 */
export function ActionTargetsCard({
	data,
	canEdit,
	outbound,
}: {
	data: ActionTargetsCardData
	canEdit: boolean
	/** Clicks that left in the last 30 days, when the count can be read. */
	outbound: Record<ActionKind, number> | null
}) {
	const { _ } = useLingui()
	const labels: Record<ActionKind, string> = {
		order: _(msg`Order online`),
		gift_cards: _(msg`Gift cards`),
		reservations: _(msg`Reservations`),
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Where buttons go</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Send Order online, Gift cards or Reservations to another site. Every
						button for that action opens it in a new tab, and our own pages for
						it are hidden from navigation and search. You can change this at any
						time.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-8">
				<Scope
					scopeId=""
					title={<Trans>Your whole site</Trans>}
					targets={data.organization}
					isLocation={false}
					canEdit={canEdit}
					labels={labels}
				/>
				{data.locations.length > 1
					? data.locations.map((location) => (
							<Scope
								key={location.id}
								scopeId={location.id}
								title={location.name}
								targets={location.targets}
								isLocation
								canEdit={canEdit}
								labels={labels}
							/>
						))
					: null}
				{outbound ? <OutboundSummary outbound={outbound} /> : null}
			</CardContent>
		</Card>
	)
}

function Scope({
	scopeId,
	title,
	targets,
	isLocation,
	canEdit,
	labels,
}: {
	scopeId: string
	title: React.ReactNode
	targets: ActionTargets
	isLocation: boolean
	canEdit: boolean
	labels: Record<ActionKind, string>
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<SaveResult>()
	const [draft, setDraft] = useState<Draft>(() => draftOf(targets, isLocation))
	useEffect(() => {
		setDraft(draftOf(targets, isLocation))
	}, [targets, isLocation])
	const busy = fetcher.state !== 'idle'
	const error = fetcher.data?.error
	const errorKind = fetcher.data?.kind

	const errorText = (code: string) => {
		switch (code) {
			case 'https_required':
				return _(msg`The link must start with https://.`)
			case 'own_domain':
				return _(msg`The link cannot point back to your own website.`)
			case 'invalid_url':
				return _(msg`Enter a full web address, like https://example.com/order.`)
			default:
				return _(msg`Could not save. Please try again.`)
		}
	}

	return (
		<section
			className="space-y-4"
			aria-label={typeof title === 'string' ? title : undefined}
		>
			<h3 className="text-sm font-semibold">{title}</h3>
			{ACTION_KINDS.map((kind) => {
				const value = draft[kind]
				const label = labels[kind]
				return (
					<fieldset
						key={kind}
						className="space-y-2"
						disabled={!canEdit || busy}
					>
						<legend className="text-muted-foreground mb-1 text-xs font-medium">
							{labels[kind]}
						</legend>
						<RadioGroup
							value={value.mode}
							onValueChange={(mode) =>
								setDraft((current) => ({
									...current,
									[kind]: { ...current[kind], mode: mode as Mode },
								}))
							}
							className="sm:grid-cols-2"
							aria-label={labels[kind]}
						>
							{isLocation ? (
								<ChoiceCard>
									<RadioGroupItem value="inherit" />
									<ChoiceCardContent>
										<ChoiceCardTitle>
											<Trans>Same as the whole site</Trans>
										</ChoiceCardTitle>
									</ChoiceCardContent>
								</ChoiceCard>
							) : null}
							<ChoiceCard>
								<RadioGroupItem value="menuza" />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										<Trans>Menuza</Trans>
									</ChoiceCardTitle>
									{kind === 'order' ? (
										<ChoiceCardDescription>
											<Trans>
												Orders through Menuza cost you nothing per order.
											</Trans>
										</ChoiceCardDescription>
									) : null}
								</ChoiceCardContent>
							</ChoiceCard>
							<ChoiceCard>
								<RadioGroupItem value="external" />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										<Trans>Another site</Trans>
									</ChoiceCardTitle>
								</ChoiceCardContent>
							</ChoiceCard>
						</RadioGroup>
						{value.mode === 'external' ? (
							<div className="space-y-1">
								<Input
									type="url"
									inputMode="url"
									value={value.url}
									onChange={(event) =>
										setDraft((current) => ({
											...current,
											[kind]: { ...current[kind], url: event.target.value },
										}))
									}
									placeholder="https://"
									aria-label={_(msg`Link for ${label}`)}
									aria-invalid={errorKind === kind && error ? true : undefined}
								/>
								{errorKind === kind && error ? (
									<p className="text-destructive text-xs" role="alert">
										{errorText(error)}
									</p>
								) : null}
							</div>
						) : null}
					</fieldset>
				)
			})}
			{canEdit ? (
				<div className="flex items-center gap-3">
					<Button
						type="button"
						size="sm"
						disabled={busy}
						onClick={() => {
							const form = new FormData()
							form.set('intent', actionTargetsActionIntent)
							form.set('locationId', scopeId)
							for (const kind of ACTION_KINDS) {
								form.set(`${kind}Mode`, draft[kind].mode)
								if (draft[kind].mode === 'external') {
									form.set(`${kind}Url`, draft[kind].url)
								}
							}
							void fetcher.submit(form, { method: 'POST' })
						}}
					>
						<Trans>Save</Trans>
					</Button>
					{fetcher.data?.ok ? (
						<span className="text-muted-foreground text-xs" role="status">
							<Trans>Saved. Your site follows this now.</Trans>
						</span>
					) : null}
					{error && !errorKind ? (
						<span className="text-destructive text-xs" role="alert">
							{errorText(error)}
						</span>
					) : null}
				</div>
			) : null}
		</section>
	)
}

function OutboundSummary({
	outbound,
}: {
	outbound: Record<ActionKind, number>
}) {
	const { order, gift_cards: giftCards, reservations } = outbound
	return (
		<p className="text-muted-foreground text-sm" data-testid="outbound-counts">
			<Trans>
				Last 30 days, visitors who left for another site: orders {order}, gift
				cards {giftCards}, reservations {reservations}.
			</Trans>
		</p>
	)
}
