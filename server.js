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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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
