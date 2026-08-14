// Zelfstandige back-up-ontvanger — draait als eigen docker compose-stack op
// een TWEEDE server, los van de hoofdsite. Ontvangt back-up-bestanden via
// een beveiligd upload-endpoint, bewaart ze, en ruimt zelf oude back-ups op
// volgens een eigen bewaartermijn — helemaal onafhankelijk van de
// hoofdsite, zodat een probleem op de hoofdserver deze kopieën niet raakt.
import http from "http";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 4000;
const SHARED_SECRET = process.env.BACKUP_SHARED_SECRET;
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
const RETENTION_DAYS = parseFloat(process.env.RETENTION_DAYS || "14");
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — ruim boven wat een db.json ooit zou moeten worden

if (!SHARED_SECRET) {
  console.error("FOUT: BACKUP_SHARED_SECRET is niet ingesteld. Stop.");
  process.exit(1);
}

fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Alleen bestandsnamen die exact op ons back-up-formaat lijken worden
// geaccepteerd — voorkomt dat dit endpoint misbruikt kan worden om
// willekeurige bestanden op de server te zetten (path traversal e.d.).
const FILENAME_REGEX = /^[a-zA-Z0-9._-]{1,200}\.json$/;

function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${SHARED_SECRET}`;
}

function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of fs.readdirSync(STORAGE_DIR)) {
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
  #loginBox, #contentBox { display: none; }
</style>
</head>
<body>
<div class="container">
  <h1>Novapers back-up-ontvanger</h1>
  <p class="sub">Overzicht van de back-ups die hier bewaard worden.</p>

  <div id="loginBox" class="card">
    <p class="muted" style="margin-top:0">Gedeeld wachtwoord</p>
    <input type="password" id="secretInput" placeholder="BACKUP_SHARED_SECRET" />
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

function login() {
  const val = document.getElementById("secretInput").value.trim();
  if (!val) return;
  sessionStorage.setItem("secret", val);
  document.getElementById("loginError").style.display = "none";
  checkAuthAndLoad();
}

function logout() {
  sessionStorage.removeItem("secret");
  checkAuthAndLoad();
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
  document.getElementById("listError").textContent = "";
  try {
    const res = await fetch("/backups", { headers: { Authorization: "Bearer " + secret } });
    if (res.status === 401) {
      sessionStorage.removeItem("secret");
      checkAuthAndLoad();
      document.getElementById("loginError").textContent = "Onjuist wachtwoord.";
      document.getElementById("loginError").style.display = "block";
      return;
    }
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

function checkAuthAndLoad() {
  const secret = getSecret();
  if (secret) {
    document.getElementById("loginBox").style.display = "none";
    document.getElementById("contentBox").style.display = "block";
    loadBackups();
  } else {
    document.getElementById("loginBox").style.display = "block";
    document.getElementById("contentBox").style.display = "none";
  }
}

checkAuthAndLoad();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // De pagina-schil zelf is publiek (bevat geen gevoelige data, alleen HTML/JS)
  // — pas de daadwerkelijke data-aanroepen die de pagina doet, vereisen het
  // gedeelde wachtwoord.
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Niet geautoriseerd" }));
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
  console.log(`[back-up-ontvanger] gestart op poort ${PORT}, bewaartermijn ${RETENTION_DAYS} dagen`);
});
