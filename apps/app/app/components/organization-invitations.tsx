import {
	getFormProps,
	getInputProps,
	useForm,
	useInputControl,
	getFieldsetProps,
	type FieldMetadata,
	FormProvider,
} from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { Trans, msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@repo/ui/input-group'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Separator } from '@repo/ui/separator'
import { useState } from 'react'
import { Form, Link } from 'react-router'
import { z } from 'zod'
import { ErrorList } from '#app/components/forms.tsx'
import { type OrganizationRoleOption } from '#app/components/organization-members.tsx'
import { MAX_ORGANIZATION_INVITES_PER_REQUEST } from '#app/utils/organization/invitation.ts'

// Create dynamic invite schema based on available roles
function createInviteSchema() {
	return z.object({
		invites: z
			.array(
				z.object({
					email: z.string().email('Invalid email address'),
					roleId: z.string().min(1, 'A role is required'),
				}),
			)
			.min(1, 'At least one invite is required')
			.max(
				MAX_ORGANIZATION_INVITES_PER_REQUEST,
				`You can invite at most ${MAX_ORGANIZATION_INVITES_PER_REQUEST} people at a time`,
			),
	})
}

export function OrganizationInvitations({
	pendingInvitations = [],
	inviteLink,
	actionData,
	availableRoles = [],
	organizationSlug,
	canManageRoles = false,
}: {
	pendingInvitations?: Array<{
		id: string
		email: string
		organizationRole: {
			id: string
			name: string
		}
		createdAt: Date
		inviter?: { name: string | null; email: string } | null
	}>
	inviteLink?: {
		id: string
		token: string
		organizationRole: {
			id: string
			name: string
		}
		isActive: boolean
		createdAt: Date
	} | null
	actionData?: any
	availableRoles?: OrganizationRoleOption[]
	organizationSlug?: string
	canManageRoles?: boolean
}) {
	const { _ } = useLingui()
	// Create dynamic schema and roles based on available roles
	const InviteSchema = createInviteSchema()
	const roles = availableRoles.map((role) => ({
		value: role.id,
		label: role.name,
		description: role.description,
	}))

	const [form, fields] = useForm({
		id: 'invite-form',
		constraint: getZodConstraint(InviteSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: InviteSchema })
		},
		defaultValue: {
			invites: [{ email: '', roleId: availableRoles[0]?.id || '' }],
		},
		shouldRevalidate: 'onBlur',
	})

	const invitesList = fields.invites.getFieldList()
	const [linkCopied, setLinkCopied] = useState(false)

	const inviteUrl = inviteLink?.isActive
		? `${typeof window !== 'undefined' ? window.location.origin : ''}/join/${inviteLink.token}`
		: ''

	const copyInviteLink = async () => {
		if (inviteUrl) {
			try {
				await navigator.clipboard.writeText(inviteUrl)
				setLinkCopied(true)
				setTimeout(() => setLinkCopied(false), 2000)
			} catch (error) {
				console.error('Failed to copy link:', error)
				// Fallback for browsers that don't support clipboard API
				const textArea = document.createElement('textarea')
				textArea.value = inviteUrl
				document.body.appendChild(textArea)
				textArea.select()
				document.execCommand('copy')
				document.body.removeChild(textArea)
				setLinkCopied(true)
				setTimeout(() => setLinkCopied(false), 2000)
			}
		}
	}

	return (
		<div className="space-y-6">
			{/* Invite Link Section */}
			<Card>
				<CardHeader>
					<CardTitle className="text-lg">
						<Trans>Personal invite link</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Share this link to let people join your organization. They'll see
							you invited them.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex gap-2">
						<InputGroup className="flex-1">
							<InputGroupAddon align="inline-start" className="pl-2.5">
								<Icon
									name="link-2"
									className="text-muted-foreground h-4 w-4 shrink-0"
								/>
							</InputGroupAddon>
							<InputGroupInput
								value={
									inviteLink?.isActive
										? inviteUrl
										: _(msg`No active invite link`)
								}
								readOnly
								onClick={inviteLink?.isActive ? copyInviteLink : undefined}
								className={
									inviteLink?.isActive ? 'cursor-pointer' : 'cursor-not-allowed'
								}
							/>
							{inviteLink?.isActive && (
								<InputGroupAddon align="inline-end" className="pr-1.5">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={copyInviteLink}
										className="h-7 px-2.5 text-xs"
									>
										{linkCopied ? (
											<>
												<Icon name="check" className="h-3.5 w-3.5" />
												<Trans>Copied</Trans>
											</>
										) : (
											<>
												<Icon name="copy" className="h-3.5 w-3.5" />
												<Trans>Copy</Trans>
											</>
										)}
									</Button>
								</InputGroupAddon>
							)}
						</InputGroup>
						{!inviteLink?.isActive && (
							<Form method="POST" className="shrink-0">
								<input type="hidden" name="intent" value="create-invite-link" />
								<Button type="submit" size="sm">
									<Icon name="plus" className="h-4 w-4" />
									<Trans>Create Link</Trans>
								</Button>
							</Form>
						)}
					</div>
					{inviteLink?.isActive && (
						<div className="flex gap-2">
							<Form method="POST">
								<input type="hidden" name="intent" value="reset-invite-link" />
								<Button type="submit" variant="outline" size="sm">
									<Icon name="undo-2" className="h-4 w-4" />
									<Trans>Reset</Trans>
								</Button>
							</Form>
							<Form method="POST">
								<input
									type="hidden"
									name="intent"
									value="deactivate-invite-link"
								/>
								<Button type="submit" variant="outline" size="sm">
									<Icon name="ban" className="h-4 w-4" />
									<Trans>Disable</Trans>
								</Button>
							</Form>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Email Invitations Section */}
			<Card>
				<CardHeader>
					<CardTitle className="text-lg">
						<Trans>Invite by email</Trans>
						{organizationSlug && canManageRoles && (
							<>
								{' '}
								·{' '}
								<Link to={`/${organizationSlug}/settings/roles`}>
									<Trans>Manage roles</Trans>
								</Link>
							</>
						)}
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Invitation Form */}
					<FormProvider context={form.context}>
						<Form method="POST" {...getFormProps(form)}>
							<input type="hidden" name="intent" value="send-invitations" />
							<div className="space-y-1">
								{invitesList.map((invite, index) => (
									<InviteFieldset
										key={invite.key}
										meta={invite}
										fields={fields}
										form={form}
										index={index}
										roles={roles}
									/>
								))}

								<Button
									variant="outline"
									className="w-full"
									onClick={() => {
										form.insert({
											name: fields.invites.name,
											defaultValue: {
												email: '',
												roleId: availableRoles[0]?.id || '',
											},
										})
									}}
								>
									<Icon name="plus" className="h-4 w-4" />
									<Trans>Add another invitation</Trans>
								</Button>
							</div>

							<div className="mt-6 space-y-2">
								<ErrorList id={form.errorId} errors={form.errors} />
								<Button type="submit" className="w-full">
									<Trans>Send Invitations</Trans>
								</Button>
							</div>
						</Form>
					</FormProvider>

					{/* Pending Invitations */}
					{pendingInvitations.length > 0 && (
						<>
							<Separator />
							<div role="region" aria-labelledby="pending-invitations-heading">
								<h4
									id="pending-invitations-heading"
									className="mb-3 text-sm font-medium"
								>
									<Trans>Pending Invitations</Trans>
								</h4>
								<ItemGroup>
									{pendingInvitations.map((invitation) => {
										const inviterName = invitation.inviter
											? invitation.inviter.name || invitation.inviter.email
											: ''
										return (
											<Item key={invitation.id} variant="outline" size="sm">
												<ItemContent>
													<ItemTitle>
														<span>{invitation.email}</span>
														<Badge variant="secondary" className="text-xs">
															{invitation.organizationRole.name}
														</Badge>
													</ItemTitle>
													{invitation.inviter && (
														<ItemDescription>
															<Trans>Invited by {inviterName}</Trans>
														</ItemDescription>
													)}
												</ItemContent>
												<ItemActions>
													<Form method="POST">
														<input
															type="hidden"
															name="intent"
															value="remove-invitation"
														/>
														<input
															type="hidden"
															name="invitationId"
															value={invitation.id}
														/>
														<Button
															type="submit"
															variant="ghost"
															size="sm"
															aria-label={t`Delete invitation`}
														>
															<Icon name="trash-2" className="h-4 w-4" />
														</Button>
													</Form>
												</ItemActions>
											</Item>
										)
									})}
								</ItemGroup>
							</div>
						</>
					)}
				</CardContent>
			</Card>
		</div>
	)
}

