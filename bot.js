require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Events, PermissionsBitField } = require("discord.js");

const DATA_FILE = path.join(__dirname, "data.json");

const DEFAULT_POINTS = 1000;
const SIGNED_PLAYERS_REQUIRED = 8;
const MIN_PLAYERS_TO_START_DRAFT = 8;
const REPORTS_REQUIRED = 6;
const ELO_K = 32;

const RESULTS_CHANNEL_ID = "1485664112770945174";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

function createDefaultData() {
  return {
    users: {},
    state: {
      captains: [],
      signedPlayers: [],
      teams: { A: [], B: [] },
      challengeActive: false,
      accepted: false,
      draftStarted: false,
      draftComplete: false,
      matchFinished: false,
      draftOrder: ["A", "B", "B", "A", "A", "B", "B", "A"],
      draftStep: 0,
      reports: {
        A: [],
        B: []
      },
      matchNumber: 1,
      resultsHistory: []
    }
  };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = createDefaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed.users) parsed.users = {};
    if (!parsed.state) parsed.state = createDefaultData().state;
    if (!parsed.state.resultsHistory) parsed.state.resultsHistory = [];
    if (!parsed.state.matchNumber) parsed.state.matchNumber = 1;
    if (!parsed.state.reports) parsed.state.reports = { A: [], B: [] };
    if (!parsed.state.teams) parsed.state.teams = { A: [], B: [] };
    if (!parsed.state.draftOrder) parsed.state.draftOrder = ["A", "B", "B", "A", "A", "B", "B", "A"];

    return parsed;
  } catch (err) {
    console.error("Error leyendo data.json, creando uno nuevo.", err);
    const initial = createDefaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

let data = loadData();

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function ensureUser(user) {
  if (!data.users[user.id]) {
    data.users[user.id] = {
      id: user.id,
      username: user.username,
      points: DEFAULT_POINTS,
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
      isAdmin: false
    };
  } else {
    data.users[user.id].username = user.username;
  }
}

function ensureUserById(userId, username = null) {
  if (!data.users[userId]) {
    data.users[userId] = {
      id: userId,
      username: username || `user_${userId}`,
      points: DEFAULT_POINTS,
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
      isAdmin: false
    };
  } else if (username) {
    data.users[userId].username = username;
  }
}

function ensureUsersFromState() {
  const allIds = [
    ...data.state.captains,
    ...data.state.signedPlayers,
    ...data.state.teams.A,
    ...data.state.teams.B
  ];

  for (const id of allIds) {
    ensureUserById(id);
  }
}

function resetMatchStateOnly() {
  const matchNumber = data.state.matchNumber || 1;
  const resultsHistory = data.state.resultsHistory || [];

  data.state = {
    captains: [],
    signedPlayers: [],
    teams: { A: [], B: [] },
    challengeActive: false,
    accepted: false,
    draftStarted: false,
    draftComplete: false,
    matchFinished: false,
    draftOrder: ["A", "B", "B", "A", "A", "B", "B", "A"],
    draftStep: 0,
    reports: {
      A: [],
      B: []
    },
    matchNumber,
    resultsHistory
  };

  saveData();
}

function isCaptain(userId) {
  return data.state.captains.includes(userId);
}

function isSigned(userId) {
  return data.state.signedPlayers.includes(userId);
}

function getUserDisplayName(userId) {
  return data.users[userId]?.username || `user_${userId}`;
}

function formatUser(id) {
  if (String(id).startsWith("fake_")) {
    return `**${getUserDisplayName(id)}**`;
  }
  return `<@${id}>`;
}

function teamContains(team, userId) {
  return data.state.teams[team].includes(userId);
}

function isPlayerInCurrentMatch(userId) {
  return (
    data.state.captains.includes(userId) ||
    data.state.signedPlayers.includes(userId) ||
    data.state.teams.A.includes(userId) ||
    data.state.teams.B.includes(userId)
  );
}

function getCurrentTurnCaptainId() {
  const side = data.state.draftOrder[data.state.draftStep];
  return side === "A" ? data.state.captains[0] : data.state.captains[1];
}

function buildLeaderboard(limit = 10) {
  const players = Object.values(data.users)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);

  if (players.length === 0) return "No hay jugadores todavía.";

  return players
    .map((u, index) => {
      return `${index + 1}. ${u.username} — ${u.points} pts | W:${u.wins} L:${u.losses} | MP:${u.matchesPlayed}`;
    })
    .join("\n");
}

