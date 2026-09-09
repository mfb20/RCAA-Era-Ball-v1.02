"use strict";

const cfg = window.REB_SUPABASE_CONFIG;
const db = window.supabase?.createClient(cfg.url, cfg.publishableKey);
const CORE = window.REBMultiplayerCore;
const POOL = window.REB_PLAYER_POOL;
const $ = (id) => document.getElementById(id);
const screens = ["setupScreen", "hubScreen", "roomScreen", "duelScreen", "fantasyScreen", "resultsScreen"];
const state = { user: null, profile: null, lobby: null, players: [], picks: [], channel: null, createMode: "duel", duel: null, finishing: false };

function showScreen(id) { screens.forEach((name) => { $(name).hidden = name !== id; }); window.scrollTo({ top: 0, behavior: "smooth" }); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function toast(message) { const el = $("toast"); el.textContent = message; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 2800); }
function setError(id, message) { const el = $(id); el.textContent = message; el.hidden = !message; }
function me() { return state.players.find((p) => p.user_id === state.user?.id); }
function isHost() { return state.lobby?.host_id === state.user?.id; }
function displayTeam(id) { const p = state.players.find((x) => x.user_id === id); return p?.team_name || "Unknown Team"; }
function traits(card) { const t = card.traits || {}; return [card.champion && "★", t.mvp && "MVP", t.opoy && "OPOY", t.dpoy && "DPOY", (t.sbmvp || t.sbMvp) && "SBMVP"].filter(Boolean).join(" · "); }
function avatar(card, className = "player-avatar") { return card.image ? `<img class="${className}" src="${escapeHtml(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.outerHTML='<span class=&quot;${className} avatar-fallback&quot;>REB</span>'">` : `<span class="${className} avatar-fallback">REB</span>`; }
function playerCard(card, disabled = false, action = "") { return `<button class="mp-player-card" data-card="${card.id}" ${disabled ? "disabled" : ""}>${avatar(card)}<span><h3>${escapeHtml(card.name)}</h3><p>S${card.season} · ${escapeHtml(card.teamCode)} ${traits(card)}</p><span class="ratings"><span class="rating-pill">${card.offense.rating} ${card.offense.position}</span><span class="rating-pill">${card.defense.rating} ${card.defense.position}</span></span></span><span class="adp-pill">${action || card.adp}</span></button>`; }

