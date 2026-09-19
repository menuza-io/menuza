import { brand } from '@repo/config/brand'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import React from 'react'
import { createRoot } from 'react-dom/client'
import browser from 'webextension-polyfill'

import {
	getAuthStatus,
	MessageHandler,
	MessageType,
	type ExtensionMessage,
	type AuthStatus,
} from '../lib/auth'

// Import CSS as text using Vite's ?inline query
import cssText from './content.css?inline'

// React component to render inside the shadow DOM
function ContentApp({ onClose }: { onClose: () => void }) {
	const [isLoggedIn, setIsLoggedIn] = React.useState(false)
	const [isLoading, setIsLoading] = React.useState(true)

	React.useEffect(() => {
		let mounted = true

		// Get initial auth status
		const loadAuthStatus = async () => {
			try {
				const authStatus = await getAuthStatus()
				if (mounted && authStatus) {
					setIsLoggedIn(authStatus.isLoggedIn)
				}
			} catch (error) {
				console.error('Error getting auth status in content script:', error)
			} finally {
				if (mounted) {
					setIsLoading(false)
				}
			}
		}

		// Listen for auth status changes
		const handleAuthStatusChange = (message: ExtensionMessage) => {
			if (mounted && message.payload) {
				const authStatus = message.payload as AuthStatus
				setIsLoggedIn(authStatus.isLoggedIn)
			}
		}

		// Set up message listener
		MessageHandler.addListener(
			MessageType.AUTH_STATUS_CHANGED,
			handleAuthStatusChange,
		)

		// Load initial status
		void loadAuthStatus()

		return () => {
			mounted = false
			MessageHandler.removeListener(
				MessageType.AUTH_STATUS_CHANGED,
				handleAuthStatusChange,
			)
		}
	}, [])

	return (
		<Card className="w-80 shadow-lg">
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<div>
						<CardTitle className="text-lg">
							{brand.products.extension.name}
						</CardTitle>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={onClose}
						className="hover:bg-destructive hover:text-destructive-foreground h-6 w-6 p-0"
					>
						×
					</Button>
				</div>
			</CardHeader>
			<CardContent>
				{/* Auth Status Display */}
				<div>
					<div className="flex items-center justify-between">
						<span className="text-xs font-medium">Status:</span>
						{isLoading ? (
							<span className="text-muted-foreground text-xs">Loading...</span>
						) : (
							<span
								className={`text-xs ${isLoggedIn ? 'text-green-600' : 'text-red-600'}`}
							>
								{isLoggedIn ? 'Logged In' : 'Not Logged In'}
							</span>
						)}
					</div>
				</div>
			</CardContent>
		</Card>
	)
}

// Create and inject the Web Component with Shadow DOM
class EpicSaasWidget extends HTMLElement {
	private shadow: ShadowRoot
	private reactRoot: any

	constructor() {
		super()
		this.shadow = this.attachShadow({ mode: 'open' })
	}

	connectedCallback() {
		// Create a container for React with CSS variables class
		const container = document.createElement('div')
		container.className = 'shadow-root-container'

		// Create style element with the processed CSS
		const style = document.createElement('style')
		style.textContent = cssText

		// Append styles and container to shadow root
		this.shadow.appendChild(style)
		this.shadow.appendChild(container)

		// Render React component
		this.reactRoot = createRoot(container)
		this.reactRoot.render(
			React.createElement(ContentApp, {
				onClose: () => {
					this.remove()
				},
			}),
		)
	}

	disconnectedCallback() {
		if (this.reactRoot) {
			this.reactRoot.unmount()
		}
	}
}

