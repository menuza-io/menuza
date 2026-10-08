import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FlowNodePalette, type FlowPaletteItem } from '@repo/flow-editor'
import { type FlowNodeType } from '@repo/phone-agent'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import {
	ACTION_STEP_TYPES,
	FLOW_STEP_META,
	MENU_STEP_TYPES,
} from './flow-meta.ts'

export function FlowHelp() {
	return (
		<div className="bg-muted rounded-lg">
			<Collapsible>
				<CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2">
					<Icon name="info" size="sm" className="text-muted-foreground" />
					<span className="text-foreground flex-1 text-start text-sm font-medium">
						<Trans>How the phone menu works</Trans>
					</span>
					<Icon
						name="chevron-down"
						size="xs"
						className="text-muted-foreground transition-transform group-data-panel-open:rotate-180"
					/>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<ul className="text-muted-foreground list-disc space-y-1.5 px-3 ps-7 pb-3 text-xs text-pretty">
						<li>
							<Trans>
								Callers hear each step in order. A keypad menu waits for them to
								press a key or say their choice, then follows that option.
							</Trans>
						</li>
						<li>
							<Trans>
								The AI assistant step hands the call to your AI. It answers
								questions using your business details, Setup, and Training rules
								until the call ends.
							</Trans>
						</li>
						<li>
							<Trans>
								Write {'{business}'} in a message to say your business's name.
							</Trans>
						</li>
					</ul>
				</CollapsibleContent>
			</Collapsible>
		</div>
	)
}

export function NodePalette({
	readOnly,
	onAdd,
}: {
	readOnly: boolean
	onAdd: (type: FlowNodeType) => void
}) {
	const { _ } = useLingui()
	const toItems = (types: readonly FlowNodeType[]) =>
		types.map((type): FlowPaletteItem<FlowNodeType> => ({
			type,
			label: _(FLOW_STEP_META[type].title),
			description: _(FLOW_STEP_META[type].description),
			icon: FLOW_STEP_META[type].icon,
		}))

	return (
		<FlowNodePalette<FlowNodeType>
			title={<Trans>Steps</Trans>}
			disabled={readOnly}
			onAdd={(item) => onAdd(item.type)}
			addLabel={({ label }) => _(msg`Add ${label}`)}
			header={
				<>
					<FlowHelp />
					{readOnly ? (
						<p className="text-muted-foreground px-1 text-xs">
							<Trans>
								You can view this phone menu, but you don't have permission to
								change it.
							</Trans>
						</p>
					) : (
						<p className="text-muted-foreground px-1 text-xs">
							<Trans>Drag a step onto the canvas, or select + to add it.</Trans>
						</p>
					)}
				</>
			}
			groups={[
				{
					id: 'menu',
					title: <Trans>Phone menu</Trans>,
					items: toItems(MENU_STEP_TYPES),
				},
				{
					id: 'actions',
					title: <Trans>Actions</Trans>,
					items: toItems(ACTION_STEP_TYPES),
				},
			]}
		/>
	)
}