async function ensureGuest() {
  if (!db) throw new Error("Supabase could not load. Check your connection and refresh.");
  const { data } = await db.auth.getSession();
  if (data.session) state.user = data.session.user;
  else {
    const result = await db.auth.signInAnonymously();
    if (result.error) throw result.error;
    state.user = result.data.user;
  }
  $("connectionBadge").textContent = "LIVE"; $("connectionBadge").classList.add("online");
}
async function loadLobbies() {
  $("lobbyList").innerHTML = '<div class="empty-list">Loading open rooms…</div>';
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from("lobbies").select("id,code,name,mode,max_players,created_at,lobby_players(count)").eq("status", "waiting").gte("created_at", since).order("created_at", { ascending: false }).limit(30);
  if (error) {
    const setup = error.message.includes("lobbies") ? "Multiplayer database setup is not finished. Run supabase/setup.sql in the Supabase SQL Editor." : error.message;
    $("lobbyList").innerHTML = `<div class="error-box">${escapeHtml(setup)}</div>`; return;
  }
  if (!data.length) { $("lobbyList").innerHTML = '<div class="empty-list">No open rooms yet. Create the first one.</div>'; return; }
  $("lobbyList").innerHTML = data.map((l) => { const count = l.lobby_players?.[0]?.count || 0; return `<div class="lobby-row"><div><strong>${escapeHtml(l.name)}</strong><small>${l.mode === "duel" ? "2-player Era Duel" : "4-player Fantasy Snake"}</small></div><span class="lobby-code">${escapeHtml(l.code)} · ${count}/${l.max_players}</span><button class="reset-button join-lobby" data-id="${l.id}">JOIN</button></div>`; }).join("");
  document.querySelectorAll(".join-lobby").forEach((b) => b.addEventListener("click", () => joinLobby(b.dataset.id)));
}
async function createLobby(event) {
  event.preventDefault(); setError("createError", "");
  const name = $("lobbyNameInput").value.trim(); if (!name) return;
  const { data, error } = await db.rpc("create_reb_lobby", { p_name: name, p_mode: state.createMode, p_display_name: state.profile.displayName, p_team_name: state.profile.teamName });
  if (error) return setError("createError", error.message);
  $("createDialog").close(); await enterLobby(data);
}
async function joinLobby(id) {
  const { data, error } = await db.rpc("join_reb_lobby", { p_lobby_id: id, p_display_name: state.profile.displayName, p_team_name: state.profile.teamName });
  if (error) return toast(error.message); await enterLobby(data);
}
async function enterLobby(id) {
  localStorage.setItem("reb-current-lobby", id); await subscribe(id); await refreshLobby();
}
async function subscribe(id) {
  if (state.channel) await db.removeChannel(state.channel);
  state.channel = db.channel(`reb-${id}`).on("postgres_changes", { event: "*", schema: "public", table: "lobbies", filter: `id=eq.${id}` }, refreshLobby).on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${id}` }, refreshLobby).on("postgres_changes", { event: "*", schema: "public", table: "fantasy_picks", filter: `lobby_id=eq.${id}` }, refreshLobby).subscribe();
}
async function refreshLobby() {
  const id = localStorage.getItem("reb-current-lobby"); if (!id) return;
  const [lobbyQ, playersQ, picksQ] = await Promise.all([db.from("lobbies").select("*").eq("id", id).maybeSingle(), db.from("lobby_players").select("*").eq("lobby_id", id).order("seat"), db.from("fantasy_picks").select("*").eq("lobby_id", id).order("pick_number")]);
  if (!lobbyQ.data || lobbyQ.error) { await clearLobby(); return; }
  state.lobby = lobbyQ.data; state.players = playersQ.data || []; state.picks = picksQ.data || [];
  if (state.lobby.status === "waiting") renderRoom();
  else if (state.lobby.status === "complete") renderResults();
  else if (state.lobby.mode === "duel") renderDuel();
  else renderFantasy();
}
async function clearLobby() { localStorage.removeItem("reb-current-lobby"); if (state.channel) await db.removeChannel(state.channel); state.channel = null; state.lobby = null; state.players = []; state.picks = []; state.duel = null; showScreen("hubScreen"); loadLobbies(); }
async function leaveLobby() { if (state.lobby) await db.rpc("leave_reb_lobby", { p_lobby_id: state.lobby.id }); await clearLobby(); }
function renderRoom() {
  showScreen("roomScreen"); $("roomMode").textContent = state.lobby.mode === "duel" ? "2-PLAYER ERA DUEL" : "4-PLAYER FANTASY SNAKE"; $("roomName").textContent = state.lobby.name; $("roomCode").textContent = state.lobby.code;
  $("roomNotice").textContent = `${state.players.length}/${state.lobby.max_players} owners joined. Share this page and lobby code ${state.lobby.code} with your friends.`;
  $("seatGrid").innerHTML = Array.from({ length: state.lobby.max_players }, (_, i) => { const p = state.players[i]; return `<article class="seat ${p ? "filled" : ""}"><span class="seat-number">SEAT ${i + 1}</span>${p ? `<h3>${escapeHtml(p.display_name)} ${p.user_id === state.lobby.host_id ? "★" : ""}</h3><p>${escapeHtml(p.team_name)}</p>` : "<h3>OPEN</h3><p>Waiting for an owner…</p>"}</article>`; }).join("");
  const start = $("startLobbyButton"); start.hidden = !isHost(); start.disabled = state.players.length !== state.lobby.max_players; start.textContent = state.players.length === state.lobby.max_players ? "START GAME" : `WAITING FOR ${state.lobby.max_players - state.players.length}`;
}
async function startLobby() {
  if (!isHost() || state.players.length !== state.lobby.max_players) return;
  const patch = state.lobby.mode === "fantasy" ? { status: "drafting", draft_order: CORE.shuffle(state.players.map((p) => p.user_id)), current_pick: 0 } : { status: "drafting" };
  const { error } = await db.from("lobbies").update(patch).eq("id", state.lobby.id); if (error) toast(error.message);
}

function duelStorageKey() { return `reb-duel-${state.lobby.id}`; }
function freshDuel() { const saved = JSON.parse(localStorage.getItem(duelStorageKey()) || "null"); return saved || { roster: me()?.roster || [], roll: null, rollHistory: [], reroll: 1 }; }
function saveDuel() { localStorage.setItem(duelStorageKey(), JSON.stringify(state.duel)); }
function availableRoll() {
  const groups = new Map(); POOL.forEach((c) => { const key = `${c.season}-${c.teamCode}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c); });
  return CORE.shuffle([...groups.values()])[0];
}
function renderDuel() {
  showScreen("duelScreen"); $("duelLobbyName").textContent = state.lobby.name; if (!state.duel) state.duel = freshDuel();
  const mine = me(); if ((mine?.roster || []).length > state.duel.roster.length) state.duel.roster = mine.roster;
  const progress = state.players.map((p) => `${p.display_name} ${p.progress}/4${p.ready ? " ✓" : ""}`).join(" · "); $("duelProgress").textContent = progress;
  $("duelTeamTitle").textContent = mine?.team_name || "YOUR TEAM"; renderDuelRoster();
  if (state.duel.roll) showDuelRoll(state.duel.roll); else { $("duelSeason").textContent = "—"; $("duelTeam").textContent = "REB"; $("duelTeamName").textContent = state.duel.roster.length >= 4 ? "DRAFT COMPLETE" : "READY TO SPIN"; $("duelMarket").innerHTML = ""; }
  $("duelSpinButton").disabled = !!state.duel.roll || state.duel.roster.length >= 4; $("duelRerollButton").disabled = !state.duel.roll || state.duel.reroll < 1;
  if (state.players.length === 2 && state.players.every((p) => p.ready) && isHost() && !state.lobby.season_results) finishDuel();
}
function spinDuel(isReroll = false) { if (isReroll) state.duel.reroll -= 1; state.duel.roll = availableRoll(); state.duel.rollHistory.push(state.duel.roll.map((c) => c.id)); saveDuel(); showDuelRoll(state.duel.roll); $("duelSpinButton").disabled = true; $("duelRerollButton").disabled = state.duel.reroll < 1; }
function showDuelRoll(cards) { const c = cards[0]; $("duelSeason").textContent = c.season; $("duelTeam").textContent = c.teamCode; $("duelTeamName").textContent = c.teamName; $("duelMarket").innerHTML = cards.map((card) => playerCard(card, false, "PICK")).join(""); document.querySelectorAll("#duelMarket [data-card]").forEach((b) => b.addEventListener("click", () => draftDuel(b.dataset.card))); }
async function draftDuel(id) {
  const card = state.duel.roll.find((c) => c.id === id); if (!card) return; state.duel.roster.push(card); state.duel.roll = null; saveDuel();
  const complete = state.duel.roster.length >= 4; const metrics = complete ? CORE.optimizeRoster(state.duel.roster) : null;
  const { error } = await db.from("lobby_players").update({ roster: state.duel.roster, progress: state.duel.roster.length, ready: complete, lineup: complete ? serializeLineup(metrics) : {}, team_ovr: metrics?.team || null }).eq("lobby_id", state.lobby.id).eq("user_id", state.user.id);
  if (error) toast(error.message); else renderDuel();
}
function serializeLineup(m) { return { offense: m.offense.slots.map((s) => ({ slot: s.slot, cardId: s.card.id, value: +s.value.toFixed(1) })), defense: m.defense.slots.map((s) => ({ slot: s.slot, cardId: s.card.id, value: +s.value.toFixed(1) })) }; }
function renderDuelRoster() { const roster = state.duel.roster; $("duelRoster").innerHTML = roster.length ? roster.map((c, i) => `<div class="roster-mini"><strong>${i + 1}</strong><span>${escapeHtml(c.name)}<small>S${c.season} ${c.teamCode}</small></span><b>${c.adp}</b></div>`).join("") : '<div class="empty-list">No picks yet.</div>'; const m = roster.length >= 4 ? CORE.optimizeRoster(roster) : null; $("duelOvr").textContent = m ? m.team.toFixed(1) : "—"; }
async function finishDuel() {
  if (state.finishing) return; state.finishing = true;
  const sorted = [...state.players].sort((a, b) => Number(b.team_ovr) - Number(a.team_ovr)); let winner = sorted[0]; if (Number(sorted[0].team_ovr) === Number(sorted[1].team_ovr) && Math.random() < .5) winner = sorted[1];
  const { error } = await db.from("lobbies").update({ status: "complete", season_results: { type: "duel", winnerId: winner.user_id, entries: state.players.map((p) => ({ id: p.user_id, owner: p.display_name, team: p.team_name, ovr: Number(p.team_ovr), roster: p.roster })) } }).eq("id", state.lobby.id); if (error) { state.finishing = false; toast(error.message); }
}

