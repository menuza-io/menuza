import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button, buttonVariants } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { useEffect, useState } from 'react'
import { Form, Link, useFetcher } from 'react-router'
import { useHomeLocation } from '#app/components/dashboard/use-home-location.ts'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { selectedLocations } from '#app/utils/dashboards/today.ts'
import {
	SKIP_REASON_MAX,
	type LaunchChecklist,
	type LaunchLocationView,
	type LaunchStepState,
	type LaunchStepView,
} from '#app/utils/launch/launch.ts'

const STEP_TEXT: Record<
	string,
	{ title: MessageDescriptor; why: MessageDescriptor }
> = {
	launch_location_details: {
		title: msg`Add the address, phone and opening hours`,
		why: msg`Guests need to know where you are and when you are open.`,
	},
	launch_menu: {
		title: msg`Build your menu`,
		why: msg`At least one category with 5 or more priced dishes, and a menu health score of 60 or more.`,
	},
	launch_branding: {
		title: msg`Upload a logo and pick the site theme`,
		why: msg`Your site should look like your restaurant.`,
	},
	launch_payments: {
		title: msg`Connect payments or choose pay at pickup`,
		why: msg`Take card payments online with Stripe or Checkout.com, or let guests pay when they collect.`,
	},
	launch_fulfillment: {
		title: msg`Set pickup, delivery and prep time`,
		why: msg`Tell guests how they get their food and how long it takes.`,
	},
	launch_station: {
		title: msg`Pair a Station terminal or kitchen display`,
		why: msg`See and run online orders on a tablet.`,
	},
	launch_test_order: {
		title: msg`Place a test order`,
		why: msg`Check the whole order flow before your guests do.`,
	},
	launch_custom_domain: {
		title: msg`Connect a custom domain`,
		why: msg`Use your own web address.`,
	},
	launch_go_live: {
		title: msg`Publish your site and turn on online ordering`,
		why: msg`The last step: guests can order.`,
	},
}

export function launchStepTitle(key: string) {
	return STEP_TEXT[key]?.title ?? msg`Setup step`
}

function StateBadge({ state }: { state: LaunchStepState }) {
	switch (state) {
		case 'done':
			return (
				<Badge variant="success">
					<Trans>Done</Trans>
				</Badge>
			)
		case 'todo':
			return (
				<Badge variant="warning">
					<Trans>To do</Trans>
				</Badge>
			)
		case 'optional':
			return (
				<Badge variant="secondary">
					<Trans>Optional</Trans>
				</Badge>
			)
		case 'skipped':
			return (
				<Badge variant="outline">
					<Trans>Skipped</Trans>
				</Badge>
			)
	}
}

function SiteQr({ url }: { url: string }) {
	const [qr, setQr] = useState<string | null>(null)
	useEffect(() => {
		let cancelled = false
		void import('qrcode')
			.then((module) =>
				module.toDataURL(url, {
					margin: 2,
					width: 240,
					errorCorrectionLevel: 'M',
					color: { dark: '#000000', light: '#ffffff' },
				}),
			)
			.then((dataUrl) => {
				if (!cancelled) setQr(dataUrl)
			})
			.catch(() => {
				if (!cancelled) setQr(null)
			})
		return () => {
			cancelled = true
		}
	}, [url])
	return qr ? (
		<img src={qr} alt="" width={120} height={120} className="rounded-md" />
	) : null
}

function YoureLive({
	checklist,
	orgSlug,
	showTellGuests,
}: {
	checklist: LaunchChecklist
	orgSlug: string
	showTellGuests: boolean
}) {
	return (
		<section
			className="bg-success/10 flex flex-wrap items-center gap-4 rounded-lg p-4"
			data-testid="launch-live"
		>
			<SiteQr url={checklist.siteUrl} />
			<div className="flex min-w-0 flex-col gap-2">
				<p className="text-base font-semibold">
					<Trans>You're live</Trans>
				</p>
				<a
					href={checklist.siteUrl}
					target="_blank"
					rel="noreferrer"
					className="text-primary truncate text-sm underline-offset-4 hover:underline"
				>
					<bdi>{checklist.siteUrl}</bdi>
				</a>
				{showTellGuests ? (
					<Form method="post" action={`/${orgSlug}/launch`}>
						<input type="hidden" name="intent" value="tell-guests" />
						<Button type="submit" size="sm" data-testid="launch-tell-guests">
							<Trans>Tell your guests</Trans>
						</Button>
					</Form>
				) : null}
			</div>
		</section>
	)
}

function SkipForm({
	step,
	organizationId,
	locationId,
}: {
	step: LaunchStepView
	organizationId: string
	locationId: string
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok: boolean }>()
	const [open, setOpen] = useState(false)
	if (!open) {
		return (
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen(true)}
				data-testid={`launch-skip-${step.key}`}
			>
				<Trans>Skip</Trans>
			</Button>
		)
	}
	return (
		<fetcher.Form
			method="post"
			action="/api/onboarding/skip-step"
			className="flex flex-wrap items-center gap-2"
		>
			<input type="hidden" name="organizationId" value={organizationId} />
			<input type="hidden" name="locationId" value={locationId} />
			<input type="hidden" name="stepKey" value={step.key} />
			<Input
				name="reason"
				maxLength={SKIP_REASON_MAX}
				placeholder={_(msg`Reason (optional)`)}
				aria-label={_(msg`Reason (optional)`)}
				className="h-8 w-48"
			/>
			<Button type="submit" size="sm" disabled={fetcher.state !== 'idle'}>
				<Trans>Skip step</Trans>
			</Button>
		</fetcher.Form>
	)
}

