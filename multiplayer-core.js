(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.REBMultiplayerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OFF_SLOTS = ["QB", "WR", "WR", "WR"];
  const DEF_SLOTS = ["RUSH", "CB", "CB", "CB"];
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const average = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const shuffle = (items, random = Math.random) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const permutations = (items) => {
    if (items.length < 2) return [items];
    return items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map((tail) => [item, ...tail]));
  };
  function positionRating(card, side, slot) {
    const skill = side === "offense" ? card.offense : card.defense;
    const position = skill.position === "DB" ? "CB" : skill.position;
    const natural = position === slot;
    let multiplier = 1;
    if (!natural && side === "offense") multiplier = position === "WR" && slot === "QB" ? 0.5 : 0.95;
    if (!natural && side === "defense") multiplier = 0.92;
    return { value: skill.rating * multiplier, natural, multiplier };
  }
  function optimizeSide(cards, side) {
    const slots = side === "offense" ? OFF_SLOTS : DEF_SLOTS;
    let best = null;
    permutations(cards).forEach((order) => {
      const values = order.map((card, i) => positionRating(card, side, slots[i]));
      const total = values.reduce((sum, item) => sum + item.value, 0);
      const naturalCount = values.filter((item) => item.natural).length;
      if (!best || total > best.total || (total === best.total && naturalCount > best.naturalCount)) {
        best = { total, naturalCount, slots: order.map((card, i) => ({ slot: slots[i], card, ...values[i] })) };
      }
    });
    return best;
  }
  function optimizeRoster(cards) {
    if (cards.length < 4) return null;
    let best = null;
    const quartets = cards.length === 4 ? [cards] : cards.map((_, omit) => cards.filter((__, i) => i !== omit));
    quartets.forEach((starters) => {
      const offense = optimizeSide(starters, "offense");
      const defense = optimizeSide(starters, "defense");
      const traits = starters.reduce((sum, card) => {
        const t = card.traits || {};
        return sum + (t.mvp ? 1.3 : 0) + (t.opoy ? 0.7 : 0) + (t.dpoy ? 0.7 : 0) + ((t.sbmvp || t.sbMvp) ? 0.45 : 0) + (card.champion ? 0.25 : 0);
      }, 0);
      const offBoost = starters.reduce((s, c) => s + ((c.traits || {}).mvp ? 0.8 : 0) + ((c.traits || {}).opoy ? 1.15 : 0), 0);
      const defBoost = starters.reduce((s, c) => s + ((c.traits || {}).mvp ? 0.8 : 0) + ((c.traits || {}).dpoy ? 1.15 : 0), 0);
      const off = offense.total / 4 + offBoost;
      const def = defense.total / 4 + defBoost;
      const team = (off + def) / 2 + traits * 0.18;
      if (!best || team > best.team) best = { offense, defense, off, def, team, starters, bench: cards.filter((c) => !starters.includes(c)) };
    });
    return best;
  }
  function snakeSeat(pick, seats = 4) {
    const round = Math.floor(pick / seats);
    const within = pick % seats;
    return round % 2 === 0 ? within : seats - 1 - within;
  }
  function scheduleFour(ids) {
    const [a, b, c, d] = ids;
    return [
      [[a, b], [c, d]], [[a, c], [b, d]], [[a, d], [b, c]],
      [[b, a], [d, c]], [[c, a], [d, b]], [[d, a], [c, b]],
    ];
  }
  function simulateGame(home, away, random = Math.random, playoff = false) {
    const h = optimizeRoster(home.cards), a = optimizeRoster(away.cards);
    const playoffBoost = (cards) => playoff ? cards.reduce((s, c) => s + (c.champion ? .7 : 0) + (((c.traits || {}).sbmvp || (c.traits || {}).sbMvp) ? 1.2 : 0), 0) : 0;
    const score = (own, opp, cards) => Math.max(8, Math.round(34 + (own.off - opp.def) * 1.8 + (random() - .5) * 26 + playoffBoost(cards)));
    let hs = score(h, a, home.cards), as = score(a, h, away.cards);
    if (hs === as) (random() < .5 ? () => { hs += 3; } : () => { as += 3; })();
    const stats = (team, metrics, opponent, points) => {
      const qbSlot = metrics.offense.slots[0];
      const receivers = metrics.offense.slots.slice(1);
      const quality = metrics.off - opponent.def;
      const yards = Math.round(clamp(550 + quality * 10 + (random() - .5) * 260, 230, 900));
      const touchdowns = Math.max(1, Math.round(points / 7 + (random() - .5) * 2));
      const interceptions = Math.max(0, Math.round(2.4 - quality * .08 + random() * 2 - 1));
      const completion = Math.round(clamp(50 + quality * .7 + (random() - .5) * 18, 32, 76));
      const sacksTaken = Math.max(0, Math.round(2.1 - quality * .06 + random() * 2 - 1));
      let remainingYards = yards, remainingTds = touchdowns;
      const receiverStats = receivers.map((slot, i) => {
        const weights = receivers.map((r) => Math.max(10, r.value));
        const weightTotal = weights.reduce((x, y) => x + y, 0);
        const recYards = i === receivers.length - 1 ? remainingYards : Math.round(yards * weights[i] / weightTotal);
        const recTds = i === receivers.length - 1 ? remainingTds : Math.min(remainingTds, Math.round(touchdowns * weights[i] / weightTotal));
        remainingYards -= recYards; remainingTds -= recTds;
        return { cardId: slot.card.id, name: slot.card.name, yards: recYards, touchdowns: recTds };
      });
      const defenders = metrics.defense.slots.map((slot) => ({
        cardId: slot.card.id, name: slot.card.name,
        sacks: +(Math.max(0, (slot.slot === "RUSH" ? 1.2 : .15) + (slot.value - 80) / 32 + random() * .8).toFixed(1)),
        interceptions: Math.max(0, Math.round((slot.slot === "CB" ? .35 : .08) + (slot.value - 80) / 45 + random() * .55 - .25)),
      }));
      return { teamId: team.id, qb: { cardId: qbSlot.card.id, name: qbSlot.card.name, yards, touchdowns, interceptions, completion, sacksTaken }, receivers: receiverStats, defenders };
    };
    return { homeId: home.id, awayId: away.id, homeScore: hs, awayScore: as, homeStats: stats(home, h, a, hs), awayStats: stats(away, a, h, as) };
  }
  function simulateLeague(teams, random = Math.random) {
    const table = Object.fromEntries(teams.map((t) => [t.id, { id: t.id, name: t.teamName, owner: t.displayName, wins: 0, losses: 0, pf: 0, pa: 0, pd: 0 }]));
    const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
    const games = [];
    scheduleFour(teams.map((t) => t.id)).forEach((week, wi) => week.forEach(([h, a]) => {
      const game = { week: wi + 1, ...simulateGame(byId[h], byId[a], random) };
      games.push(game);
      [[h, game.homeScore, game.awayScore], [a, game.awayScore, game.homeScore]].forEach(([id, pf, pa]) => { table[id].pf += pf; table[id].pa += pa; table[id].pd = table[id].pf - table[id].pa; });
      table[game.homeScore > game.awayScore ? h : a].wins += 1;
      table[game.homeScore > game.awayScore ? a : h].losses += 1;
    }));
    const standings = Object.values(table).sort((x, y) => y.wins - x.wins || y.pd - x.pd || y.pf - x.pf);
    const semifinal = simulateGame(byId[standings[1].id], byId[standings[2].id], random, true);
    const semiWinner = semifinal.homeScore > semifinal.awayScore ? semifinal.homeId : semifinal.awayId;
    const bowl = simulateGame(byId[standings[0].id], byId[semiWinner], random, true);
    const championId = bowl.homeScore > bowl.awayScore ? bowl.homeId : bowl.awayId;
    return { games, standings, semifinal, bowl, championId };
  }
  return { OFF_SLOTS, DEF_SLOTS, shuffle, positionRating, optimizeRoster, snakeSeat, scheduleFour, simulateGame, simulateLeague };
});
