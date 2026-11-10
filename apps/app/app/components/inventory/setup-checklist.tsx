import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'
import { inventoryTabPath } from '#app/utils/inventory/nav.ts'
import {
	type InventorySetupStep,
	inventorySetupProgress,
} from '#app/utils/inventory/setup-progress.ts'

const STEP_COPY = {
	items: {
		title: msg`Add your items`,
		hint: msg`List what you buy and use, with the unit you count it in.`,
	},
	storage: {
		title: msg`Say where you keep them`,
		hint: msg`Add your fridges, freezers and shelves so counts follow your walk.`,
	},
	count: {
		title: msg`Do your first count`,
		hint: msg`Count what you have now. Every number after this starts here.`,
	},
	delivery: {
		title: msg`Record a delivery`,
		hint: msg`Enter what arrived and what you paid, so stock and costs stay right.`,
	},
} as const

/**
 * The first-run checklist on Today. `steps` must be loaded (no `unknown`
 * step): the screen shows a skeleton until the region answers.
 */
export function InventorySetupChecklist({
	steps,
	orgSlug,
	search,
	dismissed,
	onDismiss,
}: {
	steps: readonly InventorySetupStep[]
	orgSlug: string
	search: string
	dismissed: boolean
	onDismiss: () => void
}) {
	const { t, i18n } = useLingui()
	const progress = inventorySetupProgress(steps)

	if (progress.complete) {
		if (dismissed) return null
		return (
			<div
				className="text-muted-foreground flex items-center justify-between gap-3 text-sm"
				data-testid="inventory-setup-complete"
			>
				<span className="flex items-center gap-2">
					<Icon name="check-circle" className="text-success size-4" />
					<Trans>Setup complete. Inventory is ready to use.</Trans>
				</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onDismiss}
					data-testid="inventory-setup-dismiss"
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
			aria-labelledby="inventory-setup-title"
			data-testid="inventory-setup-checklist"
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-baseline justify-between gap-3">
					<h2 id="inventory-setup-title" className="text-sm font-semibold">
						<Trans>Set up inventory</Trans>
					</h2>
					<span
						className="text-muted-foreground text-sm tabular-nums"
						data-testid="inventory-setup-progress"
					>
						{t`${done} of ${total} done`}
					</span>
				</div>
				<div
					className="flex gap-1"
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={total}
					aria-valuenow={done}
					aria-label={t`Setup progress`}
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
							data-testid={`inventory-setup-step-${step.id}`}
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
									{i18n._(copy.title)}
									<span className="sr-only">
										{' '}
										{isDone ? t`Done` : t`To do`}
									</span>
								</span>
								{isDone ? null : (
									<span className="text-muted-foreground text-xs text-pretty">
										{i18n._(copy.hint)}
									</span>
								)}
							</div>
							<Button
								variant={step.next ? 'default' : 'ghost'}
								size="sm"
								render={
									<Link
										to={`${inventoryTabPath(orgSlug, step.tab)}${search}`}
									/>
								}
								data-testid={`inventory-setup-go-${step.id}`}
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
