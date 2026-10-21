import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { type DashboardBlockPicker } from '#app/utils/dashboards/block-data.server.ts'
import {
	addableBuiltInBlockTypes,
	BLOCK_DEFINITIONS,
	MAX_DASHBOARD_BLOCKS,
	type BlockType,
	type DashboardBlock,
	type NewDashboardBlock,
} from '#app/utils/dashboards/config.ts'

const DEFAULT_TRIGGER = <Button type="button" variant="outline" size="sm" />

/** A titled list of blocks in the Add block dialog. */
export function AddBlockSection({
	title,
	children,
}: {
	title: string
	children: ReactNode
}) {
	const headingId = useId()
	return (
		<div
			role="group"
			aria-labelledby={headingId}
			className="flex flex-col gap-2"
		>
			<h3 id={headingId} className="text-muted-foreground text-sm font-medium">
				{title}
			</h3>
			{children}
		</div>
	)
}

/** One block that can be picked; the description is read after its name. */
export function AddBlockOption({
	title,
	description,
	onSelect,
}: {
	title: string
	description?: string
	onSelect: () => void
}) {
	const descriptionId = useId()
	return (
		<Button
			type="button"
			variant="outline"
			className="h-auto w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-start whitespace-normal"
			aria-describedby={description ? descriptionId : undefined}
			onClick={onSelect}
		>
			<span>{title}</span>
			{description ? (
				<span
					id={descriptionId}
					className="text-muted-foreground text-sm font-normal"
				>
					{description}
				</span>
			) : null}
		</Button>
	)
}

/**
 * Lists the blocks that can be added: built-in blocks that are not on the
 * dashboard yet (onboarding only while the viewer would see it), followed by
 * any `renderSections`, such as reports. A full dashboard explains the limit
 * instead.
 */
export function AddBlockDialog({
	blocks,
	picker,
	excludeTypes = [],
	onAdd,
	renderSections,
	trigger = DEFAULT_TRIGGER,
}: {
	blocks: readonly DashboardBlock[]
	picker: DashboardBlockPicker
	/** Built-in block types not to offer. */
	excludeTypes?: readonly BlockType[]
	onAdd: (block: NewDashboardBlock) => void
	/** Further sections; `select` adds a block and closes the dialog. */
	renderSections?: (select: (block: NewDashboardBlock) => void) => ReactNode
	/** The button that opens the dialog; it is labelled "Add block". */
	trigger?: ReactElement
}) {
	const { _ } = useLingui()
	const [open, setOpen] = useState(false)
	const full = blocks.length >= MAX_DASHBOARD_BLOCKS
	const builtIns = addableBuiltInBlockTypes(blocks, {
		onboardingAvailable: picker.onboardingAvailable,
		bookingsTodayAvailable: picker.bookingsToday.available,
	}).filter((type) => !excludeTypes.includes(type))

	const select = (block: NewDashboardBlock) => {
		onAdd(block)
		setOpen(false)
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={trigger}>
				<Icon name="plus" />
				<Trans>Add block</Trans>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add block</Trans>
					</DialogTitle>
					<DialogDescription>
						{full ? (
							<Trans>
								This dashboard has {MAX_DASHBOARD_BLOCKS} blocks, the most it
								can have. Remove a block to add another one.
							</Trans>
						) : (
							<Trans>
								New blocks are added at the bottom of the dashboard.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				{full ? null : (
					<div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
						<AddBlockSection title={_(msg`Built-in blocks`)}>
							{builtIns.length > 0 ? (
								<ul className="flex flex-col gap-2">
									{builtIns.map((type) => (
										<li key={type}>
											<AddBlockOption
												title={_(BLOCK_DEFINITIONS[type].title)}
												description={_(BLOCK_DEFINITIONS[type].description)}
												onSelect={() => select({ type })}
											/>
										</li>
									))}
								</ul>
							) : (
								<p className="text-muted-foreground text-sm">
									<Trans>
										All built-in blocks are already on this dashboard.
									</Trans>
								</p>
							)}
						</AddBlockSection>
						{renderSections?.(select)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
