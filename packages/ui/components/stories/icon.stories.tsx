import { type Meta, type StoryObj } from '@storybook/react'
import { useState } from 'react'
import { Icon, type IconName } from '../icon'

// All available icons from the IconName type
const allIconNames: IconName[] = [
	'activity-log',
	'activity',
	'alert-triangle',
	'arrow-left',
	'arrow-right',
	'asana',
	'badge-question-mark',
	'ban',
	'bell',
	'blocks',
	'bot',
	'building',
	'calendar',
	'camera',
	'chat-bubble',
	'check-circle',
	'check-circled',
	'check',
	'chevron-down',
	'chevron-left',
	'chevron-right',
	'chevron-up',
	'chevrons-left',
	'chevrons-right',
	'circle-check',
	'clickup',
	'clock',
	'cog',
	'command',
	'copy',
	'credit-card',
	'database',
	'download',
	'edit',
	'ellipsis-vertical',
	'ellipsis',
	'external-link',
	'file-text',
	'folder-open',
	'folder',
	'frown',
	'gear',
	'github',
	'gitlab',
	'google',
	'grip-vertical',
	'hamburger-menu',
	'height',
	'help-circle',
	'image',
	'jira',
	'key',
	'laptop',
	'linear',
	'link-2',
	'loader',
	'lock',
	'log-out',
	'logs',
	'mail',
	'meh',
	'menu',
	'message-circle',
	'message-square',
	'minus',
	'moon',
	'more-horizontal',
	'more-vertical',
	'notion',
	'octagon-alert',
	'panel-left',
	'paper-plane',
	'paperclip',
	'passkey',
	'pencil',
	'person',
	'plane',
	'plug',
	'plus',
	'pocket-knife',
	'refresh-cw',
	'search',
	'send',
	'settings',
	'share-2',
	'shield-check',
	'shield',
	'signal-high',
	'signal-low',
	'signal-medium',
	'slack',
	'smile',
	'sparkles',
	'star-off',
	'star',
	'sticky-note',
	'sun',
	'tag',
	'trash-2',
	'trello',
	'trending-down',
	'trending-up',
	'undo-2',
	'unlock',
	'user-plus',
	'user',
	'users',
	'width',
	'x',
]

const meta = {
	title: 'Components/Icon',
	component: Icon,

	tags: ['autodocs'],
	argTypes: {
		name: {
			control: 'select',
			options: allIconNames,
		},
		size: {
			control: 'select',
			options: ['font', 'xs', 'sm', 'md', 'lg', 'xl'],
		},
	},
} satisfies Meta<typeof Icon>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	args: {
		name: 'star',
		size: 'md',
	},
}

export const WithText: Story = {
	args: {
		name: 'check-circle',
		size: 'font',
		children: 'Success',
	},
}

export const Sizes: Story = {
	args: {
		name: 'star',
	},
	render: () => (
		<div className="flex items-center gap-4">
			<div className="flex flex-col items-center gap-2">
				<Icon name="star" size="xs" />
				<span className="text-muted-foreground text-xs">xs</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<Icon name="star" size="sm" />
				<span className="text-muted-foreground text-xs">sm</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<Icon name="star" size="md" />
				<span className="text-muted-foreground text-xs">md</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<Icon name="star" size="lg" />
				<span className="text-muted-foreground text-xs">lg</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<Icon name="star" size="xl" />
				<span className="text-muted-foreground text-xs">xl</span>
			</div>
		</div>
	),
}