function pickedIds() { return new Set(state.picks.map((p) => p.card_key)); }
function currentDrafter() { const order = state.lobby.draft_order || []; return order[CORE.snakeSeat(state.lobby.current_pick, 4)]; }
function renderFantasy() {
  showScreen("fantasyScreen"); $("fantasyLobbyName").textContent = state.lobby.name;
  if (state.lobby.status === "drafting") renderFantasyDraft(); else renderLineup();
}
function renderDraftBoard() {
  const order = state.lobby.draft_order || []; $("draftBoard").innerHTML = Array.from({ length: 16 }, (_, pick) => { const ownerId = order[CORE.snakeSeat(pick, 4)]; const owner = state.players.find((p) => p.user_id === ownerId); const made = state.picks.find((p) => p.pick_number === pick + 1); return `<div class="draft-pick ${pick === state.lobby.current_pick ? "current" : ""}"><span>${pick + 1}. ${escapeHtml(owner?.team_name || "—")}</span><strong>${made ? escapeHtml(made.player_snapshot.name) : "ON CLOCK"}</strong></div>`; }).join("");
}
function renderFantasyDraft() {
  $("fantasyDraftArea").hidden = false; $("lineupArea").hidden = true; renderDraftBoard(); const turn = currentDrafter(); const p = state.players.find((x) => x.user_id === turn); $("draftTurnText").textContent = turn === state.user.id ? "YOU ARE ON THE CLOCK" : `${p?.display_name || "OWNER"} IS ON THE CLOCK`;
  renderPool(); const mine = state.picks.filter((x) => x.user_id === state.user.id).map((x) => x.player_snapshot); $("myFantasyRoster").innerHTML = mine.map((c, i) => `<div class="roster-mini"><strong>${i + 1}</strong><span>${escapeHtml(c.name)}<small>S${c.season} · ${c.teamCode}</small></span><b>${c.adp}</b></div>`).join("") || '<div class="empty-list">Your picks will appear here.</div>';
}
function renderPool() {
  const query = $("playerSearch").value.toLowerCase().trim(), season = $("seasonFilter").value, pos = $("positionFilter").value, used = pickedIds(), myTurn = currentDrafter() === state.user.id;
  const cards = POOL.filter((c) => !used.has(c.id) && (season === "all" || String(c.season) === season) && (pos === "all" || c.offense.position === pos || c.defense.position === pos || (pos === "CB" && c.defense.position === "DB")) && (!query || `${c.name} ${c.teamName} ${c.teamCode}`.toLowerCase().includes(query))).sort((a, b) => b.adp - a.adp || b.offense.rating - a.offense.rating);
  $("fantasyPool").innerHTML = cards.map((c) => playerCard(c, !myTurn)).join(""); document.querySelectorAll("#fantasyPool [data-card]").forEach((b) => b.addEventListener("click", () => fantasyPick(b.dataset.card)));
}
async function fantasyPick(cardKey) { if (currentDrafter() !== state.user.id) return toast("Wait for your turn."); const card = POOL.find((c) => c.id === cardKey); if (!card) return toast("Player card not found."); const { error } = await db.rpc("make_fantasy_pick", { p_lobby_id: state.lobby.id, p_card_key: cardKey, p_player_snapshot: card }); if (error) toast(error.message); }
function myFantasyCards() { return state.picks.filter((p) => p.user_id === state.user.id).map((p) => p.player_snapshot); }
function renderLineup() {
  $("fantasyDraftArea").hidden = true; $("lineupArea").hidden = false; renderDraftBoard(); $("draftTurnText").textContent = "SET LINEUPS & LOCK IN"; const cards = myFantasyCards(), metrics = CORE.optimizeRoster(cards); if (!metrics) return;
  $("fantasyOvr").textContent = metrics.team.toFixed(1); $("fantasyLineup").innerHTML = ["offense", "defense"].map((side) => `<div class="lineup-side"><h3>${side.toUpperCase()}</h3>${metrics[side].slots.map((s) => `<div class="lineup-row"><b>${s.slot}</b><span>${escapeHtml(s.card.name)} · ${s.value.toFixed(1)}</span></div>`).join("")}</div>`).join("");
  const mine = me(); $("readyButton").disabled = mine.ready; $("readyButton").textContent = mine.ready ? "LINEUP LOCKED ✓" : "LOCK IN LINEUP";
  const allReady = state.players.length === 4 && state.players.every((p) => p.ready); $("simulateButton").hidden = !isHost(); $("simulateButton").disabled = !allReady; $("simulateButton").textContent = allReady ? "CONFIRM & SIMULATE SEASON" : `WAITING FOR ${state.players.filter((p) => !p.ready).length}`;
}
async function lockLineup() { const cards = myFantasyCards(), m = CORE.optimizeRoster(cards); if (!m) return; const { error } = await db.from("lobby_players").update({ roster: cards, lineup: serializeLineup(m), team_ovr: m.team, ready: true, progress: 4 }).eq("lobby_id", state.lobby.id).eq("user_id", state.user.id); if (error) toast(error.message); }
async function simulateFantasy() {
  if (!isHost() || !state.players.every((p) => p.ready)) return; await db.from("lobbies").update({ status: "simulating" }).eq("id", state.lobby.id);
  const teams = state.players.map((p) => ({ id: p.user_id, displayName: p.display_name, teamName: p.team_name, cards: p.roster })); const result = CORE.simulateLeague(teams); result.type = "fantasy"; result.teams = teams.map((t) => ({ id: t.id, displayName: t.displayName, teamName: t.teamName, ovr: CORE.optimizeRoster(t.cards).team, roster: t.cards })); result.awards = calculateAwards(result); result.teamTotals = calculateTeamTotals(result, teams);
  const { error } = await db.from("lobbies").update({ status: "complete", season_results: result }).eq("id", state.lobby.id); if (error) toast(error.message);
}
function calculateTeamTotals(result, teams) {
  const totals = Object.fromEntries(teams.map((t) => [t.id, { id: t.id, teamName: t.teamName, games: 0, passYards: 0, touchdowns: 0, interceptions: 0, completionTotal: 0, sacksTaken: 0, defenseSacks: 0, defenseInterceptions: 0 }]));
  result.games.forEach((g) => [g.homeStats, g.awayStats].forEach((s) => { const t = totals[s.teamId]; t.games += 1; t.passYards += s.qb.yards; t.touchdowns += s.qb.touchdowns; t.interceptions += s.qb.interceptions; t.completionTotal += s.qb.completion; t.sacksTaken += s.qb.sacksTaken; t.defenseSacks += s.defenders.reduce((n, d) => n + d.sacks, 0); t.defenseInterceptions += s.defenders.reduce((n, d) => n + d.interceptions, 0); }));
  return Object.values(totals).map((t) => ({ ...t, completion: Math.round(t.completionTotal / Math.max(1, t.games)), defenseSacks: +t.defenseSacks.toFixed(1) }));
}
function calculateAwards(result) {
  const totals = {};
  result.games.forEach((g) => [g.homeStats, g.awayStats].forEach((s) => { const q = totals[s.qb.cardId] ||= { name: s.qb.name, passYards: 0, tds: 0, ints: 0, recYards: 0, sacks: 0, picks: 0 }; q.passYards += s.qb.yards; q.tds += s.qb.touchdowns; q.ints += s.qb.interceptions; s.receivers.forEach((r) => { const x = totals[r.cardId] ||= { name: r.name, passYards: 0, tds: 0, ints: 0, recYards: 0, sacks: 0, picks: 0 }; x.recYards += r.yards; x.tds += r.touchdowns; }); s.defenders.forEach((d) => { const x = totals[d.cardId] ||= { name: d.name, passYards: 0, tds: 0, ints: 0, recYards: 0, sacks: 0, picks: 0 }; x.sacks += d.sacks; x.picks += d.interceptions; }); }));
  const all = Object.values(totals), offense = [...all].sort((a, b) => (b.passYards + b.recYards + b.tds * 65 - b.ints * 90) - (a.passYards + a.recYards + a.tds * 65 - a.ints * 90)), defense = [...all].sort((a, b) => (b.sacks * 2 + b.picks * 3) - (a.sacks * 2 + a.picks * 3)); return { mvp: offense[0]?.name, opoy: offense[1]?.name || offense[0]?.name, dpoy: defense[0]?.name };
}

