const express = require('express');
const axios = require('axios');
const cloudscraper = require('cloudscraper');
const https = require('https');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const flash = require('connect-flash');
const crypto = require('crypto');
const path = require('path');
const { Octokit } = require('@octokit/rest');
const multer = require('multer');
const config = require('./setting.js');

// ==================== KONFIGURASI ====================
const PORT = config.PORT || 8080;
const HOST = config.HOST || 'localhost';
const BASE_URL = config.URL || `http://${HOST}:${PORT}`;
const SESSION_SECRET = config.SESSION_SECRET || 'novabot-super-secret-2026';
const VERSION = config.VERSI_WEB || '1.0';
const DEVELOPER = config.DEVELOPER || '@Novabot403';
const SITE_NAME = config.SITE_NAME || 'NovaBot API';

// GitHub config (akan diinisialisasi async)
let GITHUB_TOKEN = null;
let GITHUB_REPO = null; // format "owner/repo"
let GITHUB_BRANCH = 'main';
let GITHUB_PATH = 'file';
let octokit = null;
let owner, repo;

// Multer untuk upload file (memory storage)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // max 5MB

// HTTPS Agent untuk Pinterest
const httpsAgent = new https.Agent({
  rejectUnauthorized: true,
  maxVersion: 'TLSv1.3',
  minVersion: 'TLSv1.2',
});

// Daftar tipe NSFW
const NSFW_TYPES = ['blowjob', 'neko', 'trap', 'waifu'];

// ==================== GITHUB INITIALIZATION ====================
async function initGithub() {
  const tokenConfig = config.GITHUB_TOKEN;
  if (!tokenConfig) {
    console.error('GITHUB_TOKEN tidak dikonfigurasi. Aplikasi tidak dapat berjalan.');
    process.exit(1);
  }

  // Ambil konfigurasi dari URL JSON
  if (tokenConfig.startsWith('http://') || tokenConfig.startsWith('https://')) {
    try {
      console.log('Mengambil konfigurasi GitHub dari URL:', tokenConfig);
      const response = await axios.get(tokenConfig);
      const data = response.data;
      GITHUB_TOKEN = data.github_token;
      GITHUB_REPO = data.github_repo;
      GITHUB_BRANCH = data.github_branch || 'main';
      GITHUB_PATH = data.github_path || 'file';
      if (!GITHUB_TOKEN || !GITHUB_REPO) {
        throw new Error('Token atau repo tidak ditemukan dalam response JSON');
      }
    } catch (error) {
      console.error('Gagal mengambil konfigurasi GitHub dari URL:', error.message);
      process.exit(1);
    }
  } else {
    console.error('GITHUB_TOKEN harus berupa URL JSON yang berisi token dan repo.');
    process.exit(1);
  }

  if (GITHUB_TOKEN) {
    octokit = new Octokit({ auth: GITHUB_TOKEN });
    [owner, repo] = GITHUB_REPO.split('/');
    console.log(`GitHub siap: owner=${owner}, repo=${repo}, branch=${GITHUB_BRANCH}, path=${GITHUB_PATH}`);
  }
}

// ==================== FUNGSI BACA/TULIS GITHUB ====================
async function readGitHubFile(filePath) {
  if (!octokit) throw new Error('GitHub tidak tersedia');
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: GITHUB_BRANCH,
    });
    const content = Buffer.from(data.content, 'base64').toString();
    return { content: JSON.parse(content), sha: data.sha };
  } catch (error) {
    if (error.status === 404) {
      return { content: null, sha: null };
    }
    throw error;
  }
}

async function writeGitHubFile(filePath, content, sha = null, message = 'Update file') {
  if (!octokit) throw new Error('GitHub tidak tersedia');
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    branch: GITHUB_BRANCH,
    sha,
  });
}

