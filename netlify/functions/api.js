/* Fungsi server Netlify: menyimpan data kelas sebagai berkas JSON di repository GitHub.
   Variabel lingkungan (Netlify → Site configuration → Environment variables):
     GITHUB_TOKEN   token akses GitHub (izin Contents: Read and write pada repo data)
     GITHUB_REPO    contoh: usernameanda/kelas-pti-data
     SESSION_SECRET teks acak panjang untuk menandatangani sesi login
     GITHUB_BRANCH  (opsional) kosong = memakai cabang bawaan repo
     DATA_PATH      (opsional) default: data/db.json
     DIAGNOSA       (opsional) isi "mati" untuk mematikan halaman cek
   Buka alamat fungsi ini di browser (GET) untuk melihat halaman cek pengaturan.
*/
const crypto = require('crypto');

const clip = s => String(s || '').trim();
const REPO = clip(process.env.GITHUB_REPO).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
const TOKEN = clip(process.env.GITHUB_TOKEN);
const BRANCH = clip(process.env.GITHUB_BRANCH);
const PATH = clip(process.env.DATA_PATH) || 'data/db.json';
const SECRET = clip(process.env.SESSION_SECRET);

const REPO_URL = () => `https://api.github.com/repos/${REPO}`;
const FILE_URL = () => `${REPO_URL()}/contents/${PATH}`;
const ghHeaders = () => ({
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'web-kelas-pti'
});
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const uid = () => crypto.randomBytes(5).toString('hex');

/* ---------- Kata sandi & sesi ---------- */
function hashPass(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `s1$${salt}$${crypto.scryptSync(p, salt, 32).toString('hex')}`;
}
function checkPass(p, stored) {
  if (!stored) return false;
  const [v, salt, h] = stored.split('$');
  if (v !== 's1' || !salt || !h) return false;
  const x = crypto.scryptSync(p, salt, 32), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const mac = body => crypto.createHmac('sha256', SECRET).update(body).digest('hex');
function sign(id) {
  const body = `${id}.${Date.now() + 7 * 864e5}`;
  return `${body}.${mac(body)}`;
}
function verify(tok) {
  const p = (tok || '').split('.');
  if (p.length !== 3) return null;
  const sig = mac(`${p[0]}.${p[1]}`);
  if (sig.length !== p[2].length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(p[2]))) return null;
  return Date.now() > Number(p[1]) ? null : p[0];
}

/* ---------- GitHub ---------- */
class GhError extends Error {
  constructor(status, gh) { super('GitHub ' + status); this.status = status; this.gh = gh || ''; }
}
async function ghFetch(url, opt = {}) {
  try {
    return await fetch(url, { ...opt, headers: { ...ghHeaders(), ...(opt.headers || {}) } });
  } catch (e) {
    throw new GhError(0, String((e && e.message) || e));
  }
}
async function ghMsg(r) {
  try { return (await r.json()).message || ''; } catch { return ''; }
}
function explain(e) {
  const g = e.gh ? ` (Pesan GitHub: "${e.gh}")` : '';
  switch (e.status) {
    case 0: return 'Server tidak dapat menghubungi GitHub. Coba lagi beberapa saat.' + g;
    case 401: return 'GitHub menolak token (kode 401): token salah, kedaluwarsa, atau ada spasi saat disalin. Buat token baru lalu perbarui GITHUB_TOKEN di Netlify.' + g;
    case 403: return 'Token tidak punya izin (kode 403): pastikan izin Contents = Read and write dan token dipilihkan untuk repo data.' + g;
    case 404: return 'Repo atau akses token tidak cocok (kode 404): periksa GITHUB_REPO (format username/nama-repo) dan pastikan token diberi akses ke repo itu.' + g;
    case 413: return 'Berkas data terlalu besar untuk API GitHub (lebih dari 1 MB).' + g;
    case 422: return 'GitHub menolak permintaan (kode 422): biasanya nama cabang salah. Hapus GITHUB_BRANCH di Netlify atau isi dengan nama cabang yang benar.' + g;
    default: return `Gagal mengakses GitHub (kode ${e.status}).` + g;
  }
}