// Function to create shadow DOM manually without Web Components
function createShadowWidget() {
	try {
		if (document.querySelector('#epic-saas-widget')) {
			return
		}

		// Create a regular div that will host the shadow DOM
		const hostElement = document.createElement('div')
		hostElement.id = 'epic-saas-widget'
		hostElement.style.position = 'fixed'
		hostElement.style.top = '20px'
		hostElement.style.right = '20px'
		hostElement.style.zIndex = '10000'
		hostElement.style.pointerEvents = 'auto'
		hostElement.style.opacity = '0'
		hostElement.style.transform = 'translateY(-10px)'
		hostElement.style.transition = 'all 0.3s ease-out'

		// Create shadow root manually
		const shadowRoot = hostElement.attachShadow({ mode: 'open' })

		// Create container for React
		const container = document.createElement('div')
		container.className = 'shadow-root-container'

		// Create style element with the processed CSS
		const style = document.createElement('style')
		style.textContent = cssText

		// Append styles and container to shadow root
		shadowRoot.appendChild(style)
		shadowRoot.appendChild(container)

		// Render React component
		const reactRoot = createRoot(container)
		reactRoot.render(
			React.createElement(ContentApp, {
				onClose: () => {
					reactRoot.unmount()
					hostElement.remove()
				},
			}),
		)

		// Append to body
		document.body.appendChild(hostElement)

		// Animate in
		setTimeout(() => {
			hostElement.style.opacity = '1'
			hostElement.style.transform = 'translateY(0)'
		}, 100)
	} catch (error) {
		console.error('Failed to create shadow DOM manually:', error)
	}
}

// Function to initialize the widget with Web Components fallback
function initializeWidget() {
	try {
		// Check if customElements is available
		if (!customElements) {
			createShadowWidget()
			return
		}

		// Check if the element is already defined
		if (customElements.get('epic-saas-widget')) {
			if (document.querySelector('epic-saas-widget')) {
				return
			}

			// Create the widget directly
			const widget = document.createElement('epic-saas-widget')
			widget.style.position = 'fixed'
			widget.style.top = '20px'
			widget.style.right = '20px'
			widget.style.zIndex = '10000'
			widget.style.pointerEvents = 'auto'
			widget.style.opacity = '0'
			widget.style.transform = 'translateY(-10px)'
			widget.style.transition = 'all 0.3s ease-out'

			document.body.appendChild(widget)

			setTimeout(() => {
				widget.style.opacity = '1'
				widget.style.transform = 'translateY(0)'
			}, 100)
		} else {
			// Register the custom element
			customElements.define('epic-saas-widget', EpicSaasWidget)

			// Check if widget already exists
			if (document.querySelector('epic-saas-widget')) {
				return
			}

			// Create and inject the widget
			const widget = document.createElement('epic-saas-widget')
			widget.style.position = 'fixed'
			widget.style.top = '20px'
			widget.style.right = '20px'
			widget.style.zIndex = '10000'
			widget.style.pointerEvents = 'auto'
			widget.style.opacity = '0'
			widget.style.transform = 'translateY(-10px)'
			widget.style.transition = 'all 0.3s ease-out'

			document.body.appendChild(widget)

			setTimeout(() => {
				widget.style.opacity = '1'
				widget.style.transform = 'translateY(0)'
			}, 100)
		}
	} catch (error) {
		console.error('Failed to initialize widget:', error)
		createShadowWidget()
	}
}

function destroyWidget() {
	const widget = document.querySelector('epic-saas-widget')
	if (widget) {
		widget.remove()
	}
}

browser.runtime.onMessage.addListener((message: unknown) => {
	try {
		// Type guard to ensure message is our expected format
		if (!message || typeof message !== 'object' || !('type' in message)) {
			console.warn('Invalid message format:', message)
			return Promise.resolve()
		}

		const extensionMessage = message as ExtensionMessage
		console.log('Received message in content script:', extensionMessage)
		// Handle content script ready check
		if (extensionMessage.type === MessageType.CONTENT_SCRIPT_READY) {
			initializeWidget()
			return Promise.resolve({ ready: true })
		}

		if (extensionMessage.type === MessageType.DESTROY_CONTENT_SCRIPT) {
			destroyWidget()
			return Promise.resolve()
		}

		// Pass message to MessageHandler
		MessageHandler.handleMessage(extensionMessage)
		return Promise.resolve()
	} catch (error) {
		console.error('Error handling message in content script:', error)
		return Promise.resolve()
	}
})

// Wait for DOM to be ready and then initialize
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initializeWidget)
} else {
	// DOM is already ready
	initializeWidget()
}