async function writeGitHubFileWithRetry(filePath, content, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { sha } = await readGitHubFile(filePath);
      await writeGitHubFile(filePath, content, sha, 'Update file');
      return;
    } catch (error) {
      if (error.status === 409 && i < maxRetries - 1) {
        console.log(`Konflik saat menulis ${filePath}, mencoba lagi... (${i+1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 100 * (i+1)));
        continue;
      }
      throw error;
    }
  }
}

// Fungsi untuk menghapus file di GitHub
async function deleteGitHubFile(filePath) {
  if (!octokit) throw new Error('GitHub tidak tersedia');
  try {
    const { sha } = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: GITHUB_BRANCH,
    }).then(res => res.data);
    await octokit.repos.deleteFile({
      owner,
      repo,
      path: filePath,
      message: `Delete file ${filePath}`,
      sha,
      branch: GITHUB_BRANCH,
    });
    console.log(`File ${filePath} berhasil dihapus`);
  } catch (error) {
    if (error.status === 404) {
      // File tidak ada, abaikan
      return;
    }
    throw error;
  }
}

// ==================== FUNGSI MANAJEMEN USER ====================
async function getUsers() {
  const filePath = `${GITHUB_PATH}/users.json`.replace(/\/+/g, '/');
  const { content } = await readGitHubFile(filePath);
  return content || [];
}

async function saveUsers(users) {
  const filePath = `${GITHUB_PATH}/users.json`.replace(/\/+/g, '/');
  await writeGitHubFileWithRetry(filePath, users);
}

async function findUserByEmail(email) {
  const users = await getUsers();
  return users.find(u => u.email === email);
}

async function findUserById(id) {
  const users = await getUsers();
  return users.find(u => u.id === id);
}

async function createUser(userData) {
  const users = await getUsers();
  const newId = users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1;
  const newUser = { id: newId, ...userData, createdAt: new Date().toISOString() };
  users.push(newUser);
  await saveUsers(users);
  return newUser;
}

async function updateUser(id, updatedFields) {
  const users = await getUsers();
  const index = users.findIndex(u => u.id === id);
  if (index === -1) return null;
  users[index] = { ...users[index], ...updatedFields };
  await saveUsers(users);
  return users[index];
}

// ==================== FUNGSI MANAJEMEN PESAN (CHAT) ====================
async function getMessages() {
  const filePath = `${GITHUB_PATH}/messages.json`.replace(/\/+/g, '/');
  const { content } = await readGitHubFile(filePath);
  return (content || []).map(m => ({ ...m, parentId: m.parentId || null }));
}

async function saveMessages(messages) {
  const filePath = `${GITHUB_PATH}/messages.json`.replace(/\/+/g, '/');
  await writeGitHubFileWithRetry(filePath, messages);
}

async function addMessage(messageData) {
  const messages = await getMessages();
  const newId = messages.length > 0 ? Math.max(...messages.map(m => m.id)) + 1 : 1;
  const newMessage = {
    id: newId,
    ...messageData,
    parentId: messageData.parentId || null,
    createdAt: new Date().toISOString()
  };
  messages.push(newMessage);
  await saveMessages(messages);
  return newMessage;
}

// ==================== FUNGSI MANAJEMEN KOMENTAR (LAMA) ====================
async function getComments() {
  const filePath = `${GITHUB_PATH}/comments.json`.replace(/\/+/g, '/');
  const { content } = await readGitHubFile(filePath);
  return content || [];
}

async function saveComments(comments) {
  const filePath = `${GITHUB_PATH}/comments.json`.replace(/\/+/g, '/');
  await writeGitHubFileWithRetry(filePath, comments);
}

async function addComment(commentData) {
  const comments = await getComments();
  const newId = comments.length > 0 ? Math.max(...comments.map(c => c.id)) + 1 : 1;
  const newComment = { id: newId, ...commentData, createdAt: new Date().toISOString() };
  comments.push(newComment);
  await saveComments(comments);
  return newComment;
}

// ==================== FUNGSI UPLOAD FOTO KE GITHUB (dengan penghapusan file lama) ====================
async function uploadAvatarToGitHub(userId, fileBuffer, fileName, mimeType, oldPhotoUrl) {
  if (!octokit) throw new Error('GitHub tidak tersedia');

  // Tentukan ekstensi dari file yang diupload
  const ext = path.extname(fileName) || '.jpg';
  const newFileName = `avatar_${userId}${ext}`;
  const filePath = `avatars/${newFileName}`;

  // Hapus file lama jika ada dan berbeda path
  if (oldPhotoUrl) {
    try {
      // Ekstrak path dari URL lama
      const urlParts = oldPhotoUrl.split('/');
      const oldFilePath = urlParts.slice(urlParts.indexOf('avatars')).join('/');
      if (oldFilePath !== filePath) {
        await deleteGitHubFile(oldFilePath);
      }
    } catch (error) {
      console.error('Gagal menghapus file lama:', error.message);
      // Tetap lanjutkan upload
    }
  }

  // Upload file baru
  try {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: `Upload avatar for user ${userId}`,
      content: fileBuffer.toString('base64'),
      branch: GITHUB_BRANCH,
    });
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${GITHUB_BRANCH}/${filePath}`;
    return rawUrl;
  } catch (error) {
    console.error('Gagal upload avatar ke GitHub:', error.message);
    throw error;
  }
}

// ==================== FUNGSI HELPER ====================
function getGravatarUrl(email, size = 200) {
  const hash = crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
}

async function fetchJson(url) {
  const res = await axios.get(url);
  return res.data;
}

async function getBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

function formatNumber(num) {
  if (!num) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

function isValidUrl(url) {
  return validator.isURL(url, { require_protocol: true, protocols: ['http', 'https'] });
}

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ==================== SERVICE: PINTEREST ====================
async function getPinterestCookies() {
  try {
    const response = await axios.get('https://www.pinterest.com/csrf_error/', { httpsAgent });
    const setCookieHeaders = response.headers['set-cookie'];
    if (setCookieHeaders) {
      const cookies = setCookieHeaders.map(c => c.split(';')[0].trim());
      return cookies.join('; ');
    }
    return null;
  } catch (error) {
    console.error('Gagal ambil cookie Pinterest:', error.message);
    return null;
  }
}

async function searchPinterest(query) {
  const cookies = await getPinterestCookies();
  if (!cookies) throw new Error('Tidak bisa mendapatkan cookies Pinterest');

  const url = 'https://www.pinterest.com/resource/BaseSearchResource/get/';
  const params = {
    source_url: `/search/pins/?q=${encodeURIComponent(query)}`,
    data: JSON.stringify({
      options: {
        isPrefetch: false,
        query,
        scope: 'pins',
        no_fetch_context_on_resource: false,
      },
      context: {},
    }),
    _: Date.now(),
  };

  const headers = {
    'accept': 'application/json, text/javascript, */*, q=0.01',
    'accept-encoding': 'gzip, deflate',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': cookies,
    'dnt': '1',
    'referer': 'https://www.pinterest.com/',
    'sec-ch-ua': '"Not(A:Brand";v="99", "Microsoft Edge";v="133", "Chromium";v="133"',
    'sec-ch-ua-full-version-list': '"Not(A:Brand";v="99.0.0.0", "Microsoft Edge";v="133.0.3065.92", "Chromium";v="133.0.6943.142"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"10.0.0"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0',
    'x-app-version': 'c056fb7',
    'x-pinterest-appstate': 'active',
    'x-pinterest-pws-handler': 'www/[username]/[slug].js',
    'x-pinterest-source-url': '/hargr003/cat-pictures/',
    'x-requested-with': 'XMLHttpRequest'
  };

  const { data } = await axios.get(url, { httpsAgent, headers, params });
  const results = data?.resource_response?.data?.results || [];
  return results
    .filter(v => v.images?.orig)
    .map(v => ({
      upload_by: v.pinner?.username || 'unknown',
      caption: v.grid_title || '',
      image: v.images.orig.url,
      source: `https://id.pinterest.com/pin/${v.id}`,
    }));
}

// ==================== SERVICE: WEBZIP ====================
async function saveWeb2Zip(url, options = {}) {
  if (!url) throw new Error('URL diperlukan');
  const targetUrl = url.startsWith('https://') ? url : `https://${url}`;
  const {
    renameAssets = false,
    saveStructure = false,
    alternativeAlgorithm = false,
    mobileVersion = false
  } = options;

  const response = await cloudscraper.post('https://copier.saveweb2zip.com/api/copySite', {
    json: {
      url: targetUrl,
      renameAssets,
      saveStructure,
      alternativeAlgorithm,
      mobileVersion
    },
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      origin: 'https://saveweb2zip.com',
      referer: 'https://saveweb2zip.com/'
    }
  });

  const { md5 } = response;

  const maxAttempts = 60;
  let attempts = 0;
  while (attempts < maxAttempts) {
    const process = await cloudscraper.get(`https://copier.saveweb2zip.com/api/getStatus/${md5}`, {
      json: true,
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://saveweb2zip.com',
        referer: 'https://saveweb2zip.com/'
      }
    });

    if (process.isFinished) {
      return {
        url: targetUrl,
        error: {
          text: process.errorText,
          code: process.errorCode,
        },
        copiedFilesAmount: process.copiedFilesAmount,
        downloadUrl: `https://copier.saveweb2zip.com/api/downloadArchive/${process.md5}`
      };
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  throw new Error('Timeout: proses webzip terlalu lama');
}

// ==================== SERVICE: TIKTOK ====================
async function fetchTikTok(url) {
  const response = await axios.post('https://www.tikwm.com/api/', {}, {
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': 'https://www.tikwm.com',
      'Referer': 'https://www.tikwm.com/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest'
    },
    params: { url, count: 12, cursor: 0, web: 1, hd: 1 }
  });
  return response.data.data;
}

// ==================== PASSPORT CONFIGURATION ====================
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await findUserById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const user = await findUserByEmail(email);
    if (!user) return done(null, false, { message: 'Email tidak terdaftar' });
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return done(null, false, { message: 'Password salah' });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

// ==================== INISIALISASI EXPRESS ====================
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { status: false, error: 'Terlalu banyak permintaan, coba lagi nanti.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// ==================== ROUTE AUTENTIKASI ====================
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/profile');
  const error = req.flash('error')[0];
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=0.65">
  <title>Login - ${SITE_NAME}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: 'Rajdhani', sans-serif; }
    body {
      background: radial-gradient(circle at 10% 20%, #1a2a48, #0a0c14);
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      color: #fff;
    }
    .login-box {
      background: rgba(15, 19, 32, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid #2a3a60;
      border-radius: 24px;
      padding: 40px;
      width: 400px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 20px #5b8cff33;
      text-align: center;
      animation: glow 3s infinite alternate;
    }
    @keyframes glow {
      0% { box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 20px #5b8cff33; }
      100% { box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 40px #5b8cff80; }
    }
    h2 {
      font-family: 'Orbitron', sans-serif;
      color: #5b8cff;
      margin-bottom: 10px;
      font-size: 28px;
      letter-spacing: 2px;
      text-shadow: 0 0 10px #5b8cff;
    }
    .sub {
      color: #8a9bb0;
      font-size: 12px;
      margin-bottom: 30px;
      border-bottom: 1px dashed #1f2a40;
      padding-bottom: 15px;
    }
    .input-group {
      margin-bottom: 20px;
      text-align: left;
    }
    label {
      display: block;
      margin-bottom: 5px;
      color: #8a9bb0;
      font-size: 14px;
    }
    input {
      width: 100%;
      padding: 12px;
      border-radius: 30px;
      border: 1px solid #1f2a40;
      background: #1a1f30;
      color: #fff;
      font-size: 14px;
      transition: 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #5b8cff;
      box-shadow: 0 0 10px #5b8cff;
    }
    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(45deg, #5b8cff, #3a6df0);
      border: none;
      border-radius: 30px;
      color: #000;
      font-weight: bold;
      cursor: pointer;
      margin: 10px 0;
      font-size: 16px;
      transition: 0.2s;
    }
    button:hover {
      transform: scale(1.02);
      box-shadow: 0 0 20px #5b8cff;
    }
    .error {
      background: #ff3b30;
      color: #fff;
      padding: 10px;
      border-radius: 30px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .link {
      color: #5b8cff;
      text-decoration: none;
      font-size: 14px;
    }
    .footer {
      color: #5f6b7a;
      font-size: 12px;
      border-top: 1px solid #1f2a40;
      padding-top: 20px;
      margin-top: 20px;
    }
    .footer span {
      color: #00ff88;
    }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
</head>
<body>
  <div class="login-box">
    <h2>🔐 ${SITE_NAME}</h2>
    <div class="sub">private access • encrypted session</div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form action="/login" method="POST">
      <div class="input-group">
        <label>EMAIL</label>
        <input type="email" name="email" placeholder="email@example.com" required>
      </div>
      <div class="input-group">
        <label>PASSWORD</label>
        <input type="password" name="password" placeholder="••••••••" required>
      </div>
      <button type="submit">LOGIN</button>
    </form>
    <p style="margin: 15px 0;">
      <a href="/register" class="link">Belum punya akun? Daftar</a>
    </p>
    <div class="footer">
      <span>AES-256</span> • status: ONLINE • PING 19ms
    </div>
  </div>
</body>
</html>`;
  res.send(html);
});

app.get('/register', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/profile');
  const error = req.flash('error')[0];
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=0.65">
  <title>Register - ${SITE_NAME}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: 'Rajdhani', sans-serif; }
    body {
      background: radial-gradient(circle at 10% 20%, #1a2a48, #0a0c14);
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      color: #fff;
    }
    .register-box {
      background: rgba(15, 19, 32, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid #2a3a60;
      border-radius: 24px;
      padding: 40px;
      width: 400px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 20px #5b8cff33;
      text-align: center;
      animation: glow 3s infinite alternate;
    }
    @keyframes glow {
      0% { box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 20px #5b8cff33; }
      100% { box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 40px #5b8cff80; }
    }
    h2 {
      font-family: 'Orbitron', sans-serif;
      color: #5b8cff;
      margin-bottom: 10px;
      font-size: 28px;
      letter-spacing: 2px;
      text-shadow: 0 0 10px #5b8cff;
    }
    .sub {
      color: #8a9bb0;
      font-size: 12px;
      margin-bottom: 30px;
      border-bottom: 1px dashed #1f2a40;
      padding-bottom: 15px;
    }
    .input-group {
      margin-bottom: 20px;
      text-align: left;
    }
    label {
      display: block;
      margin-bottom: 5px;
      color: #8a9bb0;
      font-size: 14px;
    }
    input {
      width: 100%;
      padding: 12px;
      border-radius: 30px;
      border: 1px solid #1f2a40;
      background: #1a1f30;
      color: #fff;
      font-size: 14px;
      transition: 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #5b8cff;
      box-shadow: 0 0 10px #5b8cff;
    }
    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(45deg, #5b8cff, #3a6df0);
      border: none;
      border-radius: 30px;
      color: #000;
      font-weight: bold;
      cursor: pointer;
      margin: 10px 0;
      font-size: 16px;
      transition: 0.2s;
    }
    button:hover {
      transform: scale(1.02);
      box-shadow: 0 0 20px #5b8cff;
    }
    .error {
      background: #ff3b30;
      color: #fff;
      padding: 10px;
      border-radius: 30px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .link {
      color: #5b8cff;
      text-decoration: none;
      font-size: 14px;
    }
    .footer {
      color: #5f6b7a;
      font-size: 12px;
      border-top: 1px solid #1f2a40;
      padding-top: 20px;
      margin-top: 20px;
    }
    .footer span {
      color: #00ff88;
    }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
</head>
<body>
  <div class="register-box">
    <h2>📝 ${SITE_NAME}</h2>
    <div class="sub">create new account</div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form action="/register" method="POST">
      <div class="input-group">
        <label>NAMA</label>
        <input type="text" name="name" placeholder="Nama lengkap" required>
      </div>
      <div class="input-group">
        <label>EMAIL</label>
        <input type="email" name="email" placeholder="email@example.com" required>
      </div>
      <div class="input-group">
        <label>PASSWORD</label>
        <input type="password" name="password" placeholder="Minimal 6 karakter" required>
      </div>
      <button type="submit">DAFTAR</button>
    </form>
    <p style="margin: 15px 0;">
      <a href="/login" class="link">Sudah punya akun? Login</a>
    </p>
    <div class="footer">
      <span>AES-256</span> • status: ONLINE • PING 19ms
    </div>
  </div>
</body>
</html>`;
  res.send(html);
});

app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    req.flash('error', 'Semua field harus diisi');
    return res.redirect('/register');
  }
  if (password.length < 6) {
    req.flash('error', 'Password minimal 6 karakter');
    return res.redirect('/register');
  }
  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      req.flash('error', 'Email sudah digunakan');
      return res.redirect('/register');
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await createUser({
      email,
      password: hashedPassword,
      name,
      bio: '',
      photo: '',
    });
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Terjadi kesalahan, coba lagi');
    res.redirect('/register');
  }
});

