// generate.js
// Fetches your GitHub contribution history and builds an animated
// contribution-graph.svg you can embed in your README.
//
// Usage:
//   1. Put GITHUB_TOKEN=your_token and GITHUB_USERNAME=your_username in a .env file
//   2. npm install node-fetch dotenv
//   3. node generate.js

require("dotenv").config();
const fs = require("fs");

const TOKEN = process.env.GITHUB_TOKEN;
const USERNAME = process.env.GITHUB_USERNAME;

if (!TOKEN || !USERNAME) {
  console.error("Missing GITHUB_TOKEN or GITHUB_USERNAME in .env");
  process.exit(1);
}

const QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

async function fetchContributions() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
  });

  const json = await res.json();

  if (json.errors) {
    console.error("GitHub API error:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }

  const calendar = json.data.user.contributionsCollection.contributionCalendar;
  const weeks = calendar.weeks;

  // Flatten into { date, count } per day, keep the week grid too
  const days = weeks.flatMap((w) => w.contributionDays).map((d) => ({
    date: d.date,
    count: d.contributionCount,
  }));

  return { totalContributions: calendar.totalContributions, weeks, days };
}

// ---- Aggregation: monthly totals, streaks, best day ----

function aggregate(days) {
  const monthlyMap = {};
  for (const d of days) {
    const month = d.date.slice(0, 7); // "2026-07"
    monthlyMap[month] = (monthlyMap[month] || 0) + d.count;
  }
  const monthly = Object.entries(monthlyMap).map(([month, total]) => ({
    month,
    total,
  }));

  let bestDay = { date: null, count: -1 };
  let activeDays = 0;
  let currentStreak = { length: 0, start: null, end: null };
  let longestStreak = { length: 0, start: null, end: null };
  let runStart = null;

  for (const d of days) {
    if (d.count > bestDay.count) bestDay = { date: d.date, count: d.count };
    if (d.count > 0) {
      activeDays++;
      if (!runStart) runStart = d.date;
      const runLength =
        (new Date(d.date) - new Date(runStart)) / 86400000 + 1;
      if (runLength > longestStreak.length) {
        longestStreak = { length: runLength, start: runStart, end: d.date };
      }
    } else {
      runStart = null;
    }
  }

  // Current streak = trailing run of active days up to the last day with data
  let i = days.length - 1;
  let streakLen = 0;
  let streakEnd = null;
  let streakStart = null;
  while (i >= 0 && days[i].count > 0) {
    if (!streakEnd) streakEnd = days[i].date;
    streakStart = days[i].date;
    streakLen++;
    i--;
  }
  currentStreak = { length: streakLen, start: streakStart, end: streakEnd };

  const avgPerActiveDay = activeDays ? +(
    days.reduce((s, d) => s + d.count, 0) / activeDays
  ).toFixed(1) : 0;

  return {
    monthly,
    bestDay,
    activeDays,
    currentStreak,
    longestStreak,
    avgPerActiveDay,
  };
}

// ---- SVG generation ----
// Color scale based on quartiles of non-zero counts, built around your
// iconic pink (#f3bfd6). Dark mode gets brighter toward that pink on a
// dark background; light mode gets more saturated/deeper toward the pink
// on a white background, so both stay readable.

const THEMES = {
  dark: {
    bg: "transparent",
    text: "#7d8590",
    total: "#e6edf3",
    empty: "#2a1620",
    levels: ["#5c2740", "#9c3f66", "#d4638f", "#f3bfd6"],
  },
  light: {
    bg: "transparent",
    text: "#57606a",
    total: "#24292f",
    empty: "#f6eef2",
    levels: ["#f3bfd6", "#e88fb3", "#d85f92", "#c22f72"],
  },
};

function levelColor(count, max, theme) {
  if (count === 0) return theme.empty;
  const ratio = count / max;
  if (ratio > 0.75) return theme.levels[3];
  if (ratio > 0.5) return theme.levels[2];
  if (ratio > 0.25) return theme.levels[1];
  return theme.levels[0];
}

function buildSvg({ weeks, totalContributions }, theme) {
  const cell = 13;
  const gap = 3;
  const colW = cell + gap;
  const rowH = cell + gap;
  const gridLeft = 34;
  const gridTop = 24;
  const width = gridLeft + weeks.length * colW + 20;
  const height = gridTop + 7 * rowH + 30;

  const maxCount = Math.max(
    ...weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount))
  );

  let cells = "";
  let monthLabels = "";
  let lastMonth = null;

  weeks.forEach((week, col) => {
    const firstDay = week.contributionDays[0];
    if (firstDay) {
      const month = new Date(firstDay.date).toLocaleString("en-US", {
        month: "short",
      });
      if (month !== lastMonth) {
        monthLabels += `<text class="lbl" x="${gridLeft + col * colW}" y="16">${month}</text>`;
        lastMonth = month;
      }
    }

    week.contributionDays.forEach((day, row) => {
      const x = gridLeft + col * colW;
      const y = gridTop + row * rowH;
      const color = levelColor(day.contributionCount, maxCount, theme);
      const delay = ((col * 7 + row) * 0.013).toFixed(3);
      const cls = day.contributionCount === 0 ? "c e" : "c g";
      cells += `<rect class="${cls}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${color}" style="animation-delay:${delay}s"/>`;
    });
  });

  const dayLabels = `
    <text class="lbl" x="2" y="${gridTop + 1 * rowH + 3}">Mon</text>
    <text class="lbl" x="2" y="${gridTop + 3 * rowH + 3}">Wed</text>
    <text class="lbl" x="2" y="${gridTop + 5 * rowH + 3}">Fri</text>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<style>
  text.lbl { fill:${theme.text}; font-size:13px; font-weight:600; }
  text.total { fill:${theme.total}; font-size:15px; font-weight:700; }
  .c { transform-box:fill-box; transform-origin:center; opacity:0; animation:pop 0.55s ease-out both; }
  .g { animation:pop 0.55s ease-out both, flash 0.7s ease-out both; }
  @keyframes pop { 0%{opacity:0;transform:scale(.2)} 60%{opacity:1;transform:scale(1.1)} 100%{opacity:1;transform:scale(1)} }
  @keyframes flash { 0%{filter:brightness(2.4)} 45%{filter:brightness(2.4)} 100%{filter:brightness(1)} }
  @media (prefers-reduced-motion: reduce) { .c { opacity:1 !important; animation:none !important; } }
</style>
<rect width="${width}" height="${height}" fill="none"/>
${monthLabels}
${dayLabels}
${cells}
<text class="total" x="${gridLeft}" y="${height - 6}">${totalContributions.toLocaleString()} contributions in the last year</text>
</svg>`;
}

// ---- Main ----

(async () => {
  console.log(`Fetching contributions for ${USERNAME}...`);
  const { totalContributions, weeks, days } = await fetchContributions();

  const stats = aggregate(days);
  const output = {
    username: USERNAME,
    generated_at: new Date().toISOString(),
    total_contributions: totalContributions,
    active_days: stats.activeDays,
    avg_per_active_day: stats.avgPerActiveDay,
    current_streak: stats.currentStreak,
    longest_streak: stats.longestStreak,
    best_day: stats.bestDay,
    monthly: stats.monthly,
    days,
  };

  fs.writeFileSync("contributions.json", JSON.stringify(output, null, 2));
  console.log("Wrote contributions.json");

  const svgDark = buildSvg({ weeks, totalContributions }, THEMES.dark);
  fs.writeFileSync("contribution-graph-dark.svg", svgDark);
  console.log("Wrote contribution-graph-dark.svg");

  const svgLight = buildSvg({ weeks, totalContributions }, THEMES.light);
  fs.writeFileSync("contribution-graph-light.svg", svgLight);
  console.log("Wrote contribution-graph-light.svg");
})();
