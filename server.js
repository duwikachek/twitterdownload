import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ strict: false, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// JSON error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "JSON tidak valid" });
  }
  next();
});

// Helpers
function extractTweetId(url) {
  if (!url) return null;
  url = url.trim();
  // handle t.co short links - can't resolve without fetch, but try regex
  const patterns = [
    /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i,
    /\/status\/(\d+)/,
    /\/i\/web\/status\/(\d+)/,
    /^\d{10,20}$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function pickBestVariant(variants) {
  if (!variants || !variants.length) return null;
  // filter mp4 only, sort by bitrate desc, then resolution
  const mp4 = variants.filter(v => v.content_type === "video/mp4" || v.url?.endsWith(".mp4"));
  const list = (mp4.length ? mp4 : variants).slice();
  list.sort((a, b) => {
    const brA = a.bitrate || 0;
    const brB = b.bitrate || 0;
    if (brB !== brA) return brB - brA;
    // fallback: parse resolution from url e.g. 1280x720
    const resA = parseRes(a.url);
    const resB = parseRes(b.url);
    return resB - resA;
  });
  return list;
}

function parseRes(url) {
  if (!url) return 0;
  const m = url.match(/(\d{3,4})x(\d{3,4})/);
  if (m) return parseInt(m[2], 10);
  return 0;
}

function labelForVariant(v, idx, total) {
  const h = parseRes(v.url);
  if (h >= 1080) return `${h}p Full HD`;
  if (h >= 720) return `${h}p HD`;
  if (h >= 480) return `${h}p SD`;
  if (h) return `${h}p`;
  // fallback by bitrate ranking
  if (idx === 0) return "Kualitas Terbaik";
  if (idx === total - 1) return "Kualitas Rendah";
  return `Varian ${idx + 1}`;
}

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", ...(opts.headers || {}) } });
    return r;
  } finally { clearTimeout(t); }
}