app.post('/login', passport.authenticate('local', {
  successRedirect: '/profile',
  failureRedirect: '/login',
  failureFlash: true
}));

app.get('/logout', (req, res) => {
  req.logout(err => {
    if (err) console.error(err);
    res.redirect('/');
  });
});

// ==================== ROUTE PROFIL ====================
app.get('/profile', isAuthenticated, (req, res) => {
  const user = req.user;
  const photoUrl = user.photo || getGravatarUrl(user.email, 200);
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=0.65">
  <title>Profil - ${SITE_NAME}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: 'Rajdhani', sans-serif; }
    body {
      background: radial-gradient(circle at 10% 20%, #1a2a48, #0a0c14);
      color: #fff;
      min-height: 100vh;
      padding: 20px;
    }
    .profile-container {
      max-width: 800px;
      margin: 0 auto;
      background: rgba(15, 19, 32, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid #2a3a60;
      border-radius: 24px;
      padding: 30px;
      position: relative;
      box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 20px #5b8cff33;
      animation: glow 3s infinite alternate;
    }
    @keyframes glow {
      0% { box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 20px #5b8cff33; }
      100% { box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 40px #5b8cff80; }
    }
    .menu-btn {
      position: absolute;
      top: 20px;
      right: 20px;
      background: transparent;
      border: none;
      color: #8a9bb0;
      font-size: 28px;
      cursor: pointer;
      transition: 0.2s;
      z-index: 10;
    }
    .menu-btn:hover {
      color: #fff;
      transform: scale(1.1);
    }
    .dropdown-content {
      display: none;
      position: absolute;
      top: 60px;
      right: 20px;
      background: #0f1320;
      border: 1px solid #2a3a60;
      border-radius: 12px;
      min-width: 160px;
      box-shadow: 0 8px 16px rgba(0,0,0,0.7);
      z-index: 100;
      overflow: hidden;
    }
    .dropdown-content a, .dropdown-content button {
      color: #fff;
      padding: 12px 16px;
      text-decoration: none;
      display: block;
      background: none;
      border: none;
      width: 100%;
      text-align: left;
      font-size: 14px;
      cursor: pointer;
      transition: 0.2s;
    }
    .dropdown-content a:hover, .dropdown-content button:hover {
      background: #1a1f30;
      color: #5b8cff;
    }
    .show {
      display: block;
    }
    .avatar-section {
      text-align: center;
      margin-bottom: 20px;
    }
    .avatar {
      width: 150px;
      height: 150px;
      border-radius: 50%;
      border: 4px solid #5b8cff;
      box-shadow: 0 0 30px #5b8cff;
      object-fit: cover;
    }
    .user-name {
      font-size: 28px;
      font-family: 'Orbitron', sans-serif;
      color: #5b8cff;
      text-align: center;
      margin: 10px 0 5px;
    }
    .user-bio {
      font-size: 16px;
      color: #ccc;
      text-align: center;
      margin-bottom: 30px;
      max-width: 500px;
      margin-left: auto;
      margin-right: auto;
      word-wrap: break-word;
    }
    .edit-form {
      display: none;
      margin-top: 30px;
      border-top: 1px solid #1f2a40;
      padding-top: 20px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 5px;
      color: #8a9bb0;
      font-size: 14px;
    }
    input, textarea {
      width: 100%;
      padding: 12px 20px;
      border-radius: 30px;
      border: 1px solid #1f2a40;
      background: #1a1f30;
      color: #fff;
      font-size: 14px;
      transition: 0.2s;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: #5b8cff;
      box-shadow: 0 0 10px #5b8cff;
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    button {
      background: linear-gradient(45deg, #5b8cff, #3a6df0);
      color: #000;
      border: none;
      padding: 12px 30px;
      border-radius: 30px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      transition: 0.2s;
    }
    button:hover {
      transform: scale(1.02);
      box-shadow: 0 0 20px #5b8cff;
    }
    .join-group {
      text-align: center;
      margin-top: 30px;
    }
    .join-group a {
      display: inline-block;
      background: linear-gradient(45deg, #5b8cff, #3a6df0);
      color: #000;
      padding: 15px 40px;
      border-radius: 50px;
      font-size: 18px;
      font-weight: bold;
      text-decoration: none;
      transition: 0.2s;
    }
    .join-group a:hover {
      transform: scale(1.05);
      box-shadow: 0 0 20px #5b8cff;
    }
    .footer {
      text-align: center;
      margin-top: 40px;
      color: #5f6b7a;
      font-size: 12px;
    }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
</head>
<body>
  <div class="profile-container">
    <button class="menu-btn" id="menuBtn">☰</button>
    <div class="dropdown-content" id="dropdown">
      <a href="/"><i class="fas fa-home"></i> Beranda</a>
      <a href="#" id="editProfileBtn"><i class="fas fa-edit"></i> Edit Profil</a>
      <a href="/logout"><i class="fas fa-sign-out-alt"></i> Keluar Akun</a>
    </div>

    <div class="avatar-section">
      <img src="${photoUrl}" class="avatar" id="avatarPreview" alt="Foto Profil">
    </div>
    <div class="user-name" id="displayName">${user.name}</div>
    <div class="user-bio" id="displayBio">${user.bio || 'Belum ada bio.'}</div>

    <!-- Form Edit (hidden by default) -->
    <div class="edit-form" id="editForm">
      <h3 style="font-family:'Orbitron'; color:#5b8cff; margin-bottom:20px;">Edit Profil</h3>
      <form id="profileEditForm" enctype="multipart/form-data">
        <div class="form-group">
          <label>Nama</label>
          <input type="text" name="name" id="editName" value="${user.name}" required>
        </div>
        <div class="form-group">
          <label>Bio</label>
          <textarea name="bio" id="editBio">${user.bio || ''}</textarea>
        </div>
        <div class="form-group">
          <label>Foto Profil</label>
          <input type="file" name="photo" id="editPhoto" accept="image/*">
        </div>
        <button type="submit">Simpan Perubahan</button>
      </form>
    </div>

    <!-- Tombol Join Grup -->
    <div class="join-group">
      <a href="/chat"><i class="fas fa-comments"></i> Join Grup Diskusi</a>
    </div>

    <div class="footer">
      <span>${SITE_NAME} v${VERSION}</span> • ${DEVELOPER}
    </div>
  </div>

  <script>
    // Dropdown menu
    const menuBtn = document.getElementById('menuBtn');
    const dropdown = document.getElementById('dropdown');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('show');
    });
    window.addEventListener('click', () => {
      dropdown.classList.remove('show');
    });

    // Toggle edit form
    document.getElementById('editProfileBtn').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('editForm').style.display = 'block';
      dropdown.classList.remove('show');
    });

    // Handle edit form submission with photo upload
    document.getElementById('profileEditForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData();
      formData.append('name', document.getElementById('editName').value);
      formData.append('bio', document.getElementById('editBio').value);
      const photoFile = document.getElementById('editPhoto').files[0];
      if (photoFile) {
        formData.append('photo', photoFile);
      }

      const res = await fetch('/profile', {
        method: 'POST',
        body: formData
      });
      const result = await res.json();
      if (result.success) {
        alert('Profil berhasil diperbarui!');
        location.reload(); // refresh untuk menampilkan data baru
      } else {
        alert('Gagal: ' + result.error);
      }
    });
  </script>
</body>
</html>`;
  res.send(html);
});

// Endpoint untuk update profil (dengan upload foto)
app.post('/profile', isAuthenticated, upload.single('photo'), async (req, res) => {
  const { name, bio } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nama tidak boleh kosong' });
  }

  let photoUrl = req.user.photo; // tetap pakai yang lama jika tidak ada upload
  if (req.file) {
    try {
      // Upload foto baru, hapus yang lama
      photoUrl = await uploadAvatarToGitHub(req.user.id, req.file.buffer, req.file.originalname, req.file.mimetype, req.user.photo);
    } catch (err) {
      return res.status(500).json({ error: 'Gagal upload foto: ' + err.message });
    }
  }

  try {
    const updatedUser = await updateUser(req.user.id, { name, bio, photo: photoUrl });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal menyimpan profil' });
  }
});

// ==================== ROUTE CHAT (MODERN, WHATSAPP-LIKE) ====================
app.get('/chat', isAuthenticated, (req, res) => {
  const user = req.user;
  const photoUrl = user.photo || getGravatarUrl(user.email, 40);
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <!-- Viewport yang optimal untuk fullscreen -->
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Chat Grup - ${SITE_NAME}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      font-family: 'Rajdhani', sans-serif;
    }
    
    html {
      /* Mencegah scrolling yang menyebabkan URL bar muncul */
      overflow: hidden;
      height: 100%;
    }
    
    body {
      background: #0a0c14;
      color: #fff;
      height: 100dvh; /* Menggunakan dvh untuk menyesuaikan dengan dynamic viewport */
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: fixed; /* Membantu menjaga fullscreen */
      width: 100%;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    }
    
    /* Glassmorphism header */
    .chat-header {
      background: rgba(15, 19, 32, 0.8);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(42, 58, 96, 0.3);
      padding: 15px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 10;
      flex-shrink: 0;
    }
    
    .chat-header h2 {
      font-family: 'Orbitron';
      color: #5b8cff;
      font-size: 24px;
      text-shadow: 0 0 10px rgba(91, 140, 255, 0.3);
    }
    
    .chat-header a {
      color: #8a9bb0;
      text-decoration: none;
      font-size: 14px;
      transition: 0.2s;
      padding: 8px 15px;
      border-radius: 30px;
      background: rgba(26, 31, 48, 0.5);
      backdrop-filter: blur(4px);
    }
    
    .chat-header a:hover {
      color: #5b8cff;
      background: rgba(91, 140, 255, 0.1);
    }
    
    /* Messages container dengan scroll internal */
    .messages-container {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch; /* Smooth scroll di iOS */
      padding: 20px 20px 15px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
      background: radial-gradient(circle at 10% 20%, rgba(26, 42, 72, 0.3), #0a0c14);
    }
    
    /* Message item dengan swipe detection */
    .message {
      display: flex;
      gap: 10px;
      max-width: 80%;
      position: relative;
      transition: transform 0.2s ease;
      will-change: transform;
      user-select: none;
      -webkit-user-select: none;
    }
    
    .message.own {
      align-self: flex-end;
      flex-direction: row-reverse;
    }
    
    /* Avatar dengan efek glow */
    .message-avatar {
      flex-shrink: 0;
    }
    
    .message-avatar img {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 2px solid #5b8cff;
      object-fit: cover;
      box-shadow: 0 0 15px rgba(91, 140, 255, 0.3);
      transition: 0.2s;
    }
    
    .message-avatar img:hover {
      transform: scale(1.05);
      box-shadow: 0 0 20px rgba(91, 140, 255, 0.6);
    }
    
    /* Bubble transparan dengan efek glassmorphism */
    .message-content {
      background: rgba(26, 31, 48, 0.4);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(91, 140, 255, 0.2);
      border-radius: 18px;
      padding: 10px 14px;
      position: relative;
      word-wrap: break-word;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
      transition: 0.2s;
    }
    
    /* Bubble milik sendiri dengan warna berbeda */
    .message.own .message-content {
      background: rgba(91, 140, 255, 0.2);
      backdrop-filter: blur(8px);
      border-color: rgba(91, 140, 255, 0.4);
    }
    
    /* Nama pengirim */
    .message-author {
      font-weight: bold;
      color: #5b8cff;
      font-size: 13px;
      margin-bottom: 4px;
      display: block;
    }
    
    .message.own .message-author {
      color: #aaccff;
      text-align: right;
    }
    
    /* Konten pesan */
    .message-text {
      font-size: 15px;
      line-height: 1.4;
      color: #fff;
      margin-bottom: 6px;
    }
    
    /* Waktu di bawah teks (seperti WhatsApp) */
    .message-time {
      font-size: 11px;
      color: rgba(138, 155, 176, 0.8);
      display: block;
      text-align: right;
      margin-top: 2px;
    }
    
    .message.own .message-time {
      color: rgba(170, 204, 255, 0.8);
    }
    
    /* Reply quote */
    .message-reply {
      background: rgba(15, 19, 32, 0.6);
      backdrop-filter: blur(4px);
      border-left: 3px solid #5b8cff;
      padding: 6px 10px;
      margin-bottom: 8px;
      border-radius: 12px;
      font-size: 12px;
      color: #ccc;
    }
    
    .message-reply strong {
      color: #5b8cff;
    }
    
    /* Reply indicator */
    .reply-indicator {
      background: rgba(15, 19, 32, 0.8);
      backdrop-filter: blur(12px);
      border-top: 1px solid rgba(42, 58, 96, 0.3);
      padding: 12px 20px;
      display: none;
      align-items: center;
      justify-content: space-between;
      z-index: 10;
      flex-shrink: 0;
    }
    
    .reply-indicator span {
      color: #8a9bb0;
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 70%;
    }
    
    .reply-indicator button {
      background: transparent;
      border: 1px solid #5b8cff;
      color: #5b8cff;
      padding: 6px 16px;
      border-radius: 30px;
      cursor: pointer;
      font-weight: bold;
      transition: 0.2s;
    }
    
    .reply-indicator button:hover {
      background: #5b8cff;
      color: #000;
    }
    
    /* Input area glassmorphism */
    .input-area {
      background: rgba(15, 19, 32, 0.8);
      backdrop-filter: blur(12px);
      border-top: 1px solid rgba(42, 58, 96, 0.3);
      padding: 15px 20px;
      display: flex;
      gap: 10px;
      z-index: 10;
      flex-shrink: 0;
    }
    
    .input-area input {
      flex: 1;
      padding: 14px 20px;
      border-radius: 40px;
      border: 1px solid rgba(42, 58, 96, 0.5);
      background: rgba(26, 31, 48, 0.6);
      backdrop-filter: blur(4px);
      color: #fff;
      font-size: 15px;
      transition: 0.2s;
    }
    
    .input-area input:focus {
      outline: none;
      border-color: #5b8cff;
      box-shadow: 0 0 15px rgba(91, 140, 255, 0.3);
    }
    
    .input-area input::placeholder {
      color: #8a9bb0;
      opacity: 0.7;
    }
    
    .input-area button {
      background: linear-gradient(45deg, #5b8cff, #3a6df0);
      border: none;
      color: #000;
      font-weight: bold;
      padding: 14px 30px;
      border-radius: 40px;
      cursor: pointer;
      transition: 0.2s;
      box-shadow: 0 4px 15px rgba(91, 140, 255, 0.3);
    }
    
    .input-area button:hover {
      transform: scale(1.02);
      box-shadow: 0 6px 20px rgba(91, 140, 255, 0.5);
    }
    
    /* Footer - lebih tinggi dan jelas */
    .footer {
      text-align: center;
      padding: 12px 20px;
      border-top: 1px solid #1f2a40;
      color: #8a9bb0;
      font-size: 14px;
      line-height: 1.5;
      background: rgba(15, 19, 32, 0.8);
      backdrop-filter: blur(12px);
      z-index: 10;
      flex-shrink: 0;
    }
    
    .footer span {
      color: #00ff88;
    }
    
    /* Scrollbar kustom */
    .messages-container::-webkit-scrollbar {
      width: 6px;
    }
    
    .messages-container::-webkit-scrollbar-track {
      background: rgba(15, 19, 32, 0.5);
    }
    
    .messages-container::-webkit-scrollbar-thumb {
      background: #5b8cff;
      border-radius: 10px;
    }
    
    /* Smooth transitions */
    * {
      -webkit-tap-highlight-color: transparent;
    }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
</head>
<body>
  <div class="chat-header">
    <h2><i class="fas fa-comments"></i> Chat Grup</h2>
    <a href="/"><i class="fas fa-home"></i> Beranda</a>
  </div>
  
  <div class="messages-container" id="messagesContainer"></div>
  
  <div class="reply-indicator" id="replyIndicator">
    <span id="replyText"></span>
    <button onclick="cancelReply()"><i class="fas fa-times"></i> Batal</button>
  </div>
  
  <div class="input-area">
    <input type="text" id="messageInput" placeholder="Tulis pesan...">
    <button onclick="sendMessage()"><i class="fas fa-paper-plane"></i></button>
  </div>

  <script>
    let currentUser = { id: ${user.id}, name: '${user.name}', photo: '${photoUrl}' };
    let replyTo = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let swipedMessageId = null;

    // Fungsi untuk memaksa fullscreen dan menjaga layout tetap stabil
    function initFullscreen() {
      // Coba minta fullscreen saat halaman dimuat
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      }
      
      // Gunakan visualViewport API untuk mendapatkan ukuran sebenarnya
      if (window.visualViewport) {
        const setViewportHeight = () => {
          const vh = window.visualViewport.height * 0.01;
          document.documentElement.style.setProperty('--vh', \`\${vh}px\`);
        };
        
        window.visualViewport.addEventListener('resize', setViewportHeight);
        setViewportHeight();
      }
    }

    function handleTouchStart(e) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      swipedMessageId = e.currentTarget.dataset.messageId;
    }

    function handleTouchMove(e) {
      if (!touchStartX) return;
      
      const touchEndX = e.touches[0].clientX;
      const touchEndY = e.touches[0].clientY;
      const diffX = touchStartX - touchEndX;
      const diffY = Math.abs(touchStartY - touchEndY);
      
      if (diffX > 50 && diffY < 50) {
        e.preventDefault();
        const messageDiv = e.currentTarget;
        const messageContent = messageDiv.querySelector('.message-text')?.innerText || '';
        const messageId = messageDiv.dataset.messageId;
        
        setReply(messageId, messageContent);
        
        touchStartX = 0;
      }
    }

    function handleTouchEnd() {
      touchStartX = 0;
    }

    async function loadMessages() {
      try {
        const res = await fetch('/api/messages');
        const messages = await res.json();
        const container = document.getElementById('messagesContainer');
        container.innerHTML = '';
        
        messages.forEach(msg => {
          const msgDiv = document.createElement('div');
          msgDiv.className = 'message' + (msg.userId === currentUser.id ? ' own' : '');
          msgDiv.dataset.messageId = msg.id;
          
          msgDiv.addEventListener('touchstart', handleTouchStart, { passive: false });
          msgDiv.addEventListener('touchmove', handleTouchMove, { passive: false });
          msgDiv.addEventListener('touchend', handleTouchEnd);
          
          const time = new Date(msg.createdAt).toLocaleTimeString('id-ID', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false 
          });
          
          let replyHtml = '';
          if (msg.parentId && msg.replyContent) {
            replyHtml = \`<div class="message-reply"><i class="fas fa-reply"></i> <strong>Membalas:</strong> \${msg.replyContent}</div>\`;
          }
          
          msgDiv.innerHTML = \`
            <div class="message-avatar">
              <img src="\${msg.userPhoto || 'https://www.gravatar.com/avatar/?d=identicon'}" 
                   onerror="this.src='https://www.gravatar.com/avatar/?d=identicon'">
            </div>
            <div class="message-content">
              \${replyHtml}
              <span class="message-author">\${msg.userName}</span>
              <div class="message-text">\${msg.content}</div>
              <span class="message-time">\${time}</span>
            </div>
          \`;
          
          container.appendChild(msgDiv);
        });
        
        container.scrollTop = container.scrollHeight;
      } catch (err) {
        console.error('Gagal memuat pesan:', err);
      }
    }

    function setReply(id, content) {
      replyTo = id;
      document.getElementById('replyIndicator').style.display = 'flex';
      
      const displayText = content.length > 50 ? content.substring(0, 50) + '…' : content;
      document.getElementById('replyText').innerHTML = \`<i class="fas fa-reply"></i> Membalas: \${displayText}\`;
      
      document.getElementById('messageInput').focus();
    }

    function cancelReply() {
      replyTo = null;
      document.getElementById('replyIndicator').style.display = 'none';
    }

    async function sendMessage() {
      const input = document.getElementById('messageInput');
      const content = input.value.trim();
      if (!content) return;
      
      try {
        await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, parentId: replyTo })
        });
        
        input.value = '';
        cancelReply();
        loadMessages();
      } catch (err) {
        alert('Gagal mengirim pesan: ' + err.message);
      }
    }

    document.getElementById('messageInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });

    // Inisialisasi fullscreen dan muat pesan
    initFullscreen();
    loadMessages();
    setInterval(loadMessages, 3000);
  </script>
</body>
</html>`;
  res.send(html);
});

// ==================== API MESSAGES (DIPERBAIKI) ====================
app.get('/api/messages', isAuthenticated, async (req, res) => {
  try {
    const messages = await getMessages();
    const users = await getUsers();
    const enriched = messages.map(m => {
      const user = users.find(u => u.id === m.userId);
      let replyContent = null;
      if (m.parentId) {
        // Konversi parentId ke number untuk perbandingan yang aman
        const parent = messages.find(p => p.id === Number(m.parentId));
        replyContent = parent ? parent.content : '[pesan telah dihapus]';
      }
      return {
        ...m,
        userName: user ? user.name : 'Unknown',
        userPhoto: user ? (user.photo || getGravatarUrl(user.email, 40)) : getGravatarUrl('', 40),
        replyContent
      };
    }).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal memuat pesan' });
  }
});

// POST /api/messages
app.post('/api/messages', isAuthenticated, async (req, res) => {
  const { content, parentId } = req.body;
  if (!content || content.trim() === '') {
    return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
  }
  
  // Konversi parentId ke number jika ada
  let parentIdNum = null;
  if (parentId) {
    parentIdNum = parseInt(parentId, 10);
    if (isNaN(parentIdNum)) {
      return res.status(400).json({ error: 'parentId tidak valid' });
    }
  }
  
  try {
    const newMessage = await addMessage({
      userId: req.user.id,
      content: content.trim(),
      parentId: parentIdNum
    });
    res.json({ success: true, message: newMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mengirim pesan' });
  }
});

// ==================== API KOMENTAR (LAMA) ====================
app.get('/api/comments', isAuthenticated, async (req, res) => {
  try {
    const comments = await getComments();
    const users = await getUsers();
    const commentsWithUser = comments.map(c => {
      const user = users.find(u => u.id === c.userId);
      return {
        ...c,
        name: user ? user.name : 'Unknown',
        email: user ? user.email : '',
        photo: user ? user.photo : '',
        gravatar: user ? (user.photo || getGravatarUrl(user.email, 40)) : getGravatarUrl('', 40)
      };
    });
    res.json(commentsWithUser);
  } catch (err) {
    console.error('Gagal memuat komentar:', err);
    res.status(500).json({ error: 'Gagal memuat komentar' });
  }
});

app.post('/api/comments', isAuthenticated, async (req, res) => {
  const { comment } = req.body;
  if (!comment || comment.trim() === '') {
    return res.status(400).json({ error: 'Komentar tidak boleh kosong' });
  }
  try {
    const newComment = await addComment({
      userId: req.user.id,
      comment: comment.trim(),
    });
    res.json({ success: true, comment: newComment });
  } catch (err) {
    console.error('Gagal mengirim komentar:', err);
    res.status(500).json({ error: 'Gagal mengirim komentar: ' + err.message });
  }
});

// ==================== HAPUS AKUN ====================
app.post('/delete-account', isAuthenticated, async (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Konfirmasi tidak valid' });
  }
  try {
    const users = await getUsers();
    const filtered = users.filter(u => u.id !== req.user.id);
    await saveUsers(filtered);
    req.logout(err => {
      if (err) console.error(err);
      res.json({ success: true });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal menghapus akun' });
  }
});

// ==================== ROUTE API ====================
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: VERSION, developer: DEVELOPER, uptime: process.uptime(), timestamp: Date.now() });
});

