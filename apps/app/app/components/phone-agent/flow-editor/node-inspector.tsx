import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	MAX_MENU_REPEATS,
	MENU_KEYS,
	type FlowNodeData,
	type FlowValidationIssue,
	type MenuKey,
	type MenuOption,
} from '@repo/phone-agent'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Textarea } from '@repo/ui/textarea'
import { useId, useState, type ReactNode } from 'react'
import { FLOW_STEP_META } from './flow-meta.ts'
import { randomId, type FlowEditorNode } from './flow-model.ts'

function IssueList({ issues }: { issues: FlowValidationIssue[] }) {
	if (!issues.length) return null
	return (
		<div className="border-destructive/20 bg-destructive/5 border-b px-3 py-2.5">
			<p className="text-destructive text-xs font-medium">
				<Trans>Fix before publishing</Trans>
			</p>
			<ul className="text-destructive/90 mt-1 space-y-0.5 text-xs">
				{issues.map((issue, index) => (
					<li key={`${issue.code}-${index}`}>{issue.message}</li>
				))}
			</ul>
		</div>
	)
}

function FieldBlock({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: ReactNode
	htmlFor?: string
	hint?: ReactNode
	children: ReactNode
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
		</div>
	)
}

function InspectorHeader({
	title,
	subtitle,
	onClose,
	onDelete,
	deleteLabel,
}: {
	title: ReactNode
	subtitle?: ReactNode
	onClose: () => void
	onDelete?: () => void
	deleteLabel: string
}) {
	const { _ } = useLingui()
	return (
		<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				onClick={onClose}
				aria-label={_(msg`Back to steps`)}
			>
				<Icon name="arrow-left" className="size-4" />
			</Button>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{title}</p>
				{subtitle ? (
					<p className="text-muted-foreground truncate text-xs">{subtitle}</p>
				) : null}
			</div>
			{onDelete ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="text-muted-foreground hover:text-destructive"
					onClick={onDelete}
					title={deleteLabel}
					aria-label={deleteLabel}
				>
					<Icon name="trash-2" className="size-4" />
				</Button>
			) : null}
		</div>
	)
}

function splitKeywords(text: string) {
	return text
		.split(',')
		.map((keyword) => keyword.trim())
		.filter(Boolean)
		.slice(0, 10)
}

function OptionRow({
	option,
	takenKeys,
	readOnly,
	onChange,
	onRemove,
}: {
	option: MenuOption
	takenKeys: Set<MenuKey>
	readOnly: boolean
	onChange: (patch: Partial<MenuOption>) => void
	onRemove: () => void
}) {
	const { _ } = useLingui()
	const id = useId()
	// Kept as typed so a trailing comma survives until the next keyword.
	const [keywordText, setKeywordText] = useState(
		(option.keywords ?? []).join(', '),
	)
	const keyItems = MENU_KEYS.map((key) => ({ value: key, label: key }))

	return (
		<li className="space-y-2 rounded-lg border p-2.5">
			<div className="flex items-center gap-2">
				<Select
					items={keyItems}
					value={option.key}
					disabled={readOnly}
					onValueChange={(value) => {
						const key = MENU_KEYS.find((candidate) => candidate === value)
						if (key && (key === option.key || !takenKeys.has(key))) {
							onChange({ key })
						}
					}}
				>
					<SelectTrigger
						className="w-16 shrink-0 font-mono"
						aria-label={_(msg`Key`)}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent align="start">
						{keyItems.map((item) => (
							<SelectItem
								key={item.value}
								value={item.value}
								disabled={
									item.value !== option.key && takenKeys.has(item.value)
								}
							>
								<span className="font-mono">{item.label}</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					aria-label={_(msg`What this option does`)}
					placeholder={_(msg`e.g. Speak with our team`)}
					value={option.label}
					maxLength={80}
					disabled={readOnly}
					onChange={(event) => onChange({ label: event.target.value })}
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					disabled={readOnly}
					aria-label={_(msg`Remove option`)}
					onClick={onRemove}
				>
					<Icon name="trash-2" />
				</Button>
			</div>
			<div className="space-y-1">
				<Label htmlFor={`${id}-keywords`} className="text-xs">
					<Trans>Words callers might say</Trans>
				</Label>
				<Input
					id={`${id}-keywords`}
					placeholder={_(msg`team, person, help`)}
					value={keywordText}
					disabled={readOnly}
					onChange={(event) => {
						setKeywordText(event.target.value)
						onChange({ keywords: splitKeywords(event.target.value) })
					}}
				/>
			</div>
		</li>
	)
}

function OptionsEditor({
	options,
	readOnly,
	onChange,
}: {
	options: MenuOption[]
	readOnly: boolean
	onChange: (options: MenuOption[]) => void
}) {
	const { _ } = useLingui()
	// The saved graph has no option ids, and keying rows by the option key
	// would remount a row (dropping focus) whenever its key is changed.
	const [rowIds, setRowIds] = useState(() =>
		options.map(() => randomId('option')),
	)
	const taken = new Set(options.map((option) => option.key))
	const nextKey = MENU_KEYS.find((key) => !taken.has(key))

	return (
		<div className="space-y-2">
			<Label>
				<Trans>Options</Trans>
			</Label>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Each option gets its own connection on the canvas. Callers can press
					the key or say the option or one of its words.
				</Trans>
			</p>
			<ul className="space-y-2">
				{options.map((option, index) => (
					<OptionRow
						key={rowIds[index] ?? `row-${index}`}
						option={option}
						takenKeys={taken}
						readOnly={readOnly}
						onChange={(patch) =>
							onChange(
								options.map((entry, i) =>
									i === index ? { ...entry, ...patch } : entry,
								),
							)
						}
						onRemove={() => {
							setRowIds((current) =>
								current.filter((ignoredId, i) => i !== index),
							)
							onChange(options.filter((ignoredEntry, i) => i !== index))
						}}
					/>
				))}
			</ul>
			{readOnly || !nextKey ? null : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						setRowIds((current) => [...current, randomId('option')])
						onChange([
							...options,
							{ key: nextKey, label: _(msg`Option ${nextKey}`) },
						])
					}}
				>
					<Icon name="plus" />
					<Trans>Add option</Trans>
				</Button>
			)}
		</div>
	)
}