async function getFile() {
  const q = BRANCH ? `?ref=${encodeURIComponent(BRANCH)}` : '';
  const r = await ghFetch(FILE_URL() + q);
  if (r.status === 404) return { db: null, sha: null };
  if (!r.ok) throw new GhError(r.status, await ghMsg(r));
  const j = await r.json();
  if (j.encoding === 'none' || typeof j.content !== 'string' || !j.content) throw new GhError(413, '');
  try {
    return { db: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
  } catch {
    throw Object.assign(new Error('json'), { code: 500, user: `Berkas ${PATH} di repo data rusak (bukan JSON yang valid). Perbaiki atau hapus berkas itu di GitHub.` });
  }
}
async function putFile(db, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify(db)).toString('base64') };
  if (BRANCH) body.branch = BRANCH;
  if (sha) body.sha = sha;
  const r = await ghFetch(FILE_URL(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) return { sha: (await r.json()).content.sha };
  const msg = await ghMsg(r);
  if (r.status === 409 || (r.status === 422 && /\bsha\b/i.test(msg))) return { conflict: true };
  throw new GhError(r.status, msg);
}
function seed() {
  return {
    users: [{ id: uid(), nama: 'Administrator', username: 'admin', pass: hashPass('admin123'), role: 'admin', aktif: true }],
    info: [{ id: uid(), judul: 'Selamat datang!', isi: 'Ini web kelas Pendidikan Teknologi Informasi. Informasi kelas akan diumumkan di sini.', tanggal: Date.now(), penulis: 'Administrator' }],
    absen: {}, kas: {}, kasNominal: 5000, transaksi: [], log: []
  };
}
async function loadDb() {
  let f = await getFile();
  if (f.db) return f;
  const db = seed();
  const r = await putFile(db, null, 'Inisialisasi data kelas');
  if (r.conflict) {
    f = await getFile();
    if (f.db) return f;
    throw new GhError(409, 'Gagal membuat berkas data awal.');
  }
  return { db, sha: r.sha };
}

const clean = db => ({ ...db, users: db.users.map(({ pass, ...u }) => u) });
const pub = u => ({ id: u.id, nama: u.nama, username: u.username, role: u.role });
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = v => (Array.isArray(v) ? v : []);

