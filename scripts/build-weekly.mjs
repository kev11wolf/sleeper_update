// scripts/build-weekly.mjs
// Node 20+ required (fetch is built in). Run with: node scripts/build-weekly.mjs
import fs from "node:fs/promises";
import path from "node:path";

/* ===== CONFIG ===== */
const LEAGUE_ID = "1257480275340828672"; // Kevin's Sleeper league (hard-coded)
const MAX_WEEKS = 18;

// Optional env knobs (used by GitHub Action)
const NOTES_SOURCE = process.env.NOTES_SOURCE || "files"; // "files" | "issues"
const REPO_SLUG = process.env.REPO_SLUG || process.env.GITHUB_REPOSITORY || ""; // "owner/repo"
const GH_TOKEN = process.env.GITHUB_TOKEN || "";   // Provided inside Actions
const AUTO_CLOSE_ISSUES = (process.env.AUTO_CLOSE_ISSUES || "false").toLowerCase() === "true";

/* ===== SLEEPER ENDPOINTS =====
   Public, read-only; no auth. We'll use:
   - /state/nfl               -> current week/leg (week may be 0 in preseason)
   - /league/<id>
   - /league/<id>/users
   - /league/<id>/rosters
   - /league/<id>/matchups/<week>
   - /players/nfl (player dictionary)
   Docs: https://docs.sleeper.com/  (read-only public API, starters & players let us derive bench)
*/
const API = {
  state:   () => `https://api.sleeper.app/v1/state/nfl`,             // 
  league:  id => `https://api.sleeper.app/v1/league/${id}`,
  users:   id => `https://api.sleeper.app/v1/league/${id}/users`,
  rosters: id => `https://api.sleeper.app/v1/league/${id}/rosters`,
  matchups:(id,w)=>`https://api.sleeper.app/v1/league/${id}/matchups/${w}`,
  players: ()=> `https://api.sleeper.app/v1/players/nfl`
};
const AVATAR = (id) => id ? `https://sleepercdn.com/avatars/thumbs/${id}` : "";  // [1](https://docs.sleeper.com/)