// Try syndication API (no auth needed)
async function trySyndication(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=id&features=tfw_timeline_list_within_page%3Dtrue`;
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`syndication ${r.status}`);
  const j = await r.json();
  // j.mediaDetails or j.media_details
  const media = j.mediaDetails || j.media_details || [];
  const videos = [];
  for (const m of media) {
    if (m.type === "video" || m.type === "animated_gif") {
      const variants = m.video_info?.variants || m.videoInfo?.variants || [];
      if (variants.length) videos.push({ thumb: m.media_url_https || m.media_url, variants });
    }
  }
  if (videos.length) {
    return {
      text: j.text || j.full_text || "",
      user: j.user?.screen_name || j.user?.name || "Twitter",
      name: j.user?.name || "",
      avatar: j.user?.profile_image_url_https || "",
      thumb: videos[0].thumb,
      videos
    };
  }
  // sometimes j contains extended_entities?
  return null;
}

// Try VxTwitter / FxTwitter API
async function tryVxTwitter(id) {
  const endpoints = [
    `https://api.vxtwitter.com/i/status/${id}`,
    `https://api.fxtwitter.com/i/status/${id}`,
    `https://api.vxtwitter.com/Twitter/status/${id}`,
    `https://api.fxtwitter.com/Twitter/status/${id}`,
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetchWithTimeout(ep);
      if (!r.ok) continue;
      const j = await r.json();
      // Different shapes: j.media_extended, j.tweet.media, j.media
      let media = j.media_extended || j.tweet?.media?.videos || j.tweet?.media?.photos || j.media || [];
      // FxTwitter shape: j.tweet.media.videos etc, or j.media_extended
      if (j.tweet && j.tweet.media) {
        const m = j.tweet.media;
        if (m.videos) media = m.videos;
        else if (m.all) media = m.all;
      }
      const videos = [];
      for (const m of media) {
        if (m.type === "video" || m.type === "gif" || m.type === "animated_gif") {
          const variants = m.variants || m.video_info?.variants || m.url ? [{ url: m.url, content_type: "video/mp4", bitrate: m.bitrate || 0 }] : [];
          // vxtwitter sometimes gives m.url directly as mp4 and m.variants array
          const allVariants = m.variants && m.variants.length ? m.variants : (m.url ? [{ url: m.url, content_type: "video/mp4", bitrate: 0 }] : []);
          // also check m.video_url
          if (m.video_url) allVariants.push({ url: m.video_url, content_type: "video/mp4", bitrate: 0 });
          if (allVariants.length) videos.push({ thumb: m.thumbnail_url || m.thumb || j.tweet?.media?.thumbnail_url || "", variants: allVariants });
        } else if (m.url && m.url.endsWith(".mp4")) {
          videos.push({ thumb: m.thumbnail_url || "", variants: [{ url: m.url, content_type: "video/mp4", bitrate: 0 }] });
        }
      }
      // Alternative shape: j.tweet.video
      if (!videos.length && j.tweet?.video) {
        const v = j.tweet.video;
        videos.push({ thumb: v.thumb || "", variants: v.variants || [{ url: v.url, content_type: "video/mp4" }] });
      }
      if (videos.length) {
        return {
          text: j.text || j.tweet?.text || j.tweet?.raw_text || "",
          user: j.user_screen_name || j.tweet?.author?.screen_name || j.author?.screen_name || "Twitter",
          name: j.user_name || j.tweet?.author?.name || "",
          avatar: j.user_profile_image_url || j.tweet?.author?.avatar_url || "",
          thumb: videos[0].thumb || j.tweet?.media?.thumbnail_url || "",
          videos
        };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

// Fallback: try to fetch tweet page and extract m3u8? Not needed for now
async function getTweetInfo(id) {
  let lastErr = null;
  // Try syndication first (most reliable, no rate limit)
  try {
    const s = await trySyndication(id);
    if (s) return s;
  } catch (e) { 
    console.error("Syndication error:", e.message);
    lastErr = e; 
  }

  try {
    const v = await tryVxTwitter(id);
    if (v) return v;
  } catch (e) { 
    console.error("VxTwitter error:", e.message);
    lastErr = e; 
  }

  if (lastErr && lastErr.message.includes("404")) {
    throw new Error("Tweet tidak ditemukan. Pastikan URL benar atau tweet sudah dihapus.");
  }
  if (lastErr && lastErr.message.includes("403")) {
    throw new Error("Tweet tidak bisa diakses. Akun mungkin private.");
  }
  if (lastErr) {
    throw new Error("Gagal mengambil info tweet: " + lastErr.message);
  }
  throw new Error("Video tidak ditemukan. Pastikan URL berisi video/GIF, bukan status teks.");
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/info", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "URL wajib diisi" });
    if (typeof url !== "string" || url.length > 500) return res.status(400).json({ error: "URL tidak valid" });
    const id = extractTweetId(url);
    if (!id) return res.status(400).json({ error: "URL Twitter/X tidak valid. Contoh: https://x.com/user/status/123..." });

    const info = await getTweetInfo(id);

    // Build response with sorted variants
    const resultVideos = info.videos.map((v, vi) => {
      const sorted = pickBestVariant(v.variants);
      const items = sorted.map((vari, idx) => ({
        url: vari.url,
        content_type: vari.content_type || "video/mp4",
        bitrate: vari.bitrate || 0,
        label: labelForVariant(vari, idx, sorted.length),
        width: (() => { const m = vari.url.match(/(\d{3,4})x(\d{3,4})/); return m ? parseInt(m[1]) : null; })(),
        height: parseRes(vari.url) || null,
        isBest: idx === 0
      }));
      return {
        thumb: v.thumb || info.thumb,
        variants: items,
        best: items[0]
      };
    });

    res.json({
      id,
      text: info.text,
      user: info.user,
      name: info.name,
      avatar: info.avatar,
      thumb: info.thumb,
      videos: resultVideos
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Gagal mengambil info video" });
  }
});

// Proxy download to avoid CORS and force download
app.get("/api/download", async (req, res) => {
  try {
    const fileUrl = req.query.url;
    const filename = req.query.filename || "twitter-video.mp4";
    if (!fileUrl) return res.status(400).send("url required");
    // Validate url is twitter video cdn
    if (!fileUrl.startsWith("https://")) return res.status(400).send("invalid url");
    const r = await fetch(fileUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return res.status(502).send("Gagal fetch video");
    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    if (r.headers.get("content-length")) res.setHeader("Content-Length", r.headers.get("content-length"));
    const body = r.body;
    if (body) {
      for await (const chunk of body) res.write(chunk);
      res.end();
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    }
  } catch (e) {
    console.error(e);
    res.status(500).send("Download gagal: " + e.message);
  }
});

// Also support direct mp4 proxy streaming for preview
app.get("/api/proxy", async (req, res) => {
  const u = req.query.url;
  if (!u) return res.status(400).send("url required");
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Range: req.headers.range || "" } });
    res.status(r.status);
    r.headers.forEach((v, k) => {
      if (["content-type", "content-length", "accept-ranges", "content-range"].includes(k.toLowerCase())) res.setHeader(k, v);
    });
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
