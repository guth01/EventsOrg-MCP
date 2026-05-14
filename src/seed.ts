/**
 * src/seed.ts
 *
 * Wipes and re-seeds the database with realistic test data.
 * Run with:  npx tsx src/seed.ts
 */
import { initDb, getDb } from "./db.js";

initDb();
const db = getDb();

// ─── helpers ────────────────────────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000); // current unix timestamp
const hrsAgo = (h: number) => now - h * 3600;
const hrsFrom = (h: number) => now + h * 3600;
const minsAgo = (m: number) => now - m * 60;
const minsFrom = (m: number) => now + m * 60;

// ─── wipe existing data ──────────────────────────────────────────────────────
db.exec(`
  DELETE FROM sms_log;
  DELETE FROM incidents;
  DELETE FROM volunteers;
  DELETE FROM vendors;
  DELETE FROM zones;
`);

// ─── zones ───────────────────────────────────────────────────────────────────
const insertZone = db.prepare(`
  INSERT INTO zones (name, type, capacity, current_headcount, min_volunteers)
  VALUES (@name, @type, @capacity, @current_headcount, @min_volunteers)
`);

const zones = [
  { name: "Main Stage",   type: "outdoor", capacity: 5000, current_headcount: 3200, min_volunteers: 8 },
  { name: "Gate A",       type: "outdoor", capacity: 500,  current_headcount: 320,  min_volunteers: 4 },
  { name: "Gate B",       type: "outdoor", capacity: 500,  current_headcount: 280,  min_volunteers: 4 },
  { name: "Food Court",   type: "indoor",  capacity: 800,  current_headcount: 610,  min_volunteers: 3 },
  { name: "Parking",      type: "outdoor", capacity: 1000, current_headcount: 870,  min_volunteers: 5 },
  { name: "Medical",      type: "indoor",  capacity: 50,   current_headcount: 12,   min_volunteers: 2 },
];

for (const z of zones) insertZone.run(z);
console.log(`[seed] Inserted ${zones.length} zones`);

// ─── vendors ─────────────────────────────────────────────────────────────────
const insertVendor = db.prepare(`
  INSERT INTO vendors
    (name, category, phone, expected_checkin, status, assigned_zone, delay_until, notes)
  VALUES
    (@name, @category, @phone, @expected_checkin, @status, @assigned_zone, @delay_until, @notes)
`);

const vendors = [
  {
    name: "Bob's Burgers",
    category: "food",
    phone: "+919876543210",
    expected_checkin: hrsAgo(2),
    status: "checked_in",
    assigned_zone: "Food Court",
    delay_until: null,
    notes: "Arrived 10 min early. Great setup.",
  },
  {
    name: "Spicy Wok",
    category: "food",
    phone: "+919876543211",
    expected_checkin: hrsAgo(1),
    status: "late",
    assigned_zone: "Food Court",
    delay_until: null,
    notes: null,
  },
  {
    name: "SoundPro AV",
    category: "sound",
    phone: "+919876543212",
    expected_checkin: hrsAgo(3),
    status: "checked_in",
    assigned_zone: "Main Stage",
    delay_until: null,
    notes: "Rigging complete. PA live.",
  },
  {
    name: "Bass Amplify",
    category: "sound",
    phone: "+919876543213",
    expected_checkin: minsAgo(45),
    status: "delay_acknowledged",
    assigned_zone: "Main Stage",
    delay_until: minsFrom(30),
    notes: "Replied — stuck on highway, ETA 30 min.",
  },
  {
    name: "GuardForce Security",
    category: "security",
    phone: "+919876543214",
    expected_checkin: hrsAgo(4),
    status: "checked_in",
    assigned_zone: "Gate A",
    delay_until: null,
    notes: "Full squad deployed.",
  },
  {
    name: "Eagle Eye Security",
    category: "security",
    phone: "+919876543215",
    expected_checkin: hrsAgo(1),
    status: "no_show",
    assigned_zone: "Gate B",
    delay_until: null,
    notes: "No response to 2 SMS attempts.",
  },
  {
    name: "QuickMove Logistics",
    category: "logistics",
    phone: "+919876543216",
    expected_checkin: hrsAgo(3),
    status: "checked_in",
    assigned_zone: "Parking",
    delay_until: null,
    notes: "Barriers and signage installed.",
  },
  {
    name: "Fridge Fresh Catering",
    category: "food",
    phone: "+919876543217",
    expected_checkin: minsAgo(30),
    status: "late",
    assigned_zone: "Food Court",
    delay_until: null,
    notes: null,
  },
  {
    name: "MedSupply Co.",
    category: "logistics",
    phone: "+919876543218",
    expected_checkin: hrsAgo(2),
    status: "checked_in",
    assigned_zone: "Medical",
    delay_until: null,
    notes: "Medical kit inventory verified.",
  },
  {
    name: "Stage Craft Infra",
    category: "logistics",
    phone: "+919876543219",
    expected_checkin: minsAgo(10),
    status: "pending",
    assigned_zone: "Main Stage",
    delay_until: null,
    notes: "Due for check-in any moment.",
  },
];

