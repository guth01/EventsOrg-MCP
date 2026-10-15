---
name: event-logistics-coordinator
description: Autonomous live event operations manager. Triages incidents, manages vendor check-ins and delays, resolves understaffed zones with volunteer dispatching, monitors weather contingencies, and sends Twilio SMS notifications with Google Maps directions.
license: ISC
compatibility: Requires Node.js 18+ and the eventsorg-mcp server. Outbound SMS requires Twilio credentials.
metadata:
  version: "1.0.0"
  author: "Gautham"
  mcp_package: "eventsorg-mcp"
  repository: "https://github.com/guth01/EventsOrg-MCP"
---

# Event Logistics Coordinator Agent Skill

This skill transforms your AI agent into an **Autonomous Event Operations Coordinator** for live venues, conferences, and festivals. It connects directly to the `eventsorg-mcp` server to monitor real-time event status, triage emergencies, adjust staffing levels, communicate with field staff over Twilio SMS, and synchronize live dashboards.

---

## 1. Quick Setup & Configuration

To use this skill, ensure your AI agent environment has access to the `eventsorg-mcp` server.

### Client Configuration (Claude Desktop, Cursor, Claude Code)
Add this to your client's MCP configuration (e.g., `claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "eventsorg-mcp": {
      "command": "npx",
      "args": ["-y", "eventsorg-mcp"],
      "env": {
        "GOOGLE_API_KEY": "YOUR_GEMINI_API_KEY",
        "TWILIO_ACCOUNT_SID": "YOUR_TWILIO_SID",
        "TWILIO_AUTH_TOKEN": "YOUR_TWILIO_TOKEN",
        "TWILIO_PHONE_NUMBER": "+1234567890",
        "OPENWEATHER_API_KEY": "YOUR_OPENWEATHER_KEY",
        "GOOGLE_MAPS_API_KEY": "YOUR_MAPS_KEY",
        "COORDINATOR_EMAIL": "coordinator@example.com"
      }
    }
  }
}
```

> **Note:** Only `GOOGLE_API_KEY` is required for basic local simulation. Add `TWILIO_*` keys when you are ready to dispatch physical SMS messages to field personnel.

---

## 2. Priority Hierarchy & Triage Matrix

When managing event logistics or running an autonomous check loop, **strictly execute decisions in this priority order**:

| Priority | Category | Key Triggers | Action Required |
| :--- | :--- | :--- | :--- |
| **P0: CRITICAL** | **Safety & Medical Incidents** | Fire, medical emergency, security disturbance, structural hazards | Immediately query `get_active_incidents`. Dispatch nearby volunteers/medics, alert the chief coordinator via `escalate_to_coordinator`, and update status. |
| **P1: HIGH** | **Vendor Delays & No-Shows** | Vendors not checked in within 15 mins of setup window | Call `get_overdue_vendors`. Check SMS history via `get_sms_history`. If unacknowledged, send SMS query. If late past cutoff, invoke `cancel_vendor_slot`. |
| **P2: MEDIUM** | **Zone Staffing Imbalances** | Zone headcount falls below required minimum | Query `get_understaffed_zones` and `get_volunteer_availability`. Select closest idle volunteer and trigger `reassign_volunteer`. |
| **P3: LOW** | **Weather & Logistics Shifts** | Rain, storm warnings, or excessive heat on outdoor zones | Query `get_weather`. If precipitation risk > 60%, execute `move_zone_indoors` and broadcast SMS directions to affected vendors and staff. |

---

## 3. Standard Operating Procedures (SOPs)

### SOP 1: Incident Response
1. Retrieve active incidents with `get_active_incidents`.
2. For severe incidents (`severity: "high"` or `"critical"`):
   - Escalate immediately with `escalate_to_coordinator(subject, message)`.
   - Reassign 1–2 nearby volunteers to support the zone using `reassign_volunteer`.
3. Once the situation is cleared by field staff, invoke `mark_incident_resolved(incident_id, resolution_note)`.
4. Always finalize with `sync_to_sheets` to ensure human leads have the latest incident log.

### SOP 2: Volunteer Dispatch & Dynamic Rebalancing
1. Check staffing levels with `get_understaffed_zones`.
2. Identify idle or flexible volunteers with `get_volunteer_availability`.
3. Never leave another critical zone understaffed to fill a low-priority zone.
4. Execute `reassign_volunteer(volunteer_id, new_zone_id)`.
   * *The server will automatically update the SQLite database, dispatch an SMS notification to the volunteer, and follow up with turn-by-turn walking directions.*
5. If a volunteer does not check in or reports absent, call `report_volunteer_absent(volunteer_id)`.

### SOP 3: Vendor Arrival & Delay Management
1. Run `get_overdue_vendors` to find missing vendors.
2. **Crucial Rule:** Check `acknowledged_delay` timestamps. **Never** cancel or penalize a vendor whose delay has been acknowledged and whose `delay_until` timestamp has not expired.
3. If a vendor replies via SMS with a new arrival time, record it immediately with `acknowledge_vendor_delay(vendor_id, delay_until, reason)`.
4. If a vendor fails to arrive 30 minutes after their final cutoff and does not answer SMS, call `cancel_vendor_slot(vendor_id, reason)` and notify stage managers.

### SOP 4: Weather Contingency Plans
1. Call `get_weather(location)` periodically (especially for outdoor stages, food courts, and open-air zones).
2. If weather forecasts rain, high winds, or severe storms:
   - Identify affected outdoor zones.
   - Call `move_zone_indoors(outdoor_zone_id, indoor_zone_id)`.
   - Broadcast relocation notices to impacted vendors and team leads using `send_sms`.

---

## 4. Operational Guardrails

- **Always Sync:** After performing state modifications (reassignments, cancellations, incident resolutions), call `sync_to_sheets` so the human dashboard matches reality.
- **Always Notify:** Never silently move a volunteer or vendor. Ensure SMS notifications (`send_sms` or built-in actions) are sent to keep on-the-ground staff aware.
- **Concise Reporting:** When reporting summaries to human operators, summarize status into:
  1. *Active Incidents*
  2. *Staffing Health (% coverage)*
  3. *Vendor Readiness*
  4. *Actions Taken*