app.get('/pinterest', async (req, res) => {
  const { q } = req.query;
  if (!q || typeof q !== 'string') return res.status(400).json({ status: false, error: 'Parameter q diperlukan.' });
  try {
    const results = await searchPinterest(q);
    res.json({ status: true, result: results });
  } catch (error) {
    console.error('Pinterest error:', error.message);
    res.status(500).json({ status: false, error: 'Gagal mengambil data dari Pinterest.' });
  }
});

app.get('/waifu', async (req, res) => {
  try {
    const data = await fetchJson('https://api.waifu.pics/sfw/waifu');
    const buffer = await getBuffer(data.url);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length });
    res.end(buffer);
  } catch (error) {
    console.error('Waifu error:', error.message);
    res.status(500).send('Error mengambil gambar waifu.');
  }
});

app.get('/nsfw', async (req, res) => {
  try {
    const randomType = NSFW_TYPES[Math.floor(Math.random() * NSFW_TYPES.length)];
    const data = await fetchJson(`https://api.waifu.pics/nsfw/${randomType}`);
    const buffer = await getBuffer(data.url);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length });
    res.end(buffer);
  } catch (error) {
    console.error('NSFW error:', error.message);
    res.status(500).send('Error mengambil gambar NSFW.');
  }
});

app.get('/webzip', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: false, error: 'Parameter ?url= wajib diisi.' });
  if (!isValidUrl(url)) return res.status(400).json({ status: false, error: 'URL tidak valid.' });
  try {
    const result = await saveWeb2Zip(url, { renameAssets: true });
    if (result.error?.code) return res.status(500).json({ status: false, error: result.error.text || 'Gagal menyimpan website.' });
    res.json({ status: true, originalUrl: result.url, copiedFilesAmount: result.copiedFilesAmount, downloadUrl: result.downloadUrl });
  } catch (error) {
    console.error('Webzip error:', error.message);
    res.status(500).json({ status: false, error: error.message });
  }
});

