const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8")
  .replace(/\ninit\(\);\s*$/, "\n")
  + "\nglobalThis.__REB_DATA = { SEASONS, PLAYER_DETAILS };";
const sandbox = { document: { querySelector: () => ({}) }, window: {}, HTMLElement: function HTMLElement() {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const { SEASONS, PLAYER_DETAILS } = sandbox.__REB_DATA;
const cards = SEASONS.flatMap((season) => season.teams.flatMap((team) => team.players.map((candidate) => {
  const id = `${season.number}-${team.code}-${candidate.name}`.toLowerCase();
  const details = PLAYER_DETAILS[id] || PLAYER_DETAILS[candidate.name.toLowerCase()] || {};
  return {
    id,
    season: season.number,
    teamCode: team.code,
    teamName: team.name,
    champion: Boolean(team.champion),
    name: candidate.name,
    offense: candidate.offense,
    offenseAlternates: candidate.offenseAlternates || [],
    defense: candidate.defense,
    traits: candidate.traits || {},
    image: details.image || null,
    info: details.info || null,
    adp: Number(((candidate.offense.rating + candidate.defense.rating) / 2).toFixed(1)),
  };
})));

fs.writeFileSync(
  path.join(root, "player-pool.js"),
  `"use strict";\n\n// Generated from app.js by scripts/export-player-pool.cjs.\nwindow.REB_PLAYER_POOL = ${JSON.stringify(cards, null, 2)};\n`,
);
console.log(`Exported ${cards.length} era player cards.`);