export const AllIcons: Story = {
	args: {
		name: 'star',
	},
	render: () => {
		const [searchTerm, setSearchTerm] = useState('')
		const [copiedIcon, setCopiedIcon] = useState<string | null>(null)

		const filteredIcons = allIconNames.filter((iconName) =>
			iconName.toLowerCase().includes(searchTerm.toLowerCase()),
		)

		const handleCopyToClipboard = async (iconName: IconName) => {
			const componentCode = `<Icon name="${iconName}" size="md" />`
			try {
				await navigator.clipboard.writeText(componentCode)
				setCopiedIcon(iconName)
				setTimeout(() => setCopiedIcon(null), 2000)
			} catch (err) {
				console.error('Failed to copy:', err)
			}
		}

		return (
			<div className="max-w-6xl p-8">
				<h2 className="mb-4 text-2xl font-bold">
					All Available Icons ({allIconNames.length})
				</h2>

				{/* Search Input */}
				<div className="mb-6">
					<input
						type="text"
						placeholder="Search icons..."
						value={searchTerm}
						onChange={(e) => setSearchTerm(e.target.value)}
						className="border-border bg-background focus:ring-ring w-full max-w-md rounded-lg border px-4 py-2 focus:ring-2 focus:outline-none"
					/>
					{searchTerm && (
						<p className="text-muted-foreground mt-2 text-sm">
							Found {filteredIcons.length} icon
							{filteredIcons.length !== 1 ? 's' : ''}
						</p>
					)}
				</div>

				<div className="grid grid-cols-4 gap-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
					{filteredIcons.map((iconName) => (
						<div
							key={iconName}
							className="hover:bg-muted group hover:border-border relative flex cursor-pointer flex-col items-center justify-center rounded-lg border border-transparent p-3 transition-colors"
							title={`Click to copy: <Icon name="${iconName}" />`}
							onClick={() => handleCopyToClipboard(iconName)}
						>
							<Icon name={iconName} size="lg" className="mb-2" />
							<span className="text-muted-foreground group-hover:text-foreground text-center text-[10px] leading-tight break-all">
								{iconName}
							</span>
							{copiedIcon === iconName && (
								<div className="bg-background/90 absolute inset-0 flex items-center justify-center rounded-lg">
									<span className="text-xs font-medium text-green-600">
										Copied!
									</span>
								</div>
							)}
						</div>
					))}
				</div>

				{filteredIcons.length === 0 && (
					<div className="py-12 text-center">
						<p className="text-muted-foreground">
							No icons found matching "{searchTerm}"
						</p>
					</div>
				)}
			</div>
		)
	},
	parameters: {
		layout: 'fullscreen',
	},
}

