import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type EmailBlock } from '@repo/common/email-blocks'
import {
	AiDraftButton,
	AiDraftDialog,
	CouponOfferField,
	type CouponOfferValue,
	EmailDesignOverlay,
	MergeTagField,
	RewriteWithAi,
} from '@repo/marketing'
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
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { type Node } from '@xyflow/react'
import { useState, type ReactNode } from 'react'
import { type DelayUnit } from './types.ts'
import { useWorkflowConfig } from './workflow-config.tsx'
import { useWorkflowUiLabels } from './workflow-labels.ts'

/** Merge tags are passed as values: Lingui reads literal braces as a placeholder. */
const FIRST_NAME_TAG = '{{firstName}}'
const NAME_TAG = '{{name}}'

/** Condition fields computed from a guest's history (numbers) or reservations (yes / no). */
const NUMERIC_CONDITION_FIELDS: string[] = [
	'orders_last_30_days',
	'orders_last_90_days',
	'days_since_last_order',
	'lifetime_spend',
]
const BOOLEAN_BEHAVIOR_FIELDS: string[] = ['has_upcoming_reservation']
const BOOLEAN_CONDITION_FIELDS: string[] = [
	'phoneVerified',
	...BOOLEAN_BEHAVIOR_FIELDS,
]

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

