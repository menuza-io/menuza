import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	managerAlertKindFromNotificationType,
	managerAlertPath,
} from '@repo/staffing'
import { Avatar, AvatarFallback } from '@repo/ui/avatar'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader } from '@repo/ui/card'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverTrigger, PopoverContent } from '@repo/ui/popover'
import { ScrollArea } from '@repo/ui/scroll-area'
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@repo/ui/tooltip'
import { motion, AnimatePresence } from 'framer-motion'
import React, { useEffect, useState, useRef } from 'react'
import Markdown from 'react-markdown'
import { useNavigate, useFetcher, useParams } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { useEventSource } from 'remix-utils/sse/react'
import { BellIcon } from '#app/components/icons/bell-icon.tsx'
import { reservationAlertCopy } from '#app/utils/reservations/alert-copy.ts'
import {
	reservationAlertKindFromNotificationType,
	reservationAlertPath,
} from '#app/utils/reservations/manager-alerts.ts'
import { staffingAlertCopy } from '#app/utils/staffing/alert-copy.ts'

interface Notification {
	id: string
	type: string
	payload: string
	isRead: boolean
	isSeen: boolean
	createdAt: string
}

function formatRelativeTime(
	timestamp: string,
	_: (message: { id: string; message: string }) => string,
): string {
	const date = new Date(timestamp)
	const now = new Date()
	const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

	if (diffInSeconds < 60) {
		const seconds = diffInSeconds
		return _(msg`${seconds}s ago` as { id: string; message: string })
	}
	if (diffInSeconds < 3600) {
		const minutes = Math.floor(diffInSeconds / 60)
		return _(msg`${minutes}m ago` as { id: string; message: string })
	}
	if (diffInSeconds < 86400) {
		const hours = Math.floor(diffInSeconds / 3600)
		return _(msg`${hours}h ago` as { id: string; message: string })
	}
	if (diffInSeconds < 604800) {
		const days = Math.floor(diffInSeconds / 86400)
		return _(msg`${days}d ago` as { id: string; message: string })
	}

	return date.toLocaleDateString()
}