app.get('/tiktok', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('tiktok.com')) return res.status(400).json({ status: false, error: 'URL TikTok tidak valid.' });
  if (!isValidUrl(url)) return res.status(400).json({ status: false, error: 'URL tidak valid.' });
  try {
    const data = await fetchTikTok(url);
    if (!data) return res.status(404).json({ status: false, error: 'Video tidak ditemukan.' });
    res.json({
      status: true,
      result: {
        video: data.play ? 'https://www.tikwm.com' + data.play : null,
        audio: data.music ? 'https://www.tikwm.com' + data.music : (data.music_info?.play ? 'https://www.tikwm.com' + data.music_info.play : null),
        title: data.title || 'Tidak ada judul',
        author: data.author?.nickname || 'Unknown',
        author_username: data.author?.unique_id || '',
        duration: formatDuration(data.duration),
        duration_seconds: data.duration || 0,
        play_count: formatNumber(data.play_count),
        like_count: formatNumber(data.digg_count),
        comment_count: formatNumber(data.comment_count),
        share_count: formatNumber(data.share_count),
        download_count: formatNumber(data.download_count)
      }
    });
  } catch (error) {
    console.error('TikTok error:', error.message);
    res.status(500).json({ status: false, error: 'Gagal memproses permintaan TikTok.' });
  }
});

app.get('/brat', async (req, res) => {
  const { text } = req.query;
  if (!text || typeof text !== 'string') return res.status(400).json({ status: false, message: 'Parameter text diperlukan.' });
  try {
    const apiUrl = `https://api.siputzx.my.id/api/m/brat?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    console.error('Brat error:', error.message);
    res.status(500).json({ status: false, message: 'Gagal mengambil gambar brat.' });
  }
});

app.get('/bratvid', async (req, res) => {
  const { text } = req.query;
  if (!text || typeof text !== 'string') return res.status(400).json({ status: false, message: 'Parameter text diperlukan.' });
  try {
    const apiUrl = `https://zelapioffciall.koyeb.app/canvas/bratvid?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    console.error('Bratvid error:', error.message);
    res.status(500).json({ status: false, message: 'Gagal mengambil gambar bratvid.' });
  }
});