export const IconCategories: Story = {
	args: {
		name: 'star',
	},
	render: () => {
		const [searchTerm, setSearchTerm] = useState('')
		const [copiedIcon, setCopiedIcon] = useState<string | null>(null)

		const categories = {
			Navigation: [
				'arrow-left',
				'arrow-right',
				'chevron-down',
				'chevron-left',
				'chevron-right',
				'chevron-up',
				'chevrons-left',
				'chevrons-right',
				'external-link',
				'link-2',
			],
			Actions: [
				'check',
				'check-circle',
				'check-circled',
				'circle-check',
				'copy',
				'download',
				'edit',
				'pencil',
				'plus',
				'minus',
				'trash-2',
				'x',
				'send',
				'share-2',
				'refresh-cw',
				'undo-2',
			],
			UI: [
				'menu',
				'hamburger-menu',
				'command',
				'search',
				'settings',
				'cog',
				'gear',
				'ellipsis',
				'ellipsis-vertical',
				'more-horizontal',
				'more-vertical',
				'grip-vertical',
				'panel-left',
			],
			Communication: [
				'mail',
				'message-circle',
				'message-square',
				'chat-bubble',
				'bell',
				'paper-plane',
				'plane',
				'paperclip',
			],
			Users: ['user', 'users', 'user-plus', 'person'],
			Security: ['lock', 'unlock', 'shield', 'shield-check', 'key', 'passkey'],
			Files: ['file-text', 'folder', 'folder-open', 'image', 'camera'],
			Status: [
				'check-circle',
				'alert-triangle',
				'octagon-alert',
				'help-circle',
				'badge-question-mark',
				'ban',
				'loader',
				'activity',
				'activity-log',
			],
			Integrations: [
				'github',
				'gitlab',
				'google',
				'slack',
				'asana',
				'clickup',
				'jira',
				'linear',
				'notion',
				'trello',
			],
			Misc: [
				'star',
				'star-off',
				'calendar',
				'clock',
				'sun',
				'moon',
				'smile',
				'meh',
				'frown',
				'sparkles',
				'tag',
				'credit-card',
				'database',
				'laptop',
				'log-out',
				'logs',
				'plug',
				'pocket-knife',
				'sticky-note',
				'bot',
				'building',
				'blocks',
				'signal-high',
				'signal-medium',
				'signal-low',
				'trending-up',
				'trending-down',
				'height',
				'width',
			],
		}

		const handleCopyToClipboard = async (iconName: string) => {
			const componentCode = `<Icon name="${iconName}" size="md" />`
			try {
				await navigator.clipboard.writeText(componentCode)
				setCopiedIcon(iconName)
				setTimeout(() => setCopiedIcon(null), 2000)
			} catch (err) {
				console.error('Failed to copy:', err)
			}
		}

		// Filter categories based on search term
		const filteredCategories = Object.entries(categories).reduce(
			(acc, [category, icons]) => {
				const filteredIcons = icons.filter((iconName) =>
					iconName.toLowerCase().includes(searchTerm.toLowerCase()),
				)
				if (filteredIcons.length > 0) {
					acc[category] = filteredIcons
				}
				return acc
			},
			{} as Record<string, string[]>,
		)

		const totalFilteredIcons = Object.values(filteredCategories).flat().length

		return (
			<div className="max-w-6xl p-8">
				<h2 className="mb-4 text-2xl font-bold">Icon Categories</h2>

				{/* Search Input */}
				<div className="mb-6">
					<input
						type="text"
						placeholder="Search icons..."
						value={searchTerm}
						onChange={(e) => setSearchTerm(e.target.value)}
						className="border-border bg-background focus:ring-ring w-full max-w-md rounded-lg border px-4 py-2 focus:ring-2 focus:outline-none"
					/>
					{searchTerm && (
						<p className="text-muted-foreground mt-2 text-sm">
							Found {totalFilteredIcons} icon
							{totalFilteredIcons !== 1 ? 's' : ''} in{' '}
							{Object.keys(filteredCategories).length} categor
							{Object.keys(filteredCategories).length !== 1 ? 'ies' : 'y'}
						</p>
					)}
				</div>

				{Object.keys(filteredCategories).length > 0 ? (
					<div className="space-y-8">
						{Object.entries(filteredCategories).map(([category, icons]) => (
							<div key={category}>
								<h3 className="mb-4 text-lg">{category}</h3>
								<div className="grid grid-cols-4 gap-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
									{icons.map((iconName) => (
										<div
											key={iconName}
											className="hover:bg-muted group hover:border-border relative flex cursor-pointer flex-col items-center justify-center rounded-lg border border-transparent p-3 transition-colors"
											title={`Click to copy: <Icon name="${iconName}" />`}
											onClick={() => handleCopyToClipboard(iconName)}
										>
											<Icon
												name={iconName as IconName}
												size="lg"
												className="mb-2"
											/>
											<span className="text-muted-foreground group-hover:text-foreground text-center text-[10px] leading-tight break-all">
												{iconName}
											</span>
											{copiedIcon === iconName && (
												<div className="bg-background/90 absolute inset-0 flex items-center justify-center rounded-lg">
													<span className="text-xs font-medium text-green-600">
														Copied!
													</span>
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						))}
					</div>
				) : (
					<div className="py-12 text-center">
						<p className="text-muted-foreground">
							No icons found matching "{searchTerm}"
						</p>
					</div>
				)}
			</div>
		)
	},
	parameters: {
		layout: 'fullscreen',
	},
}
