/*
 * ─────────────────────────────────────────────────────────────
 *  TASTE THE SHOW — SHOW DATES
 *  This is the only file you need to edit to add a new show.
 *
 *  1. Create the event on Ticket Tailor.
 *  2. Copy its link (e.g. https://www.tickettailor.com/events/fitnesstemplellc/1234567)
 *  3. Add a new entry below (copy an existing one and change it).
 *
 *  Dates use the format YYYY-MM-DD. Times are 24-hour, Las Vegas time.
 *  Past shows hide themselves automatically the day after they happen.
 * ─────────────────────────────────────────────────────────────
 */
window.TASTE_SHOWS = [
  {
    date: "2026-09-23",
    doors: "19:00",
    show: "20:00",
    end: "21:30",
    venue: "Gipsy Nightclub",
    address: "4605 Paradise Rd, Las Vegas, NV 89169",
    tickets: "https://www.tickettailor.com/events/fitnesstemplellc/2329193",
  },
];

/* Where the "Buy Tickets" button goes when no upcoming show is listed. */
window.TASTE_ALL_EVENTS_URL = "https://www.tickettailor.com/events/fitnesstemplellc";
