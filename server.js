// Zelfstandige back-up-ontvanger — draait als eigen docker compose-stack op
// een TWEEDE server, los van de hoofdsite. Ontvangt back-up-bestanden via
// een beveiligd upload-endpoint, bewaart ze, en ruimt zelf oude back-ups op
// volgens een eigen bewaartermijn — helemaal onafhankelijk van de
// hoofdsite, zodat een probleem op de hoofdserver deze kopieën niet raakt.
//
// Bewust GEEN wachtwoord via een environment-variabele/.env-bestand — dat
// stel je zelf in via het webscherm bij de eerste keer opstarten. Het
// wachtwoord wordt daarna alleen GEHASHT opgeslagen (met scrypt + een
// willekeurig salt, hetzelfde principe als bcrypt) in dezelfde map als de
// back-ups zelf, nooit in platte tekst en nooit in een configuratiebestand.
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const PORT = process.env.PORT || 4000;
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
const RETENTION_DAYS = parseFloat(process.env.RETENTION_DAYS || "14");
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — ruim boven wat een db.json ooit zou moeten worden
const AUTH_FILE = path.join(STORAGE_DIR, ".auth.json");

fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Herkent alleen het exacte back-up-bestandsformaat dat de hoofdsite
// gebruikt (db-JJJJ-MM-DD.json of db-JJJJ-MM-DDTUU-mm.json) — bewust géén
// brede regex, want dat zou per ongeluk ook .auth.json (met het
// wachtwoord-hash erin) als "back-up" behandelen, zichtbaar en
// downloadbaar maken. Voorkomt ook path traversal e.d.
const FILENAME_REGEX = /^db-\d{4}-\d{2}-\d{2}(T\d{2}-\d{2})?\.json$/;

function isSetUp() {
  return fs.existsSync(AUTH_FILE);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password) {
  if (!isSetUp()) return false;
  try {
    const { salt, hash } = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    const attempt = crypto.scryptSync(password, salt, 64).toString("hex");
    // Constante-tijd-vergelijking — voorkomt dat een aanvaller aan de
    // reactietijd kan aflezen hoeveel tekens al kloppen.
    return crypto.timingSafeEqual(Buffer.from(attempt, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) return false;
  return verifyPassword(auth.slice("Bearer ".length));
}

function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of fs.readdirSync(STORAGE_DIR)) {
    if (!FILENAME_REGEX.test(file)) continue; // .auth.json en andere interne bestanden overslaan
    const fullPath = path.join(STORAGE_DIR, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
        removed++;
      }
    } catch {
      // bestand kan tussentijds al weg zijn — geen probleem
    }
  }
  if (removed > 0) console.log(`[opruimen] ${removed} back-up(s) ouder dan ${RETENTION_DAYS} dagen verwijderd`);
}

// Elke 6 uur checken — de bewaartermijn zelf is in dagen, dus dit hoeft
// niet vaker; goedkoop genoeg om sowieso geen probleem te zijn.
pruneOldBackups();
setInterval(pruneOldBackups, 6 * 60 * 60 * 1000);

