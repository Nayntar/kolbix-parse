import express from "express";
import multer from "multer";
import * as cheerio from "cheerio";
import sharp from "sharp";
import archiver from "archiver";
import { promises as fs } from "fs";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static("public"));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// храним логи по jobId
const jobs = new Map(); // jobId -> { lines: string[], finished: boolean }

function absolutize(base, url) {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

function uniq(arr) {
  const s = new Set();
  const out = [];
  for (const x of arr) if (x && !s.has(x)) (s.add(x), out.push(x));
  return out;
}
function dedupeByBaseName(urls) {
  const seen = new Set();
  const out = [];

  for (const u of urls) {
    try {
      const urlObj = new URL(u);
      const file = urlObj.pathname.split("/").pop() || "";
      const noExt = file.replace(/\.(jpe?g|png|webp|avif)$/i, "");

      // убираем размеры и силу / объём
      let base = noExt
        .replace(/-\d+x\d+$/i, "")   // -600x600, -1000x1000
        .replace(/-\d+ml$/i, "")     // -30ml, -60ml
        .replace(/-\d+mg$/i, "");    // -25mg, -50mg, -100mg

      // на всякий случай нормализуем
      base = base.toLowerCase();

      if (seen.has(base)) continue;
      seen.add(base);
      out.push(u);
    } catch {
      // если что-то пошло не так с URL — не трогаем
      out.push(u);
    }
  }

  return out;
}

function extractImageUrls(pageUrl, html) {
  const $ = cheerio.load(html);
  const candidates = [];

  // 1. Собираем ссылки из <a>
  $("a").each((_, el) => {
    const attrs = [
      "href",
      "data-zoom-image",
      "data-image",
      "data-src",
      "data-original",
      "data-large-image",
    ];
    for (const attr of attrs) {
      const v = $(el).attr(attr);
      if (v) candidates.push(absolutize(pageUrl, v));
    }
  });

  // 2. Собираем ссылки из <img>
  $("img").each((_, el) => {
    const attrs = [
      "src",
      "data-src",
      "data-original",
      "data-lazy",
      "data-url",
      "data-srcset",
    ];
    for (const attr of attrs) {
      const v = $(el).attr(attr);
      if (!v) continue;

      if (attr === "data-srcset") {
        const first = v.split(",")[0].trim().split(/\s+/)[0];
        if (first) candidates.push(absolutize(pageUrl, first));
      } else {
        candidates.push(absolutize(pageUrl, v));
      }
    }
  });

  // 3. Базовая фильтрация по формату и мусору
  let imgs = uniq(candidates).filter((url) => {
    if (!url) return false;
    const lower = url.toLowerCase();

    if (!/\.(jpe?g|png|webp|avif)(\?.*)?$/i.test(lower)) return false;

    const isJunk =
      lower.includes("logo") ||
      lower.includes("sprite") ||
      lower.includes("icon") ||
      lower.includes("placeholder") ||
      lower.includes("payment") ||
      lower.includes("visa") ||
      lower.includes("mastercard") ||
      lower.includes("facebook") ||
      lower.includes("instagram") ||
      lower.includes("vk.com") ||
      lower.includes("telegram");

    if (isJunk) return false;

    return true;
  });

  // 4. Инфа о странице (для kalyancity)
  let pageHost = "";
  let productSlug = "";
  let brandSlug = "";

  try {
    const u = new URL(pageUrl);
    pageHost = u.hostname.toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);
    productSlug = (parts[parts.length - 1] || "").toLowerCase();
    brandSlug   = (parts[parts.length - 2] || "").toLowerCase();
  } catch (e) {}

  // 5. Нормализация урлов (full-size)
  imgs = imgs.map((u) => {
    try {
      const urlObj = new URL(u);

      // kalyancity: width=48/520 → width=1000
      if (urlObj.hostname.endsWith("kalyancity.in.ua")) {
        const params = urlObj.searchParams;
        if (params.has("width")) {
          params.set("width", "1000");
          urlObj.search = params.toString();
        }
      }

      // общий случай: ...-600x600.jpg → ...-1000x1000.jpg
      urlObj.pathname = urlObj.pathname.replace(
        /-\d+x\d+(\.[a-z]+)$/i,
        "-1000x1000$1"
      );

      return urlObj.toString();
    } catch {
      return u;
    }
  });

  // 6. Фильтр "картинки конкретного товара" для kalyancity
  if (pageHost.endsWith("kalyancity.in.ua")) {
    const slugCandidates = [];

    if (productSlug) {
      // полный slug товара
      slugCandidates.push(productSlug);                    // nabir-chaser-7-years-30ml

      const parts = productSlug.split("-");

      if (parts.length > 1) {
        // хвост без первого слова
        slugCandidates.push(parts.slice(1).join("-"));     // chaser-7-years-30ml
      }

      if (parts.length > 2) {
        // хвост без первого и без последнего слова
        slugCandidates.push(parts.slice(1, -1).join("-")); // chaser-7-years
      }
    }

    if (brandSlug) {
      slugCandidates.push(brandSlug);                      // nabir-chaser-lab
      const bp = brandSlug.split("-");
      if (bp.length > 1) {
        slugCandidates.push(bp.slice(1).join("-"));        // chaser-lab / chaser и т.п.
      }
    }

    const uniqSlugs = uniq(slugCandidates)
      .map((s) => s && s.toLowerCase())
      .filter((s) => s && s.length > 2);

    if (uniqSlugs.length > 0) {
      imgs = imgs.filter((url) => {
        const lu = url.toLowerCase();
        return uniqSlugs.some((sl) => lu.includes(sl));
      });
    }
  }
  imgs = uniq(imgs);
  imgs = dedupeByBaseName(imgs);
  return uniq(imgs);
}