function MessageField({
	id,
	label,
	hint,
	value,
	readOnly,
	placeholder,
	onChange,
}: {
	id: string
	label: ReactNode
	hint?: ReactNode
	value: string
	readOnly: boolean
	placeholder?: string
	onChange: (value: string) => void
}) {
	return (
		<FieldBlock label={label} htmlFor={id} hint={hint}>
			<Textarea
				id={id}
				value={value}
				rows={4}
				maxLength={600}
				disabled={readOnly}
				placeholder={placeholder}
				onChange={(event) => onChange(event.target.value)}
			/>
		</FieldBlock>
	)
}

export function NodeInspector({
	node,
	issues,
	readOnly,
	onUpdate,
	onDelete,
	onClose,
}: {
	node: FlowEditorNode
	issues: FlowValidationIssue[]
	readOnly: boolean
	onUpdate: (nodeId: string, patch: Partial<FlowNodeData>) => void
	onDelete: (nodeId: string) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const id = useId()
	const type = node.type ?? 'play_message'
	const meta = FLOW_STEP_META[type]
	const message = node.data.message ?? ''
	const setMessage = (value: string) => onUpdate(node.id, { message: value })
	const repeatItems = Array.from(
		{ length: MAX_MENU_REPEATS + 1 },
		(ignoredValue, n) => ({
			value: String(n),
			label:
				n === 0
					? _(msg`Don't replay`)
					: n === 1
						? _(msg`Replay once`)
						: _(msg`Replay ${n} times`),
		}),
	)

	return (
		<>
			<InspectorHeader
				title={node.data.label || _(meta.title)}
				subtitle={_(meta.title)}
				onClose={onClose}
				onDelete={
					readOnly || type === 'start' ? undefined : () => onDelete(node.id)
				}
				deleteLabel={_(msg`Delete step`)}
			/>
			<IssueList issues={issues} />
			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-5 p-4">
					<FieldBlock label={<Trans>Step name</Trans>} htmlFor={`${id}-label`}>
						<Input
							id={`${id}-label`}
							value={node.data.label}
							maxLength={80}
							disabled={readOnly}
							onChange={(event) =>
								onUpdate(node.id, { label: event.target.value })
							}
						/>
					</FieldBlock>

					{type === 'start' ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								Every call starts here. Connect it to the first thing callers
								should hear.
							</Trans>
						</p>
					) : null}

					{type === 'play_message' ? (
						<MessageField
							id={`${id}-message`}
							label={<Trans>Message</Trans>}
							hint={<Trans>Read aloud, then the call moves on.</Trans>}
							value={message}
							readOnly={readOnly}
							onChange={setMessage}
						/>
					) : null}

					{type === 'keypad_menu' ? (
						<>
							<MessageField
								id={`${id}-message`}
								label={<Trans>Prompt</Trans>}
								hint={<Trans>Tell callers which key does what.</Trans>}
								value={message}
								readOnly={readOnly}
								placeholder={_(
									msg`For our hours, press 1. To speak with our team, press 2.`,
								)}
								onChange={setMessage}
							/>
							<OptionsEditor
								options={node.data.options ?? []}
								readOnly={readOnly}
								onChange={(options) => onUpdate(node.id, { options })}
							/>
							<FieldBlock
								label={<Trans>If the caller doesn't choose</Trans>}
								htmlFor={`${id}-repeat`}
								hint={
									<Trans>
										After the replays, the call follows the "No choice"
										connection, or hangs up if it isn't connected.
									</Trans>
								}
							>
								<Select
									items={repeatItems}
									value={String(node.data.repeat ?? 2)}
									disabled={readOnly}
									onValueChange={(value) => {
										if (value !== null) {
											onUpdate(node.id, { repeat: Number(value) })
										}
									}}
								>
									<SelectTrigger id={`${id}-repeat`} className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent align="start">
										{repeatItems.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</FieldBlock>
						</>
					) : null}

					{type === 'hours_check' ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								Uses your opening hours and special hours for the line the
								caller reached. Connect the Open and Closed outputs to different
								steps.
							</Trans>
						</p>
					) : null}

					{type === 'ai_agent' ? (
						<>
							<MessageField
								id={`${id}-message`}
								label={<Trans>First thing the AI says</Trans>}
								hint={
									<Trans>
										Optional. The AI always introduces itself as an AI assistant
										first. Leave empty to ask how it can help.
									</Trans>
								}
								value={message}
								readOnly={readOnly}
								placeholder={_(msg`How can I help you today?`)}
								onChange={setMessage}
							/>
							<p className="text-muted-foreground text-sm">
								<Trans>
									From here the AI handles the rest of the call: questions,
									texted links, and messages. It follows your Setup and Training
									rules, and can transfer to staff if auto-escalation is on.
								</Trans>
							</p>
						</>
					) : null}

					{type === 'text_link' ? (
						<MessageField
							id={`${id}-message`}
							label={<Trans>Say after sending</Trans>}
							hint={
								<Trans>
									The link opens your website. It's texted to the number they're
									calling from.
								</Trans>
							}
							value={message}
							readOnly={readOnly}
							placeholder={_(
								msg`We just sent you a text with a link to our website.`,
							)}
							onChange={setMessage}
						/>
					) : null}

					{type === 'transfer' ? (
						<>
							<FieldBlock
								label={<Trans>Phone number</Trans>}
								htmlFor={`${id}-phone`}
								hint={
									<Trans>
										Leave empty to use the staff number from Setup. If the
										transfer fails, the call follows "No answer".
									</Trans>
								}
							>
								<Input
									id={`${id}-phone`}
									type="tel"
									inputMode="tel"
									placeholder="+15551234567"
									value={node.data.phone ?? ''}
									maxLength={20}
									disabled={readOnly}
									onChange={(event) =>
										onUpdate(node.id, { phone: event.target.value })
									}
								/>
							</FieldBlock>
							<MessageField
								id={`${id}-message`}
								label={<Trans>Say before transferring</Trans>}
								value={message}
								readOnly={readOnly}
								placeholder={_(msg`Please hold while we connect you.`)}
								onChange={setMessage}
							/>
						</>
					) : null}

					{type === 'voicemail' ? (
						<MessageField
							id={`${id}-message`}
							label={<Trans>Prompt</Trans>}
							hint={
								<Trans>
									The message ends when the caller presses pound, stops talking,
									or hangs up. It shows up under Calls as a callback request.
								</Trans>
							}
							value={message}
							readOnly={readOnly}
							placeholder={_(
								msg`Please leave your name, number, and message after this.`,
							)}
							onChange={setMessage}
						/>
					) : null}

					{type === 'hang_up' ? (
						<MessageField
							id={`${id}-message`}
							label={<Trans>Goodbye message</Trans>}
							hint={
								<Trans>Leave empty to use the closing line from Setup.</Trans>
							}
							value={message}
							readOnly={readOnly}
							onChange={setMessage}
						/>
					) : null}
				</div>
			</ScrollArea>
		</>
	)
}
