import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FlowNodePalette, type FlowPaletteItem } from '@repo/flow-editor'
import { Badge } from '@repo/ui/badge'
import { type IconName } from '@repo/ui/icon'
import { useMemo } from 'react'
import { type PaletteItem } from './types.ts'
import { useWorkflowConfig } from './workflow-config.tsx'

const PALETTE_ICONS: Record<string, IconName> = {
	trigger: 'play',
	delay: 'clock',
	action_email: 'mail',
	action_sms: 'smartphone',
	condition: 'route',
}

interface NodePaletteProps {
	onAddNode: (item: PaletteItem) => void
	className?: string
}

export function NodePalette({ onAddNode, className }: NodePaletteProps) {
	const { _ } = useLingui()
	const { paletteItems } = useWorkflowConfig()

	const items = useMemo<FlowPaletteItem<PaletteItem['type']>[]>(
		() =>
			paletteItems.map((item) => ({
				type: item.type,
				label: item.label,
				description: item.description,
				icon: PALETTE_ICONS[item.type] ?? 'blocks',
				data: { ...item.defaultData },
				badge: item.isGated ? (
					<Badge
						variant="outline"
						className="text-muted-foreground h-4 px-1 text-[9px] uppercase"
					>
						<Trans>Pro</Trans>
					</Badge>
				) : null,
			})),
		[paletteItems],
	)

	return (
		<FlowNodePalette
			className={className}
			title={<Trans>Nodes</Trans>}
			groups={[{ id: 'nodes', items }]}
			addLabel={({ label }) => _(msg`Add ${label}`)}
			onAdd={(item) => {
				const original = paletteItems.find((entry) => entry.type === item.type)
				if (original) onAddNode(original)
			}}
		/>
	)
}