app.post("/api/download", upload.single("wm"), async (req, res) => {
  const debug = req.body.debug === "true";
  const jobId = debug ? (req.body.jobId || null) : null;

  let job = null;
  if (debug && jobId) {
    job = jobs.get(jobId) || { lines: [], finished: false };
    jobs.set(jobId, job);
  }

  const dbg = (msg) => {
    const line = typeof msg === "string" ? msg : String(msg);
    if (job) job.lines.push(line);
    console.log(line);
  };

  try {
    const raw = (req.body.urls || req.body.url || "").trim();
    const shouldRemoveWm = req.body.removeWm === "true";

    if (!raw) return res.status(400).json({ error: "No urls" });

    const urls = raw.split(/\s+/g).map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) return res.status(400).json({ error: "No urls" });

    dbg(`START. URLs: ${urls.length}`);
    urls.forEach((u, i) => dbg(`  [${i + 1}] ${u}`));
    dbg(`Remove WM: ${shouldRemoveWm ? "YES" : "NO"}`);

    // --- ЛОГИКА ВЫБОРА ВОТЕРМАРКИ ---
    let wmBuf = req.file?.buffer;
    if (!wmBuf) {
      try {
        wmBuf = await fs.readFile("watermark.png");
        dbg("Watermark: используем стандартный watermark.png");
      } catch {
        dbg("Watermark: watermark.png не найден, логотип не будет наложен");
      }
    } else {
      dbg("Watermark: используем пользовательский PNG");
    }

    let wmPng = null;
    if (wmBuf) {
      wmPng = await sharp(wmBuf)
        .resize(1000, 1000, { fit: "fill" })
        .png()
        .toBuffer();
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="photos.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      throw err;
    });
    archive.pipe(res);

    for (let uIndex = 0; uIndex < urls.length; uIndex++) {
      const pageUrl = urls[uIndex];
      dbg(`\n[PAGE ${uIndex + 1}] ${pageUrl}`);

      const pageResp = await fetch(pageUrl, { headers: { "User-Agent": UA } });
      if (!pageResp.ok) {
        dbg(`  ❌ Ошибка загрузки страницы: HTTP ${pageResp.status}`);
        archive.append(`Error: ${pageResp.status}`, {
          name: `${String(uIndex + 1).padStart(2, "0")}_error.txt`,
        });
        continue;
      }

      const html = await pageResp.text();
      dbg("  HTML получен, парсим изображения...");

      const imageUrls = extractImageUrls(pageUrl, html);
      dbg(`  После фильтров изображений: ${imageUrls.length}`);

      if (imageUrls.length === 0) {
        archive.append(`No images found`, {
          name: `${String(uIndex + 1).padStart(2, "0")}_no_img.txt`,
        });
        continue;
      }

      let folderName = "";
      try {
        const urlObj = new URL(pageUrl);
        folderName = urlObj.pathname.split("/").filter(Boolean).pop();
      } catch {
        folderName = "";
      }

      if (!folderName) folderName = String(uIndex + 1).padStart(2, "0");
      folderName = folderName.replace(/[<>:"/\\|?*]+/g, "_");
      const folder = `${folderName}/`;

      dbg(`  Папка: ${folderName}`);
      dbg(`  Сохраняем файлов: ${imageUrls.length}`);

      for (let i = 0; i < imageUrls.length; i++) {
        const imgUrl = imageUrls[i];
        dbg(`    [img ${i + 1}/${imageUrls.length}] ${imgUrl}`);

        const r = await fetch(imgUrl, { headers: { "User-Agent": UA } });
        if (!r.ok) {
          dbg(`      ❌ Ошибка загрузки картинки: HTTP ${r.status}`);
          continue;
        }
        const inputBuffer = Buffer.from(await r.arrayBuffer());

        let img;

        if (shouldRemoveWm) {
          // EDGE STRETCH
          let sharpImg = sharp(inputBuffer).resize(1000, 1000, {
            fit: "contain",
            background: "#ffffff",
          });
          const baseBuffer = await sharpImg.png().toBuffer();

          const patchW = 400;
          const patchH = 200;
          const targetX = 1000 - patchW;
          const targetY = 1000 - patchH;

          const leftStrip = await sharp(baseBuffer)
            .extract({ left: targetX - 2, top: targetY, width: 2, height: patchH })
            .resize(patchW, patchH, { fit: "fill" })
            .blur(20)
            .png()
            .toBuffer();

          const topStrip = await sharp(baseBuffer)
            .extract({ left: targetX, top: targetY - 2, width: patchW, height: 2 })
            .resize(patchW, patchH, { fit: "fill" })
            .blur(20)
            .png()
            .toBuffer();

          const cleanPatch = await sharp(leftStrip)
            .composite([{ input: topStrip, blend: "overlay", opacity: 0.5 }])
            .png()
            .toBuffer();

          const fadeMask = Buffer.from(`
             <svg width="${patchW}" height="${patchH}">
               <defs>
                 <linearGradient id="g" x1="0" y1="0" x2="20%" y2="20%">
                   <stop offset="0%" stop-color="black" stop-opacity="0" />
                   <stop offset="100%" stop-color="white" stop-opacity="1" />
                 </linearGradient>
               </defs>
               <rect width="${patchW}" height="${patchH}" fill="white" />
               <rect width="${patchW}" height="${patchH}" fill="url(#g)" />
             </svg>
          `);

          const maskedPatch = await sharp(cleanPatch)
            .composite([{ input: fadeMask, blend: "dest-in" }])
            .png()
            .toBuffer();

          img = sharp(baseBuffer).composite([
            { input: maskedPatch, left: targetX, top: targetY },
          ]);
        } else {
          img = sharp(inputBuffer).resize(1000, 1000, {
            fit: "contain",
            background: "#ffffff",
          });
        }

        if (wmPng) {
          const temp = await img.png().toBuffer();
          img = sharp(temp).composite([{ input: wmPng, gravity: "center" }]);
        }

        const out = await img.png().toBuffer();

        archive.append(out, {
          name: `${folder}${String(i + 1).padStart(2, "0")}.png`,
        });
      }

      archive.append(`${pageUrl}\n`, { name: `${folder}source.txt` });
    }

    dbg("\n=== END ===");
    if (job) job.finished = true;

    await archive.finalize();
  } catch (e) {
    console.error(e);
    if (job) {
      job.lines.push(`FATAL: ${e.stack || e}`);
      job.finished = true;
    }
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.get("/api/debug-log", (req, res) => {
  const jobId = req.query.jobId;
  const from = parseInt(req.query.from || "0", 10);

  if (!jobId || !jobs.has(jobId)) {
    return res.json({ lines: [], finished: true, next: from });
  }

  const job = jobs.get(jobId);
  const lines = job.lines.slice(from);
  const next = from + lines.length;

  // если задача завершена и всё уже отдали — можно почистить
  if (job.finished && lines.length === 0) {
    jobs.delete(jobId);
  }

  res.json({ lines, finished: job.finished, next });
});

// --- ИНСТРУМЕНТ 2: БЕЛЫЙ ФОН МАССОВО ---
app.post("/api/white-bg", upload.array("images"), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files" });
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="white_bg_ready.zip"`);
        const archive = archiver("zip");
        archive.pipe(res);

        for (const file of req.files) {
            const out = await sharp(file.buffer)
                .flatten({ background: '#ffffff' })
                .resize(1000, 1000, { fit: 'contain', background: '#ffffff' })
                .png().toBuffer();
            archive.append(out, { name: `white_${file.originalname}` });
        }
        await archive.finalize();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server is running on port ${PORT}`));