function StepRow({
	step,
	orgSlug,
	organizationId,
	locationId,
	canSkip,
	canChoosePayAtPickup,
	compact,
}: {
	step: LaunchStepView
	orgSlug: string
	organizationId: string
	locationId: string
	canSkip: boolean
	canChoosePayAtPickup: boolean
	compact: boolean
}) {
	const { _ } = useLingui()
	const text = STEP_TEXT[step.key]
	const pending = step.state !== 'done'
	const skipReason = step.skipReason
	return (
		<li
			className="border-border flex flex-col gap-1.5 border-b pb-2 last:border-b-0"
			data-testid={`launch-step-${step.key}`}
			data-state={step.state}
		>
			<div className="flex items-start justify-between gap-2">
				<p className="text-sm font-medium">{text ? _(text.title) : step.key}</p>
				<StateBadge state={step.state} />
			</div>
			{!compact && text ? (
				<p className="text-muted-foreground text-xs">{_(text.why)}</p>
			) : null}
			{step.state === 'skipped' && skipReason ? (
				<p className="text-muted-foreground text-xs">
					<Trans>Skipped: {skipReason}</Trans>
				</p>
			) : null}
			{pending ? (
				<div className="flex flex-wrap items-center gap-2">
					<Link
						to={`/${orgSlug}${step.href}`}
						className={buttonVariants({ variant: 'outline', size: 'sm' })}
					>
						<Trans>Open</Trans>
					</Link>
					{step.key === 'launch_payments' &&
					canChoosePayAtPickup &&
					!compact ? (
						<Form method="post" action={`/${orgSlug}/launch`}>
							<input type="hidden" name="intent" value="pay-at-pickup-only" />
							<Button type="submit" variant="ghost" size="sm">
								<Trans>Use pay at pickup only</Trans>
							</Button>
						</Form>
					) : null}
					{step.optional && step.state === 'optional' && canSkip && !compact ? (
						<SkipForm
							step={step}
							organizationId={organizationId}
							locationId={locationId}
						/>
					) : null}
				</div>
			) : null}
		</li>
	)
}

function RequiredProgress({ done, total }: { done: number; total: number }) {
	return (
		<p className="text-muted-foreground text-xs">
			<Trans>
				{done} of {total} required steps done
			</Trans>
		</p>
	)
}

/**
 * The restaurant launch checklist for one location (the home picker's choice,
 * or the first location under All locations). Compact on the home page; the
 * full page adds the why, skipping optional steps and pay at pickup.
 */
export function LaunchChecklistView({
	checklist,
	orgSlug,
	organizationId,
	locationStorageKey,
	compact = false,
	canSkip = false,
	canChoosePayAtPickup = false,
	canTellGuests = false,
}: {
	checklist: LaunchChecklist
	orgSlug: string
	organizationId: string
	locationStorageKey: string
	compact?: boolean
	canSkip?: boolean
	canChoosePayAtPickup?: boolean
	canTellGuests?: boolean
}) {
	const { _ } = useLingui()
	const [selection, setSelection] = useHomeLocation(locationStorageKey)
	const [location] = selectedLocations(checklist.locations, selection) as [
		LaunchLocationView | undefined,
	]
	// On the home page "Tell your guests" is offered once per organization;
	// the launch page always has it.
	const showTellGuests = canTellGuests && (!compact || !checklist.guestsOffered)

	return (
		<Card className="h-full overflow-auto" data-testid="launch-checklist">
			<CardContent className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex flex-col">
						<h3 className="text-sm font-semibold">
							<Trans>Get ready to take orders</Trans>
						</h3>
						{location ? (
							<RequiredProgress
								done={location.requiredDone}
								total={location.requiredTotal}
							/>
						) : null}
					</div>
					<div className="flex items-center gap-2">
						{checklist.locations.length > 1 ? (
							<FilterSelect
								label={_(msg`Location`)}
								options={checklist.locations.map((entry) => ({
									value: entry.id,
									label: entry.name,
								}))}
								value={location?.id ?? ''}
								onValueChange={setSelection}
								testId="launch-location"
							/>
						) : null}
						{compact ? (
							<Link
								to={`/${orgSlug}/launch`}
								className={buttonVariants({ variant: 'ghost', size: 'xs' })}
							>
								<Trans>See all</Trans>
							</Link>
						) : null}
					</div>
				</div>
				{!location ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Add a location to start your launch checklist.</Trans>
					</p>
				) : (
					<>
						{location.live ? (
							<YoureLive
								checklist={checklist}
								orgSlug={orgSlug}
								showTellGuests={showTellGuests}
							/>
						) : null}
						<ol className="flex flex-col gap-2">
							{location.steps.map((step) => (
								<StepRow
									key={step.key}
									step={step}
									orgSlug={orgSlug}
									organizationId={organizationId}
									locationId={location.id}
									canSkip={canSkip}
									canChoosePayAtPickup={canChoosePayAtPickup}
									compact={compact}
								/>
							))}
						</ol>
					</>
				)}
			</CardContent>
		</Card>
	)
}
