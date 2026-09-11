import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type EmailBlock } from '@repo/common/email-blocks'
import { EmailDesignOverlay, MergeTagField } from '@repo/marketing'
import { cn } from '@repo/ui'
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
import { type Node } from '@xyflow/react'
import { useState, type ReactNode } from 'react'
import { type DelayUnit } from './types.ts'
import { useWorkflowUiLabels } from './workflow-labels.ts'
import { useWorkflowConfig } from './workflow-config.tsx'

interface NodeInspectorProps {
	node: Node | null
	onUpdateNodeData: (nodeId: string, newData: Record<string, any>) => void
	/** Apply node data and persist the journey (used by the email designer). */
	onSaveNodeData: (nodeId: string, newData: Record<string, any>) => void
	onDeleteNode: (nodeId: string) => void
	onClose: () => void
	errors?: string[]
	/** Extra header controls for the email designer (e.g. the AI toggle). */
	emailDesignerHeaderExtras?: ReactNode
	/** Content inset for the email designer (e.g. a docked AI panel). */
	emailDesignerContentClassName?: string
	className?: string
}

export function NodeInspector({
	node,
	onUpdateNodeData,
	onSaveNodeData,
	onDeleteNode,
	onClose,
	errors = [],
	emailDesignerHeaderExtras,
	emailDesignerContentClassName,
	className,
}: NodeInspectorProps) {
	const { _ } = useLingui()
	const { triggerOptions } = useWorkflowConfig()
	const { conditionFieldLabel, delayUnitLabel } = useWorkflowUiLabels()
	const [designerOpen, setDesignerOpen] = useState(false)

	if (!node) return null

	const data = (node.data || {}) as Record<string, any>
	const emailBlocks: EmailBlock[] = Array.isArray(data.blocks)
		? (data.blocks as EmailBlock[])
		: []

	const handleChange = (key: string, value: any) => {
		onUpdateNodeData(node.id, {
			...data,
			[key]: value,
		})
	}

	const handleConfigChange = (key: string, value: any) => {
		const currentConfig = (data.config || {}) as Record<string, any>
		onUpdateNodeData(node.id, {
			...data,
			config: {
				...currentConfig,
				[key]: value,
			},
		})
	}

	const insertMergeTag = (fieldKey: string, tag: string) => {
		const currentVal = data[fieldKey] || ''
		handleChange(fieldKey, `${currentVal} ${tag}`.trim())
	}

	const nodeTypeLabel = node.type?.replaceAll('_', ' ') ?? ''

	return (
		<div
			className={cn('bg-background flex h-full min-h-0 flex-col', className)}
		>
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={onClose}
					aria-label={_(msg`Back to nodes`)}
				>
					<Icon name="arrow-left" className="size-4" />
				</Button>
				<span className="min-w-0 truncate text-sm font-medium capitalize">
					{nodeTypeLabel}
				</span>
				<div className="flex-1" />
				{node.type !== 'trigger' ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="text-muted-foreground hover:text-destructive"
						onClick={() => onDeleteNode(node.id)}
						title={_(msg`Delete node`)}
						aria-label={_(msg`Delete node`)}
					>
						<Icon name="trash-2" className="size-4" />
					</Button>
				) : null}
			</div>

			{errors.length > 0 ? (
				<div className="border-destructive/20 bg-destructive/5 border-b px-3 py-2.5">
					<p className="text-destructive text-xs font-medium">
						<Trans>Configuration required</Trans>
					</p>
					<ul className="text-destructive/90 mt-1 space-y-0.5 text-xs">
						{errors.map((err, i) => (
							<li key={i}>{err}</li>
						))}
					</ul>
				</div>
			) : null}

			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-5 p-4">
					{node.type === 'trigger' && (
						<div className="space-y-4">
							<div className="space-y-1.5">
								<Label htmlFor="triggerType" className="text-xs font-medium">
									<Trans>Trigger Event Type</Trans>
								</Label>
								<Select
									value={
										data.triggerType || triggerOptions[0]?.value || 'manual'
									}
									onValueChange={(val) => handleChange('triggerType', val)}
								>
									<SelectTrigger id="triggerType" className="h-9">
										<SelectValue placeholder={_(msg`Select trigger type`)}>
											{
												triggerOptions.find(
													(option) =>
														option.value ===
														(data.triggerType ||
															triggerOptions[0]?.value ||
															'manual'),
												)?.label
											}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{triggerOptions.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										Select which event initiates this automated journey.
									</Trans>
								</p>
							</div>

							{data.triggerType === 'custom_event' && (
								<div className="space-y-1.5">
									<Label htmlFor="eventName" className="text-xs font-medium">
										<Trans>Custom Event Name</Trans>
									</Label>
									<Input
										id="eventName"
										placeholder={_(msg`e.g. checkout_abandoned, tier_upgraded`)}
										value={data.config?.eventName || ''}
										onChange={(e) =>
											handleConfigChange('eventName', e.target.value)
										}
										className="h-9"
									/>
								</div>
							)}
						</div>
					)}

					{node.type === 'delay' && (
						<div className="space-y-4">
							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-1.5">
									<Label htmlFor="duration" className="text-xs font-medium">
										<Trans>Duration</Trans>
									</Label>
									<Input
										id="duration"
										type="number"
										min="1"
										value={data.duration ?? 1}
										onChange={(e) =>
											handleChange(
												'duration',
												Math.max(1, parseInt(e.target.value) || 1),
											)
										}
										className="h-9"
									/>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="unit" className="text-xs font-medium">
										<Trans>Unit</Trans>
									</Label>
									<Select
										value={data.unit || 'hours'}
										onValueChange={(val: DelayUnit) =>
											handleChange('unit', val)
										}
									>
										<SelectTrigger id="unit" className="h-9">
											<SelectValue placeholder={_(msg`Unit`)} />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="minutes">
												<Trans>Minutes</Trans>
											</SelectItem>
											<SelectItem value="hours">
												<Trans>Hours</Trans>
											</SelectItem>
											<SelectItem value="days">
												<Trans>Days</Trans>
											</SelectItem>
											<SelectItem value="weeks">
												<Trans>Weeks</Trans>
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
							</div>

							<p className="text-muted-foreground text-[11px]">
								<Trans>
									The execution engine will durably sleep for{' '}
									{data.duration || 1} {delayUnitLabel(data.unit || 'hours')}{' '}
									before continuing to the next node.
								</Trans>
							</p>
						</div>
					)}

					{node.type === 'action_email' && (
						<div className="space-y-4">
							<div className="space-y-1.5">
								<Label htmlFor="subject" className="text-xs font-medium">
									<Trans>Subject Line</Trans>
								</Label>
								<MergeTagField
									id="subject"
									placeholder={_(msg`e.g. Welcome {{firstName}}!`)}
									value={data.subject || ''}
									onChange={(subject) => handleChange('subject', subject)}
								/>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="fromName" className="text-xs font-medium">
									<Trans>From Name (Optional)</Trans>
								</Label>
								<Input
									id="fromName"
									placeholder={_(msg`e.g. Sarah from Marketing`)}
									value={data.fromName || ''}
									onChange={(e) => handleChange('fromName', e.target.value)}
									className="h-9"
								/>
							</div>

							<div className="space-y-2">
								<Label className="text-xs font-medium">
									<Trans>Email design</Trans>
								</Label>
								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setDesignerOpen(true)}
									>
										<Icon name="paintbrush" className="size-3.5" />
										{emailBlocks.length > 0 ? (
											<Trans>Edit design</Trans>
										) : (
											<Trans>Design email</Trans>
										)}
									</Button>
									{emailBlocks.length > 0 ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="text-muted-foreground"
											onClick={() => {
												handleChange('blocks', undefined)
												handleChange(
													'bodyHtml',
													data.bodyText || '<p></p><p></p>',
												)
											}}
										>
											<Trans>Remove design</Trans>
										</Button>
									) : null}
								</div>
								<p className="text-muted-foreground text-[11px]">
									{emailBlocks.length > 0 ? (
										<Trans>
											{emailBlocks.length} blocks · rendered in your website
											branding
										</Trans>
									) : (
										<Trans>Build a branded HTML email with blocks.</Trans>
									)}
								</p>
							</div>

							{emailBlocks.length === 0 ? (
								<>
									<div className="space-y-1.5">
										<Label htmlFor="bodyHtml" className="text-xs font-medium">
											<Trans>Email HTML Body</Trans>
										</Label>
										<Textarea
											id="bodyHtml"
											rows={6}
											placeholder={_(
												msg`<p>Hi {{name}},</p><p>Welcome to our service!</p>`,
											)}
											value={data.bodyHtml || ''}
											onChange={(e) => handleChange('bodyHtml', e.target.value)}
											className="font-mono text-xs"
										/>
									</div>

									<div className="space-y-1.5">
										<Label htmlFor="bodyText" className="text-xs font-medium">
											<Trans>Plaintext Fallback (Optional)</Trans>
										</Label>
										<Textarea
											id="bodyText"
											rows={3}
											placeholder={_(msg`Hi {{name}}, Welcome to our service!`)}
											value={data.bodyText || ''}
											onChange={(e) => handleChange('bodyText', e.target.value)}
											className="text-xs"
										/>
									</div>
								</>
							) : null}

							<EmailDesignOverlay
								open={designerOpen}
								onOpenChange={setDesignerOpen}
								initialBlocks={emailBlocks}
								title={_(msg`Email design`)}
								subject={data.subject ?? ''}
								headerExtras={emailDesignerHeaderExtras}
								contentClassName={emailDesignerContentClassName}
								onSave={(blocks) => onSaveNodeData(node.id, { blocks })}
							/>
						</div>
					)}

					{node.type === 'action_sms' && (
						<div className="space-y-4">
							<div className="space-y-1">
								<span className="text-muted-foreground text-[11px] font-semibold">
									<Trans>Insert Merge Tags:</Trans>
								</span>
								<div className="flex flex-wrap gap-1.5">
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-6 px-2 font-mono text-[11px]"
										onClick={() => insertMergeTag('messageText', '{{name}}')}
									>
										+ {'{{name}}'}
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-6 px-2 font-mono text-[11px]"
										onClick={() => insertMergeTag('messageText', '{{phone}}')}
									>
										+ {'{{phone}}'}
									</Button>
								</div>
							</div>

							<div className="space-y-1.5">
								<div className="flex items-center justify-between">
									<Label htmlFor="messageText" className="text-xs font-medium">
										<Trans>SMS Message Text</Trans>
									</Label>
									<span
										className={cn(
											'font-mono text-[10px]',
											(data.messageText?.length || 0) > 160
												? 'font-semibold text-amber-500'
												: 'text-muted-foreground',
											(data.messageText?.length || 0) > 1600 &&
												'text-destructive font-bold',
										)}
									>
										<Trans>{data.messageText?.length || 0} / 1600 chars</Trans>
									</span>
								</div>
								<Textarea
									id="messageText"
									rows={5}
									placeholder={_(
										msg`Hi {{name}}, your order has been confirmed!`,
									)}
									value={data.messageText || ''}
									onChange={(e) => handleChange('messageText', e.target.value)}
									className="text-xs"
									maxLength={1600}
								/>
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										SMS messages over 160 characters will be segmented according
										to standard GSM telecommunication protocols.
									</Trans>
								</p>
							</div>
						</div>
					)}

					{node.type === 'condition' && (
						<div className="space-y-4">
							<div className="space-y-1.5">
								<Label htmlFor="field" className="text-xs font-medium">
									<Trans>Customer Attribute</Trans>
								</Label>
								<Select
									value={data.field || 'email'}
									onValueChange={(val: string) => {
										handleChange('field', val)
										if (val === 'phoneVerified') {
											handleChange('operator', 'equals')
											handleChange('value', 'true')
										} else {
											handleChange('operator', 'contains')
											handleChange('value', '')
										}
									}}
								>
									<SelectTrigger id="field" className="h-9">
										<SelectValue placeholder={_(msg`Select attribute`)} />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="email">
											<Trans>Email Address</Trans>
										</SelectItem>
										<SelectItem value="phone">
											<Trans>Phone Number</Trans>
										</SelectItem>
										<SelectItem value="phoneVerified">
											<Trans>Phone Verification Status</Trans>
										</SelectItem>
										<SelectItem value="name">
											<Trans>Name</Trans>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{data.field === 'phoneVerified' ? (
								<div className="space-y-1.5">
									<Label htmlFor="booleanValue" className="text-xs font-medium">
										<Trans>Verification Status</Trans>
									</Label>
									<Select
										value={data.value || 'true'}
										onValueChange={(val: string) => handleChange('value', val)}
									>
										<SelectTrigger id="booleanValue" className="h-9">
											<SelectValue placeholder={_(msg`Select status`)} />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="true">
												<Trans>Is Verified (True)</Trans>
											</SelectItem>
											<SelectItem value="false">
												<Trans>Not Verified (False)</Trans>
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
							) : (
								<>
									<div className="space-y-1.5">
										<Label htmlFor="operator" className="text-xs font-medium">
											<Trans>Condition Logic</Trans>
										</Label>
										<Select
											value={data.operator || 'contains'}
											onValueChange={(val: string) =>
												handleChange('operator', val)
											}
										>
											<SelectTrigger id="operator" className="h-9">
												<SelectValue placeholder={_(msg`Select operator`)} />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="equals">
													<Trans>Exactly Equals</Trans>
												</SelectItem>
												<SelectItem value="not_equals">
													<Trans>Does Not Equal</Trans>
												</SelectItem>
												<SelectItem value="contains">
													<Trans>Contains (Partial Match)</Trans>
												</SelectItem>
											</SelectContent>
										</Select>
									</div>

									<div className="space-y-1.5">
										<Label htmlFor="value" className="text-xs font-medium">
											<Trans>Target Value</Trans>
										</Label>
										<Input
											id="value"
											placeholder={_(msg`e.g. @gmail.com`)}
											value={data.value ?? ''}
											onChange={(e) => handleChange('value', e.target.value)}
											className="h-9"
										/>
									</div>
								</>
							)}

							<div className="bg-muted/40 space-y-1.5 rounded-lg border p-3 text-xs">
								<p className="text-foreground font-semibold">
									<Trans>Routing Logic:</Trans>
								</p>
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										• If Customer{' '}
										{data.field === 'phoneVerified'
											? 'Verification Status'
											: conditionFieldLabel(data.field || 'email')}
										{data.field === 'phoneVerified'
											? ' is '
											: data.operator === 'equals'
												? ' equals '
												: data.operator === 'not_equals'
													? ' does not equal '
													: ' contains '}
										<span className="text-foreground font-semibold">
											{data.field === 'phoneVerified'
												? data.value === 'true'
													? 'Verified'
													: 'Not Verified'
												: data.value || '...'}
										</span>{' '}
										&rarr;{' '}
										<span className="font-semibold text-emerald-600 dark:text-emerald-400">
											True branch
										</span>
									</Trans>
								</p>
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										• Otherwise &rarr;{' '}
										<span className="font-semibold text-rose-600 dark:text-rose-400">
											False branch
										</span>
									</Trans>
								</p>
							</div>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	)
}