function buildTeamString(team) {
  return data.state.teams[team].map(formatUser).join(", ") || "vacío";
}

function buildAvailableString() {
  return data.state.signedPlayers.map(formatUser).join(", ") || "ninguno";
}

function isDiscordAdmin(msg) {
  return msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator) || false;
}

function isBotAdmin(userId) {
  return Boolean(data.users[userId]?.isAdmin);
}

function hasAdminAccess(msg) {
  return isDiscordAdmin(msg) || isBotAdmin(msg.author.id);
}

function averageTeamRating(teamIds) {
  if (!teamIds.length) return DEFAULT_POINTS;
  const total = teamIds.reduce((sum, userId) => {
    const points = data.users[userId]?.points ?? DEFAULT_POINTS;
    return sum + points;
  }, 0);
  return total / teamIds.length;
}

function expectedScore(teamRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - teamRating) / 400));
}

function calculateEloChanges(winnerTeamIds, loserTeamIds) {
  const winnerAvg = averageTeamRating(winnerTeamIds);
  const loserAvg = averageTeamRating(loserTeamIds);

  const expectedWinner = expectedScore(winnerAvg, loserAvg);
  const expectedLoser = expectedScore(loserAvg, winnerAvg);

  const winnerDelta = Math.round(ELO_K * (1 - expectedWinner));
  const loserDelta = Math.round(ELO_K * (0 - expectedLoser));

  return {
    winnerAvg: Math.round(winnerAvg),
    loserAvg: Math.round(loserAvg),
    expectedWinner,
    expectedLoser,
    winnerDelta,
    loserDelta
  };
}

function fakeUserId(n) {
  return `fake_${n}`;
}

function fakeUsername(n) {
  return `FakePlayer${n}`;
}

function ensureFakeUser(n) {
  const id = fakeUserId(n);
  if (!data.users[id]) {
    data.users[id] = {
      id,
      username: fakeUsername(n),
      points: DEFAULT_POINTS,
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
      isAdmin: false
    };
  }
}

async function postResultToResultsChannel(summary) {
  if (!RESULTS_CHANNEL_ID || RESULTS_CHANNEL_ID === "PEGA_AQUI_EL_CHANNEL_ID") {
    console.log("RESULTS_CHANNEL_ID no configurado. Resultado:", summary);
    return;
  }

  try {
    const channel = await client.channels.fetch(RESULTS_CHANNEL_ID);
    if (!channel) {
      console.log("No se encontró el canal de resultados.");
      return;
    }
    await channel.send(summary);
  } catch (err) {
    console.error("Error publicando resultado en canal dedicado:", err);
  }
}

async function applyMatchResult(winnerTeam, confirmedBy = "reports") {
  if (data.state.matchFinished) return false;

  const loserTeam = winnerTeam === "A" ? "B" : "A";
  const winners = data.state.teams[winnerTeam];
  const losers = data.state.teams[loserTeam];

  ensureUsersFromState();

  const elo = calculateEloChanges(winners, losers);

  for (const userId of winners) {
    data.users[userId].points += elo.winnerDelta;
    data.users[userId].wins += 1;
    data.users[userId].matchesPlayed += 1;
  }

  for (const userId of losers) {
    data.users[userId].points += elo.loserDelta;
    data.users[userId].losses += 1;
    data.users[userId].matchesPlayed += 1;
  }

  data.state.matchFinished = true;

  const matchId = data.state.matchNumber;
  const resultRecord = {
    matchId,
    winnerTeam,
    loserTeam,
    confirmedBy,
    timestamp: new Date().toISOString(),
    teamA: [...data.state.teams.A],
    teamB: [...data.state.teams.B],
    reportsA: [...data.state.reports.A],
    reportsB: [...data.state.reports.B],
    elo
  };

  data.state.resultsHistory.push(resultRecord);
  data.state.matchNumber += 1;
  saveData();

  const teamAAvg = Math.round(averageTeamRating(data.state.teams.A));
  const teamBAvg = Math.round(averageTeamRating(data.state.teams.B));

  const summary =
    `🏁 **Resultado Match #${matchId}**\n` +
    `Ganador: **Team ${winnerTeam}**\n` +
    `Confirmado por: **${confirmedBy}**\n\n` +
    `**Team A:** ${data.state.teams.A.map(formatUser).join(", ")}\n` +
    `**Team B:** ${data.state.teams.B.map(formatUser).join(", ")}\n\n` +
    `**ELO**\n` +
    `Promedio Team A: ${teamAAvg}\n` +
    `Promedio Team B: ${teamBAvg}\n` +
    `Ganadores: +${elo.winnerDelta}\n` +
    `Perdedores: ${elo.loserDelta}`;

  await postResultToResultsChannel(summary);
  return {
    winnerDelta: elo.winnerDelta,
    loserDelta: elo.loserDelta,
    elo
  };
}