function renderResults() {
  showScreen("resultsScreen"); const r = state.lobby.season_results || {}; if (r.type === "duel") {
    const winner = r.entries.find((e) => e.id === r.winnerId); $("resultsContent").innerHTML = `<section class="mp-card results-hero"><p class="eyebrow">ERA DUEL CHAMPION</p><h1>${escapeHtml(winner?.team || "WINNER")}</h1><p>${escapeHtml(winner?.owner)} wins with a ${Number(winner?.ovr).toFixed(1)} OVR.</p></section><div class="results-grid">${[...r.entries].sort((a,b)=>b.ovr-a.ovr).map((e) => `<article class="mp-card"><h2>${escapeHtml(e.team)}</h2><p>${escapeHtml(e.owner)}</p><div class="big-ovr"><span>TEAM OVR</span><strong>${Number(e.ovr).toFixed(1)}</strong></div>${e.roster.map((c)=>`<div class="roster-mini"><span>${escapeHtml(c.name)}<small>S${c.season} ${c.teamCode}</small></span><b>${c.adp}</b></div>`).join("")}</article>`).join("")}</div>`; return;
  }
  const champion = r.teams?.find((t) => t.id === r.championId); const gameName = (id) => r.teams?.find((t) => t.id === id)?.teamName || "Team"; const line = (g) => `<div class="game-line"><span>${escapeHtml(gameName(g.homeId))} <b>${g.homeScore}</b></span><span><b>${g.awayScore}</b> ${escapeHtml(gameName(g.awayId))}</span></div>`;
  $("resultsContent").innerHTML = `<section class="mp-card results-hero"><p class="eyebrow">FANTASY BOWL CHAMPION</p><h1>${escapeHtml(champion?.teamName || "CHAMPION")}</h1><p>${escapeHtml(champion?.displayName)} won the fantasy draft.</p><p>🏆 MVP ${escapeHtml(r.awards?.mvp)} · OPOY ${escapeHtml(r.awards?.opoy)} · DPOY ${escapeHtml(r.awards?.dpoy)}</p></section><div class="results-grid"><article class="mp-card"><p class="eyebrow">FINAL TABLE</p><h2>STANDINGS</h2><table class="standings"><thead><tr><th>#</th><th>TEAM</th><th>W-L</th><th>PD</th></tr></thead><tbody>${r.standings.map((s,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(s.name)}</td><td>${s.wins}-${s.losses}</td><td>${s.pd>0?"+":""}${s.pd}</td></tr>`).join("")}</tbody></table></article><article class="mp-card playoff-card"><p class="eyebrow">POSTSEASON</p><h2>PLAYOFFS</h2><h3>#2 vs #3 SEMIFINAL</h3>${line(r.semifinal)}<h3>RCAA FANTASY BOWL</h3>${line(r.bowl)}</article><article class="mp-card"><p class="eyebrow">REGULAR SEASON</p><h2>6-WEEK SCHEDULE</h2>${Array.from({length:6},(_,i)=>`<div class="week"><b>WEEK ${i+1}</b>${r.games.filter(g=>g.week===i+1).map(line).join("")}</div>`).join("")}</article><article class="mp-card"><p class="eyebrow">SEASON TOTALS</p><h2>TEAM STATS</h2><table class="standings"><thead><tr><th>TEAM</th><th>PASS</th><th>TD/INT</th><th>COMP</th><th>DEF</th></tr></thead><tbody>${(r.teamTotals||[]).map(t=>`<tr><td>${escapeHtml(t.teamName)}</td><td>${t.passYards}</td><td>${t.touchdowns}/${t.interceptions}</td><td>${t.completion}%</td><td>${t.defenseSacks} SCK · ${t.defenseInterceptions} INT</td></tr>`).join("")}</tbody></table></article></div>`;
}