function InviteFieldset({
	meta,
	fields,
	form,
	index,
	roles,
}: {
	meta: FieldMetadata<
		{
			email: string
			roleId: string
		},
		{
			invites: {
				email: string
				roleId: string
			}[]
		},
		string[]
	>
	fields: Required<{
		invites: FieldMetadata<
			{
				email: string
				roleId: string
			}[],
			{
				invites: {
					email: string
					roleId: string
				}[]
			},
			string[]
		>
	}>
	form: any
	index: number
	roles: Array<{
		value: string
		label: string
		description: string
	}>
}) {
	const { _ } = useLingui()
	const inviteFields = meta.getFieldset()
	const role = useInputControl(inviteFields.roleId)
	const { key: _key, ...emailProps } = getInputProps(inviteFields.email, {
		type: 'email',
	})

	return (
		<div>
			<fieldset className="mb-2 w-full" {...getFieldsetProps(meta)}>
				<InputGroup className="w-full">
					<InputGroupInput
						{...emailProps}
						placeholder={_(msg`Enter email address`)}
						aria-label={_(msg`Email`)}
						aria-invalid={
							inviteFields.email.errors?.length ? 'true' : undefined
						}
					/>

					<InputGroupAddon
						className="gap-0 rounded-r-lg py-1 pr-1.5"
						align="inline-end"
					>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<InputGroupButton variant="ghost">
										{roles.find((r) => r.value === role.value)?.label}
										<Icon name="chevron-down" />
									</InputGroupButton>
								}
							></DropdownMenuTrigger>
							<DropdownMenuContent className="w-[250px]" side="top" align="end">
								{roles.map((roleOption) => (
									<DropdownMenuItem
										key={roleOption.value}
										onClick={() => role.change(roleOption.value)}
										className="group"
									>
										<div className="flex flex-col">
											<span className="font-medium">{roleOption.label}</span>
											<span className="text-muted-foreground group-data-[highlighted]:text-accent-foreground text-xs">
												{roleOption.description ||
													_(msg`No description provided`)}
											</span>
										</div>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>

						{index > 0 && (
							<InputGroupButton
								variant="ghost"
								size="icon-sm"
								type="button"
								onClick={() =>
									form.remove({ name: fields.invites.name, index })
								}
							>
								<Icon name="trash-2" className="h-4 w-4" />
							</InputGroupButton>
						)}
					</InputGroupAddon>
				</InputGroup>
				<ErrorList id={meta.errorId} errors={meta.errors} />
			</fieldset>
		</div>
	)
}
