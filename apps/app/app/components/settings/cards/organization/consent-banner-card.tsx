/**
 * The cookie banner mode of the website (#89), next to the tracking IDs it
 * governs: Required (tags wait for Accept), Notice only (tags load, with an
 * opt-out) or Off (only while no tracking tag is set).
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ConsentMode, type LegalRegion } from '@repo/common/legal'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Spinner } from '@repo/ui/spinner'
import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'

export const consentModeActionIntent = 'update-consent-mode'

export type ConsentSettingsView = {
	stored: ConsentMode | null
	effective: ConsentMode
	defaultMode: ConsentMode
	region: LegalRegion
	hasTrackingTags: boolean
	bannerEnabled: boolean
}

export function ConsentBannerCard({
	consent,
}: {
	consent: ConsentSettingsView
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ status?: string; error?: string }>()
	const [mode, setMode] = useState<ConsentMode>(consent.effective)
	useEffect(() => setMode(consent.effective), [consent.effective])
	const busy = fetcher.state !== 'idle'
	const regionNames: Record<LegalRegion, string> = {
		eu: _(msg`the EU`),
		uk: _(msg`the UK`),
		ksa: _(msg`Saudi Arabia`),
		us: _(msg`the US`),
		other: _(msg`your region`),
	}
	const region = regionNames[consent.region]
	const defaultModeLabel =
		consent.defaultMode === 'notice' ? _(msg`Notice only`) : _(msg`Required`)
	const error =
		fetcher.data?.error === 'tags_need_consent'
			? _(
					msg`Remove your tracking tags before turning the banner off: they need visitors' consent.`,
				)
			: fetcher.data?.error
				? _(msg`Could not save the banner setting.`)
				: null
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Cookie banner</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Choose when your tracking tags may load. Essential storage (the
						cart, sign-in and language) never needs consent. A browser sending
						the Global Privacy Control signal is treated as Reject.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{!consent.bannerEnabled ? (
					<p role="note" className="text-muted-foreground text-xs">
						<Trans>
							The banner is switched off for this site by the platform; tags
							load as they did before.
						</Trans>
					</p>
				) : null}
				<RadioGroup
					value={mode}
					onValueChange={(value) => setMode(value as ConsentMode)}
					className="grid gap-3"
				>
					<ChoiceCard>
						<RadioGroupItem value="required" />
						<ChoiceCardContent>
							<ChoiceCardTitle>
								<Trans>Required</Trans>
							</ChoiceCardTitle>
							<ChoiceCardDescription>
								<Trans>
									Tracking tags stay off until the visitor accepts. The default
									for the EU, UK and Saudi Arabia.
								</Trans>
							</ChoiceCardDescription>
						</ChoiceCardContent>
					</ChoiceCard>
					<ChoiceCard>
						<RadioGroupItem value="notice" />
						<ChoiceCardContent>
							<ChoiceCardTitle>
								<Trans>Notice only</Trans>
							</ChoiceCardTitle>
							<ChoiceCardDescription>
								<Trans>
									Tags load, and the visitor can opt out. The default for the
									US.
								</Trans>
							</ChoiceCardDescription>
						</ChoiceCardContent>
					</ChoiceCard>
					<ChoiceCard>
						<RadioGroupItem value="off" disabled={consent.hasTrackingTags} />
						<ChoiceCardContent>
							<ChoiceCardTitle>
								<Trans>Off</Trans>
							</ChoiceCardTitle>
							<ChoiceCardDescription>
								{consent.hasTrackingTags ? (
									<Trans>
										Not available while a tracking tag is set above.
									</Trans>
								) : (
									<Trans>
										No banner. Only for sites with no tracking tags.
									</Trans>
								)}
							</ChoiceCardDescription>
						</ChoiceCardContent>
					</ChoiceCard>
				</RadioGroup>
				<p className="text-muted-foreground text-xs">
					<Trans>
						The default for {region} is {defaultModeLabel}.
					</Trans>
				</p>
				{error ? (
					<p role="alert" className="text-destructive text-xs">
						{error}
					</p>
				) : null}
			</CardContent>
			<CardFooter>
				<Button
					type="button"
					disabled={busy || mode === consent.effective}
					onClick={() => {
						void fetcher.submit(
							{ intent: consentModeActionIntent, mode },
							{ method: 'POST' },
						)
					}}
				>
					{busy ? <Spinner /> : null}
					<Trans>Save banner setting</Trans>
				</Button>
			</CardFooter>
		</Card>
	)
}