// ==================== HALAMAN UTAMA ====================
app.get('/', (req, res) => {
  const user = req.user;
  const gravatar = user ? (user.photo || getGravatarUrl(user.email, 40)) : '';

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=0.60" />
<title>${SITE_NAME}</title>
<!-- Favicon dihapus karena error, hanya menggunakan teks info -->
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}">
<meta property="og:title" content="${SITE_NAME}">
<meta property="og:description" content="API untuk bot WhatsApp Novabot">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600&family=Orbitron:wght@500;700&family=VT323&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body {
  font-family: 'Rajdhani', sans-serif;
  background: #0a0c14;
  color: #fff;
  min-height: 100vh;
  padding-bottom: 40px;
  position: relative;
  overflow-x: hidden;
}
/* HEADER */
.custom-header {
  position: sticky; top: 0; width: 100%; height: 55px;
  background: rgba(10, 12, 20, 0.95); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px; z-index: 100; border-bottom: 1px solid #1f2a40;
}
.header-title {
  font-family: 'Orbitron'; font-size: 20px; color: #5b8cff; letter-spacing: 1px;
  text-decoration: none;
}
.header-title:hover {
  text-decoration: underline;
}
.menu-btn {
  width: 40px; height: 40px; display: flex; flex-direction: column;
  justify-content: center; align-items: center; gap: 5px; cursor: pointer;
  border-radius: 8px; transition: 0.2s;
}
.menu-btn:hover { background: #1f2a40; }
.menu-btn span {
  width: 22px; height: 2px; background: #fff; border-radius: 2px;
  transition: 0.3s;
}
.menu-btn.active span:nth-child(1) { transform: rotate(45deg) translate(6px, 6px); }
.menu-btn.active span:nth-child(2) { opacity: 0; }
.menu-btn.active span:nth-child(3) { transform: rotate(-45deg) translate(6px, -6px); }

/* DROPDOWN */
.user-dropdown {
  position: relative;
  display: inline-block;
}
.user-dropdown-content {
  display: none;
  position: absolute;
  right: 0;
  background: #0f1320;
  border: 1px solid #2a3a60;
  border-radius: 12px;
  min-width: 160px;
  box-shadow: 0 8px 16px rgba(0,0,0,0.7);
  z-index: 101;
  overflow: hidden;
}
.user-dropdown-content a, .user-dropdown-content button {
  color: #fff;
  padding: 12px 16px;
  text-decoration: none;
  display: block;
  background: none;
  border: none;
  width: 100%;
  text-align: left;
  font-size: 14px;
  cursor: pointer;
  transition: 0.2s;
}
.user-dropdown-content a:hover, .user-dropdown-content button:hover {
  background: #1a1f30;
  color: #5b8cff;
}
.user-dropdown:hover .user-dropdown-content {
  display: block;
}
.user-avatar {
  width: 35px;
  height: 35px;
  border-radius: 50%;
  border: 2px solid #5b8cff;
  cursor: pointer;
  transition: 0.2s;
}
.user-avatar:hover {
  transform: scale(1.05);
  box-shadow: 0 0 15px #5b8cff;
}

/* STATUS PANEL (SLIDE DOWN) */
.status-panel {
  position: fixed;
  top: -100%;
  left: 0;
  width: 100%;
  background: #0f1320;
  border-bottom: 2px solid #2a3a60;
  box-shadow: 0 10px 20px rgba(0,0,0,0.7);
  z-index: 99;
  transition: top 0.4s ease;
  padding: 70px 20px 20px 20px;
  backdrop-filter: blur(8px);
}
.status-panel.show { top: 0; }
.status-panel h3 {
  font-family: 'Orbitron';
  color: #5b8cff;
  margin-bottom: 20px;
  font-size: 24px;
  text-align: center;
}

/* METRIC CARDS */
.metric-row {
  margin-bottom: 20px;
  background: #0b0e18;
  border-radius: 12px;
  padding: 15px;
  border: 1px solid #1f2a40;
}
.metric-header {
  display: flex;
  justify-content: space-between;
  color: #8a9bb0;
  font-size: 16px;
  margin-bottom: 10px;
}
.wave-container {
  position: relative;
  width: 100%;
  height: 60px;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}
.wave-svg {
  position: absolute;
  width: 200%;
  height: 100%;
  animation: waveMove linear infinite;
}
.cpu-wave { animation-duration: 7s; }
.cpu-wave:nth-child(2) { animation-duration: 9s; }
.cpu-wave:nth-child(3) { animation-duration: 11s; }
.mem-wave { animation-duration: 6s; }
.mem-wave:nth-child(2) { animation-duration: 8s; }
.mem-wave:nth-child(3) { animation-duration: 10s; }
.net-wave { animation-duration: 5s; }
.net-wave:nth-child(2) { animation-duration: 7s; }
.net-wave:nth-child(3) { animation-duration: 9s; }
@keyframes waveMove {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
  margin-top: 25px;
}
.status-item {
  background: #1a1f30;
  border-radius: 8px;
  padding: 12px;
  border-left: 3px solid #3a6df0;
}
.status-item .label { color: #8a9bb0; font-size: 12px; text-transform: uppercase; }
.status-item .value { color: #fff; font-size: 18px; font-weight: bold; font-family: 'VT323'; }

/* PAGE CONTAINER */
.page-container { padding: 20px; transition: filter 0.3s; }
.page-container.blur { filter: blur(3px); pointer-events: none; }

/* HEADER CARD */
.lux-header-card {
  background: linear-gradient(135deg, #1a2a48, #14233c);
  border-radius: 16px; padding: 20px; margin-bottom: 25px;
  border: 1px solid #2a3a60;
}
.lux-header-card h2 { font-family: 'Orbitron'; font-size: 20px; color: #5b8cff; }
.lux-header-card p { font-size: 14px; color: #a0b0c0; }

/* SECTION TITLE */
.lux-section-title {
  font-family: 'Orbitron'; font-size: 16px; color: #fff; margin-bottom: 15px;
  padding-left: 8px; border-left: 4px solid #5b8cff;
}

/* SLIDER */
.slider-container {
  width: 100%; background: #101520; border-radius: 12px; overflow: hidden;
  border: 1px solid #1f2a40; margin-bottom: 25px; height: 150px;
  touch-action: pan-y; cursor: grab; user-select: none;
}
.slider-track { display: flex; width: 200%; height: 100%; transition: transform 0.4s; }
.slide { width: 50%; height: 100%; position: relative; flex-shrink: 0; }
.slide video { width: 100%; height: 100%; object-fit: cover; display: block; }
.slide-content {
  position: absolute; bottom: 0; left: 0; width: 100%; padding: 15px;
  background: linear-gradient(to top, rgba(0,0,0,0.9), transparent);
}
.slide-content h3 { font-family: 'Orbitron'; font-size: 14px; color: #fff; }
.slide-content p { font-size: 12px; color: #ccc; }

/* API ENDPOINT CARDS */
.api-card { margin-bottom: 20px; }
.api-endpoint {
  background: #101520;
  border: 1px solid #1f2a40;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 15px;
  transition: 0.2s;
}
.api-endpoint:hover { border-color: #5b8cff; }
.api-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.method {
  background: #1f2a40;
  color: #ffcc00;
  font-weight: bold;
  padding: 2px 10px;
  border-radius: 30px;
  font-size: 12px;
  border: 1px solid #ffcc00;
}
.url {
  color: #00ff88;
  word-break: break-all;
  font-family: 'VT323';
  font-size: 14px;
  background: #1a1f30;
  padding: 2px 10px;
  border-radius: 30px;
  flex: 1;
}
.copy-btn {
  background: transparent;
  border: 1px solid #5b8cff;
  color: #5b8cff;
  padding: 4px 12px;
  border-radius: 30px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: 0.2s;
}
.copy-btn:hover {
  background: #5b8cff;
  color: #000;
}
.api-desc {
  color: #a0b0c0;
  font-size: 13px;
  margin-bottom: 12px;
}

/* TOMBOL START */
.start-btn {
  background: #5b8cff;
  color: #000;
  border: none;
  padding: 6px 16px;
  border-radius: 30px;
  font-size: 13px;
  font-weight: bold;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: 0.2s;
}
.start-btn:hover {
  filter: brightness(1.1);
  transform: scale(1.02);
}

/* INPUT GROUP */
.input-group {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 10px 0;
  flex-wrap: wrap;
}
.input-group input {
  flex: 1;
  padding: 8px 14px;
  border-radius: 30px;
  border: 1px solid #1f2a40;
  background: #1a1f30;
  color: #fff;
  font-size: 13px;
}
.input-group input:focus {
  outline: none;
  border-color: #5b8cff;
}

/* RESPONSE CONTAINER */
.response-container {
  margin-top: 15px;
  padding: 12px;
  background: #1a1f30;
  border-radius: 8px;
  border-left: 4px solid #5b8cff;
  display: none;
  max-height: 500px;
  overflow: auto;
}
.response-container.show { display: block; }
.response-container.success { border-left-color: #00ff88; }
.response-container.error { border-left-color: #ff3b30; }
.response-container img {
  max-width: 100%;
  max-height: 300px;
  width: auto;
  height: auto;
  display: block;
  margin: 0 auto;
  object-fit: contain;
  border-radius: 8px;
  border: 2px solid #2a3a60;
}
.response-container video {
  max-width: 100%;
  max-height: 300px;
  border-radius: 8px;
  display: block;
  margin: 10px auto;
}
.response-container pre {
  white-space: pre-wrap;
  font-family: 'VT323';
  font-size: 12px;
  color: #ccc;
  margin-top: 10px;
}
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 30px;
  font-weight: bold;
  font-size: 11px;
  margin-bottom: 8px;
}
.badge.success { background: #00ff88; color: #000; }
.badge.error { background: #ff3b30; color: #fff; }

/* COPY JSON BUTTON */
.copy-json-btn {
  background: #2a3a60;
  color: #fff;
  border: none;
  padding: 4px 10px;
  border-radius: 30px;
  font-size: 11px;
  cursor: pointer;
  margin-left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.copy-json-btn:hover { background: #3a4a70; }

/* DOWNLOAD BUTTON */
.download-btn {
  background: #3a6df0;
  color: #fff;
  border: none;
  padding: 4px 10px;
  border-radius: 30px;
  font-size: 11px;
  cursor: pointer;
  margin-left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.download-btn:hover { background: #2a5ac0; }

/* FOOTER */
.footer {
  text-align: center;
  padding: 20px;
  border-top: 1px solid #1f2a40;
  color: #8a9bb0;
  font-size: 12px;
  margin-top: 20px;
}
</style>
</head>
<body>
<div class="custom-header">
  <a href="/" class="header-title">${SITE_NAME}</a>
  <div style="display: flex; align-items: center; gap: 15px;">
    ${user ? `
      <div class="user-dropdown">
        <img src="${gravatar}" class="user-avatar" alt="Avatar">
        <div class="user-dropdown-content">
          <a href="/profile"><i class="fas fa-user"></i> Profil</a>
          <a href="/chat"><i class="fas fa-comments"></i> Chat Grup</a>
          <button onclick="confirmDelete()"><i class="fas fa-trash"></i> Hapus Akun</button>
        </div>
      </div>
    ` : `
      <a href="/login" style="color:#5b8cff; font-weight:bold;"><i class="fas fa-sign-in-alt"></i> Login</a>
    `}
    <div class="menu-btn" id="menuBtn">
      <span></span><span></span><span></span>
    </div>
  </div>
</div>

<!-- STATUS PANEL (SLIDE DOWN) -->
<div class="status-panel" id="statusPanel">
  <h3><i class="fas fa-chart-line"></i> SERVER STATUS</h3>
  
  <!-- CPU Load -->
  <div class="metric-row">
    <div class="metric-header">
      <span>CPU Load</span>
      <span id="cpuValue">0.0%</span>
    </div>
    <div class="wave-container">
      <svg class="wave-svg cpu-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,40 Q200,0 400,40 T800,40 T1200,40 L1200,60 L0,60 Z" fill="#3a6df0" opacity="0.4"/>
      </svg>
      <svg class="wave-svg cpu-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,25 Q200,45 400,25 T800,25 T1200,25 L1200,60 L0,60 Z" fill="#5b8cff" opacity="0.4"/>
      </svg>
      <svg class="wave-svg cpu-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,35 Q200,10 400,35 T800,35 T1200,35 L1200,60 L0,60 Z" fill="#1a4a9f" opacity="0.4"/>
      </svg>
    </div>
  </div>

  <!-- Memory -->
  <div class="metric-row">
    <div class="metric-header">
      <span>Memory</span>
      <span id="memValue">0 MiB</span>
    </div>
    <div class="wave-container">
      <svg class="wave-svg mem-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,40 Q200,0 400,40 T800,40 T1200,40 L1200,60 L0,60 Z" fill="#f97316" opacity="0.4"/>
      </svg>
      <svg class="wave-svg mem-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,25 Q200,45 400,25 T800,25 T1200,25 L1200,60 L0,60 Z" fill="#fb923c" opacity="0.4"/>
      </svg>
      <svg class="wave-svg mem-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,35 Q200,10 400,35 T800,35 T1200,35 L1200,60 L0,60 Z" fill="#ea580c" opacity="0.4"/>
      </svg>
    </div>
  </div>

  <!-- Network -->
  <div class="metric-row">
    <div class="metric-header">
      <span>Network</span>
      <span id="netValue">0 B/s</span>
    </div>
    <div class="wave-container">
      <svg class="wave-svg net-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,40 Q200,0 400,40 T800,40 T1200,40 L1200,60 L0,60 Z" fill="#a855f7" opacity="0.4"/>
      </svg>
      <svg class="wave-svg net-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,25 Q200,45 400,25 T800,25 T1200,25 L1200,60 L0,60 Z" fill="#c084fc" opacity="0.4"/>
      </svg>
      <svg class="wave-svg net-wave" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0,35 Q200,10 400,35 T800,35 T1200,35 L1200,60 L0,60 Z" fill="#9333ea" opacity="0.4"/>
      </svg>
    </div>
  </div>

  <!-- Status Info Grid -->
  <div id="statusContent" class="status-grid">Memuat...</div>
</div>

<div class="page-container" id="pageContainer">
  <div class="lux-header-card">
    <h2>${SITE_NAME} Service</h2>
    <p>API untuk bot WhatsApp Novabot</p>
  </div>

  <div class="lux-section-title">Latest News</div>
  <div class="slider-container" id="newsSlider">
    <div class="slider-track">
      <div class="slide"><video src="https://files.catbox.moe/7iyjd5.mp4" autoplay muted loop playsinline></video><div class="slide-content"><h3>${SITE_NAME} v${VERSION}</h3><p>API siap digunakan</p></div></div>
      <div class="slide"><video src="https://files.catbox.moe/sbwa8f.mp4" autoplay muted loop playsinline></video><div class="slide-content"><h3>Mudah & Cepat</h3><p>Integrasi dengan bot Anda</p></div></div>
    </div>
  </div>

  <div class="lux-section-title">API Endpoints</div>
  <div class="api-card">
    <!-- WAIFU -->
    <div class="api-endpoint">
      <div class="api-header">
        <span class="method">GET</span><span class="url">/waifu</span>
        <button class="copy-btn" onclick="copyText('${BASE_URL}/waifu')"><i class="fas fa-copy"></i> waifu</button>
      </div>
      <div class="api-desc">Gambar waifu random (PNG)</div>
      <div class="input-group" style="justify-content: flex-end;">
        <button class="start-btn" onclick="testWaifu()"><i class="fas fa-play"></i> Start</button>
      </div>
      <div id="waifuResponse" class="response-container"></div>
    </div>

    <!-- NSFW -->
    <div class="api-endpoint">
      <div class="api-header">
        <span class="method">GET</span><span class="url">/nsfw</span>
        <button class="copy-btn" onclick="copyText('${BASE_URL}/nsfw')"><i class="fas fa-copy"></i> nsfw</button>
      </div>
      <div class="api-desc">Gambar NSFW random (blowjob, neko, trap, waifu)</div>
      <div class="input-group" style="justify-content: flex-end;">
        <button class="start-btn" onclick="testNsfw()"><i class="fas fa-play"></i> Start</button>
      </div>
      <div id="nsfwResponse" class="response-container"></div>
    </div>

    <!-- WEBZIP -->
    <div class="api-endpoint">
      <div class="api-header">
        <span class="method">GET</span><span class="url">/webzip?url=</span>
        <button class="copy-btn" onclick="copyText('${BASE_URL}/webzip?url=')"><i class="fas fa-copy"></i> webzip</button>
      </div>
      <div class="api-desc">Arsip website (ZIP). Parameter ?url=</div>
      <div class="input-group">
        <input type="text" id="webzipUrl" placeholder="https://contoh.com">
        <button class="start-btn" onclick="testWebzip()"><i class="fas fa-play"></i> Start</button>
      </div>
      <div id="webzipResponse" class="response-container"></div>
    </div>

    <!-- TIKTOK -->
    <div class="api-endpoint">
      <div class="api-header">
        <span class="method">GET</span><span class="url">/tiktok?url=</span>
        <button class="copy-btn" onclick="copyText('${BASE_URL}/tiktok?url=')"><i class="fas fa-copy"></i> tiktok</button>
      </div>
      <div class="api-desc">Download video TikTok (tanpa watermark). Parameter ?url=</div>
      <div class="input-group">
        <input type="text" id="tiktokUrl" placeholder="https://www.tiktok.com/@user/video/123456">
        <button class="start-btn" onclick="testTiktok()"><i class="fas fa-play"></i> Start</button>
      </div>
      <div id="tiktokResponse" class="response-container"></div>
    </div>

    <!-- BRAT -->
    <div class="api-endpoint">
      <div class="api-header">
        <span class="method">GET</span><span class="url">/brat?text=</span>
        <button class="copy-btn" onclick="copyText('${BASE_URL}/brat?text=')"><i class="fas fa-copy"></i> brat</button>
      </div>
      <div class="api-desc">Buat gambar brat (via API eksternal). Parameter ?text=</div>
      <div class="input-group">
        <input type="text" id="bratText" placeholder="Masukkan teks">
        <button class="start-btn" onclick="testBrat()"><i class="fas fa-play"></i> Start</button>
      </div>
      <div id="bratResponse" class="response-container"></div>
    </div>

    <!-- PINTEREST -->
    <div class="api-endpoint">
      <div class="api-header">
        <span class="method">GET</span><span class="url">/pinterest?q=</span>
        <button class="copy-btn" onclick="copyText('${BASE_URL}/pinterest?q=')"><i class="fas fa-copy"></i> pinterest</button>
      </div>
      <div class="api-desc">Cari gambar di Pinterest. Parameter ?q= (kata kunci)</div>
      <div class="input-group">
        <input type="text" id="pinterestQuery" placeholder="Masukkan kata kunci">
        <button class="start-btn" onclick="testPinterest()"><i class="fas fa-play"></i> Start</button>
      </div>
      <div id="pinterestResponse" class="response-container"></div>
    </div>

    <!-- BRATVID -->
    <div class="api-endpoint">
      <div class="api-header">
        <span class="method">GET</span><span class="url">/bratvid?text=</span>
        <button class="copy-btn" onclick="copyText('${BASE_URL}/bratvid?text=')"><i class="fas fa-copy"></i> bratvid</button>
      </div>
      <div class="api-desc">Buat gambar brat video (via API eksternal). Parameter ?text=</div>
      <div class="input-group">
        <input type="text" id="bratvidText" placeholder="Masukkan teks">
        <button class="start-btn" onclick="testBratvid()"><i class="fas fa-play"></i> Start</button>
      </div>
      <div id="bratvidResponse" class="response-container"></div>
    </div>
  </div>

  <div class="footer">
    <p>© 2026 Novabot • <i class="fab fa-telegram"></i> ${DEVELOPER} • v${VERSION}</p>
  </div>
</div>

<script>
// ==================== STATUS PANEL TOGGLE ====================
const menuBtn = document.getElementById('menuBtn');
const statusPanel = document.getElementById('statusPanel');
const pageContainer = document.getElementById('pageContainer');

menuBtn.addEventListener('click', () => {
  menuBtn.classList.toggle('active');
  statusPanel.classList.toggle('show');
  pageContainer.classList.toggle('blur');
});

// ==================== LOAD STATUS INFO ====================
const statusContent = document.getElementById('statusContent');
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const uptime = formatUptime(data.uptime);
    statusContent.innerHTML = \`
      <div class="status-item"><div class="label">STATUS</div><div class="value" style="color:#0f0;">🟢 ONLINE</div></div>
      <div class="status-item"><div class="label">VERSION</div><div class="value">\${data.version}</div></div>
      <div class="status-item"><div class="label">DEV</div><div class="value">\${data.developer}</div></div>
      <div class="status-item"><div class="label">UPTIME</div><div class="value">\${uptime}</div></div>
      <div class="status-item"><div class="label">TIME</div><div class="value">\${new Date(data.timestamp).toLocaleTimeString('id-ID')}</div></div>
    \`;
  } catch { statusContent.innerHTML = '<div class="status-item">❌ Gagal</div>'; }
}
function formatUptime(s) {
  const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60);
  return \`\${d}d \${h}h \${m}m \${sec}s\`;
}
loadStatus();
setInterval(loadStatus, 30000);

// ==================== SIMULASI NILAI CPU, MEMORY, NETWORK ====================
setInterval(() => {
  const cpu = (Math.random() * 30).toFixed(1) + '%';
  const mem = Math.floor(Math.random() * 400) + ' MiB';
  const net = Math.floor(Math.random() * 500) + ' B/s';
  document.getElementById('cpuValue').innerText = cpu;
  document.getElementById('memValue').innerText = mem;
  document.getElementById('netValue').innerText = net;
}, 2000);

// ==================== SLIDER ====================
let slideIdx=0, slideInt;
const slider=document.getElementById('newsSlider'), track=document.querySelector('.slider-track');
function startSlider(){clearInterval(slideInt);slideInt=setInterval(()=>{slideIdx=(slideIdx+1)%2;updateSlide();},5000);}
function updateSlide(){if(track)track.style.transform=\`translateX(-\${slideIdx*50}%)\`;}
function setupSlider(){
if(!slider||!track)return;
let isSwiping=false,startX=0,curX=0;
const getX=e=>e.type.includes('mouse')?e.pageX:e.touches[0].clientX;
slider.addEventListener('touchstart',e=>{startX=getX(e);isSwiping=true;clearInterval(slideInt);});
slider.addEventListener('touchmove',e=>{if(!isSwiping)return;curX=getX(e);const diff=curX-startX;if(Math.abs(diff)>20)track.style.transform=\`translateX(-\${slideIdx*50+(diff/slider.offsetWidth)*50}%)\`;});
slider.addEventListener('touchend',e=>{if(!isSwiping)return;isSwiping=false;const diff=curX-startX;if(Math.abs(diff)>80)diff>0?slideIdx=(slideIdx-1+2)%2:slideIdx=(slideIdx+1)%2;updateSlide();startSlider();});
['mousedown','mousemove','mouseup','mouseleave'].forEach(ev=>slider.addEventListener(ev,e=>{e.preventDefault();}));
}
startSlider(); setupSlider();

// ==================== PINTEREST ====================
async function testPinterest() {
  const query = document.getElementById('pinterestQuery').value.trim();
  if (!query) return alert('Masukkan kata kunci!');
  const respDiv = document.getElementById('pinterestResponse');
  respDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  respDiv.className = 'response-container show';
  try {
    const apiUrl = '/pinterest?q=' + encodeURIComponent(query);
    const res = await fetch(apiUrl);
    const data = await res.json();
    const status = res.status;
    const jsonStr = JSON.stringify(data, null, 2);
    if (data.status) {
      let html = \`
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
          <div class="badge success">200 OK</div>
          <button class="copy-json-btn" onclick="copyText('\${encodeURIComponent(jsonStr)}', 'json')"><i class="fas fa-copy"></i> Copy JSON</button>
        </div>
        <p>Ditemukan \${data.result.length} hasil.</p>
      \`;
      if (data.result.length > 0) {
        html += '<div style="display: flex; flex-wrap: wrap; gap: 5px;">';
        data.result.forEach(item => {
          if (item.image) {
            html += \`<img src="\${item.image}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 5px;">\`;
          }
        });
        html += '</div>';
      }
      html += \`<pre>\${jsonStr}</pre>\`;
      respDiv.innerHTML = html;
      respDiv.classList.add('success');
    } else {
      respDiv.innerHTML = \`
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
          <div class="badge error">\${status}</div>
          <button class="copy-json-btn" onclick="copyText('\${encodeURIComponent(jsonStr)}', 'json')"><i class="fas fa-copy"></i> Copy JSON</button>
        </div>
        <pre>\${jsonStr}</pre>
      \`;
      respDiv.classList.add('error');
    }
  } catch (err) {
    respDiv.innerHTML = \`<div class="badge error">Network Error</div><pre>\${err.message}</pre>\`;
    respDiv.classList.add('error');
  }
}

// ==================== WAIFU ====================
async function testWaifu() {
  const respDiv = document.getElementById('waifuResponse');
  respDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  respDiv.className = 'response-container show';
  try {
    const res = await fetch('/waifu');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    respDiv.innerHTML = \`
      <div class="badge success">200 OK</div>
      <img src="\${url}" alt="Waifu Image">
    \`;
    respDiv.classList.add('success');
  } catch (err) {
    respDiv.innerHTML = \`<div class="badge error">Network Error</div><pre>\${err.message}</pre>\`;
    respDiv.classList.add('error');
  }
}

// ==================== NSFW ====================
async function testNsfw() {
  const respDiv = document.getElementById('nsfwResponse');
  respDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  respDiv.className = 'response-container show';
  try {
    const res = await fetch('/nsfw');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    respDiv.innerHTML = \`
      <div class="badge success">200 OK</div>
      <img src="\${url}" alt="NSFW Image">
    \`;
    respDiv.classList.add('success');
  } catch (err) {
    respDiv.innerHTML = \`<div class="badge error">Network Error</div><pre>\${err.message}</pre>\`;
    respDiv.classList.add('error');
  }
}

// ==================== WEBZIP ====================
async function testWebzip() {
  const urlInput = document.getElementById('webzipUrl').value.trim();
  if (!urlInput) return alert('Masukkan URL!');
  const respDiv = document.getElementById('webzipResponse');
  respDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  respDiv.className = 'response-container show';
  try {
    const apiUrl = '/webzip?url=' + encodeURIComponent(urlInput);
    const res = await fetch(apiUrl);
    const data = await res.json();
    const status = res.status;
    const jsonStr = JSON.stringify(data, null, 2);
    respDiv.innerHTML = \`
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
        <div class="badge \${status===200?'success':'error'}">\${status}</div>
        <button class="copy-json-btn" onclick="copyText('\${encodeURIComponent(jsonStr)}', 'json')"><i class="fas fa-copy"></i> Copy JSON</button>
      </div>
      <pre>\${jsonStr}</pre>
    \`;
    respDiv.classList.add(status===200?'success':'error');
  } catch (err) {
    respDiv.innerHTML = \`<div class="badge error">Network Error</div><pre>\${err.message}</pre>\`;
    respDiv.classList.add('error');
  }
}

// ==================== TIKTOK ====================
async function testTiktok() {
  const urlInput = document.getElementById('tiktokUrl').value.trim();
  if (!urlInput) return alert('Masukkan URL TikTok!');
  const respDiv = document.getElementById('tiktokResponse');
  respDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  respDiv.className = 'response-container show';
  try {
    const apiUrl = '/tiktok?url=' + encodeURIComponent(urlInput);
    const res = await fetch(apiUrl);
    const data = await res.json();
    const status = res.status;
    if (data.status) {
      const r = data.result;
      const jsonStr = JSON.stringify(data, null, 2);
      let html = \`
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
          <div class="badge success">200 OK</div>
          <button class="copy-json-btn" onclick="copyText('\${encodeURIComponent(jsonStr)}', 'json')"><i class="fas fa-copy"></i> Copy JSON</button>
        </div>
      \`;
      html += \`<p><strong>Judul:</strong> \${r.title}</p>\`;
      html += \`<p><strong>Author:</strong> \${r.author} (@\${r.author_username})</p>\`;
      if (r.thumbnail) html += \`<img src="\${r.thumbnail}" style="max-width:100%; max-height:150px; border-radius:8px; margin-bottom:10px;">\`;
      html += \`<p><strong>Durasi:</strong> \${r.duration} (\${r.duration_seconds} detik)</p>\`;
      html += \`<p><strong>👍 Likes:</strong> \${r.like_count} • <strong>💬 Komentar:</strong> \${r.comment_count} • <strong>🔄 Dibagikan:</strong> \${r.share_count} • <strong>📥 Download:</strong> \${r.download_count}</p>\`;
      if (r.video) html += \`<video src="\${r.video}" controls style="max-width:100%; margin-top:10px;"></video>\`;
      if (r.audio) html += \`<p><strong>Audio:</strong> <a href="\${r.audio}" target="_blank">Download Audio</a></p>\`;
      respDiv.innerHTML = html;
      respDiv.classList.add('success');
    } else {
      const jsonStr = JSON.stringify(data, null, 2);
      respDiv.innerHTML = \`
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
          <div class="badge error">\${status}</div>
          <button class="copy-json-btn" onclick="copyText('\${encodeURIComponent(jsonStr)}', 'json')"><i class="fas fa-copy"></i> Copy JSON</button>
        </div>
        <pre>\${jsonStr}</pre>
      \`;
      respDiv.classList.add('error');
    }
  } catch (err) {
    respDiv.innerHTML = \`<div class="badge error">Network Error</div><pre>\${err.message}</pre>\`;
    respDiv.classList.add('error');
  }
}

// ==================== BRAT ====================
async function testBrat() {
  const textInput = document.getElementById('bratText').value.trim();
  if (!textInput) return alert('Masukkan teks!');
  const respDiv = document.getElementById('bratResponse');
  respDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  respDiv.className = 'response-container show';
  try {
    const apiUrl = '/brat?text=' + encodeURIComponent(textInput);
    const res = await fetch(apiUrl);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(\`HTTP \${res.status}: \${errText}\`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    respDiv.innerHTML = \`
      <div class="badge success">200 OK</div>
      <img src="\${url}" alt="Brat Image">
    \`;
    respDiv.classList.add('success');
  } catch (err) {
    console.error('Brat fetch error:', err);
    respDiv.innerHTML = \`<div class="badge error">Error</div><pre>\${err.message}</pre>\`;
    respDiv.classList.add('error');
  }
}

// ==================== BRATVID ====================
async function testBratvid() {
  const textInput = document.getElementById('bratvidText').value.trim();
  if (!textInput) return alert('Masukkan teks!');
  const respDiv = document.getElementById('bratvidResponse');
  respDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  respDiv.className = 'response-container show';
  try {
    const apiUrl = '/bratvid?text=' + encodeURIComponent(textInput);
    const res = await fetch(apiUrl);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(\`HTTP \${res.status}: \${errText}\`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    respDiv.innerHTML = \`
      <div class="badge success">200 OK</div>
      <img src="\${url}" alt="Bratvid Image">
    \`;
    respDiv.classList.add('success');
  } catch (err) {
    console.error('Bratvid fetch error:', err);
    respDiv.innerHTML = \`<div class="badge error">Error</div><pre>\${err.message}</pre>\`;
    respDiv.classList.add('error');
  }
}

// ==================== COPY TEXT ====================
function copyText(text, label) {
  if (label === 'json') text = decodeURIComponent(text);
  navigator.clipboard.writeText(text).then(() => alert('Teks disalin!'));
}

// ==================== HAPUS AKUN ====================
function confirmDelete() {
  if (confirm('Apakah Anda yakin ingin menghapus akun? Semua data akan hilang.')) {
    const code = prompt('Ketik "DELETE" untuk konfirmasi penghapusan akun:');
    if (code === 'DELETE') {
      fetch('/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' })
      }).then(res => res.json()).then(data => {
        if (data.success) {
          window.location.href = '/';
        } else {
          alert('Gagal menghapus akun.');
        }
      });
    } else {
      alert('Konfirmasi salah.');
    }
  }
}

document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('video').forEach(v=>v.play().catch(()=>{}));
});
document.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('keydown',e=>{
  if(e.key==='F12'||(e.ctrlKey&&e.shiftKey&&e.key==='I')||(e.ctrlKey&&e.key==='U'))e.preventDefault();
});
</script>
</body>
</html>`;
  res.send(html);
});

// ==================== ERROR HANDLER GLOBAL ====================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ status: false, error: 'Terjadi kesalahan internal server.' });
});

// ==================== START SERVER (ASYNC) ====================
async function startServer() {
  await initGithub(); // Ambil token GitHub terlebih dahulu
  app.listen(PORT, HOST, () => {
    console.log(`
\x1b[1m\x1b[34m╔╗ ╦  ╔═\x1b[0m╗╔═╗╔═╗╦═╗╔═╗ \x1b[31m
\x1b[1m\x1b[34m╠╩╗║  ╠═╣╔═╝\x1b[0m║╣ ╠╦╝╚═╗ \x1b[31m
\x1b[1m\x1b[34m╚═╝╩═╝╩ ╩╚═╝╚═╝╩\x1b[0m╚═╚═╝ \x1b[31m
\x1b[1m\x1b[33m${SITE_NAME} v${VERSION}\x1b[0m
\x1b[1m\x1b[32m═══════════════════════════════════════\x1b[0m
🌐 Server: http://${HOST}:${PORT}
👤 Developer: ${DEVELOPER}
✅ Chat grup modern dengan swipe to reply, waktu di bawah teks, bubble transparan, input dinaikkan dengan footer!
    `);
  });
}

startServer().catch(err => {
  console.error('Gagal memulai server:', err);
  process.exit(1);
});