/* ---------- Halaman cek pengaturan (GET) ---------- */
const h = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function diagnose() {
  const out = [];
  const add = (ok, teks) => out.push({ ok, teks });
  add(!!TOKEN, TOKEN ? 'GITHUB_TOKEN terisi.' : 'GITHUB_TOKEN KOSONG. Isi di Netlify → Site configuration → Environment variables.');
  const fmt = /^[\w.-]+\/[\w.-]+$/.test(REPO);
  add(fmt, fmt ? 'GITHUB_REPO berformat benar.' : 'GITHUB_REPO salah atau kosong. Formatnya harus: username/nama-repo (contoh: budi123/kelas-pti-data).');
  add(SECRET.length >= 16, SECRET.length >= 16 ? 'SESSION_SECRET terisi.' : 'SESSION_SECRET kosong atau terlalu pendek (minimal 16 karakter, disarankan 32).');
  if (!TOKEN || !fmt) return out;
  const [owner, name] = REPO.split('/');
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  try {
    // 1) Siapa pemilik token & apa jenisnya?
    let login = '';
    const u = await ghFetch('https://api.github.com/user');
    if (u.status === 401) { add(false, explain(new GhError(401, await ghMsg(u)))); return out; }
    if (u.ok) {
      login = (await u.json()).login || '';
      if (login) add(true, `Token ini milik akun GitHub: ${login}.`);
      const sc = u.headers && u.headers.get ? u.headers.get('x-oauth-scopes') : null;
      if (sc !== null && sc !== undefined) {
        const list = sc.split(',').map(x => x.trim()).filter(Boolean);
        const okRepo = list.includes('repo');
        add(okRepo, okRepo ? 'Token classic punya scope "repo".' : `Token classic TIDAK punya scope "repo" (scope sekarang: ${list.join(', ') || 'kosong'}). Buat token baru dan centang kotak "repo".`);
      } else add(true, 'Token berjenis fine-grained: akses ditentukan per repo.');
    }

    // 2) Apakah repo di GITHUB_REPO terlihat oleh token?
    const r = await ghFetch(REPO_URL());
    if (!r.ok) {
      add(false, explain(new GhError(r.status, await ghMsg(r))));
      if (r.status === 404 && login) {
        if (!same(owner, login)) {
          const alt = await ghFetch(`https://api.github.com/repos/${login}/${name}`);
          add(false, alt.ok
            ? `Repo "${name}" DITEMUKAN di akun token (${login}). Ubah GITHUB_REPO di Netlify menjadi ${login}/${name}.`
            : `Pemilik di GITHUB_REPO ("${owner}") berbeda dengan akun pemilik token ("${login}"). Buat token saat login sebagai ${owner}, atau perbaiki GITHUB_REPO.`);
        } else {
          add(false, `Akun sudah cocok (${login}), tetapi repo "${name}" tidak terlihat oleh token. Buka https://github.com/${REPO} saat login sebagai ${login}: jika 404, nama repo salah atau repo belum dibuat; jika terbuka, token tidak punya akses ke repo ini.`);
        }
      }
      return out;
    }
    const j = await r.json();
    add(true, `Repo ditemukan dan token bisa membukanya (${j.private ? 'privat' : 'PUBLIK, sebaiknya dijadikan privat'}).`);
    if (j.private === false) add(false, 'Repo data berstatus PUBLIK: semua orang bisa membaca data kelas. Ubah menjadi Private di Settings repo.');
    if (j.permissions && j.permissions.push === false) add(false, 'Token hanya bisa MEMBACA repo. Ubah izin Contents menjadi "Read and write" lalu buat ulang token.');
    else if (j.permissions) add(true, 'Token punya izin menulis ke repo.');

    const br = BRANCH || j.default_branch;
    const b = await ghFetch(`${REPO_URL()}/branches/${encodeURIComponent(br)}`);
    if (b.ok) add(true, `Cabang "${br}" ada.`);
    else add(false, `Cabang "${br}" tidak ditemukan. ${BRANCH ? 'Hapus GITHUB_BRANCH di Netlify atau isi nama cabang yang benar.' : 'Repo kemungkinan masih kosong: tambahkan satu berkas (mis. README) di repo data.'}`);

    const f = await ghFetch(FILE_URL() + (BRANCH ? `?ref=${encodeURIComponent(BRANCH)}` : ''));
    if (f.ok) add(true, `Berkas data (${PATH}) sudah ada.`);
    else if (f.status === 404) add(true, `Berkas data (${PATH}) belum ada. Normal: akan dibuat otomatis saat login pertama.`);
    else add(false, explain(new GhError(f.status, await ghMsg(f))));
  } catch (e) {
    add(false, e instanceof GhError ? explain(e) : 'Terjadi kesalahan saat memeriksa GitHub.');
  }
  return out;
}
async function diagPage() {
  if (clip(process.env.DIAGNOSA).toLowerCase() === 'mati') return { statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Halaman cek dimatikan.' };
  const out = await diagnose();
  const siap = out.every(x => x.ok);
  const body = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cek pengaturan</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:30px auto;padding:0 16px;line-height:1.5}li{margin:8px 0;list-style:none}.ok{color:#047857}.bad{color:#be123c;font-weight:700}h1{font-size:1.3rem}.box{padding:12px 14px;border-radius:12px;background:${siap ? '#d1fae5' : '#ffe4e6'}}</style></head>
<body><h1>Cek pengaturan Web Kelas PTI</h1><p class="box">${siap ? '✅ Semua pengaturan terlihat benar. Silakan buka halaman utama dan login.' : '❌ Ada yang perlu diperbaiki (baris bertanda ✘). Perbaiki, lalu deploy ulang dan muat ulang halaman ini.'}</p>
<ul>${out.map(x => `<li class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '✔' : '✘'} ${h(x.teks)}</li>`).join('')}</ul>
<p style="color:#666;font-size:.85rem">Halaman ini tidak pernah menampilkan token. Nama akun/repo hanya muncul pada baris petunjuk saat ada kesalahan. Matikan halaman ini dengan variabel DIAGNOSA = mati.</p></body></html>`;
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body };
}

/* ---------- Penangan ---------- */
exports.handler = async event => {
  if (event.httpMethod === 'GET') return diagPage();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Metode tidak diizinkan.' });
  const kurang = [!TOKEN && 'GITHUB_TOKEN', !REPO && 'GITHUB_REPO', !SECRET && 'SESSION_SECRET'].filter(Boolean);
  if (kurang.length) return json(500, { error: `Konfigurasi server belum lengkap, variabel kosong: ${kurang.join(', ')}. Isi di Netlify lalu deploy ulang.` });
  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Permintaan tidak valid.' }); }

  try {
    const { db, sha } = await loadDb();

    if (req.action === 'login') {
      const un = String(req.username || '').trim().toLowerCase();
      const u = db.users.find(x => x.username.toLowerCase() === un);
      if (!u || !checkPass(String(req.password || ''), u.pass)) return json(401, { error: 'Nama pengguna atau kata sandi salah.' });
      if (!u.aktif) return json(403, { error: 'Akun dinonaktifkan. Hubungi admin.' });
      return json(200, { token: sign(u.id), me: pub(u), db: clean(db), version: sha });
    }

    const id = verify((event.headers.authorization || '').replace(/^Bearer /i, ''));
    const me = db.users.find(u => u.id === id && u.aktif);
    if (!me) return json(401, { error: 'Sesi berakhir, silakan masuk lagi.' });

    if (req.action === 'load') return json(200, { me: pub(me), db: clean(db), version: sha });

    if (req.action === 'password') {
      const baru = String(req.baru || '');
      if (!checkPass(String(req.lama || ''), me.pass)) return json(400, { error: 'Kata sandi lama salah.' });
      if (baru.length < 6) return json(400, { error: 'Kata sandi baru minimal 6 karakter.' });
      me.pass = hashPass(baru);
      const r = await putFile(db, sha, `Ganti kata sandi ${me.username}`);
      if (r.conflict) return json(409, { error: 'Data baru saja berubah, coba lagi.' });
      return json(200, { version: r.sha });
    }

    if (req.action === 'save') {
      if (me.role === 'member') return json(403, { error: 'Anda tidak memiliki izin mengubah data.' });
      if (req.version !== sha) return json(409, { error: 'konflik', db: clean(db), version: sha, me: pub(me) });
      const inc = obj(req.db);
      const next = {
        users: db.users,
        info: arr(inc.info), absen: obj(inc.absen), kas: obj(inc.kas),
        kasNominal: Number(inc.kasNominal) || 0, transaksi: arr(inc.transaksi), log: arr(inc.log).slice(0, 1000)
      };
      if (me.role === 'admin') {
        const users = arr(inc.users).map(u => {
          const old = db.users.find(x => x.id === u.id);
          const rec = {
            id: String(u.id), nama: String(u.nama || '').slice(0, 80), username: String(u.username || '').trim().toLowerCase().slice(0, 40),
            role: ['admin', 'spesial', 'member'].includes(u.role) ? u.role : 'member', aktif: !!u.aktif, pass: old ? old.pass : ''
          };
          if (u.newPass) {
            if (String(u.newPass).length < 6) throw Object.assign(new Error('sandi'), { user: 'Kata sandi minimal 6 karakter.' });
            rec.pass = hashPass(String(u.newPass));
          }
          return rec;
        });
        if (!users.some(u => u.role === 'admin' && u.aktif)) return json(400, { error: 'Harus ada minimal satu admin aktif.' });
        if (new Set(users.map(u => u.username)).size !== users.length || users.some(u => !u.username)) return json(400, { error: 'Nama pengguna harus unik dan tidak boleh kosong.' });
        next.users = users;
      }
      const r = await putFile(next, sha, `Perbarui data oleh ${me.username}`);
      if (r.conflict) {
        const f = await getFile();
        return json(409, { error: 'konflik', db: clean(f.db), version: f.sha, me: pub(me) });
      }
      return json(200, { version: r.sha });
    }

    return json(400, { error: 'Aksi tidak dikenal.' });
  } catch (e) {
    if (e.user) return json(e.code || 400, { error: e.user });
    console.error(e);
    if (e instanceof GhError) return json(502, { error: explain(e) + ' Untuk detail, buka halaman cek di alamat situs Anda + /.netlify/functions/api', kode: e.status });
    return json(500, { error: 'Terjadi kesalahan di server: ' + (e && e.message ? e.message : 'tidak diketahui') });
  }
};