function truncateSmsMergeTags(text: string, maxLength = 1600): string {
	if (text.length <= maxLength) return text
	let sliced = text.slice(0, maxLength)
	const lastOpen = sliced.lastIndexOf('{{')
	const lastClose = sliced.lastIndexOf('}}')
	if (lastOpen !== -1 && (lastClose === -1 || lastClose < lastOpen)) {
		sliced = sliced.slice(0, lastOpen)
	}
	return sliced
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
	const {
		triggerOptions,
		hiddenTriggerTypes,
		couponOptions,
		emailMenuItems,
		emailTemplatesEndpoint,
		audienceOptions,
	} = useWorkflowConfig()
	const { conditionFieldLabel, delayUnitLabel } = useWorkflowUiLabels()
	const [designerOpen, setDesignerOpen] = useState(false)
	const [aiDraftOpen, setAiDraftOpen] = useState(false)

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

	const nodeTypeLabel = node.type?.replaceAll('_', ' ') ?? ''

	// A saved coupon stays visible even when the picker is hidden for this
	// user, so it is never dropped by accident.
	const couponValue = (data.discountOffer ?? null) as CouponOfferValue | null
	const couponField =
		couponOptions || couponValue ? (
			<CouponOfferField
				compact
				options={couponOptions ?? []}
				value={couponValue}
				onChange={(offer) => handleChange('discountOffer', offer ?? undefined)}
			/>
		) : null

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
									<SelectTrigger id="triggerType" className="h-11">
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
										{triggerOptions
											.filter(
												(option) =>
													!hiddenTriggerTypes?.includes(option.value) ||
													option.value === data.triggerType,
											)
											.map((option) => (
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

							{data.triggerType !== 'manual' &&
							data.triggerType !== 'custom_event' ? (
								<div className="flex items-start justify-between gap-3 rounded-lg border p-3">
									<div className="space-y-1">
										<Label htmlFor="goalOrder" className="text-xs font-medium">
											<Trans>Stop when the guest places an order</Trans>
										</Label>
										<p className="text-muted-foreground text-[11px]">
											<Trans>
												Checked before every step, including after a delay.
												Guests who order are not sent the rest of this
												automation.
											</Trans>
										</p>
									</div>
									<Switch
										id="goalOrder"
										checked={data.config?.goal === 'order'}
										onCheckedChange={(checked) =>
											handleConfigChange('goal', checked ? 'order' : undefined)
										}
									/>
								</div>
							) : null}

							{data.triggerType === 'order_completed' && (
								<div className="space-y-1.5">
									<Label htmlFor="nth" className="text-xs font-medium">
										<Trans>Only the Nth order</Trans>
									</Label>
									<Input
										id="nth"
										type="number"
										min="1"
										max="1000"
										placeholder={_(msg`Every order`)}
										value={data.config?.nth ?? ''}
										onChange={(e) => {
											const n = parseInt(e.target.value)
											handleConfigChange(
												'nth',
												Number.isFinite(n) && n >= 1
													? Math.min(n, 1000)
													: undefined,
											)
										}}
										className="h-11"
									/>
									<p className="text-muted-foreground text-[11px]">
										<Trans>
											Leave empty to run for every completed order, or enter 3
											to run only for a guest's third order.
										</Trans>
									</p>
								</div>
							)}

							{data.triggerType === 'guest_lapsed' && (
								<div className="space-y-1.5">
									<Label htmlFor="lapsedDays" className="text-xs font-medium">
										<Trans>Days without an order</Trans>
									</Label>
									<Select
										value={String(data.config?.days ?? 60)}
										onValueChange={(val) =>
											handleConfigChange('days', parseInt(val ?? '') || 60)
										}
									>
										<SelectTrigger id="lapsedDays" className="h-11">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{[30, 60, 90, 120, 180].map((days) => (
												<SelectItem key={days} value={String(days)}>
													{days}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<p className="text-muted-foreground text-[11px]">
										<Trans>
											Runs once per quiet spell, for a guest who ordered at
											least once. It starts again after their next order.
										</Trans>
									</p>
								</div>
							)}

							{data.triggerType === 'birthday_coming_up' && (
								<div className="space-y-1.5">
									<Label htmlFor="daysBefore" className="text-xs font-medium">
										<Trans>Days before the birthday</Trans>
									</Label>
									<Input
										id="daysBefore"
										type="number"
										min="0"
										max="60"
										value={data.config?.daysBefore ?? 7}
										onChange={(e) =>
											handleConfigChange(
												'daysBefore',
												Math.min(
													60,
													Math.max(0, parseInt(e.target.value) || 0),
												),
											)
										}
										className="h-11"
									/>
									<p className="text-muted-foreground text-[11px]">
										<Trans>
											Starts at 10:00 local time, once a year. A birthday alone
											is not consent: guests who did not agree to hear from you
											get nothing.
										</Trans>
									</p>
								</div>
							)}

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
										className="h-11"
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
										className="h-11"
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
										<SelectTrigger id="unit" className="h-11">
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
									placeholder={_(msg`e.g. Welcome ${FIRST_NAME_TAG}!`)}
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
									className="h-11"
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
									<AiDraftButton onClick={() => setAiDraftOpen(true)} />
									{emailBlocks.length > 0 ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="text-muted-foreground"
											onClick={() => {
												onUpdateNodeData(node.id, {
													...data,
													blocks: undefined,
													bodyHtml: data.bodyText || '<p></p><p></p>',
												})
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
												msg`<p>Hi ${NAME_TAG},</p><p>Welcome to our service!</p>`,
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
											placeholder={_(
												msg`Hi ${NAME_TAG}, Welcome to our service!`,
											)}
											value={data.bodyText || ''}
											onChange={(e) => handleChange('bodyText', e.target.value)}
											className="text-xs"
										/>
									</div>
								</>
							) : null}

							{couponField}

							{/* AI only FILLS the step (subject and design); the author reviews
							    it in the designer and saves the automation as usual. */}
							<AiDraftDialog
								open={aiDraftOpen}
								onOpenChange={setAiDraftOpen}
								channel="email"
								hasContent={
									emailBlocks.length > 0 ||
									Boolean(data.bodyHtml && data.bodyHtml.trim().length > 7)
								}
								onApply={(draft) => {
									if (draft.channel !== 'email') return
									onUpdateNodeData(node.id, {
										...data,
										subject: draft.subject,
										blocks: draft.blocks,
										emailFormat: 'designed',
									})
								}}
							/>

							<EmailDesignOverlay
								open={designerOpen}
								onOpenChange={setDesignerOpen}
								initialBlocks={emailBlocks}
								title={_(msg`Email design`)}
								subject={data.subject ?? ''}
								headerExtras={emailDesignerHeaderExtras}
								// eslint-disable-next-line shadcn/require-static-classes -- callers forward a static content inset
								contentClassName={emailDesignerContentClassName}
								onSave={(blocks) => onSaveNodeData(node.id, { blocks })}
								// Sent journey emails carry a signed unsubscribe link.
								unsubscribeLinkPreview
								menuItems={emailMenuItems}
								templatesEndpoint={emailTemplatesEndpoint}
								couponAvailable={Boolean(couponValue)}
								requestFields={{
									discountOffer: couponValue ? JSON.stringify(couponValue) : '',
								}}
							/>
						</div>
					)}

					{node.type === 'action_push' && (
						<div className="space-y-4">
							<div className="space-y-1.5">
								<Label htmlFor="pushTitle" className="text-xs font-medium">
									<Trans>Push title</Trans>
								</Label>
								<Input
									id="pushTitle"
									maxLength={65}
									value={(data.title as string) || ''}
									onChange={(event) =>
										handleChange('title', event.target.value)
									}
									className="text-xs"
								/>
							</div>
							<div className="space-y-1.5">
								<div className="flex items-center justify-between">
									<Label htmlFor="pushBody" className="text-xs font-medium">
										<Trans>Push message</Trans>
									</Label>
									<span className="text-muted-foreground font-mono text-[10px]">
										<Trans>
											{(data.body as string | undefined)?.length || 0} / 178
											chars
										</Trans>
									</span>
								</div>
								<Textarea
									id="pushBody"
									rows={4}
									maxLength={178}
									value={(data.body as string) || ''}
									onChange={(event) => handleChange('body', event.target.value)}
									className="text-xs"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="pushLink" className="text-xs font-medium">
									<Trans>Opens (a page of your site)</Trans>
								</Label>
								<Input
									id="pushLink"
									placeholder="/menu"
									value={(data.link as string) || ''}
									onChange={(event) =>
										handleChange('link', event.target.value || undefined)
									}
									className="text-xs"
								/>
							</div>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Guests who turned on offers in the app get this once per run.
									A push holds no personal data, so merge tags are not
									available.
								</Trans>
							</p>
						</div>
					)}

					{node.type === 'action_sms' && (
						<div className="space-y-4">
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
								<MergeTagField
									id="messageText"
									multiline
									rows={5}
									placeholder={_(
										msg`Hi ${NAME_TAG}, your order has been confirmed!`,
									)}
									value={data.messageText || ''}
									onChange={(value) =>
										handleChange(
											'messageText',
											truncateSmsMergeTags(value, 1600),
										)
									}
									className="text-xs"
								/>
								<div className="flex flex-wrap items-center gap-1">
									<AiDraftButton onClick={() => setAiDraftOpen(true)} />
									<RewriteWithAi
										sms
										text={data.messageText || ''}
										onRewrite={(value) =>
											handleChange(
												'messageText',
												truncateSmsMergeTags(value, 1600),
											)
										}
									/>
								</div>
								<AiDraftDialog
									open={aiDraftOpen}
									onOpenChange={setAiDraftOpen}
									channel="sms"
									hasContent={(data.messageText || '').trim().length > 0}
									onApply={(draft) => {
										if (draft.channel !== 'sms') return
										handleChange(
											'messageText',
											truncateSmsMergeTags(draft.message, 1600),
										)
									}}
								/>
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										SMS messages over 160 characters will be segmented according
										to standard GSM telecommunication protocols. Every text ends
										with &quot;Reply STOP to opt out.&quot; and goes out between
										9:00 and 20:00 local time: a step that comes up at night
										waits for the morning.
									</Trans>
								</p>
							</div>
							{couponField}
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
										onUpdateNodeData(node.id, {
											...data,
											field: val,
											...(BOOLEAN_CONDITION_FIELDS.includes(val)
												? { operator: 'equals', value: 'true' }
												: NUMERIC_CONDITION_FIELDS.includes(val)
													? { operator: 'greater_than', value: '0' }
													: val === 'audience'
														? {
																operator: 'equals',
																value: audienceOptions?.[0]?.id ?? '',
															}
														: { operator: 'contains', value: '' }),
										})
									}}
								>
									<SelectTrigger id="field" className="h-11">
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
										{(
											[
												...NUMERIC_CONDITION_FIELDS,
												...BOOLEAN_BEHAVIOR_FIELDS,
												...(audienceOptions ? ['audience'] : []),
											] as string[]
										).map((field) => (
											<SelectItem key={field} value={field}>
												{conditionFieldLabel(field)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{data.field === 'audience' ? (
								<div className="space-y-1.5">
									<Label htmlFor="audienceId" className="text-xs font-medium">
										<Trans>Saved audience</Trans>
									</Label>
									<Select
										value={data.value || ''}
										onValueChange={(val: string) => handleChange('value', val)}
									>
										<SelectTrigger id="audienceId" className="h-11">
											<SelectValue placeholder={_(msg`Choose an audience`)}>
												{
													audienceOptions?.find((a) => a.id === data.value)
														?.name
												}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											{(audienceOptions ?? []).map((audience) => (
												<SelectItem key={audience.id} value={audience.id}>
													{audience.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Select
										value={
											data.operator === 'not_equals' ? 'not_equals' : 'equals'
										}
										onValueChange={(val) =>
											handleChange('operator', val ?? 'equals')
										}
									>
										<SelectTrigger id="audienceOperator" className="h-11">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="equals">
												<Trans>Guest is in the audience</Trans>
											</SelectItem>
											<SelectItem value="not_equals">
												<Trans>Guest is not in the audience</Trans>
											</SelectItem>
										</SelectContent>
									</Select>
									<p className="text-muted-foreground text-[11px]">
										<Trans>
											Checked when the guest reaches this step, never stored.
										</Trans>
									</p>
								</div>
							) : NUMERIC_CONDITION_FIELDS.includes(data.field) ? (
								<div className="grid grid-cols-2 gap-3">
									<div className="space-y-1.5">
										<Label
											htmlFor="numericOperator"
											className="text-xs font-medium"
										>
											<Trans>Condition Logic</Trans>
										</Label>
										<Select
											value={data.operator || 'greater_than'}
											onValueChange={(val: string) =>
												handleChange('operator', val)
											}
										>
											<SelectTrigger id="numericOperator" className="h-11">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="greater_than">
													<Trans>Is more than</Trans>
												</SelectItem>
												<SelectItem value="less_than">
													<Trans>Is less than</Trans>
												</SelectItem>
												<SelectItem value="equals">
													<Trans>Is exactly</Trans>
												</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1.5">
										<Label
											htmlFor="numericValue"
											className="text-xs font-medium"
										>
											<Trans>Target Value</Trans>
										</Label>
										<Input
											id="numericValue"
											type="number"
											min="0"
											value={data.value ?? ''}
											onChange={(e) => handleChange('value', e.target.value)}
											className="h-11"
										/>
									</div>
								</div>
							) : data.field === 'has_upcoming_reservation' ? (
								<div className="space-y-1.5">
									<Label
										htmlFor="upcomingValue"
										className="text-xs font-medium"
									>
										<Trans>Upcoming reservation</Trans>
									</Label>
									<Select
										value={data.value || 'true'}
										onValueChange={(val: string) => handleChange('value', val)}
									>
										<SelectTrigger id="upcomingValue" className="h-11">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="true">
												<Trans>Has one (True)</Trans>
											</SelectItem>
											<SelectItem value="false">
												<Trans>Has none (False)</Trans>
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
							) : data.field === 'phoneVerified' ? (
								<div className="space-y-1.5">
									<Label htmlFor="booleanValue" className="text-xs font-medium">
										<Trans>Verification Status</Trans>
									</Label>
									<Select
										value={data.value || 'true'}
										onValueChange={(val: string) => handleChange('value', val)}
									>
										<SelectTrigger id="booleanValue" className="h-11">
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
											<SelectTrigger id="operator" className="h-11">
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
											className="h-11"
										/>
									</div>
								</>
							)}

							<div className="bg-muted/40 space-y-1.5 rounded-lg border p-3 text-xs">
								<p className="text-foreground">
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
										<span className="text-foreground">
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
										<span className="text-destructive font-semibold">
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