function NotificationItem({
	notification,
	onMarkRead,
}: {
	notification: Notification
	onMarkRead: (id: string) => void
}) {
	const { _ } = useLingui()
	const [isHovered, setIsHovered] = useState(false)
	const navigate = useNavigate()

	let payload: any = {}
	try {
		payload =
			typeof notification.payload === 'string'
				? JSON.parse(notification.payload)
				: notification.payload
	} catch (e) {
		console.error('Failed to parse notification payload', e)
	}

	const staffingKind = managerAlertKindFromNotificationType(notification.type)
	const staffing = staffingKind
		? staffingAlertCopy(staffingKind, Number(payload?.count), _)
		: null

	const reservationsKind = reservationAlertKindFromNotificationType(
		notification.type,
	)
	const reservations = reservationsKind
		? reservationAlertCopy(
				reservationsKind,
				Number(payload?.count),
				_,
				typeof payload?.locationName === 'string' ? payload.locationName : null,
			)
		: null

	const subject =
		staffing?.subject ??
		reservations?.subject ??
		(notification.type === 'mention'
			? `**${payload?.commenterName || 'Someone'}** mentioned you`
			: `**${payload?.commenterName || 'Someone'}** commented on your note`)
	const body =
		staffing?.body ?? reservations?.body ?? payload?.commentContent ?? ''

	const handlePress = () => {
		if (!notification.isRead) {
			onMarkRead(notification.id)
		}
		if (staffingKind && typeof payload?.orgSlug === 'string') {
			const scopeId =
				typeof payload.scopeId === 'string' ? payload.scopeId : null
			void navigate(
				`/${payload.orgSlug}${managerAlertPath(staffingKind, scopeId)}`,
			)
		} else if (reservationsKind && typeof payload?.orgSlug === 'string') {
			void navigate(
				`/${payload.orgSlug}${reservationAlertPath(reservationsKind)}`,
			)
		} else if (payload.noteUrl) {
			void navigate(payload.noteUrl)
		}
	}

	const handleMarkAsReadUnread = (e: React.MouseEvent) => {
		e.stopPropagation()
		if (!notification.isRead) {
			onMarkRead(notification.id)
		}
	}

	return (
		<div
			role="button"
			tabIndex={0}
			className={`w-full text-left ${notification.isRead ? 'bg-background' : 'bg-muted'}`}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			onClick={handlePress}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					void handlePress()
				}
			}}
		>
			<div className="flex items-start border-b border-dashed p-2">
				<Avatar className="mr-2 h-8 w-8">
					<AvatarFallback>
						{reservationsKind ? (
							<Icon name="calendar" className="h-4 w-4" />
						) : staffingKind ? (
							<Icon name="clock" className="h-4 w-4" />
						) : (
							payload.commenterName?.[0] || 'N'
						)}
					</AvatarFallback>
				</Avatar>
				<div className="flex-1">
					<div className="mb-1 flex items-start justify-between">
						<h3 className="mr-2 text-sm [&_strong]:font-semibold">
							<Markdown>{subject}</Markdown>
						</h3>
					</div>
					<div>
						<p className="text-muted-foreground mb-2 text-sm">
							<Markdown>{body}</Markdown>
						</p>
						<div className="flex justify-between space-x-2">
							<div />
							<div className="flex shrink-0 items-center space-x-2">
								{!isHovered ? (
									<p className="text-muted-foreground text-xs whitespace-nowrap">
										{formatRelativeTime(notification.createdAt, _)}
									</p>
								) : (
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger>
												<Button
													variant="ghost"
													size="sm"
													onClick={handleMarkAsReadUnread}
													disabled={notification.isRead}
												>
													{notification.isRead ? (
														<Icon name="bell" className="h-3 w-3" />
													) : (
														<Icon name="check-circled" className="h-3 w-3" />
													)}
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													{notification.isRead ? (
														<Trans>Already read</Trans>
													) : (
														<Trans>Mark as read</Trans>
													)}
												</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}

function EmptyState() {
	const cardVariants = [
		{ rotate: -10, y: 0, x: -20 },
		{ rotate: 10, y: 40, x: 20 },
		{ rotate: -10, y: 80, x: -20 },
	]

	return (
		<div className="px-4 py-12">
			<div className="relative mx-auto h-40 w-full max-w-[280px]">
				{cardVariants.map((variant, index) => (
					<motion.div
						key={index}
						className="absolute right-0 left-0 w-full"
						initial={{ opacity: 0, y: 20 }}
						animate={{
							opacity: 1,
							y: variant.y,
							x: variant.x,
							rotate: variant.rotate,
							transition: {
								duration: 0.4,
								delay: index * 0.1,
								ease: [0.22, 1, 0.36, 1],
							},
						}}
					>
						<div className="border-border bg-background mx-auto w-full rounded-lg border p-4 shadow-sm">
							<div className="flex items-center space-x-3">
								<div className="bg-muted h-8 w-8 rounded-full" />
								<div className="flex-1 space-y-2">
									<div className="bg-muted h-2 w-3/4 rounded-full" />
									<div className="bg-muted h-2 w-1/2 rounded-full" />
								</div>
							</div>
						</div>
					</motion.div>
				))}
			</div>
			<div className="mt-8 text-center">
				<h3 className="text-foreground text-lg font-medium">
					<Trans>Nothing here yet!</Trans>
				</h3>
				<p className="text-muted-foreground mt-1 text-sm">
					<Trans>When you get notifications, they'll show up here.</Trans>
				</p>
			</div>
		</div>
	)
}

export default function NotificationBell() {
	const { _ } = useLingui()
	const [isOpen, setIsOpen] = useState(false)
	const [filter, setFilter] = useState<'all' | 'unread'>('all')

	const fetcher = useFetcher<any>()
	const actionFetcher = useFetcher<any>()

	const [notifications, setNotifications] = useState<Notification[]>([])
	const [unreadCount, setUnreadCount] = useState(0)

	const [hasLoaded, setHasLoaded] = useState(false)
	const markReadFormRef = useRef<HTMLFormElement>(null)
	const markAllReadFormRef = useRef<HTMLFormElement>(null)

	const { orgSlug } = useParams()

	useEffect(() => {
		setHasLoaded(false)
		setNotifications([])
		setUnreadCount(0)
	}, [orgSlug])

	// Fetch initial notifications
	useEffect(() => {
		if (!hasLoaded && fetcher.state === 'idle') {
			setHasLoaded(true)
			const query = orgSlug ? `?orgSlug=${orgSlug}` : ''
			void fetcher.load(`/api/notifications${query}`)
		}
	}, [fetcher.state, hasLoaded, fetcher, orgSlug])

	useEffect(() => {
		if (fetcher.data) {
			setNotifications(fetcher.data.notifications || [])
			setUnreadCount(fetcher.data.unreadCount || 0)
		}
	}, [fetcher.data])

	// Listen to real-time updates
	const streamQuery = orgSlug ? `?orgSlug=${orgSlug}` : ''
	const newNotification = useEventSource(
		`/api/notifications/stream${streamQuery}`,
		{
			event: 'notification',
		},
	)

	useEffect(() => {
		if (newNotification) {
			try {
				const notification = JSON.parse(newNotification) as Notification
				setNotifications((prev) => {
					const exists = prev.find((n) => n.id === notification.id)
					if (exists) {
						return prev
							.map((n) => (n.id === notification.id ? notification : n))
							.sort(
								(a, b) =>
									new Date(b.createdAt).getTime() -
									new Date(a.createdAt).getTime(),
							)
					}
					return [notification, ...prev]
				})
				setUnreadCount((prev) => prev + 1)
			} catch (e) {
				console.error('Failed to parse SSE notification', e)
			}
		}
	}, [newNotification])

	const handleMarkRead = (id: string) => {
		setNotifications((prev) =>
			prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
		)
		setUnreadCount((prev) => Math.max(0, prev - 1))

		const formData = new FormData(markReadFormRef.current!)
		formData.set('notificationId', id)

		void actionFetcher.submit(formData, {
			method: 'post',
			action: '/api/notifications',
		})
	}

	const handleReadAll = () => {
		setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })))
		setUnreadCount(0)

		const formData = new FormData(markAllReadFormRef.current!)
		void actionFetcher.submit(formData, {
			method: 'post',
			action: '/api/notifications',
		})
	}

	const handleFilterChange = (value: 'all' | 'unread') => {
		setFilter(value)
	}

	const filteredNotifications = notifications.filter((n) =>
		filter === 'unread' ? !n.isRead : true,
	)

	const filterTitles = {
		all: _(msg`All Notifications`),
		unread: _(msg`Unread Notifications`),
	}

	const containerVariants = {
		hidden: { opacity: 0, scale: 0.95, y: -20 },
		visible: {
			opacity: 1,
			scale: 1,
			y: 0,
			transition: {
				duration: 0.2,
				staggerChildren: 0.1,
			},
		},
	}

	const itemVariants = {
		hidden: { opacity: 0, x: -20 },
		visible: { opacity: 1, x: 0 },
	}

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger
				render={
					<button
						type="button"
						className="text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground relative flex size-8 items-center justify-center rounded-md transition-colors after:absolute after:-inset-1.5 md:after:hidden"
					/>
				}
			>
				<motion.span
					className="flex size-full items-center justify-center"
					whileTap={{ scale: 0.92 }}
				>
					<BellIcon size={16} />
				</motion.span>
				<AnimatePresence>
					{unreadCount > 0 && (
						<motion.div
							initial={{ scale: 0 }}
							animate={{ scale: 1 }}
							exit={{ scale: 0 }}
							className="absolute -top-1 -right-1"
						>
							<Badge
								variant="destructive"
								data-testid="unread-count"
								className="bg-destructive h-4 min-w-4 rounded-full px-1 text-[10px] leading-none text-white tabular-nums"
							>
								{unreadCount}
							</Badge>
						</motion.div>
					)}
				</AnimatePresence>
				<span className="sr-only">
					<Trans>Toggle notifications</Trans>
				</span>
			</PopoverTrigger>
			<PopoverContent className="w-[400px] p-0" align="end">
				{/* Hidden forms for CSRF Honeypot submission */}
				<form ref={markReadFormRef} className="hidden">
					<HoneypotInputs />
					<input type="hidden" name="intent" value="markAsRead" />
					<input type="hidden" name="notificationId" value="" />
					{orgSlug && <input type="hidden" name="orgSlug" value={orgSlug} />}
				</form>
				<form ref={markAllReadFormRef} className="hidden">
					<HoneypotInputs />
					<input type="hidden" name="intent" value="markAllAsRead" />
					{orgSlug && <input type="hidden" name="orgSlug" value={orgSlug} />}
				</form>

				<motion.div
					initial="hidden"
					animate="visible"
					exit="hidden"
					variants={containerVariants}
				>
					<Card className="border-0 py-0 shadow-none">
						<CardHeader className="p-2">
							<div className="flex justify-between">
								<div className="mt-1 flex-1">
									<DropdownMenu>
										<DropdownMenuTrigger>
											<Button
												variant="ghost"
												className="focus-visible:ring-ring h-auto p-0 focus-visible:ring-2 focus-visible:outline-none"
											>
												{filterTitles[filter]}
												<Icon
													name="chevron-down"
													className="ml-2 inline h-4 w-4"
												/>
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent style={{ width: 'max-content' }}>
											<DropdownMenuItem
												onClick={() => handleFilterChange('all')}
											>
												<Trans>All Notifications</Trans>
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() => handleFilterChange('unread')}
											>
												<Trans>Unread Notifications</Trans>
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
								<DropdownMenu>
									<DropdownMenuTrigger>
										<Button variant="ghost" size="sm" className="h-10 w-10 p-0">
											<Icon name="ellipsis" className="h-4 w-4" />
											<span className="sr-only">
												<Trans>Open menu</Trans>
											</span>
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="end"
										style={{ width: 'max-content' }}
									>
										<DropdownMenuItem onClick={handleReadAll}>
											<Icon name="check-circled" className="mr-2 h-4 w-4" />
											<Trans>Mark all as read</Trans>
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</CardHeader>
						<CardContent className="p-0">
							{fetcher.state === 'loading' && notifications.length === 0 ? (
								<div className="flex h-[calc(100vh-200px)] max-h-[500px] items-center justify-center">
									<motion.div
										animate={{ rotate: 360 }}
										transition={{
											duration: 1,
											repeat: Infinity,
											ease: 'linear',
										}}
									>
										<Icon name="bell" className="text-primary h-8 w-8" />
									</motion.div>
								</div>
							) : (
								<ScrollArea className="h-[calc(100vh-200px)] max-h-[500px]">
									{filteredNotifications.length === 0 ? (
										<EmptyState />
									) : (
										<div className="flex flex-col">
											{filteredNotifications.map((notification) => (
												<motion.div
													key={notification.id}
													variants={itemVariants}
												>
													<NotificationItem
														notification={notification}
														onMarkRead={handleMarkRead}
													/>
												</motion.div>
											))}
										</div>
									)}
								</ScrollArea>
							)}
						</CardContent>
					</Card>
				</motion.div>
			</PopoverContent>
		</Popover>
	)
}
