# KM Tracker

A web app for field executives. An executive registers, signs in, and the app records the km travelled from sign in to sign out using the phone's GPS. Those km are added to the month's expenses. Check-in and check-out at visiting places are recorded too, and any report can be pulled from other apps such as Excel or Google Sheets.

Stack: Node.js 22.13 or newer, Express, SQLite (built into Node, nothing to compile), password login with an httpOnly cookie, plain HTML/CSS/JS front end.

## Run it on your PC

```
npm install
set ADMIN_EMAIL=you@company.com
set ADMIN_PASSWORD=a-long-password
npm start
```

(PowerShell: `$env:ADMIN_EMAIL="you@company.com"` and `$env:ADMIN_PASSWORD="a-long-password"`. Mac and Linux: `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm start`.)

Open http://localhost:3000. The admin account is created from those two values the first time only.

Phones share location only over HTTPS, so deploy behind HTTPS before real use. localhost is the exception.

## The flow

1. **Register.** An executive taps "New executive? Register here". The account waits for approval.
2. **Approve.** The admin opens **Team**, sets the rate per km and taps Approve. (Under **Rules** the admin can close registration and create accounts only by hand.)
3. **Sign in = start of day.** Signing in starts a shift and starts live tracking. A bar at the top shows "Tracking on", the km so far and the allowance.
4. **Check in and out.** At each place the executive enters the place name and checks in. When leaving, adds toll, parking and other costs and checks out.
5. **Sign out = end of day.** The shift closes. If a phone stops sending for 2 hours the shift is closed automatically at the last signal.
6. **Month.** Report shows each day signed in (login, logout, km, allowance) and each visit (place, times, costs), with totals.

## What the claim is

- Km claimed = km from live tracking, per day signed in.
- Allowance = km claimed x the executive's rate (the rate is saved when the day starts).
- Total claim = allowance + toll + parking + other costs from visits.
- The admin can correct a day's km under Report, Adjust, with a written reason that stays in the report.

## How live km are counted

The phone sends a GPS reading about every 10 seconds, in batches every 15 seconds. The server judges each reading against the last counted position:

| Situation | Result |
| --- | --- |
| Moved less than 25 m (standing still, GPS drift) | not counted |
| GPS accuracy worse than 100 m | skipped |
| Speed above 120 km/h between readings | not counted, flagged (fake or skipped location) |
| Location jumped far in seconds | not counted, flagged |
| Phone moved while silent for over 15 minutes | not counted, flagged |
| Reading with a wrong or future timestamp | skipped |

Times are checked against the server's clock. All limits are editable under **Rules**. Flags show on the executive's screen and in the report.

## Check in and check out

Each visit is checked against rules (stay at least 5 min, check-out within 500 m of check-in, places at least 5 km apart, believable speed between places). The result appears as "Distance OK" or "Check needed". This is a cross-check of the visits and does not change the km claimed.

## Admin live map

**Map** shows each signed-in executive's current position, the path travelled that day, check-in places and who is live, signal lost or signed out. It refreshes every 10 seconds and can show past days.

## Reports for other apps

Under **Rules**, "Reports for other apps", create a key. Then:

```
https://YOUR-SITE/api/external/summary.csv?month=2026-10&tz=-330&key=YOUR_KEY
https://YOUR-SITE/api/external/shifts.csv?month=2026-10&tz=-330&key=YOUR_KEY
https://YOUR-SITE/api/external/visits.csv?month=2026-10&tz=-330&key=YOUR_KEY
https://YOUR-SITE/api/external/report.json?month=2026-10&tz=-330&key=YOUR_KEY
```

Add `&email=person@company.com` for one executive. A program can send `Authorization: Bearer YOUR_KEY` instead of putting the key in the address. In Excel use Data, Get Data, From Web. In Google Sheets use `=IMPORTDATA("address")`. Outside apps can reach this only when it is online over HTTPS. The key can be replaced or turned off at any time.

## Limits to know

- A web page can track only while the page is open and the phone is awake. The app asks the phone to keep the screen on, but if the executive locks the phone or switches apps for long, readings stop and that stretch of travel is not counted (it shows as a gap). A native Android app can track in the background.
- A fake-GPS app that moves at believable speeds cannot be detected from a web page. A native Android app can detect most of them.
- Straight-line distance between readings every 10 seconds is very close to the driven distance, slightly under on winding roads.

## Deploy

Any host that runs Node works. Keep the `DATA_DIR` folder on a persistent disk, because it holds the database.

- **Docker:** `docker build -t km-tracker . && docker run -p 3000:3000 -v kmdata:/data -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... km-tracker`
- **Render / Railway / similar:** build command `npm install`, start command `npm start`, add a persistent disk, set `NODE_ENV=production`, `DATA_DIR` to the disk path, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Without a persistent disk the data is lost on every deploy.

Back up `km.db` regularly. Detailed GPS points are kept for 120 days.

## Files

- `server.js` API, rules, reports
- `public/` the web app (`index.html`, `app.js`, `styles.css`) and `vendor/leaflet` for the map. Map tiles load from OpenStreetMap, so the admin's browser needs internet access.
