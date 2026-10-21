import { plural } from '@lingui/core/macro'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Link } from 'react-router'
import {
	type SetupStep,
	type SetupStepId,
	setupProgress,
} from '#app/utils/reservations/setup-progress.ts'

const STEP_COPY = {
	hours: {
		title: msg`Hours & services`,
		hint: msg`Add the hours and meal periods guests can book.`,
	},
	tables: {
		title: msg`Tables`,
		hint: msg`Add the tables guests are seated at.`,
	},
	rules: {
		title: msg`Booking rules`,
		hint: msg`Check party sizes, notice and how far ahead guests can book.`,
	},
	messages: {
		title: msg`Guest messages`,
		hint: msg`Choose the confirmations and reminders guests receive.`,
	},
	test: {
		title: msg`Test a booking`,
		hint: msg`Make one booking yourself to see what guests see.`,
	},
} as const

export function setupStepHref(
	step: Pick<SetupStep, 'tab'>,
	orgSlug: string,
	search: string,
): string {
	const base = `/${orgSlug}/reservations`
	if (step.tab === 'book') return `${base}/book${search}`
	if (step.tab === 'rules') return `${base}/settings${search}`
	return `${base}/settings/${step.tab}${search}`
}

export function SetupChecklist({
	steps,
	orgSlug,
	search,
	dismissed,
	onGo,
	onDismiss,
}: {
	steps: readonly SetupStep[]
	orgSlug: string
	search: string
	dismissed: boolean
	onGo: (id: SetupStepId) => void
	onDismiss: () => void
}) {
	const { _ } = useLingui()
	const progress = setupProgress(steps)

	if (progress.loading) {
		return (
			<Skeleton
				className="h-40 w-full rounded-xl"
				data-testid="setup-checklist-skeleton"
			/>
		)
	}

	if (progress.complete) {
		if (dismissed) return null
		return (
			<div
				className="text-muted-foreground flex items-center justify-between gap-3 text-sm"
				data-testid="setup-checklist-complete"
			>
				<span className="flex items-center gap-2">
					<Icon name="check-circle" className="text-success size-4" />
					<Trans>Setup complete. Guests can book.</Trans>
				</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onDismiss}
					data-testid="setup-checklist-dismiss"
				>
					<Trans>Dismiss</Trans>
				</Button>
			</div>
		)
	}

	const done = progress.done
	const total = progress.total
	return (
		<section
			className="bg-card shadow-card flex flex-col gap-4 rounded-xl border p-4"
			aria-labelledby="setup-checklist-title"
			data-testid="setup-checklist"
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-baseline justify-between gap-3">
					<h2 id="setup-checklist-title" className="text-sm font-semibold">
						<Trans>Set up reservations</Trans>
					</h2>
					<span
						className="text-muted-foreground text-sm tabular-nums"
						data-testid="setup-checklist-progress"
					>
						{_(msg`${done} of ${total} done`)}
					</span>
				</div>
				<div
					className="flex gap-1"
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={total}
					aria-valuenow={done}
					aria-label={_(msg`Setup progress`)}
				>
					{steps.map((step) => (
						<span
							key={step.id}
							className={cn(
								'h-1 flex-1 rounded-full',
								step.status === 'done' ? 'bg-success' : 'bg-muted',
							)}
						/>
					))}
				</div>
			</div>
			<ol className="flex flex-col">
				{steps.map((step, index) => {
					const copy = STEP_COPY[step.id]
					const isDone = step.status === 'done'
					return (
						<li
							key={step.id}
							className="flex min-h-11 items-center gap-3 border-t py-2 first:border-t-0"
							data-testid={`setup-step-${step.id}`}
							data-status={step.status}
						>
							<span
								className={cn(
									'text-2xs flex size-5 shrink-0 items-center justify-center rounded-full font-medium',
									isDone
										? 'bg-success/15 text-success'
										: step.next
											? 'bg-primary text-primary-foreground'
											: 'bg-muted text-muted-foreground',
								)}
								aria-hidden
							>
								{isDone ? <Icon name="check" className="size-3" /> : index + 1}
							</span>
							<div className="flex min-w-0 flex-1 flex-col">
								<span
									className={cn(
										'text-sm font-medium',
										isDone && 'text-muted-foreground',
									)}
								>
									{_(copy.title)}
									<span className="sr-only">
										{' '}
										{isDone ? _(msg`Done`) : _(msg`To do`)}
									</span>
								</span>
								{isDone ? null : (
									<span className="text-muted-foreground text-xs text-pretty">
										{_(copy.hint)}
									</span>
								)}
							</div>
							<Button
								variant={step.next ? 'default' : 'ghost'}
								size="sm"
								render={
									<Link
										to={setupStepHref(step, orgSlug, search)}
										onClick={() => onGo(step.id)}
									/>
								}
								data-testid={`setup-step-go-${step.id}`}
							>
								{isDone ? <Trans>Review</Trans> : <Trans>Go</Trans>}
								<Icon name="arrow-right" className="rtl:rotate-180" />
							</Button>
						</li>
					)
				})}
			</ol>
		</section>
	)
}

export function setupSuggestionCountLabel(count: number): string {
	return plural(count, { one: '# suggestion', other: '# suggestions' })
}
