/**
 * scrape-stickers.js
 *
 * Downloads stickers from every Discord server you're in,
 * organized into folders by server name — ready to push to your GitHub repo.
 *
 * Usage:
 *   node scrape-stickers.js YOUR_DISCORD_TOKEN
 *
 * Place this file in the root of your Discord-Stickers repo folder,
 * next to generate-manifest.js. After it finishes, run generate-manifest.js
 * to update your stickers.json.
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

//  Args 

const TOKEN = process.argv[2];
if (!TOKEN) {
    console.error("Usage: node scrape-stickers.js YOUR_DISCORD_TOKEN");
    console.error("\nHow to get your token:");
    console.error("  1. Open Discord in your browser (discord.com/app)");
    console.error("  2. Press F12 → Network tab");
    console.error("  3. Type something in any chat");
    console.error("  4. Find a request to discord.com/api → look for the Authorization header");
    console.error("\nKeep your token private — it gives full access to your account.");
    process.exit(1);
}

//  Helpers 

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function safeName(str) {
    // Remove characters Windows/Mac won't allow in filenames
    return str.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim().slice(0, 80);
}

// Discord API GET with basic rate limit handling
function apiGet(endpoint) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "discord.com",
            path:     `/api/v10${endpoint}`,
            headers:  {
                "Authorization": TOKEN,
                "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        }, res => {
            let raw = "";
            res.on("data", chunk => raw += chunk);
            res.on("end", () => {
                if (res.statusCode === 429) {
                    // Rate limited — wait and retry
                    let retryAfter = 2;
                    try { retryAfter = JSON.parse(raw).retry_after || 2; } catch {}
                    console.log(`  Rate limited, waiting ${retryAfter}s…`);
                    sleep(retryAfter * 1000).then(() => apiGet(endpoint).then(resolve).catch(reject));
                } else if (res.statusCode === 401) {
                    reject(new Error("Invalid token. Double-check your Discord token."));
                } else if (res.statusCode === 403) {
                    resolve(null); // no access to this guild, skip silently
                } else {
                    try { resolve(JSON.parse(raw)); }
                    catch { reject(new Error(`Bad JSON from ${endpoint}: ${raw.slice(0, 100)}`)); }
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

// Download a file from a URL, following redirects
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);

        function get(urlStr) {
            https.get(urlStr, res => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    file.close();
                    get(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    file.close();
                    fs.unlink(dest, () => {});
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on("finish", () => file.close(resolve));
                file.on("error", err => { fs.unlink(dest, () => {}); reject(err); });
            }).on("error", err => { file.close(); fs.unlink(dest, () => {}); reject(err); });
        }

        get(url);
    });
}

//  Format type → file extension 

const FMT_EXT = { 1: "png", 2: "apng", 3: null, 4: "gif" }; // 3 = Lottie, skip

//  Main 

async function main() {
    console.log("Fetching your guild list…\n");

    // Paginate through all guilds (Discord returns max 200 at a time)
    let guilds = [];
    let after  = null;
    while (true) {
        const url   = `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`;
        const batch = await apiGet(url);
        if (!batch || !Array.isArray(batch)) break;
        guilds.push(...batch);
        if (batch.length < 200) break;
        after = batch[batch.length - 1].id;
        await sleep(1000);
    }

    console.log(`You're in ${guilds.length} servers. Scanning for stickers…\n`);

    let totalDownloaded = 0;
    let totalSkipped    = 0;
    let totalFailed     = 0;

    for (const guild of guilds) {
        await sleep(400); // stay well under rate limits

        const stickers = await apiGet(`/guilds/${guild.id}/stickers`);
        if (!stickers || !Array.isArray(stickers) || stickers.length === 0) continue;

        // Only keep stickers we can actually save as image files (skip Lottie)
        const usable = stickers.filter(s => FMT_EXT[s.format_type] !== null && FMT_EXT[s.format_type] !== undefined);
        if (usable.length === 0) continue;

        console.log(`📁 ${guild.name}  (${usable.length} sticker${usable.length !== 1 ? "s" : ""})`);

        // Output folder = stickers/<guild name>/
        const outDir = path.join(__dirname, "stickers", safeName(guild.name));
        fs.mkdirSync(outDir, { recursive: true });

        for (const sticker of usable) {
            const ext      = FMT_EXT[sticker.format_type];
            const filename = `${safeName(sticker.name)}.${ext}`;
            const dest     = path.join(outDir, filename);

            // Skip if already downloaded
            if (fs.existsSync(dest)) {
                totalSkipped++;
                continue;
            }

                const cdnUrl = `https://media.discordapp.net/stickers/${sticker.id}.${ext}`;

            try {
                process.stdout.write(`  ↓ ${sticker.name}…`);
                await downloadFile(cdnUrl, dest);
                process.stdout.write(" ✓\n");
                totalDownloaded++;
                await sleep(150); // brief pause between downloads
            } catch (e) {
                process.stdout.write(` ✗ ${e.message}\n`);
                totalFailed++;
                // Clean up partial file if it exists
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
            }
        }
    }

    console.log("\n");
    console.log(`✅ Downloaded:  ${totalDownloaded}`);
    console.log(`⏭  Skipped:     ${totalSkipped} (already existed)`);
    if (totalFailed > 0)
        console.log(`✗  Failed:      ${totalFailed}`);
    console.log("\nRun this next:");
    console.log("  node generate-manifest.js https://raw.githubusercontent.com/DogeTennant/Discord-Stickers/main");
    console.log("\nThen push to GitHub:");
    console.log("  git add . && git commit -m \"Add scraped stickers\" && git push");
}

main().catch(err => {
    console.error("\nFatal error:", err.message);
    process.exit(1);
});
