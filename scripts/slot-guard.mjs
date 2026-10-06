// Runs before `npm install` in post.yml (plain Node, no dependencies), so a
// backup run whose slot already went out stops in seconds.
//
// 2026-10-07: GitHub's scheduler skipped 9 of 23 posts on 10/3-10/6 (no run
// record at all) and delayed others by hours. Each slot is now scheduled three
// times (:07/:27/:47, see post.yml). This script works out which slot the run
// belongs to from the cron line that fired it — not from the clock, since a
// late 20:00 run would otherwise read as 21:00 and post the wrong type — and
// skips the run if that slot has already been posted or is too late.
//
// Writes to $GITHUB_ENV: SLOT_JST_HOUR / SLOT_JST_DATE (read by src/index.ts)
// and SLOT_SKIP=true when the run should stop.
import { appendFileSync, readFileSync } from "node:fs";

// A run this late is dropped rather than posted at an odd hour.
const MAX_DELAY_MINUTES = 180;

const schedule = process.env.SCHEDULE ?? "";
const out = (line) => {
  console.log(line);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, line + "\n");
};

// Manual runs (workflow_dispatch) have no schedule: leave them to the clock.
const fields = schedule.trim().split(/\s+/);
if (fields.length < 2 || !/^\d+$/.test(fields[1])) {
  console.log(`No single-hour schedule (${schedule || "manual run"}); slot is decided by the clock.`);
  process.exit(0);
}
const utcHour = Number(fields[1]);
const slotHour = (utcHour + 9) % 24;

// The slot's intended moment is the latest occurrence of slotHour:00 JST at or
// before now (a 22:00 slot run that slips past midnight still belongs to the
// previous day).
const now = new Date();
const intended = new Date(now);
intended.setUTCMinutes(0, 0, 0);
intended.setUTCHours(utcHour);
if (intended > now) intended.setUTCDate(intended.getUTCDate() - 1);
const slotDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(intended);
const delayMinutes = Math.round((now - intended) / 60000);

out(`SLOT_JST_HOUR=${slotHour}`);
out(`SLOT_JST_DATE=${slotDate}`);

const log = JSON.parse(readFileSync("data/posted-log.json", "utf-8"));
const done = log.find((entry) => entry.slotDate === slotDate && entry.slotHour === slotHour);
if (done) {
  console.log(`Slot ${slotDate} ${slotHour}:00 already posted at ${done.postedAt}; skipping.`);
  out("SLOT_SKIP=true");
} else if (delayMinutes > MAX_DELAY_MINUTES) {
  console.log(`Slot ${slotDate} ${slotHour}:00 is ${delayMinutes} min late; skipping.`);
  out("SLOT_SKIP=true");
} else {
  console.log(`Slot ${slotDate} ${slotHour}:00 not posted yet (${delayMinutes} min after the hour); posting.`);
}