/* ===== Utilities ===== */
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
function fmt(n) { return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function uniq(arr) { return Array.from(new Set(arr || [])); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function playerName(dict, pid) {
  const p = dict[pid] || {};
  if (p.first_name || p.last_name) return `${p.first_name || ""} ${p.last_name || ""}`.trim();
  return p.full_name || p.search_full_name || p.last_name || pid;
}

/* ===== Detect default week via /state/nfl =====
   Week can be 0 during preseason; we also nudge back on Mondays (UTC) so we show last completed week.
*/
async function detectWeek() {
  try {
    const s = await fetchJson(API.state()); // { season, week, leg, ... }  
    let wk = Number(s.week || 1);
    const dow = new Date().getUTCDay(); // 1=Mon
    if (wk > 1 && dow === 1) wk = wk - 1; // Monday -> show prior week
    return clamp(wk || 1, 1, MAX_WEEKS);
  } catch {
    return 1;
  }
}

/* ===== Optional smack-talk config =====
   If repo has smack-config.json, we merge with defaults.
*/
async function loadSmackConfig() {
  const defaults = {
    winQuips: [
      "put this one on ice 🧊",
      "brought the smoke 🔥",
      "owned the red zone like a landlord",
      "left skid marks on the scoreboard",
      "turned Sunday into a highlight reel"
    ],
    loseQuips: [
      "left points on the pine 🪵",
      "hit snooze on lineup changes 😴",
      "ran into a buzzsaw",
      "needed VAR on those start/sit calls",
      "played keep‑away… from the end zone"
    ]
  };
  try {
    const raw = await fs.readFile("smack-config.json", "utf8");
    const user = JSON.parse(raw);
    return {
      winQuips: Array.isArray(user.winQuips) && user.winQuips.length ? user.winQuips : defaults.winQuips,
      loseQuips: Array.isArray(user.loseQuips) && user.loseQuips.length ? user.loseQuips : defaults.loseQuips
    };
  } catch {
    return defaults;
  }
}

/* ===== Pull notes from file or Issues ===== */
async function loadNotesForWeek(week) {
  if (NOTES_SOURCE === "files") {
    try {
      const md = await fs.readFile(path.join("notes", `week-${week}.md`), "utf8");
      return md.trim();
    } catch {
      return "";
    }
  }
  if (NOTES_SOURCE === "issues" && REPO_SLUG && GH_TOKEN) {
    // Find open issue labeled weekly-notes with "Week <n>" in title
    const url = `https://api.github.com/repos/${REPO_SLUG}/issues?labels=weekly-notes&state=open&per_page=100`;
    const issues = await fetchJson(url, {
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    const re = new RegExp(`\\bweek\\s*${week}\\b`, "i");
    const hit = (issues || []).find(i => re.test(i.title || ""));
    if (hit) {
      // Optionally auto-close after consumption
      if (AUTO_CLOSE_ISSUES && hit.number) {
        await fetch(`https://api.github.com/repos/${REPO_SLUG}/issues/${hit.number}`, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${GH_TOKEN}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ state: "closed" })
        }).catch(()=>{});
      }
      return (hit.body || "").trim();
    }
  }
  return "";
}

/* ===== Friendly smack talk builder (PG-13) ===== */
function makeSmack({winner, loser, margin, t1, t2}, cfg) {
  const lines = { good: [], bad: [], ugly: [] };
  if (winner) lines.good.push(`🗣️ <b>${winner.team_name}</b> ${cfg.winQuips[Math.floor(Math.random()*cfg.winQuips.length)]}.`);
  if (loser)  lines.bad .push(`🗣️ <b>${loser.team_name}</b> ${cfg.loseQuips[Math.floor(Math.random()*cfg.loseQuips.length)]}.`);
  if (margin >= 40) lines.ugly.push(`🧹 Clean sweep — ${margin}‑pt blowout.`);
  if (t1?.benchPts > t1?.startersPts) lines.ugly.push(`🪑 ${t1.team_name} benched the fireworks (${fmt(t1.benchPts)} bench pts).`);
  if (t2 && t2.benchPts > t2.startersPts) lines.ugly.push(`🪑 ${t2.team_name} kept the heat on the sideline (${fmt(t2.benchPts)}).`);
  return lines;
}

/* ===== Render HTML (fully self-contained) ===== */
function renderHTML({ league, week, kpi, cardsHTML, repoSlug, notesMD }) {
  // Simple markdown → HTML (very light; only paragraphs & lists)
  const md = (s="") => s
    .replace(/^###\s?(.*)$/gm, "<h3>$1</h3>")
    .replace(/^##\s?(.*)$/gm, "<h2>$1</h2>")
    .replace(/^#\s?(.*)$/gm, "<h1>$1</h1>")
    .replace(/^\s*-\s+(.*)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, m=>`<ul>${m}</ul>`)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/^(.+)$/gm, "<p>$1</p>");

  const submitLink = repoSlug
    ? `https://github.com/${repoSlug}/issues/new?template=weekly-notes.yml&title=${encodeURIComponent(`Week ${week} Notes`)}&labels=weekly-notes&week=${week}
         ✍️ Submit Notes for Week ${week}
       </a>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>🏈 Fantasy Weekly — ${league.name || "Sleeper League"} (Week ${week})</title>
<meta name="description" content="Automated Sleeper league recap with avatars, animations, and friendly smack talk."/>
<style>
  :root{
    --bg:#f7f7f8; --ink:#111827; --muted:#6b7280; --card:#ffffff; --border:#e5e7eb;
    --accent:#0ea5e9; --good:#16a34a; --bad:#ef4444; --ugly:#f59e0b; --link:#0369a1;
    --chip:#eef2ff; --chip-ink:#3730a3;
  }
  *{box-sizing:border-box} html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--link);text-decoration:none}
  header{position:sticky;top:0;z-index:10;background:linear-gradient(180deg,#fff,rgba(255,255,255,.9));border-bottom:1px solid var(--border);backdrop-filter:saturate(1.3) blur(10px)}
  .wrap{max-width:1100px;margin:0 auto;padding:16px}
  h1{font-size:28px;margin:0 0 4px 0;display:flex;gap:8px;align-items:center}
  .sub{color:var(--muted);font-size:14px}
  .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 0}
  .pill,.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;border:1px solid var(--border);background:#fff;color:var(--muted)}
  .chip{background:var(--chip);color:var(--chip-ink);border:1px solid #e6e9ff}
  main{max-width:1100px;margin:18px auto;padding:0 16px}
  .kpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0 18px}
  .box{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px}
  .label{color:var(--muted);font-size:12px}.value{font-size:22px;font-weight:800;display:flex;align-items:center;gap:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:0 1px 1px rgba(0,0,0,.02)}
  .head{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .teams{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}
  .avatar{width:28px;height:28px;border-radius:50%;border:1px solid var(--border);object-fit:cover}
  .score{font-variant-numeric:tabular-nums;font-weight:800}
  .kpi-mini{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:12px 0}
  .mini{background:#fafafa;border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center}
  .mini .label{color:var(--muted);font-size:12px}.mini .value{font-size:18px;font-weight:700}
  .section{margin-top:12px}
  .section h4{margin:0 0 6px 0;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  .good ul{border-left:3px solid var(--good);padding-left:10px;margin:6px 0}
  .bad  ul{border-left:3px solid var(--bad); padding-left:10px;margin:6px 0}
  .ugly ul{border-left:3px solid var(--ugly);padding-left:10px;margin:6px 0}
  ul{padding-left:20px;margin:0} li{margin:4px 0}
  .muted{color:var(--muted)} footer{color:var(--muted);text-align:center;padding:20px}
  .smack-toggle{cursor:pointer;border:1px solid var(--border);background:#fff;color:var(--ink);border-radius:10px;padding:8px 10px}
  .smack-line[data-on="false"]{display:none}
  @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}} .appear{animation:fadeUp 650ms cubic-bezier(.22,.84,.35,1) both}
  .confetti{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:999}
  .confetti span{position:absolute;font-size:20px;animation:float 1200ms linear forwards;will-change:transform,opacity}
  @keyframes float{from{transform:translateY(0) rotate(0deg);opacity:1}to{transform:translateY(-120vh) rotate(720deg);opacity:0}}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1 class="appear">🏈 Fantasy Football Weekly</h1>
    <div class="sub">Sleeper recap — ✅ Good, ⚠️ Bad, 😬 Ugly, 🔍 Next Week <span class="muted">(smack talk optional)</span></div>
    <div class="controls">
      <span class="pill">League</span><span class="pill">${league.name || "Sleeper League"}</span>
      <span class="pill">Season ${league.season}</span>
      <span class="pill">Week ${week}</span>
      ${submitLink}
      <button class="smack-toggle" id="toggleSmack">🗣️ Smack Talk: ON</button>
    </div>
  </div>
</header>

<main>
  <section class="wrap">
    <div class="kpi appear">
      <div class="box"><div class="label">High</div><div class="value">🔥 ${fmt(kpi.high)}</div></div>
      <div class="box"><div class="label">Low</div><div class="value">🧊 ${fmt(kpi.low)}</div></div>
      <div class="box"><div class="label">Average</div><div class="value">📊 ${fmt(kpi.avg)}</div></div>
      <div class="box"><div class="label">Matchups</div><div class="value">🧮 ${kpi.matchups}</div></div>
    </div>

    ${notesMD ? `
    <div class="card appear">
      <div class="head"><div class="teams">📝 Commissioner Notes</div></div>
      <div class="section">${md(notesMD)}</div>
    </div>` : ""}

    <div class="grid">${cardsHTML}</div>
  </section>
</main>

<div class="confetti" id="confetti"></div>
<footer><div class="wrap"><div>Powered by Sleeper public API. Bench = players − starters. Avatars from sleepercdn.</div></div></footer>

<script>
(function(){
  const confettiBox = document.getElementById("confetti");
  function confettiBlast(emojiSet=["🎉","🏈","💥","⭐"], count=40){
    for(let i=0;i<count;i++){
      const s=document.createElement("span");
      s.textContent=emojiSet[Math.floor(Math.random()*emojiSet.length)];
      s.style.left=(Math.random()*100)+"vw"; s.style.bottom="-20px";
      s.style.animationDuration=(900+Math.random()*1200)+"ms";
      s.style.filter="hue-rotate("+(Math.random()*360)+"deg)";
      confettiBox.appendChild(s); setTimeout(()=>confettiBox.removeChild(s),2500);
    }
  }
  // Trigger a small celebration on load
  setTimeout(()=>confettiBlast(),300);

  // Smack talk show/hide
  let on = true;
  document.getElementById("toggleSmack").addEventListener("click", ()=>{
    on = !on;
    document.querySelectorAll(".smack-line").forEach(el=>el.setAttribute("data-on", String(on)));
    document.getElementById("toggleSmack").textContent = on ? "🗣️ Smack Talk: ON" : "🤐 Smack Talk: OFF";
  });
})();
</script>
</body></html>`;
}

/* ===== Build matchup cards ===== */
function buildMatchupCards(matchups, teamMeta, playersDict, highScore, smackCfg) {
  const byMatch = {};
  for (const m of matchups) (byMatch[m.matchup_id] ||= []).push(m);

  const ids = Object.keys(byMatch).sort((a,b)=>a-b);
  const cards = [];

  for (const id of ids) {
    const pair = byMatch[id], A = pair?.[0], B = pair?.[1];
    const rows = [A,B].filter(Boolean).map(t=>{
      const starters = uniq(t.starters);
      const all = uniq(t.players);
      const bench = all.filter(p => !new Set(starters).has(p)); // Bench = players − starters (per docs)  [1](https://docs.sleeper.com/)
      const pp = t.players_points || {};
      const sum = ids => ids.reduce((a,p)=>a+(pp[p]||0),0);
      const startersPts = sum(starters), benchPts = sum(bench);
      const breakdown = starters.map(pid=>({pid,pts:pp[pid]||0})).sort((x,y)=>y.pts-x.pts);
      const mvp = breakdown[0], dud = breakdown[breakdown.length-1];
      const benchMVP = bench.map(pid=>({pid,pts:pp[pid]||0})).sort((x,y)=>y.pts-x.pts)[0];
      const tm = teamMeta[t.roster_id] || { team_name:`Team ${t.roster_id}`, avatar:"" };
      return { team_name:tm.team_name, avatar:tm.avatar, points: t.points ?? startersPts, startersPts, benchPts, mvp, dud, benchMVP };
    });

    const [t1,t2] = rows;
    const highTeam = t2 ? (t1.points >= t2.points ? t1 : t2) : t1;
    const lowTeam  = t2 ? (t1.points >= t2.points ? t2 : t1) : null;
    const margin   = t2 ? Math.abs((t1.points||0)-(t2.points||0)) : 0;

    const good = [`✅ <b>${highTeam.team_name}</b> — ${fmt(highTeam.points)} pts (MVP: ${highTeam.mvp ? playerName(playersDict, highTeam.mvp.pid) : "—"}${highTeam.mvp?` · ${fmt(highTeam.mvp.pts)} pts`:""})`];
    const bad  = lowTeam ? [`⚠️ <b>${lowTeam.team_name}</b> — ${fmt(lowTeam.points)} pts (Lowest starter: ${lowTeam.dud ? playerName(playersDict, lowTeam.dud.pid) : "—"}${lowTeam.dud?` · ${fmt(lowTeam.dud.pts)} pts`:""})`] : [`⚠️ No opponent — limited signal.`];
    const ugly = [];
    if (margin >= 40) ugly.push(`😬 Blowout: ${fmt(margin)}‑pt margin.`);
    if (t1 && t2){
      if ((t1.benchPts||0) > 50 || (t2.benchPts||0) > 50){
        const name = (t1.benchPts > t2.benchPts) ? t1.team_name : t2.team_name;
        ugly.push(`😬 ${name} left a pile of points on the bench.`);
      }
    }
    if (!ugly.length) ugly.push(`😮‍💨 No major uglies — parity week.`);

    const consider = [];
    if (t1?.benchMVP && (!t1?.mvp || t1.benchMVP.pts > (t1.dud?.pts||0))) consider.push(`Promote <b>${playerName(playersDict, t1.benchMVP.pid)}</b> (${fmt(t1.benchMVP.pts)} pts).`);
    if (t2?.benchMVP && (!t2?.mvp || t2.benchMVP.pts > (t2.dud?.pts||0))) consider.push(`Promote <b>${playerName(playersDict, t2.benchMVP.pid)}</b> (${fmt(t2.benchMVP.pts)} pts).`);
    if (!consider.length) consider.push(`Lineup aligned; minimal changes needed.`);

    // Smack talk (wrapped in elements with class="smack-line" so it can be toggled)
    const smack = t2 ? makeSmack({winner:highTeam, loser:lowTeam, margin, t1, t2}, smackCfg) : {good:[],bad:[],ugly:[]};
    const smackGood = smack.good.map(s=>`<li class="smack-line" data-on="true">${s}</li>`).join("");
    const smackBad  = smack.bad .map(s=>`<li class="smack-line" data-on="true">${s}</li>`).join("");
    const smackUgly = smack.ugly.map(s=>`<li class="smack-line" data-on="true">${s}</li>`).join("");

    const card = `
      <div class="card appear">
        <div class="head">
          <div class="teams">
            ${t1?.avatar?`${t1.avatar}`:""} <span>${t1?.team_name||"—"}</span>
            <span class="muted">vs</span>
            ${t2?.avatar?`${t2.avatar}`:""} <span>${t2 ? t2.team_name : "—"}</span>
          </div>
          <div class="score">${t2 ? `${fmt(t1.points)} — ${fmt(t2.points)}` : `${fmt(t1.points)} pts`}</div>
        </div>
        <div class="kpi-mini">
          <div class="mini"><div class="label">${t1.team_name} starters</div><div class="value">💪 ${fmt(t1.startersPts)}</div></div>
          <div class="mini"><div class="label">${t1.team_name} bench</div><div class="value">🧰 ${fmt(t1.benchPts)}</div></div>
          ${t2 ? `
          <div class="mini"><div class="label">${t2.team_name} starters</div><div class="value">💪 ${fmt(t2.startersPts)}</div></div>
          <div class="mini"><div class="label">${t2.team_name} bench</div><div class="value">🧰 ${fmt(t2.benchPts)}</div></div>` : `
          <div class="mini"><div class="label">Margin</div><div class="value">—</div></div>
          <div class="mini"><div class="label">—</div><div class="value">—</div></div>`}
        </div>

        <div class="section good"><h4>✅ The Good</h4>
          <ul>${good.map(x=>`<li>${x}</li>`).join("")}${smackGood}</ul>
        </div>
        <div class="section bad"><h4>⚠️ The Bad</h4>
          <ul>${bad.map(x=>`<li>${x}</li>`).join("")}${smackBad}</ul>
        </div>
        <div class="section ugly"><h4>😬 The Ugly</h4>
          <ul>${ugly.map(x=>`<li>${x}</li>`).join("")}${smackUgly}</ul>
        </div>
        <div class="section"><h4>🔍 Things to Consider Next Week</h4>
          <ul>${consider.map(x=>`<li>${x}</li>`).join("")}</ul>
        </div>
      </div>`;
    cards.push(card);
  }
  return cards.join("\n");
}

/* ===== Main build ===== */
async function main() {
  const week = await detectWeek(); // auto-detected per Sleeper state  
  const smackCfg = await loadSmackConfig();

  // Fetch core data in parallel
  const [league, users, rosters, matchups, playersDict] = await Promise.all([
    fetchJson(API.league(LEAGUE_ID)),
    fetchJson(API.users(LEAGUE_ID)),
    fetchJson(API.rosters(LEAGUE_ID)),
    fetchJson(API.matchups(LEAGUE_ID, week)),
    fetchJson(API.players())
  ]);

  // Build team meta (names, avatars) from users/rosters (public docs)  [1](https://docs.sleeper.com/)
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const teamMeta = {};
  for (const r of rosters) {
    const u = userById[r.owner_id] || {};
    const team_name = (u.metadata && (u.metadata.team_name || u.metadata.nickname)) ||
                      u.display_name || u.username || `Team ${r.roster_id}`;
    teamMeta[r.roster_id] = { team_name, avatar: AVATAR(u.avatar) };
  }

  // League KPIs
  const pts = matchups.map(m => m.points || 0);
  const kpi = {
    high: Math.max(...pts),
    low:  Math.min(...pts),
    avg:  pts.reduce((a,b)=>a+b,0) / (pts.length || 1),
    matchups: new Set(matchups.map(m => m.matchup_id)).size
  };

  // Build cards HTML
  const cardsHTML = buildMatchupCards(matchups, teamMeta, playersDict, kpi.high, smackCfg);

  // Pull weekly notes (file or issue)
  const notesMD = await loadNotesForWeek(week);

  // Render pages
  const html = renderHTML({ league, week, kpi, cardsHTML, repoSlug: REPO_SLUG, notesMD });

  // Write outputs
  await fs.writeFile("index.html", html, "utf8");
  await ensureDir("archive");
  await fs.writeFile(path.join("archive", `week-${week}.html`), html, "utf8");

  // Write archive index (simple list of weeks found)
  const files = await fs.readdir("archive").catch(()=>[]);
  const weeks = files.map(f => (f.match(/^week-(\d+)\.html$/)||[])[1]).filter(Boolean).map(Number).sort((a,b)=>a-b);
  const archiveHtml = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Archive — Fantasy Weekly</title>
<style>body{font:16px system-ui;background:#f7f7f8;color:#111827;margin:0}
.wrap{max-width:900px;margin:0 auto;padding:16px}
a{color:#0369a1;text-decoration:none}
ul{line-height:1.9}</style></head>
<body><div class="wrap">
<h1>📚 Archive — ${league.name || "Sleeper League"}</h1>
<ul>
${weeks.map(w => `<li>./week-${w}.htmlWeek ${w}</a></li>`).join("")}
</ul>
<p>../index.html⬅️ Back to latest</a></p>
</div></body></html>`;
  await fs.writeFile(path.join("archive", "index.html"), archiveHtml, "utf8");

  // Save raw computed data (optional debug/export)
  await ensureDir("data");
  await fs.writeFile(path.join("data", `week-${week}.json`),
    JSON.stringify({ league, week, kpi, matchups, teamMeta }, null, 2), "utf8");

  console.log(`Built index.html + archive for week ${week}`);
}

main().catch(err => { console.error(err); process.exit(1); });
