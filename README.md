# LAOT — Seafood Trading Corporation EDM

> **LAOT** (Binisaya *laot*, "the open sea" where fishers go out to catch) is also an acronym of the parts the system connects: **L**ogistics · **A**ccounting · **O**perations · **T**raceability.

An enterprise data management system for a fish port & seafood trading company.
It has two main parts:

1. **Department Integration.** Three departments work on the **same records**: **Operations** (landing, grading, cold storage), **Sales & Logistics** (orders, trucks, delivery) and **Finance** (fisher pay, invoices, payments). When one department finishes a step, the next department's work is created automatically through events. The **Admin** looks after data quality.
2. **Data Quality Management (DQM).** There are 15 configurable rules covering 6 quality dimensions. They run in real time (to block or warn), at workflow events, and in a scheduled scan. The DQM also has an issue queue, duplicate detection and merging, standardization, scores, and an audit trail.

| Part | Tech |
|---|---|
| Frontend | Next.js 16 (App Router, TypeScript, Tailwind CSS 4), Chart.js, qrcode.react |
| Backend | Express 5 + TypeScript, Prisma 6, Zod, JWT auth, node-cron |
| Database | PostgreSQL on **Neon** (uses the `pg_trgm` extension for fuzzy duplicate matching) |

---

## Setup (each group member)

You need **Node.js 20+**.

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env        # then paste the Neon connection strings (ask the group lead)
npm run db:migrate          # creates the tables (only needed once per database)
npm run db:seed             # ⚠ ERASES all data and loads the demo data
npm run dev                 # API on http://localhost:4000/api

# 2. Frontend (new terminal)
cd frontend
npm install
cp .env.example .env.local
npm run dev                 # app on http://localhost:3000
```

**Neon tips**
- `DATABASE_URL` is the **pooled** string (its host contains `-pooler`). `DIRECT_URL` is the same string without `-pooler`, and migrations use it.
- All four members can share one Neon database. To experiment without breaking the shared data, create a **Neon branch** and put its URLs in your own `.env`.
- Neon sleeps when it is idle, so the first request can take about a second. Open the app a minute before you demo.
- Only one person should run `npm run db:seed`, because it resets everyone's data.

**Demo accounts.** The password for all of them is `laot2026`. The login page has a one-tap sign-in row for each one.

| Department | Email | Sees in the sidebar |
|---|---|---|
| Operations | operations@laot.com | Landing & Grading, Cold Storage, Species, Fishers, Vessels, Storage Units |
| Sales & Logistics | sales@laot.com | Sales Orders, Dispatch & Delivery, Buyers, Trucks, Species |
| Finance | finance@laot.com | Finance, Fishers, Buyers |
| Admin | admin@laot.com | Everything, plus DQ Rules, Duplicates, Standardization, Audit Trail, Users |

Every department also sees the Dashboard (with the Arrivals/Departures boards), Lot Traceability, the DQ Dashboard, its **own** DQ issues, and the Integration Log. The API enforces the same rules: requesting another department's data returns **403**.

## Using it with real data

The data is **not hardcoded**. Every screen reads from the Neon database. The seed only loads sample data for the demo.

```bash
cd backend
npm run db:fresh            # ⚠ clears all sample data; keeps users, DQ rules, species, storage units, trucks
npm run db:fresh -- --all   # ⚠ also clears species, storage units and trucks
```

Then, in this order:
1. **Admin:** create real user accounts (Master Data → Users) and change the demo passwords. Set up Species (prices, shelf life), Storage Units and Trucks.
2. **Operations:** register Fishers and Vessels. When a boat arrives, use **Record landing**, then **Grade** the catch into lots, then **Store** each lot and **Log temperature** regularly.
3. **Sales & Logistics:** register Buyers, create a **New order**, **Assign truck**, then **Record delivery** with the actual weight.
4. **Finance:** **Approve / Pay** the fisher settlements (drafted automatically after grading) and **Record payment** on invoices (issued automatically after delivery).
5. **Admin:** watch the DQ Dashboard and Issue Queue, merge duplicates, and run Standardization.

---

## How the departments are connected

```
        OPERATIONS                         SALES & LOGISTICS                     FINANCE
  landing → grading → storage  ──LotStored──▶  order → truck → delivery
              │                                           │
              └───────────LandingGraded─────────────────────────────────▶ fisher settlement drafted
                                                          └──DispatchDelivered──▶ invoice issued (delivered kg)
  ◀──ShrinkageAlert── (weight lost on delivery)
  ◀────────────────────────SettlementPaid / PaymentReceived──────────────────────────────