const HTML_PAGE = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Novapers back-up-ontvanger</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0d0e14; color: #f2f2f0;
    margin: 0; padding: 24px 16px;
  }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 4px; }
  p.sub { color: #a3a5b0; font-size: 13px; margin: 0 0 24px; }
  .card {
    background: rgba(255,255,255,0.055); border: 1px solid rgba(255,255,255,0.09);
    border-radius: 12px; padding: 16px; margin-bottom: 16px;
  }
  input {
    width: 100%; padding: 10px; border-radius: 8px; font-size: 14px;
    border: 1px solid rgba(255,255,255,0.09); background: rgba(255,255,255,0.07);
    color: #f2f2f0; margin-bottom: 8px;
  }
  button {
    padding: 10px 16px; border-radius: 8px; border: none; cursor: pointer;
    background: #f2f2f0; color: #0d0e14; font-size: 14px; font-weight: 500;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: rgba(255,255,255,0.07); color: #f2f2f0; border: 1px solid rgba(255,255,255,0.09); }
  .row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 0; border-top: 1px solid rgba(255,255,255,0.09);
  }
  .row:first-child { border-top: none; }
  .muted { color: #6e7180; font-size: 12px; }
  .error { color: #f09595; font-size: 13px; margin-top: 8px; }
  .success { color: #9fd15d; font-size: 13px; margin-top: 8px; }
  #setupBox, #loginBox, #contentBox { display: none; }
</style>
</head>
<body>
<div class="container">
  <h1>Novapers back-up-ontvanger</h1>
  <p class="sub">Overzicht van de back-ups die hier bewaard worden.</p>

  <div id="setupBox" class="card">
    <p style="margin-top:0; font-weight:500">Eerste keer hier — stel een wachtwoord in</p>
    <p class="muted">Dit wachtwoord wordt gehasht opgeslagen, nooit in platte tekst. Dit vul je straks
      ook in bij Instellingen → Back-ups op novapers.nl.</p>
    <input type="password" id="setupInput" placeholder="Kies een sterk wachtwoord" />
    <input type="password" id="setupConfirmInput" placeholder="Herhaal het wachtwoord" />
    <button onclick="setup()">Wachtwoord instellen</button>
    <p id="setupError" class="error" style="display:none"></p>
  </div>

  <div id="loginBox" class="card">
    <p class="muted" style="margin-top:0">Wachtwoord</p>
    <input type="password" id="secretInput" placeholder="Wachtwoord" />
    <button onclick="login()">Inloggen</button>
    <p id="loginError" class="error" style="display:none"></p>
  </div>

  <div id="contentBox">
    <div class="card">
      <div class="row" style="border-top:none">
        <div>
          <p style="margin:0; font-weight:500" id="summaryText">Laden...</p>
        </div>
        <div style="display:flex; gap:8px">
          <button class="secondary" onclick="loadBackups()">Verversen</button>
          <button class="secondary" onclick="logout()">Uitloggen</button>
        </div>
      </div>
    </div>
    <div class="card" id="listCard" style="padding:0 16px"></div>
    <p id="listError" class="error"></p>
  </div>
</div>

<script>
function getSecret() { return sessionStorage.getItem("secret"); }

async function setup() {
  const val = document.getElementById("setupInput").value;
  const confirmVal = document.getElementById("setupConfirmInput").value;
  const errEl = document.getElementById("setupError");
  errEl.style.display = "none";
  if (!val || val.length < 8) {
    errEl.textContent = "Wachtwoord moet minstens 8 tekens zijn.";
    errEl.style.display = "block";
    return;
  }
  if (val !== confirmVal) {
    errEl.textContent = "Wachtwoorden komen niet overeen.";
    errEl.style.display = "block";
    return;
  }
  const res = await fetch("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: val }),
  });
  if (res.ok) {
    sessionStorage.setItem("secret", val);
    init();
  } else {
    const data = await res.json();
    errEl.textContent = data.error || "Instellen mislukt.";
    errEl.style.display = "block";
  }
}

function login() {
  const val = document.getElementById("secretInput").value;
  if (!val) return;
  sessionStorage.setItem("secret", val);
  document.getElementById("loginError").style.display = "none";
  loadBackups();
}

function logout() {
  sessionStorage.removeItem("secret");
  init();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatMoment(iso) {
  const d = new Date(iso);
  return d.toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function downloadBackup(filename) {
  const res = await fetch("/backups/" + encodeURIComponent(filename), {
    headers: { Authorization: "Bearer " + getSecret() },
  });
  if (!res.ok) { alert("Downloaden mislukt"); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadBackups() {
  const secret = getSecret();
  if (!secret) { showLogin(); return; }
  document.getElementById("listError").textContent = "";
  try {
    const res = await fetch("/backups", { headers: { Authorization: "Bearer " + secret } });
    if (res.status === 401) {
      sessionStorage.removeItem("secret");
      showLogin();
      document.getElementById("loginError").textContent = "Onjuist wachtwoord.";
      document.getElementById("loginError").style.display = "block";
      return;
    }
    showContent();
    const data = await res.json();
    const backups = data.backups || [];
    document.getElementById("summaryText").textContent =
      backups.length === 0 ? "Nog geen back-ups ontvangen" : backups.length + " back-up(s) beschikbaar";

    const list = document.getElementById("listCard");
    if (backups.length === 0) {
      list.innerHTML = '<p class="muted" style="padding:16px 0">Wachten op de eerste back-up vanaf de hoofdsite.</p>';
      return;
    }
    list.innerHTML = backups.map(function(b) {
      return '<div class="row">' +
        '<span>' + formatMoment(b.createdAt) + '</span>' +
        '<div style="display:flex; align-items:center; gap:14px">' +
        '<span class="muted">' + formatBytes(b.sizeBytes) + '</span>' +
        '<button class="secondary" onclick="downloadBackup(\\'' + b.filename.replace(/'/g, "\\\\'") + '\\')">Downloaden</button>' +
        '</div></div>';
    }).join("");
  } catch (err) {
    document.getElementById("listError").textContent = "Kon geen verbinding maken met de server.";
  }
}

function showSetup() {
  document.getElementById("setupBox").style.display = "block";
  document.getElementById("loginBox").style.display = "none";
  document.getElementById("contentBox").style.display = "none";
}
function showLogin() {
  document.getElementById("setupBox").style.display = "none";
  document.getElementById("loginBox").style.display = "block";
  document.getElementById("contentBox").style.display = "none";
}
function showContent() {
  document.getElementById("setupBox").style.display = "none";
  document.getElementById("loginBox").style.display = "none";
  document.getElementById("contentBox").style.display = "block";
}

async function init() {
  const res = await fetch("/api/status");
  const data = await res.json();
  if (!data.setup) {
    showSetup();
    return;
  }
  if (getSecret()) {
    loadBackups();
  } else {
    showLogin();
  }
}

init();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // De pagina-schil en de setup-status zijn bewust publiek (bevatten geen
  // gevoelige data) — alle daadwerkelijke back-up-data blijft beveiligd.
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ setup: isSetUp() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/setup") {
    if (isSetUp()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Er is al een wachtwoord ingesteld." }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { password } = JSON.parse(body);
        if (!password || password.length < 8) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Wachtwoord moet minstens 8 tekens zijn." }));
          return;
        }
        const { salt, hash } = hashPassword(password);
        fs.writeFileSync(AUTH_FILE, JSON.stringify({ salt, hash }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Ongeldig verzoek" }));
      }
    });
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: isSetUp() ? "Niet geautoriseerd" : "Nog geen wachtwoord ingesteld — ga naar de website van deze ontvanger" }));
    return;
  }

  // POST /upload/<bestandsnaam> — de body is de rauwe inhoud van de back-up
  if (req.method === "POST" && url.pathname.startsWith("/upload/")) {
    const filename = decodeURIComponent(url.pathname.slice("/upload/".length));
    if (!FILENAME_REGEX.test(filename)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Ongeldige bestandsnaam" }));
      return;
    }

    const chunks = [];
    let totalSize = 0;
    let tooBig = false;
    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD_BYTES) {
        tooBig = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return; // response is al niet meer nodig, verbinding is dicht
      try {
        fs.writeFileSync(path.join(STORAGE_DIR, filename), Buffer.concat(chunks));
        console.log(`[ontvangen] ${filename} (${(totalSize / 1024).toFixed(0)} KB)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, filename }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    req.on("error", () => {
      // client brak de verbinding af — niets meer te doen
    });
    return;
  }

  // GET /backups — lijst van wat hier bewaard wordt, ter controle
  if (req.method === "GET" && url.pathname === "/backups") {
    const files = fs.readdirSync(STORAGE_DIR)
      .filter((f) => FILENAME_REGEX.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(STORAGE_DIR, f));
        return { filename: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ backups: files }));
    return;
  }

  // GET /backups/<bestandsnaam> — een specifieke back-up terugdownloaden
  if (req.method === "GET" && url.pathname.startsWith("/backups/")) {
    const filename = decodeURIComponent(url.pathname.slice("/backups/".length));
    if (!FILENAME_REGEX.test(filename)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Ongeldige bestandsnaam" }));
      return;
    }
    const fullPath = path.join(STORAGE_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Niet gevonden" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Niet gevonden" }));
});

server.listen(PORT, () => {
  console.log(`[back-up-ontvanger] gestart op poort ${PORT}, bewaartermijn ${RETENTION_DAYS} dagen${isSetUp() ? "" : " — nog geen wachtwoord ingesteld, ga naar de website"}`);
});