async function boot() {
  try { await ensureGuest(); } catch (error) { $("connectionBadge").textContent = "OFFLINE"; setError("setupError", `${error.message} Enable Anonymous Sign-Ins in Supabase Authentication settings.`); return; }
  const saved = JSON.parse(localStorage.getItem("reb-guest") || "null"); if (saved) { state.profile = saved; $("displayNameInput").value = saved.displayName; $("teamNameInput").value = saved.teamName; }
  const current = localStorage.getItem("reb-current-lobby"); if (current) { await enterLobby(current); return; } showScreen(saved ? "hubScreen" : "setupScreen"); if (saved) loadLobbies();
}

$("guestForm").addEventListener("submit", (e) => { e.preventDefault(); state.profile = { displayName: $("displayNameInput").value.trim(), teamName: $("teamNameInput").value.trim() }; localStorage.setItem("reb-guest", JSON.stringify(state.profile)); showScreen("hubScreen"); loadLobbies(); });
$("editGuestButton").addEventListener("click", () => showScreen("setupScreen"));
document.querySelectorAll(".create-mode").forEach((b) => b.addEventListener("click", () => { state.createMode = b.dataset.mode; $("createModeLabel").textContent = state.createMode === "duel" ? "2-PLAYER ERA DUEL" : "4-PLAYER FANTASY SNAKE"; $("createDialog").showModal(); }));
$("closeCreateButton").addEventListener("click", (e) => { e.preventDefault(); $("createDialog").close(); }); $("createLobbyForm").addEventListener("submit", createLobby); $("refreshLobbiesButton").addEventListener("click", loadLobbies); $("leaveLobbyButton").addEventListener("click", leaveLobby); $("fantasyLeaveButton").addEventListener("click", leaveLobby); $("startLobbyButton").addEventListener("click", startLobby); $("duelSpinButton").addEventListener("click", () => spinDuel(false)); $("duelRerollButton").addEventListener("click", () => spinDuel(true)); $("readyButton").addEventListener("click", lockLineup); $("simulateButton").addEventListener("click", simulateFantasy); $("resultsHomeButton").addEventListener("click", clearLobby); ["playerSearch", "seasonFilter", "positionFilter"].forEach((id) => $(id).addEventListener(id === "playerSearch" ? "input" : "change", renderPool));
const seasons = [...new Set(POOL.map((c) => c.season))].sort((a,b)=>a-b); $("seasonFilter").insertAdjacentHTML("beforeend", seasons.map((s)=>`<option value="${s}">Season ${s}</option>`).join(""));
boot();
