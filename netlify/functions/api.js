/* Fungsi server Netlify: menyimpan data kelas sebagai berkas JSON di repository GitHub.
   Variabel lingkungan (Netlify → Site configuration → Environment variables):
     GITHUB_TOKEN   token akses GitHub (izin Contents: Read and write pada repo data)
     GITHUB_REPO    contoh: usernameanda/kelas-pti-data
     GITHUB_BRANCH  (opsional) default: main
     DATA_PATH      (opsional) default: data/db.json
     SESSION_SECRET teks acak panjang untuk menandatangani sesi login
*/
const crypto = require('crypto');

const REPO = process.env.GITHUB_REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const PATH = process.env.DATA_PATH || 'data/db.json';
const SECRET = process.env.SESSION_SECRET;

const GH = () => `https://api.github.com/repos/${REPO}/contents/${PATH}`;
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
async function getFile() {
  const r = await fetch(`${GH()}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders() });
  if (r.status === 404) return { db: null, sha: null };
  if (!r.ok) throw new Error('GitHub GET ' + r.status);
  const j = await r.json();
  return { db: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function putFile(db, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify(db)).toString('base64'), branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(GH(), { method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (!r.ok) throw new Error('GitHub PUT ' + r.status);
  return { sha: (await r.json()).content.sha };
}
function seed() {
  return {
    users: [{ id: uid(), nama: 'Administrator', username: 'admin', pass: hashPass('admin123'), role: 'admin', aktif: true }],
    info: [{ id: uid(), judul: 'Selamat datang!', isi: 'Ini web kelas Pendidikan Teknologi Informasi. Informasi kelas akan diumumkan di sini.', tanggal: Date.now(), penulis: 'Administrator' }],
    absen: {}, kas: {}, kasNominal: 5000, transaksi: [], log: []
  };
}
async function loadDb() {
  const f = await getFile();
  if (f.db) return f;
  const db = seed();
  const r = await putFile(db, null, 'Inisialisasi data kelas');
  return r.conflict ? getFile() : { db, sha: r.sha };
}

const clean = db => ({ ...db, users: db.users.map(({ pass, ...u }) => u) });
const pub = u => ({ id: u.id, nama: u.nama, username: u.username, role: u.role });
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = v => (Array.isArray(v) ? v : []);

/* ---------- Penangan ---------- */
exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Metode tidak diizinkan.' });
  if (!REPO || !TOKEN || !SECRET) return json(500, { error: 'Konfigurasi server belum lengkap (GITHUB_TOKEN, GITHUB_REPO, SESSION_SECRET).' });
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
    if (e.user) return json(400, { error: e.user });
    console.error(e);
    return json(502, { error: 'Gagal mengakses penyimpanan GitHub. Periksa token dan nama repository.' });
  }
};
