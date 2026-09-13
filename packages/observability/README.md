# @repo/observability

Observability package for monitoring application uptime using BetterStack.

## Features

- Fetches uptime status from BetterStack API
- Displays system status with visual indicators
- Three status states:
  - **All systems normal** (●) - 100% monitors up
  - **Partial outage** (◐) - At least one monitor down
  - **Major outage** (○) - 0% monitors up
- Built-in caching to reduce API calls
- Auto-refresh status display

## Installation

This package is already part of the monorepo. To use it in your app:

```bash
npm install @repo/observability
```

## Usage

### Server-side Status Fetching

Create an API endpoint in your app to fetch the status server-side:

```typescript
// Example: app/routes/api.status.ts
import { json } from 'react-router'
import { getUptimeStatus } from '@repo/observability'

export async function loader() {
	const apiKey = process.env.BETTERSTACK_API_KEY
	const statusPageUrl = process.env.BETTERSTACK_URL

	if (!apiKey) {
		return json(
			{
				status: 'degraded',
				message: 'Status monitoring not configured',
				upMonitors: 0,
				totalMonitors: 0,
			},
			{ status: 503 },
		)
	}

	const status = await getUptimeStatus(apiKey, statusPageUrl)
	return json(status)
}
```

### Client-side Status Display

Use the `Status` component to display the status in your UI:

```tsx
import { Status } from '@repo/observability'

export function Footer() {
	return (
		<footer>
			<div className="flex items-center gap-4">
				<Status statusEndpoint="/api/status" />
				<a href="https://status.yoursite.com">Status Page</a>
			</div>
		</footer>
	)
}
```

## Environment Variables

- `BETTERSTACK_API_KEY` (required): Your BetterStack API key
- `BETTERSTACK_URL` (optional): Your status page URL

## Configuration

### BetterStack Setup

1. Sign up at [BetterStack](https://betterstack.com)
2. Create uptime monitors for your services:
   - `menuza.io` - Main website
   - `app.menuza.io/health` - App health endpoint
   - `admin.menuza.io/health` - Admin health endpoint
3. Get your API key from the dashboard
4. Add the API key to your environment variables

## API

### `getUptimeStatus(apiKey: string, statusPageUrl?: string): Promise<StatusInfo>`

Fetches the current uptime status from BetterStack.

**Parameters:**

- `apiKey`: Your BetterStack API key
- `statusPageUrl`: (Optional) Your status page URL

**Returns:** A promise that resolves to `StatusInfo`

### `Status` Component

React component that displays the current system status.

**Props:**

- `statusEndpoint`: API endpoint that returns status information
- `className`: (Optional) CSS class name for the container
- `refreshInterval`: (Optional) Refresh interval in milliseconds
  (default: 60000)

## Types

### `StatusInfo`

```typescript
interface StatusInfo {
	status: 'operational' | 'partial_outage' | 'degraded'
	message: string
	upMonitors: number
	totalMonitors: number
}
```

## License

MIT