for (const v of vendors) insertVendor.run(v);
console.log(`[seed] Inserted ${vendors.length} vendors`);

// ─── volunteers ───────────────────────────────────────────────────────────────
const insertVolunteer = db.prepare(`
  INSERT INTO volunteers
    (name, phone, role, current_zone, shift_start, shift_end, status)
  VALUES
    (@name, @phone, @role, @current_zone, @shift_start, @shift_end, @status)
`);

const shiftStart = hrsAgo(4);
const shiftEnd   = hrsFrom(4);

const volunteers = [
  // Main Stage (3 volunteers)
  { name: "Arjun Mehta",     phone: "+919800000001", role: "Crowd Control",   current_zone: "Main Stage", shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Priya Nair",      phone: "+919800000002", role: "Wristband Check", current_zone: "Main Stage", shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Kiran Das",       phone: "+919800000003", role: "Barrier Monitor", current_zone: "Main Stage", shift_start: shiftStart, shift_end: shiftEnd, status: "absent" },
  // Gate A (4 volunteers)
  { name: "Sneha Pillai",    phone: "+919800000004", role: "Entry Scanner",   current_zone: "Gate A",     shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Rohan Gupta",     phone: "+919800000005", role: "Entry Scanner",   current_zone: "Gate A",     shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Divya Sharma",    phone: "+919800000006", role: "Queue Manager",   current_zone: "Gate A",     shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Amit Singh",      phone: "+919800000007", role: "Queue Manager",   current_zone: "Gate A",     shift_start: shiftStart, shift_end: shiftEnd, status: "reassigned" },
  // Gate B (2 volunteers — understaffed, min is 4)
  { name: "Lakshmi Iyer",    phone: "+919800000008", role: "Entry Scanner",   current_zone: "Gate B",     shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Nikhil Verma",    phone: "+919800000009", role: "Queue Manager",   current_zone: "Gate B",     shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  // Food Court (4 volunteers)
  { name: "Pooja Krishnan",  phone: "+919800000010", role: "Vendor Liaison",  current_zone: "Food Court", shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Suresh Bhat",     phone: "+919800000011", role: "Crowd Control",   current_zone: "Food Court", shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Ananya Roy",      phone: "+919800000012", role: "Crowd Control",   current_zone: "Food Court", shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Rajeev Pillai",   phone: "+919800000013", role: "Vendor Liaison",  current_zone: "Food Court", shift_start: shiftStart, shift_end: shiftEnd, status: "absent" },
  // Parking (3 volunteers)
  { name: "Meera Joshi",     phone: "+919800000014", role: "Traffic Guide",   current_zone: "Parking",    shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Vimal Chandran",  phone: "+919800000015", role: "Traffic Guide",   current_zone: "Parking",    shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Shreya Reddy",    phone: "+919800000016", role: "Traffic Guide",   current_zone: "Parking",    shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  // Medical (2 volunteers)
  { name: "Dr. Anil Kumar",  phone: "+919800000017", role: "First Aid",       current_zone: "Medical",    shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Sana Sheikh",     phone: "+919800000018", role: "First Aid",       current_zone: "Medical",    shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  // Unassigned / floaters
  { name: "Tarun Bose",      phone: "+919800000019", role: "Runner",          current_zone: null,         shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
  { name: "Heena Malhotra",  phone: "+919800000020", role: "Runner",          current_zone: null,         shift_start: shiftStart, shift_end: shiftEnd, status: "active" },
];

for (const v of volunteers) insertVolunteer.run(v);
console.log(`[seed] Inserted ${volunteers.length} volunteers`);

// ─── incidents ────────────────────────────────────────────────────────────────
const insertIncident = db.prepare(`
  INSERT INTO incidents (description, zone_id, severity, status, created_at, resolved_at, resolution_note)
  VALUES (@description, @zone_id, @severity, @status, @created_at, @resolved_at, @resolution_note)
`);

const incidents = [
  {
    description: "Medical emergency — attendee fainted near front barrier.",
    zone_id: 1, // Main Stage
    severity: "high",
    status: "resolved",
    created_at: hrsAgo(1),
    resolved_at: minsAgo(45),
    resolution_note: "Medical team responded. Attendee escorted to Medical zone.",
  },
  {
    description: "Gate B scanner offline — staff manually checking tickets.",
    zone_id: 3, // Gate B
    severity: "medium",
    status: "open",
    created_at: minsAgo(20),
    resolved_at: null,
    resolution_note: null,
  },
  {
    description: "Minor spillage in Food Court aisle 3.",
    zone_id: 4, // Food Court
    severity: "low",
    status: "resolved",
    created_at: hrsAgo(2),
    resolved_at: hrsAgo(1),
    resolution_note: "Cleaned up by custodial staff.",
  },
  {
    description: "Unauthorized vehicle in Parking Zone C.",
    zone_id: 5, // Parking
    severity: "medium",
    status: "open",
    created_at: minsAgo(10),
    resolved_at: null,
    resolution_note: null,
  },
];

for (const i of incidents) insertIncident.run(i);
console.log(`[seed] Inserted ${incidents.length} incidents`);

// ─── sms_log ─────────────────────────────────────────────────────────────────
const insertSms = db.prepare(`
  INSERT INTO sms_log (phone, direction, body, intent, created_at)
  VALUES (@phone, @direction, @body, @intent, @created_at)
`);

const smsLogs = [
  {
    phone: "+919876543213",
    direction: "outbound",
    body: "Hi Bass Amplify, you were expected to check in 45 minutes ago. Are you on your way?",
    intent: null,
    created_at: minsAgo(42),
  },
  {
    phone: "+919876543213",
    direction: "inbound",
    body: "Sorry stuck behind an accident on the highway. Will be there in 30 min.",
    intent: "arrival_delay",
    created_at: minsAgo(40),
  },
  {
    phone: "+919876543215",
    direction: "outbound",
    body: "Hi Eagle Eye Security, you were expected at Gate B 1 hour ago. Please respond.",
    intent: null,
    created_at: minsAgo(58),
  },
  {
    phone: "+919876543215",
    direction: "outbound",
    body: "Hi Eagle Eye Security, this is a second reminder. No response received. Please call the coordinator.",
    intent: null,
    created_at: minsAgo(28),
  },
  {
    phone: "+919800000007",
    direction: "outbound",
    body: "Hi Amit, Gate B is short-staffed. Can you head there now? Directions: https://maps.google.com/?q=Gate+B",
    intent: null,
    created_at: minsAgo(15),
  },
  {
    phone: "+919800000007",
    direction: "inbound",
    body: "Yes on my way!",
    intent: "confirmed_reassignment",
    created_at: minsAgo(13),
  },
];

for (const s of smsLogs) insertSms.run(s);
console.log(`[seed] Inserted ${smsLogs.length} SMS log entries`);

console.log("\n✅  Seed complete. Run: sqlite3 grid.db");
