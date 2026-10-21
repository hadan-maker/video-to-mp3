const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_MB = parseInt(process.env.MAX_MB || '200', 10);
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '2', 10);
const BITRATES = ['128', '192', '320'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v2mp3-'));
let active = 0;

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
    const kbps = BITRATES.includes(req.body.kbps) ? req.body.kbps : '192';
    const clean = () => {
      fs.unlink(input, () => {});
      fs.unlink(output, () => {});
      release();
    };

    const ff = spawn('ffmpeg', [
      '-y', '-i', input, '-vn', '-map', 'a:0',
      '-codec:a', 'libmp3lame', '-b:a', kbps + 'k', output
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

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
        return res.status(422).json({ error: 'تعذّر استخراج الصوت. تأكد أن الملف فيديو سليم وفيه صوت.' });
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
