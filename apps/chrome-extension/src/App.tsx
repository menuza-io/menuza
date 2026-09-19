import { brand } from '@repo/config/brand'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { useState, useEffect } from 'react'
import browser from 'webextension-polyfill'
import {
	AUTH_STATUS_KEY,
	APP_URL,
	getAuthStatus,
	checkAuthCookie,
	MessageHandler,
	MessageType,
	type ExtensionMessage,
	type AuthStatus,
	setAuthStatus,
} from './lib/auth'

function App() {
	const [url, setUrl] = useState('')
	const [tabId, setTabId] = useState<number | null>(null)
	const [hasPermission, setHasPermission] = useState(false)
	const [isLoggedIn, setIsLoggedIn] = useState(false)
	const [isCheckingAuth, setIsCheckingAuth] = useState(true)

	useEffect(() => {
		document.title = brand.products.extension.name
	}, [])

	useEffect(() => {
		let mounted = true

		const init = async () => {
			try {
				const tabs = await browser.tabs.query({
					active: true,
					currentWindow: true,
				})

				if (tabs[0] && tabs[0].id && tabs[0].url && mounted) {
					setTabId(tabs[0].id)
					const url = new URL(tabs[0].url)

					if (url.protocol === 'http:' || url.protocol === 'https:') {
						const hostname = url.hostname
						setUrl(hostname)
						const result = await browser.storage.local.get([hostname])
						if (result[hostname] && mounted) {
							setHasPermission(true)
						}
					} else {
						if (mounted) setUrl('This page is not supported.')
					}
				}

				// Check for authentication cookie
				if (mounted) {
					await checkAuthStatus()
				}
			} catch (error) {
				console.error('Error initializing popup:', error)
				if (mounted) {
					setUrl('Invalid URL.')
					setIsCheckingAuth(false)
				}
			}
		}

		// Listen for auth status changes
		const handleAuthStatusChange = (message: ExtensionMessage) => {
			if (mounted && message.payload) {
				const authStatus = message.payload as AuthStatus
				setIsLoggedIn(authStatus.isLoggedIn)
				setIsCheckingAuth(false)
			}
		}

		// Set up message listener
		MessageHandler.addListener(
			MessageType.AUTH_STATUS_CHANGED,
			handleAuthStatusChange,
		)

		// Listen for storage changes as fallback
		const handleStorageChange = (changes: any, areaName: string) => {
			if (mounted && areaName === 'local' && changes[AUTH_STATUS_KEY]) {
				const newAuthStatus = changes[AUTH_STATUS_KEY].newValue
				if (newAuthStatus) {
					setIsLoggedIn(newAuthStatus.isLoggedIn)
					setIsCheckingAuth(false)
				}
			}
		}

		browser.storage.onChanged.addListener(handleStorageChange)
		void init()

		return () => {
			mounted = false
			MessageHandler.removeListener(
				MessageType.AUTH_STATUS_CHANGED,
				handleAuthStatusChange,
			)
			browser.storage.onChanged.removeListener(handleStorageChange)
		}
	}, [])

	const checkAuthStatus = async () => {
		try {
			setIsCheckingAuth(true)

			// First try to get cached auth status from background script
			const authStatus = await getAuthStatus()
			if (authStatus) {
				const isRecent = Date.now() - authStatus.lastChecked < 60000 // 1 minute

				if (isRecent) {
					setIsLoggedIn(authStatus.isLoggedIn)
				}
			}

			// Fallback to direct cookie check if no recent cached status
			const isLoggedIn = await checkAuthCookie()
			const updatedStatus: AuthStatus = {
				isLoggedIn,
				lastChecked: Date.now(),
			}

			await setAuthStatus(updatedStatus)
			setIsLoggedIn(isLoggedIn)

			// Update the cached status
			await browser.storage.local.set({
				[AUTH_STATUS_KEY]: {
					isLoggedIn,
					lastChecked: Date.now(),
				},
			})
		} catch (error) {
			console.error('Error checking auth status:', error)
			setIsLoggedIn(false)
		} finally {
			setIsCheckingAuth(false)
		}
	}

	const handleAllow = async () => {
		if (!tabId || !url) return

		try {
			await browser.storage.local.set({ [url]: true })
			console.log(`Permission granted for ${url}`)

			// Send message to background script to inject content script
			await MessageHandler.sendMessage({
				type: MessageType.INJECT_CONTENT_SCRIPT,
				tabId: tabId,
			})

			window.close()
		} catch (error) {
			console.error('Error granting permission:', error)
		}
	}

	const handleDisable = async () => {
		if (!tabId || !url) return

		await MessageHandler.sendMessage(
			{
				type: MessageType.DESTROY_CONTENT_SCRIPT,
			},
			tabId,
		)

		await browser.storage.local.remove([url])
		setHasPermission(false)
		window.close()
	}

	return (
		<Card className="w-80 rounded-none border-none shadow-none">
			<CardHeader>
				<CardTitle className="text-lg">
					{brand.products.extension.name}
				</CardTitle>
			</CardHeader>
			<CardContent>
				{/* Authentication Status */}
				<div className="mb-2 rounded-lg p-1">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							{isCheckingAuth ? (
								<span className="text-muted-foreground text-sm">
									Checking...
								</span>
							) : (
								<span
									className={`text-sm ${isLoggedIn ? 'text-green-600' : 'text-red-600'}`}
								>
									{isLoggedIn ? 'Logged In' : 'Not Logged In'}
								</span>
							)}
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={checkAuthStatus}
							disabled={isCheckingAuth}
						>
							Reload
						</Button>
					</div>
					{!isCheckingAuth && (
						<div className="mt-1">
							{!isLoggedIn && (
								<a
									href={`${APP_URL}/login`}
									target="_blank"
									rel="noopener noreferrer"
									className="mt-1 inline-block text-xs text-blue-600 underline hover:text-blue-800"
								>
									Click here to login
								</a>
							)}
						</div>
					)}
				</div>

				{/* Permission Status */}
				<p className="text-muted-foreground text-center text-sm">
					{hasPermission
						? 'Permission has been granted for:'
						: 'Grant permission to inject script on:'}
					<br />
					<span className="text-foreground">{url}</span>
				</p>
				<div>
					{hasPermission ? (
						<Button
							variant="destructive"
							className="w-full"
							onClick={handleDisable}
						>
							Disable
						</Button>
					) : (
						<Button className="w-full" onClick={handleAllow}>
							Allow
						</Button>
					)}
				</div>
			</CardContent>
		</Card>
	)
}

export default App
