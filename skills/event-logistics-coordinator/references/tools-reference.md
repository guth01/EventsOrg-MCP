# EventsOrg MCP Tool Reference

This document catalogs the MCP tools provided by `eventsorg-mcp`.

## 1. Query & Inspection Tools

| Tool Name | Parameters | Purpose |
| :--- | :--- | :--- |
| `get_event_summary` | *(none)* | Returns a complete bird's-eye view of event health: incident count, overdue vendors, understaffed zones, and current headcount. |
| `get_active_incidents` | *(none)* | Lists all open incidents with zone IDs, descriptions, timestamps, and severity levels. |
| `get_overdue_vendors` | *(none)* | Identifies vendors who missed their scheduled arrival window. |
| `get_vendor_status` | `vendor_id?: number` | Queries status, contact details, assigned zones, and delay notes for a specific vendor or all vendors. |
| `get_understaffed_zones` | *(none)* | Returns zones where actual staff is below minimum required headcount. |
| `get_volunteer_availability` | *(none)* | Lists all checked-in, idle, or unassigned volunteers available for immediate reassignment. |
| `get_sms_history` | `limit?: number, phone?: string` | Fetches inbound and outbound SMS history with parsed intents. |
| `get_weather` | `location?: string` | Fetches current weather and rain forecasts for the venue coordinates. |
| `query_db` | `sql: string` | Run read-only diagnostic SQL queries directly against the local SQLite database. |

---

## 2. Operations & Action Tools

| Tool Name | Parameters | Purpose |
| :--- | :--- | :--- |
| `reassign_volunteer` | `volunteer_id: number, new_zone_id: number` | Moves a volunteer, logs the change, texts them an alert, and sends walking directions via SMS. |
| `report_incident` | `description: string, zone_id?: number, severity: "low"\|"medium"\|"high"\|"critical"` | Logs a new safety, medical, or crowd incident. |
| `mark_incident_resolved` | `incident_id: number, resolution_note: string` | Closes an incident with resolution documentation. |
| `acknowledge_vendor_delay` | `vendor_id: number, delay_until: string, reason: string` | Logs a vendor's approved delayed arrival time and pauses automatic escalation. |
| `cancel_vendor_slot` | `vendor_id: number, reason: string` | Cancels a vendor who failed to arrive after their final cutoff. |
| `move_zone_indoors` | `outdoor_zone_id: number, indoor_zone_id: number` | Migrates all activities, volunteers, and vendors from an outdoor zone to a protected indoor zone. |
| `escalate_to_coordinator` | `subject: string, message: string` | Sends an emergency escalation email to the chief event director. |
| `send_sms` | `to: string, body: string` | Sends an outbound Twilio text message to any phone number (in E.164 format). |
| `get_directions` | `origin: string, destination: string` | Queries walking directions and travel time between two locations or stages. |
| `sync_to_sheets` | *(none)* | Pushes the latest database state to the Google Sheets coordinator dashboard. |