client.once(Events.ClientReady, () => {
  console.log(`Bot listo como ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("/")) return;

  ensureUser(msg.author);
  saveData();

  const args = msg.content.trim().split(/\s+/);
  const command = args[0].toLowerCase();

  if (command === "/awelin") {
    return msg.reply("/bombim 👴🏻");
  }

  if (command === "/help") {
    return msg.channel.send(
      `🎯 **Ranked Matches Commands**

⚔️ **Crear / cancelar**
/challenge @usuario
/accept
/cancelmatch

👥 **Unirse**
/sign
/unsign

🎯 **Draft**
/startdraft
/pick @usuario
/pick FakePlayer1

🧾 **Resultado**
/report a
/report b
/finishmatch

🏆 **Ranking**
/leaderboard
/mypoints

🤖 **Test (admin)**
/fill

ℹ️ **Utilidades**
/ping
/help`
    );
  }

  if (command === "/mypoints") {
    const user = data.users[msg.author.id];
    return msg.reply(
      `Tienes **${user.points} puntos**.\nWins: ${user.wins} | Losses: ${user.losses} | Matches: ${user.matchesPlayed}`
    );
  }

  if (command === "/leaderboard") {
    return msg.channel.send(`🏆 **Leaderboard**\n${buildLeaderboard(10)}`);
  }

  if (command === "/challenge") {
    if (data.state.challengeActive) {
      return msg.reply("Ya hay un challenge activo.");
    }

    const mentionedUser = msg.mentions.users.first();
    if (!mentionedUser) {
      return msg.reply("Usa: /challenge @usuario");
    }

    if (mentionedUser.id === msg.author.id) {
      return msg.reply("No te puedes desafiar a ti mismo.");
    }

    ensureUser(mentionedUser);

    if (isPlayerInCurrentMatch(msg.author.id) || isPlayerInCurrentMatch(mentionedUser.id)) {
      return msg.reply("Uno de los jugadores ya está involucrado en un match actual.");
    }

    data.state.challengeActive = true;
    data.state.accepted = false;
    data.state.captains = [msg.author.id, mentionedUser.id];
    saveData();

    return msg.channel.send(
      `⚔️ Challenge creado: ${formatUser(msg.author.id)} desafió a ${formatUser(mentionedUser.id)}.\n${formatUser(mentionedUser.id)} responde con /accept`
    );
  }

  if (command === "/accept") {
    if (!data.state.challengeActive) {
      return msg.reply("No hay un challenge activo.");
    }

    if (msg.author.id !== data.state.captains[1]) {
      return msg.reply("Solo el desafiado puede aceptar.");
    }

    if (data.state.accepted) {
      return msg.reply("El challenge ya fue aceptado.");
    }

    data.state.accepted = true;
    saveData();

    return msg.channel.send(
      `✅ Challenge aceptado.\nCapitanes: ${formatUser(data.state.captains[0])} vs ${formatUser(data.state.captains[1])}\nUsen /sign (mínimo ${MIN_PLAYERS_TO_START_DRAFT} jugadores para empezar draft)`
    );
  }

  if (command === "/sign") {
    if (!data.state.accepted) {
      return msg.reply("No hay match listo.");
    }

    if (data.state.draftStarted) {
      return msg.reply("El draft ya empezó.");
    }

    if (isCaptain(msg.author.id)) {
      return msg.reply("Eres capitán.");
    }

    if (isSigned(msg.author.id)) {
      return msg.reply("Ya estás.");
    }

    data.state.signedPlayers.push(msg.author.id);
    saveData();

    return msg.channel.send(
      `📝 ${formatUser(msg.author.id)} entró a la lista.\n` +
      `Signed players: ${data.state.signedPlayers.length}\n` +
      `Mínimo para empezar draft: ${MIN_PLAYERS_TO_START_DRAFT}`
    );
  }

  if (command === "/unsign") {
    if (data.state.draftStarted) {
      return msg.reply("El draft ya empezó.");
    }

    const before = data.state.signedPlayers.length;
    data.state.signedPlayers = data.state.signedPlayers.filter(id => id !== msg.author.id);
    saveData();

    if (before === data.state.signedPlayers.length) {
      return msg.reply("No estabas en la lista.");
    }

    return msg.channel.send(`❌ ${formatUser(msg.author.id)} salió de la lista.`);
  }

  if (command === "/startdraft") {
    if (!data.state.accepted) {
      return msg.reply("No hay challenge aceptado.");
    }

    if (!isCaptain(msg.author.id)) {
      return msg.reply("Solo capitanes.");
    }

    if (data.state.draftStarted) {
      return msg.reply("El draft ya empezó.");
    }

    if (data.state.signedPlayers.length < MIN_PLAYERS_TO_START_DRAFT) {
      const missing = MIN_PLAYERS_TO_START_DRAFT - data.state.signedPlayers.length;
      return msg.reply(
        `Faltan jugadores para empezar el draft.\n` +
        `Actuales: ${data.state.signedPlayers.length}\n` +
        `Mínimo: ${MIN_PLAYERS_TO_START_DRAFT}\n` +
        `Faltan: ${missing}`
      );
    }

    data.state.draftStarted = true;
    data.state.teams.A = [data.state.captains[0]];
    data.state.teams.B = [data.state.captains[1]];
    data.state.draftStep = 0;
    saveData();

    return msg.channel.send(
      `🎯 Draft iniciado.\n\n` +
      `**Team A:** ${buildTeamString("A")}\n` +
      `**Team B:** ${buildTeamString("B")}\n\n` +
      `**Disponibles:** ${buildAvailableString()}\n\n` +
      `Turno de pick: ${formatUser(getCurrentTurnCaptainId())}\n` +
      `Usa /pick @usuario o /pick FakePlayer1`
    );
  }

  if (command === "/pick") {
    if (!data.state.draftStarted) {
      return msg.reply("El draft no ha empezado.");
    }

    if (data.state.draftComplete) {
      return msg.reply("El draft ya terminó.");
    }

    const expectedCaptainId = getCurrentTurnCaptainId();
    const side = data.state.draftOrder[data.state.draftStep];

    if (msg.author.id !== expectedCaptainId) {
      return msg.reply(`No es tu turno. Le toca a ${formatUser(expectedCaptainId)}.`);
    }

    let pickedId = null;

    const mentionedUser = msg.mentions.users.first();
    if (mentionedUser) {
      pickedId = mentionedUser.id;
      ensureUser(mentionedUser);
    } else {
      const rawName = args.slice(1).join(" ").trim().toLowerCase();
      if (!rawName) {
        return msg.reply("Usa /pick @usuario o /pick FakePlayer1");
      }

      const foundFake = data.state.signedPlayers.find(id => {
        const username = getUserDisplayName(id).toLowerCase();
        return username === rawName;
      });

      if (foundFake) {
        pickedId = foundFake;
      }
    }

    if (!pickedId) {
      return msg.reply("Jugador no encontrado. Usa /pick @usuario o /pick FakePlayer1");
    }

    if (!isSigned(pickedId)) {
      return msg.reply("Ese jugador no está en la lista.");
    }

    data.state.teams[side].push(pickedId);
    data.state.signedPlayers = data.state.signedPlayers.filter(id => id !== pickedId);
    data.state.draftStep += 1;

    const teamAFull = data.state.teams.A.length >= 5;
    const teamBFull = data.state.teams.B.length >= 5;

    if (teamAFull && teamBFull) {
      data.state.draftComplete = true;
      saveData();

      return msg.channel.send(
        `✅ Draft completo.\n\n` +
        `**Team A:** ${buildTeamString("A")}\n` +
        `**Team B:** ${buildTeamString("B")}\n\n` +
        `Suplentes / no pickeados: ${buildAvailableString()}\n\n` +
        `Cuando terminen, cada jugador usa \`/report a\` o \`/report b\`.`
      );
    }

    saveData();

    return msg.channel.send(
      `✅ Pick: ${formatUser(pickedId)} para Team ${side}\n\n` +
      `**Team A:** ${buildTeamString("A")}\n` +
      `**Team B:** ${buildTeamString("B")}\n\n` +
      `**Disponibles:** ${buildAvailableString()}\n\n` +
      `Turno de pick: ${formatUser(getCurrentTurnCaptainId())}`
    );
  }

  if (command === "/report") {
    if (!data.state.draftComplete) {
      return msg.reply("Todavía no hay match listo para reportar.");
    }

    if (!teamContains("A", msg.author.id) && !teamContains("B", msg.author.id)) {
      return msg.reply("No participas en este match.");
    }

    const teamArg = args[1]?.toUpperCase();
    if (!teamArg || !["A", "B"].includes(teamArg)) {
      return msg.reply("Usa: /report a  o  /report b");
    }

    data.state.reports.A = data.state.reports.A.filter(id => id !== msg.author.id);
    data.state.reports.B = data.state.reports.B.filter(id => id !== msg.author.id);
    data.state.reports[teamArg].push(msg.author.id);

    saveData();

    const countA = data.state.reports.A.length;
    const countB = data.state.reports.B.length;

    if (countA >= REPORTS_REQUIRED) {
      const applied = await applyMatchResult("A", "reports");
      if (applied) {
        return msg.channel.send(
          `🏁 Resultado confirmado: **Team A**\n\n` +
          `Ganadores: +${applied.winnerDelta}\n` +
          `Perdedores: ${applied.loserDelta}\n\n` +
          `**Team A:** ${buildTeamString("A")}\n` +
          `**Team B:** ${buildTeamString("B")}`
        );
      }
    }

    if (countB >= REPORTS_REQUIRED) {
      const applied = await applyMatchResult("B", "reports");
      if (applied) {
        return msg.channel.send(
          `🏁 Resultado confirmado: **Team B**\n\n` +
          `Ganadores: +${applied.winnerDelta}\n` +
          `Perdedores: ${applied.loserDelta}\n\n` +
          `**Team A:** ${buildTeamString("A")}\n` +
          `**Team B:** ${buildTeamString("B")}`
        );
      }
    }

    return msg.channel.send(
      `🧾 Reporte recibido de ${formatUser(msg.author.id)} para Team ${teamArg}\nReportes actuales → A: ${countA} | B: ${countB}`
    );
  }

  if (command === "/room") {
    return msg.channel.send(
      `📌 Estado actual

Challenge activo: ${data.state.challengeActive ? "sí" : "no"}
Aceptado: ${data.state.accepted ? "sí" : "no"}
Draft iniciado: ${data.state.draftStarted ? "sí" : "no"}
Draft completo: ${data.state.draftComplete ? "sí" : "no"}
Match finalizado: ${data.state.matchFinished ? "sí" : "no"}

Capitanes: ${data.state.captains.map(formatUser).join(" vs ") || "ninguno"}
Sign list (${data.state.signedPlayers.length} total, mínimo ${MIN_PLAYERS_TO_START_DRAFT} para draft): ${buildAvailableString()}

Team A: ${buildTeamString("A")}
Team B: ${buildTeamString("B")}

Reportes A: ${data.state.reports.A.map(formatUser).join(", ") || "ninguno"}
Reportes B: ${data.state.reports.B.map(formatUser).join(", ") || "ninguno"}`
    );
  }

  if (command === "/finishmatch") {
    if (!data.state.matchFinished) {
      return msg.reply("El match no ha sido confirmado todavía.");
    }

    resetMatchStateOnly();
    return msg.channel.send("♻️ Match cerrado y lobby reseteado. El ranking quedó guardado.");
  }

  if (command === "/cancelmatch") {
    if (!hasAdminAccess(msg) && !data.state.captains.includes(msg.author.id)) {
      return msg.reply("Solo los capitanes o un admin pueden cancelar el match.");
    }

    if (!data.state.challengeActive) {
      return msg.reply("No hay match activo.");
    }

    if (data.state.matchFinished) {
      return msg.reply("El match ya terminó. Usa /finishmatch.");
    }

    resetMatchStateOnly();
    return msg.channel.send("❌ Match cancelado. Puedes iniciar uno nuevo.");
  }

  if (command === "/results") {
    const history = data.state.resultsHistory || [];
    if (history.length === 0) {
      return msg.reply("No hay resultados todavía.");
    }

    const latest = history.slice(-5).reverse();
    const text = latest.map(r =>
      `Match #${r.matchId} — Ganó Team ${r.winnerTeam} — ${new Date(r.timestamp).toLocaleString()}`
    ).join("\n");

    return msg.channel.send(`📚 **Últimos resultados**\n${text}`);
  }

  if (command === "/adminhelp") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    return msg.channel.send(
      `🛠️ **Admin commands**
/setpoints @user 1200
/addpoints @user 25
/removepoints @user 25
/forcewin a
/forcewin b
/addsign @user
/removesign @user
/resetreports
/resetmatch
/resetelo
/fill
/clearfakes
/makeadmin @user
/removeadmin @user`
    );
  }

  if (command === "/makeadmin") {
    if (!isDiscordAdmin(msg)) {
      return msg.reply("Solo un admin real de Discord puede dar admin del bot.");
    }

    const mentionedUser = msg.mentions.users.first();
    if (!mentionedUser) {
      return msg.reply("Usa: /makeadmin @usuario");
    }

    ensureUser(mentionedUser);
    data.users[mentionedUser.id].isAdmin = true;
    saveData();

    return msg.channel.send(`✅ ${formatUser(mentionedUser.id)} ahora es admin del bot.`);
  }

  if (command === "/removeadmin") {
    if (!isDiscordAdmin(msg)) {
      return msg.reply("Solo un admin real de Discord puede quitar admin del bot.");
    }

    const mentionedUser = msg.mentions.users.first();
    if (!mentionedUser) {
      return msg.reply("Usa: /removeadmin @usuario");
    }

    ensureUser(mentionedUser);
    data.users[mentionedUser.id].isAdmin = false;
    saveData();

    return msg.channel.send(`✅ ${formatUser(mentionedUser.id)} ya no es admin del bot.`);
  }

  if (command === "/setpoints") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    const mentionedUser = msg.mentions.users.first();
    const amount = parseInt(args[2], 10);

    if (!mentionedUser || Number.isNaN(amount)) {
      return msg.reply("Usa: /setpoints @usuario 1200");
    }

    ensureUser(mentionedUser);
    data.users[mentionedUser.id].points = amount;
    saveData();

    return msg.channel.send(`✅ ${formatUser(mentionedUser.id)} ahora tiene ${amount} puntos.`);
  }

  if (command === "/addpoints") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    const mentionedUser = msg.mentions.users.first();
    const amount = parseInt(args[2], 10);

    if (!mentionedUser || Number.isNaN(amount)) {
      return msg.reply("Usa: /addpoints @usuario 25");
    }

    ensureUser(mentionedUser);
    data.users[mentionedUser.id].points += amount;
    saveData();

    return msg.channel.send(`✅ Se agregaron ${amount} puntos a ${formatUser(mentionedUser.id)}.`);
  }

  if (command === "/removepoints") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    const mentionedUser = msg.mentions.users.first();
    const amount = parseInt(args[2], 10);

    if (!mentionedUser || Number.isNaN(amount)) {
      return msg.reply("Usa: /removepoints @usuario 25");
    }

    ensureUser(mentionedUser);
    data.users[mentionedUser.id].points -= amount;
    saveData();

    return msg.channel.send(`✅ Se quitaron ${amount} puntos a ${formatUser(mentionedUser.id)}.`);
  }

  if (command === "/addsign") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    if (!data.state.accepted || data.state.draftStarted) {
      return msg.reply("Solo puedes agregar signed players antes del draft y con challenge aceptado.");
    }

    const mentionedUser = msg.mentions.users.first();
    if (!mentionedUser) {
      return msg.reply("Usa: /addsign @usuario");
    }

    ensureUser(mentionedUser);

    if (isCaptain(mentionedUser.id)) {
      return msg.reply("Ese usuario es capitán.");
    }

    if (isSigned(mentionedUser.id)) {
      return msg.reply("Ese usuario ya está en la lista.");
    }

    data.state.signedPlayers.push(mentionedUser.id);
    saveData();

    return msg.channel.send(`✅ Admin agregó a ${formatUser(mentionedUser.id)} a la sign list.`);
  }

  if (command === "/removesign") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    const mentionedUser = msg.mentions.users.first();
    if (!mentionedUser) {
      return msg.reply("Usa: /removesign @usuario");
    }

    const before = data.state.signedPlayers.length;
    data.state.signedPlayers = data.state.signedPlayers.filter(id => id !== mentionedUser.id);
    saveData();

    if (before === data.state.signedPlayers.length) {
      return msg.reply("Ese usuario no estaba en la lista.");
    }

    return msg.channel.send(`✅ Admin removió a ${formatUser(mentionedUser.id)} de la sign list.`);
  }

  if (command === "/resetreports") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    data.state.reports.A = [];
    data.state.reports.B = [];
    saveData();

    return msg.channel.send("✅ Reportes reseteados.");
  }

  if (command === "/forcewin") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    if (!data.state.draftComplete) {
      return msg.reply("Todavía no hay draft completo.");
    }

    const teamArg = args[1]?.toUpperCase();
    if (!teamArg || !["A", "B"].includes(teamArg)) {
      return msg.reply("Usa: /forcewin a  o  /forcewin b");
    }

    const applied = await applyMatchResult(teamArg, `admin:${msg.author.username}`);
    if (!applied) {
      return msg.reply("Ese match ya fue finalizado.");
    }

    return msg.channel.send(
      `✅ Admin confirmó victoria para Team ${teamArg}.\n` +
      `Ganadores: +${applied.winnerDelta}\n` +
      `Perdedores: ${applied.loserDelta}`
    );
  }

  if (command === "/fill") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    if (!data.state.accepted) {
      return msg.reply("No hay challenge aceptado.");
    }

    if (data.state.draftStarted) {
      return msg.reply("El draft ya empezó.");
    }

    let added = 0;

    for (let i = 1; i <= 50; i++) {
      const id = fakeUserId(i);

      if (data.state.signedPlayers.length >= SIGNED_PLAYERS_REQUIRED && i > 20) break;

      ensureFakeUser(i);

      if (
        !isCaptain(id) &&
        !isSigned(id) &&
        !data.state.teams.A.includes(id) &&
        !data.state.teams.B.includes(id)
      ) {
        data.state.signedPlayers.push(id);
        added++;
      }
    }

    saveData();

    return msg.channel.send(
      `🤖 Se agregaron ${added} fake players.\n` +
      `Sign list actual: ${data.state.signedPlayers.length}\n` +
      `Mínimo para draft: ${MIN_PLAYERS_TO_START_DRAFT}`
    );
  }
