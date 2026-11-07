const $ = (id) => document.getElementById(id);
const screens = ["welcome", "join-panel", "room"];
const state = { code: null, playerToken: null, adminToken: null, player: null, game: null, busy: false, poll: null };

function showScreen(id) {
  screens.forEach((screen) => $(screen).classList.toggle("hidden", screen !== id));
}
function notice(message, type = "info") {
  const el = $("notice");
  el.textContent = message;
  el.className = `notice ${type}`;
}
function clearNotice() { $("notice").className = "notice hidden"; }
function storageKey(code) { return `lucky-five:${code.toUpperCase()}`; }
function saveSession() {
  localStorage.setItem(storageKey(state.code), JSON.stringify({
    playerToken: state.playerToken, adminToken: state.adminToken
  }));
}
function loadSession(code) {
  try { return JSON.parse(localStorage.getItem(storageKey(code)) || "null"); }
  catch { return null; }
}
function configReady() {
  const c = window.LUCKY_FIVE_CONFIG || {};
  return c.supabaseUrl?.startsWith("https://") && c.supabaseAnonKey && !c.supabaseUrl.includes("YOUR_");
}
async function api(action, payload = {}) {
  if (!configReady()) throw new Error("The app still needs its Supabase settings. Follow the setup guide in the project ZIP.");
  const c = window.LUCKY_FIVE_CONFIG;
  const response = await fetch(`${c.supabaseUrl}/functions/v1/lucky-five`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": c.supabaseAnonKey, "Authorization": `Bearer ${c.supabaseAnonKey}` },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function setBusy(value) {
  state.busy = value;
  ["create-game", "join-game", "spin-number", "spin-gift", "copy-link", "save-couples"].forEach(id => {
    const el = $(id); if (el) el.disabled = value || el.dataset.locked === "true";
  });
}
function setButton(id, enabled, text) {
  const el = $(id); el.disabled = !enabled || state.busy;
  el.dataset.locked = enabled ? "false" : "true";
  if (text) el.textContent = text;
}
function setWheelSpinning(id, spinning) {
  const wheel = $(`${id}`).querySelector(".wheel");
  wheel.classList.toggle("spinning", spinning);
}
function spinAnimation(id) {
  return new Promise(resolve => {
    const wheel = $(`${id}`).querySelector(".wheel");
    wheel.classList.remove("spinning");
    wheel.style.setProperty("--spin", `${1800 + Math.floor(Math.random() * 900)}deg`);
    void wheel.offsetWidth;
    wheel.classList.add("spinning");
    window.setTimeout(() => { wheel.classList.remove("spinning"); resolve(); }, 3300);
  });
}
function revealResult(target, html) {
  $(target).innerHTML = html;
  $(target).classList.remove("hidden");
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function renderStatus(data) {
  state.game = data;
  $("room-title").textContent = `Game ${state.code}`;
  $("room-count").textContent = `${data.players.length} / 5 joined`;
  $("invite-link").value = `${location.origin}${location.pathname}?join=${state.code}`;
  $("lobby-caption").textContent = data.status === "open" ? "Waiting for all five players to join." : "All five players are in! Let the draws begin.";
  $("player-list").innerHTML = data.players.map((p, i) => `
    <li class="player-item">
      <span class="player-avatar">${["🎅","🧑‍🎄","🦌","⛄","🎄"][i]}</span>
      <span class="player-name">${escapeHtml(p.name)}${p.is_me ? ' <small>(you)</small>' : ""}</span>
      <span class="player-state">${p.number_drawn ? "Number drawn ✓" : "Joined"}</span>
      <span class="player-state">${p.gift_drawn ? "Gift drawn ✓" : ""}</span>
    </li>`).join("");
  const ready = data.status === "ready" || data.status === "complete";
  const couplesPanel = $("couples-panel");
  couplesPanel.classList.toggle("hidden", !(data.is_admin && ready));
  if (data.is_admin && ready) {
    ["pair1a", "pair1b", "pair2a", "pair2b"].forEach(id => {
      const select = $(id);
      const previous = select.value;
      select.innerHTML = '<option value="">Choose a player…</option>' + data.players.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
      if (previous && data.players.some(p => p.id === previous)) select.value = previous;
      select.disabled = !!data.couples_set;
    });
    $("save-couples").classList.toggle("hidden", !!data.couples_set);
    $("couples-saved").classList.toggle("hidden", !data.couples_set);
  }
  $("number-stage").classList.toggle("hidden", !ready);
  $("gift-stage").classList.toggle("hidden", !ready);
  if (data.my_number !== null && data.my_number !== undefined) {
    revealResult("number-result", `Your secret number is <strong>${data.my_number}</strong> 🎉`);
    setButton("spin-number", false, "Number already revealed ✓");
  } else {
    $("number-result").classList.add("hidden");
    setButton("spin-number", ready, ready ? "Spin for my number" : "Waiting for five players…");
  }
  if (data.my_gift) {
    revealResult("gift-result", `You're buying a present for <strong>${escapeHtml(data.my_gift.name)}</strong><br><span class="recipient-number">Their number: ${data.my_gift.number}</span><br><span class="whisper">Shhh… it's a secret! 🤫</span>`);
    setButton("spin-gift", false, "Your secret is safe ✓");
  } else {
    $("gift-result").classList.add("hidden");
    const canGift = ready && data.couples_set && data.my_number !== null && data.my_number !== undefined;
    setButton("spin-gift", canGift, canGift ? "Spin for my gift recipient" : (!data.couples_set ? "Waiting for host to set couples…" : "Reveal your number first"));
  }
  showScreen("room");
}
async function refreshStatus() {
  if (!state.playerToken) return;
  const data = await api("status", { playerToken: state.playerToken, adminToken: state.adminToken });
  renderStatus(data);
}
async function startPolling() {
  if (state.poll) clearInterval(state.poll);
  await refreshStatus();
  state.poll = setInterval(() => refreshStatus().catch(() => {}), 5000);
}
async function joinWithName(code, name, creating = false) {
  setBusy(true); clearNotice();
  try {
    if (creating) {
      const created = await api("create", {});
      code = created.inviteCode;
      state.adminToken = created.adminToken;
      history.replaceState({}, "", `${location.pathname}?join=${code}`);
    }
    const joined = await api("join", { inviteCode: code, name });
    state.code = code.toUpperCase();
    state.playerToken = joined.playerToken;
    state.player = name;
    saveSession();
    await startPolling();
    notice("You're in! Share the invitation link with the other four players.", "success");
  } catch (e) {
    notice(e.message, "error");
    if (creating) state.adminToken = null;
  } finally { setBusy(false); }
}
$("create-game").addEventListener("click", () => {
  state.code = null; state.adminToken = null;
  $("player-name").value = "";
  $("join-panel").dataset.mode = "create";
  $("join-panel").classList.remove("hidden");
  $("welcome").classList.add("hidden");
  $("player-name").focus();
});
$("join-game").addEventListener("click", async () => {
  const name = $("player-name").value.trim();
  if (!name) return notice("Please enter your name first.", "error");
  const creating = $("join-panel").dataset.mode === "create";
  const code = state.code || new URLSearchParams(location.search).get("join");
  if (!creating && !code) return notice("This invitation link doesn't contain a game code.", "error");
  await joinWithName(code, name, creating);
});
$("save-couples").addEventListener("click", async () => {
  const pair1a = $("pair1a").value, pair1b = $("pair1b").value;
  const pair2a = $("pair2a").value, pair2b = $("pair2b").value;
  if (![pair1a, pair1b, pair2a, pair2b].every(Boolean)) return notice("Choose all four people first.", "error");
  if (new Set([pair1a, pair1b, pair2a, pair2b]).size !== 4) return notice("Each couple must contain two different people, and the couples must be different.", "error");
  setBusy(true); clearNotice();
  try {
    await api("set-couples", { adminToken: state.adminToken, pair1a, pair1b, pair2a, pair2b });
    await refreshStatus();
    notice("Both couples are saved. The gift draw is ready! ❤️", "success");
  } catch (e) { notice(e.message, "error"); }
  finally { setBusy(false); }
});

$("copy-link").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("invite-link").value); $("copy-link").textContent = "Copied ✓"; }
  catch { $("invite-link").select(); notice("Copy wasn't available. Select and copy the invitation link.", "info"); }
});
$("spin-number").addEventListener("click", async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    await spinAnimation("number-wheel");
    const result = await api("spin-number", { playerToken: state.playerToken });
    revealResult("number-result", `Your secret number is <strong>${result.number}</strong> 🎉`);
    setButton("spin-number", false, "Number already revealed ✓");
    await refreshStatus();
  } catch (e) { notice(e.message, "error"); }
  finally { setBusy(false); }
});
$("spin-gift").addEventListener("click", async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    await spinAnimation("gift-wheel");
    const result = await api("spin-gift", { playerToken: state.playerToken });
    if (result.retry) { notice(result.reason || "Not a valid draw. Spin again!", "info"); return; }
    revealResult("gift-result", `You're buying a present for <strong>${escapeHtml(result.recipient.name)}</strong><br><span class="recipient-number">Their number: ${result.recipient.number}</span><br><span class="whisper">Shhh… it's a secret! 🤫`);
    setButton("spin-gift", false, "Your secret is safe ✓");
    await refreshStatus();
  } catch (e) { notice(e.message, "error"); }
  finally { setBusy(false); }
});
$("leave-view").addEventListener("click", () => {
  if (state.poll) clearInterval(state.poll);
  state.poll = null; state.playerToken = null; state.adminToken = null; state.code = null;
  history.replaceState({}, "", location.pathname);
  showScreen("welcome"); clearNotice();
});
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const code = new URLSearchParams(location.search).get("join");
  if (code) {
    state.code = code.toUpperCase();
    const session = loadSession(state.code);
    if (session?.playerToken) {
      state.playerToken = session.playerToken;
      state.adminToken = session.adminToken || null;
      try { await startPolling(); return; }
      catch { localStorage.removeItem(storageKey(state.code)); state.playerToken = null; }
    }
    $("join-panel").dataset.mode = "join";
    $("welcome").classList.add("hidden");
    $("join-panel").classList.remove("hidden");
  }
}
boot().catch(e => notice(e.message, "error"));
