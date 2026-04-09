/**
 * generate-manifest.js
 *
 * Run this locally whenever you add/remove stickers from your GitHub repo.
 * It walks your /stickers folder, builds stickers.json, and that's all the
 * plugin needs to find everything.
 *
 * Usage:
 *   node generate-manifest.js https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main
 *
 * Expected repo layout:
 *   stickers/
 *     linkin-park/
 *       chester-laugh.gif
 *       mike-pointing.gif
 *     reactions/
 *       facepalm.gif
 *   stickers.json        ← this file gets created/overwritten
 *   generate-manifest.js ← this script
 */

const fs   = require("fs");
const path = require("path");

//  Args 

const RAW_BASE = (process.argv[2] || "").replace(/\/$/, "");

if (!RAW_BASE) {
    console.error("Usage: node generate-manifest.js https://raw.githubusercontent.com/USER/REPO/main");
    process.exit(1);
}

const STICKERS_DIR = path.join(__dirname, "stickers");

if (!fs.existsSync(STICKERS_DIR)) {
    console.error(`No 'stickers/' folder found next to this script. Create it and put your GIFs in subfolders.`);
    process.exit(1);
}

//  Walk the folder tree 

const SUPPORTED = /\.(gif|png|apng)$/i;

function toDisplayName(filename) {
    // "chester-laughing-hard.gif" → "Chester Laughing Hard"
    return path.basename(filename, path.extname(filename))
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}

function toTags(filename) {
    // "chester-laughing-hard.gif" → "chester, laughing, hard"
    return path.basename(filename, path.extname(filename))
        .replace(/[-_]+/g, " ")
        .toLowerCase()
        .trim();
}

function walk(dir, category) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Subfolder name becomes the category, title-cased
            const subCategory = entry.name
                .replace(/[-_]+/g, " ")
                .replace(/\b\w/g, c => c.toUpperCase())
                .trim();
            results.push(...walk(fullPath, subCategory));
        } else if (SUPPORTED.test(entry.name)) {
            // Build a relative path from the stickers/ dir for the URL
            const rel = path.relative(STICKERS_DIR, fullPath).replace(/\\/g, "/");
            results.push({
                name:     toDisplayName(entry.name),
                category: category || "Uncategorized",
                tags:     toTags(entry.name),
                url:      `${RAW_BASE}/stickers/${rel}`,
            });
        }
    }
    return results;
}

//  Generate & write 

const stickers = walk(STICKERS_DIR, null);
stickers.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

const outPath = path.join(__dirname, "stickers.json");
fs.writeFileSync(outPath, JSON.stringify(stickers, null, 2), "utf8");

// Print a summary
const byCat = stickers.reduce((acc, s) => {
    acc[s.category] = (acc[s.category] || 0) + 1;
    return acc;
}, {});

console.log(`\n✅ Generated stickers.json with ${stickers.length} stickers:\n`);
for (const [cat, count] of Object.entries(byCat).sort()) {
    console.log(`   ${cat.padEnd(30)} ${count} sticker${count !== 1 ? "s" : ""}`);
}
console.log(`\nCommit stickers.json to your repo and you're done.\n`);