if (command === "/purgefakes") {
  if (!hasAdminAccess(msg)) {
    return msg.reply("No tienes permisos de admin.");
  }

  // sacar fake users de sign list
  data.state.signedPlayers = data.state.signedPlayers.filter(
    id => !String(id).startsWith("fake_")
  );

  // sacar fake users de teams
  data.state.teams.A = data.state.teams.A.filter(
    id => !String(id).startsWith("fake_")
  );
  data.state.teams.B = data.state.teams.B.filter(
    id => !String(id).startsWith("fake_")
  );

  // sacar fake users de reportes
  data.state.reports.A = data.state.reports.A.filter(
    id => !String(id).startsWith("fake_")
  );
  data.state.reports.B = data.state.reports.B.filter(
    id => !String(id).startsWith("fake_")
  );

  // borrar fake users del leaderboard / base de usuarios
  for (const userId of Object.keys(data.users)) {
    if (String(userId).startsWith("fake_")) {
      delete data.users[userId];
    }
  }

  saveData();

  return msg.channel.send("🧹 Fake users eliminados completamente.");
}

  if (command === "/clearfakes") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    if (data.state.draftStarted) {
      return msg.reply("No puedes limpiar fake players después de iniciar el draft.");
    }

    data.state.signedPlayers = data.state.signedPlayers.filter(
      id => !String(id).startsWith("fake_")
    );

    saveData();

    return msg.channel.send("🧹 Fake players removidos de la sign list.");
  }

  if (command === "/resetelo") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    for (const userId of Object.keys(data.users)) {
      data.users[userId].points = DEFAULT_POINTS;
      data.users[userId].wins = 0;
      data.users[userId].losses = 0;
      data.users[userId].matchesPlayed = 0;
    }

    saveData();

    return msg.channel.send("♻️ Todo el ranking fue reseteado a 1000.");
  }

  if (command === "/resetmatch") {
    if (!hasAdminAccess(msg)) {
      return msg.reply("No tienes permisos de admin.");
    }

    resetMatchStateOnly();
    return msg.channel.send("♻️ Admin reseteó el match actual.");
  }
});
console.log("TOKEN:", process.env.DISCORD_TOKEN);
client.login(process.env.DISCORD_TOKEN);