```

- The central record is the **Lot**: `GRADED → IN_STORAGE → RESERVED → DELIVERED`, or `QUARANTINED → SPOILED`.
- Every hand-off is saved in `IntegrationEvent` and shown on the **Integration Log** page.
- Automatic hand-offs are coded in `backend/src/integration/handlers.ts`.
- Every create, update, delete and merge is written to the **Audit Trail** automatically (`backend/src/db.ts`).

## Data Quality Management

| Code | Dimension | Rule | Default |
|---|---|---|---|
| DQ-01 | Completeness | Fisher has TIN + payout details before settlement | BLOCK |
| DQ-02 | Completeness | Lot has grade, weight, expiry and unit before storage | BLOCK |
| DQ-03 | Validity | Phone `09XXXXXXXXX`, TIN `XXX-XXX-XXX-XXX`, email format | BLOCK |
| DQ-04 | Validity | Temperature reading is physically plausible | WARN |
| DQ-05 | Accuracy | Net weight ≤ gross weight | BLOCK |
| DQ-06 | Accuracy | Selling price within the species range | WARN |
| DQ-07 | Accuracy | Catch ≤ vessel capacity | WARN |
| DQ-08 | Uniqueness | No duplicate fishers/buyers (pg_trgm similarity or same phone) | WARN |
| DQ-09 | Uniqueness | No over-selling a lot (also enforced atomically in the DB) | BLOCK |
| DQ-10 | Consistency | Shrinkage between storage and delivery within tolerance | WARN |
| DQ-11 | Consistency | Invoice total = sum of its lines | BLOCK |
| DQ-12 | Consistency | Storage unit temperature within its range | WARN |
| DQ-13 | Timeliness | Expired lots are quarantined and cannot be stored or sold | BLOCK |
| DQ-14 | Timeliness | Each storage unit has a temperature reading in the last 4 h | WARN |
| DQ-15 | Timeliness | Landings are graded within 2 h | WARN |

- **BLOCK** stops the save (HTTP 422, shown as a red toast). **WARN** saves the record but opens an issue (shown as an amber toast).
- An issue is assigned to the department that **owns** the data, and it closes automatically once the data passes the rule again.
- Rules are stored in the `DqRule` table. On the **Rules** page an admin can switch a rule on or off, change BLOCK ↔ WARN, and change thresholds without touching code.
- **Cleansing** happens before every save: Title Case names, phones as `09XXXXXXXXX`, TINs as `XXX-XXX-XXX-XXX`. The **Standardization** page fixes older records.
- **Score** is the % of checked records with no open issue. It is computed overall, per department and per dimension, and saved daily for the trend chart.
- Code: `backend/src/dq/` (`catalog.ts` lists the rules, `rules.ts` holds the checks, `engine.ts` is the real-time gate, `scan.ts` runs the batch scan and computes scores).

The seed adds **dirty data on purpose** (duplicates, bad formats, a missing TIN, an expired lot, a +25 °C freezer reading, an edited invoice total, high shrinkage, an over-capacity landing, an ungraded landing). The first scan finds all of it, and the overall score starts at about **82%**.

## Demo script for the defense (about 10 minutes)

1. **Login page.** Explain the 3 departments plus the Admin. Sign in as **Admin**.
2. **Dashboard.** Point out the Arrivals and Departures boards: a blinking orange status means another department must act. Open the **DQ Dashboard**: the score is 82%.
3. **Duplicates & Merge.** "Juan Dela Cruz" and "dela cruz, juan" are a 100% match with the same phone. Click **Keep this one**. The vessel moves to the kept record.
4. **Standardization.** Show the before and after values, then **Apply all**.
5. **Finance** (finance@). Approve Ramon Villanueva's settlement. It is **blocked by DQ-01** because he has no TIN and no payout method. As admin, add both in Master Data → Fishers, then approve again. It goes through.
6. **Operations** (operations@). The sidebar shows only Operations pages, and opening /finance shows **No access**. Grade the FB Lucky Star catch with more net weight than gross: **DQ-05 blocks** it. Enter a correct weight, store the lots, and log a temperature on CH-02 (DQ-14 resolves).
7. **Sales & Logistics** (sales@). Try to sell more than is available: **DQ-09 blocks**. Sell a normal amount, assign a truck (the non-reefer truck is rejected), then deliver with a big weight loss: **DQ-10 warns**. Finance gets the invoice automatically.
8. **Lot Traceability.** Open a lot and follow it from boat to invoice. Show the QR code.
9. **DQ Dashboard → Run full scan now.** The score goes up. Show the **Integration Log** and **Audit Trail**.

## Project structure

```
backend/
  prisma/schema.prisma      database design (all tables)
  prisma/seed.ts            demo data
  src/services/             one file per department workflow
  src/dq/                   Data Quality Management engine
  src/integration/          event bus + automatic hand-offs
  src/routes/               REST API
frontend/
  src/app/(app)/            one folder per page
  src/components/           shared UI (Shell, tables, modals, toasts)
  src/lib/                  API client, auth, formatting
```
