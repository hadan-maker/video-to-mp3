const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_MB = parseInt(process.env.MAX_MB || '200', 10);
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '2', 10);
const BITRATES = ['128', '192', '320'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v2mp3-'));
const AUDIO_EXT = ['.m4a', '.mp3', '.wav', '.wma', '.aac', '.ogg'];
const MAX_PPTX_AUDIO_BYTES = 500 * 1024 * 1024;
let active = 0;

// ---------- PowerPoint: استخراج الصوت بترتيب الشرائح ----------
function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return m ? m[1] : null;
}

function parseRels(xml) {
  return (xml.match(/<Relationship\b[^>]*>/g) || []).map((t) => ({
    id: attr(t, 'Id'),
    target: attr(t, 'Target'),
  }));
}

function pptxAudio(zipPath) {
  const zip = new AdmZip(zipPath);
  const text = (name) => {
    const e = zip.getEntry(name);
    return e ? e.getData().toString('utf8') : null;
  };

  let slides = [];
  const pres = text('ppt/presentation.xml');
  const presRels = text('ppt/_rels/presentation.xml.rels');
  if (pres && presRels) {
    const map = {};
    parseRels(presRels).forEach((r) => { map[r.id] = r.target; });
    (pres.match(/<p:sldId\b[^>]*>/g) || []).forEach((t) => {
      const target = map[attr(t, 'r:id')];
      if (!target) return;
      slides.push(target.startsWith('/') ? target.slice(1) : path.posix.normalize('ppt/' + target));
    });
  }
  if (!slides.length) {
    slides = zip.getEntries()
      .map((e) => e.entryName)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  }

  const tracks = [];
  const seen = new Set();
  let total = 0;
  slides.forEach((slidePath) => {
    const relsPath = path.posix.join(path.posix.dirname(slidePath), '_rels', path.posix.basename(slidePath) + '.rels');
    const xml = text(relsPath);
    if (!xml) return;
    const rels = parseRels(xml).sort((a, b) => {
      const na = parseInt((a.id || '').replace(/\D/g, ''), 10) || 0;
      const nb = parseInt((b.id || '').replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });
    rels.forEach((r) => {
      if (!r.target) return;
      const ext = path.posix.extname(r.target).toLowerCase();
      if (!AUDIO_EXT.includes(ext)) return;
      const full = r.target.startsWith('/')
        ? r.target.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(slidePath), r.target));
      if (seen.has(full)) return;
      const entry = zip.getEntry(full);
      if (!entry) return;
      total += entry.header.size;
      if (total > MAX_PPTX_AUDIO_BYTES) throw new Error('too big');
      seen.add(full);
      tracks.push({ ext, data: entry.getData() });
    });
  });
  return tracks;
}

// ---------- الخادم ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

app.use('/convert', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'عدد كبير من الطلبات. حاول بعد قليل.' }
}));

const upload = multer({
  dest: TMP,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 }
});

app.post('/convert', (req, res) => {
  if (active >= MAX_JOBS) {
    return res.status(503).json({ error: 'الخادم مشغول الآن. حاول بعد دقيقة.' });
  }
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };

  upload.single('file')(req, res, (err) => {
    if (err) {
      release();
      const big = err.code === 'LIMIT_FILE_SIZE';
      return res.status(big ? 413 : 400).json({
        error: big ? 'الملف أكبر من ' + MAX_MB + ' ميجابايت.' : 'فشل رفع الملف.'
      });
    }
    if (!req.file) {
      release();
      return res.status(400).json({ error: 'لم يصل أي ملف.' });
    }

    const input = req.file.path;
    const output = input + '.mp3';
    const extras = [];
    const kbps = BITRATES.includes(req.body.kbps) ? req.body.kbps : '192';
    const clean = () => {
      fs.unlink(input, () => {});
      fs.unlink(output, () => {});
      extras.forEach((p) => fs.unlink(p, () => {}));
      release();
    };

    let args;
    if (/\.pptx$/i.test(req.file.originalname || '')) {
      let tracks;
      try {
        tracks = pptxAudio(input);
      } catch (e) {
        clean();
        return res.status(422).json({ error: 'تعذّرت قراءة ملف PowerPoint.' });
      }
      if (!tracks.length) {
        clean();
        return res.status(422).json({ error: 'لا يحتوي هذا العرض على ملفات صوتية.' });
      }
      try {
        tracks.forEach((t, i) => {
          const p = input + '.t' + i + t.ext;
          fs.writeFileSync(p, t.data);
          extras.push(p);
        });
      } catch (e) {
        clean();
        return res.status(500).json({ error: 'خطأ في الخادم.' });
      }
      args = ['-y'];
      extras.forEach((p) => { args.push('-i', p); });
      const filters = extras.map((p, i) =>
        '[' + i + ':a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a' + i + ']'
      );
      const labels = extras.map((p, i) => '[a' + i + ']').join('');
      args.push(
        '-filter_complex',
        filters.join(';') + ';' + labels + 'concat=n=' + extras.length + ':v=0:a=1[out]',
        '-map', '[out]',
        '-codec:a', 'libmp3lame', '-b:a', kbps + 'k', output
      );
    } else {
      args = [
        '-y', '-i', input, '-vn', '-map', 'a:0',
        '-codec:a', 'libmp3lame', '-b:a', kbps + 'k', output
      ];
    }

    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });

    const timer = setTimeout(() => ff.kill('SIGKILL'), 10 * 60 * 1000);
    res.on('close', () => { if (!res.writableEnded) ff.kill('SIGKILL'); });

    ff.on('error', () => {
      clearTimeout(timer);
      clean();
      res.status(500).json({ error: 'خطأ في الخادم.' });
    });

    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        clean();
        return res.status(422).json({ error: 'تعذّر استخراج الصوت. تأكد أن الملف سليم وفيه صوت.' });
      }
      let base = 'audio';
      try {
        base = path.parse(Buffer.from(req.file.originalname, 'latin1').toString('utf8')).name || 'audio';
      } catch (e) {}
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(base) + '.mp3');
      res.sendFile(output, () => clean());
    });
  });
});

setInterval(() => {
  fs.readdir(TMP, (e, files) => {
    if (e) return;
    files.forEach((f) => {
      const p = path.join(TMP, f);
      fs.stat(p, (er, st) => {
        if (!er && Date.now() - st.mtimeMs > 30 * 60 * 1000) fs.unlink(p, () => {});
      });
    });
  });
}, 10 * 60 * 1000).unref();

app.listen(PORT, () => console.log('Listening on ' + PORT));