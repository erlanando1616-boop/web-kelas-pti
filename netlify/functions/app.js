'use strict';
/* =========================================================
   Web Kelas Pendidikan Teknologi Informasi
   Peran: admin (semua fitur), spesial (pengurus), member (anggota)
   Data disimpan di repository GitHub lewat fungsi Netlify
   (netlify/functions/api.js). Mode lokal (localStorage) hanya
   dipakai oleh preview.html. Lihat README.md.
   ========================================================= */

const KEY = window.PTIK_KEY || 'ptik_db_v1';
const SES = window.PTIK_SES || 'ptik_sesi';
const REMOTE = window.PTIK_REMOTE !== false;
const API = '/.netlify/functions/api';
const TOK = 'ptik_token';
const ROLE = { admin: 'Admin', spesial: 'Spesial', member: 'Member' };
const ROLE_ICON = { admin: '👑', spesial: '⭐', member: '🎓' };
let db, me = null, ver = null, gen = 0, saving = Promise.resolve(), dirty = false, timer = null;
const ui = { week: null, day: null, page: null, filter: 'semua' };

/* ---------- Util ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const rp = n => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n || 0);
const isAdmin = () => me && me.role === 'admin';
const isStaff = () => me && (me.role === 'admin' || me.role === 'spesial');

function avatar(nama, cls = '') {
  const hue = ([...nama].reduce((s, c) => s + c.charCodeAt(0), 0) * 7) % 360;
  const ini = nama.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return `<span class="av ${cls}" style="--h:${hue}">${esc(ini)}</span>`;
}

async function sha(t) {
  const s = 'ptik::' + t;
  if (window.crypto && crypto.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return 'f' + h;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2800);
}

/* ---------- Tema ---------- */
const tema = () => localStorage.getItem('ptik_tema') || 'dark';
document.documentElement.dataset.theme = tema();
function toggleTema() {
  const t = tema() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('ptik_tema', t);
  document.documentElement.dataset.theme = t; render();
}

/* ---------- Tanggal ---------- */
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const today = () => iso(new Date());
function addDays(k, n) { const d = parse(k); d.setDate(d.getDate() + n); return iso(d); }
function mondayOf(d) {
  const x = new Date(d); x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return iso(x);
}
const thisWeek = () => mondayOf(new Date());
const addWeeks = (k, n) => addDays(k, 7 * n);
const fmt = (k, o) => parse(k).toLocaleDateString('id-ID', o || { day: 'numeric', month: 'short', year: 'numeric' });
const fmtHari = k => `${HARI[parse(k).getDay()]}, ${fmt(k)}`;
const fmtPendek = k => `${HARI[parse(k).getDay()].slice(0, 3)} ${parse(k).getDate()}`;
function weekLabel(k) {
  const e = parse(k); e.setDate(e.getDate() + 6);
  return `${fmt(k, { day: 'numeric', month: 'short' })} – ${fmt(iso(e))}`;
}
const fmtWaktu = t => new Date(t).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const jam = t => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

/* ---------- Komunikasi dengan server (mode GitHub) ---------- */
async function api(action, body = {}) {
  const t = localStorage.getItem(TOK);
  let r;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
      body: JSON.stringify({ action, ...body })
    });
  } catch { throw { error: 'Tidak dapat terhubung ke server.' }; }
  let j = {};
  try { j = await r.json(); } catch { /* abaikan */ }
  if (!r.ok) throw { status: r.status, ...j };
  return j;
}
function adopt(j) {
  db = j.db; ver = j.version;
  me = db.users.find(u => u.id === j.me.id) || j.me;
}
function sesiHabis() {
  localStorage.removeItem(TOK); me = null;
  toast('Sesi berakhir, silakan masuk lagi.'); render();
}
async function segarkan() {
  if (!REMOTE || !me || document.hidden || dirty) return;
  const a = document.activeElement;
  if ((a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) || !$('#modal').hidden) return;
  try {
    await saving;
    if (dirty) return;
    const j = await api('load');
    if (j.version !== ver) { adopt(j); render(); }
  } catch (e) { if (e.status === 401) sesiHabis(); }
}

/* ---------- Data ---------- */
function save() {
  if (!REMOTE) { localStorage.setItem(KEY, JSON.stringify(db)); return; }
  if (!me || me.role === 'member') return;
  dirty = true; clearTimeout(timer); timer = setTimeout(flush, 600);
}
function flush() {
  clearTimeout(timer);
  if (dirty) {
    dirty = false;
    const snapshot = JSON.stringify(db);
    db.users.forEach(u => delete u.newPass);
    const g = gen;
    saving = saving.then(async () => {
      if (g !== gen) return;
      try {
        const j = await api('save', { db: JSON.parse(snapshot), version: ver });
        ver = j.version;
      } catch (e) {
        if (e.status === 409 && e.db) {
          gen++; adopt(e); render();
          toast('Data baru saja diubah pengguna lain dan sudah dimuat ulang. Mohon ulangi perubahan Anda.');
        } else if (e.status === 401) { gen++; sesiHabis(); }
        else { gen++; toast(e.error || 'Gagal menyimpan data.'); segarkan(); }
      }
    });
  }
  return saving;
}
function log(aksi) {
  db.log.unshift({ t: Date.now(), oleh: me ? me.nama : 'Sistem', aksi });
  db.log = db.log.slice(0, 1000);
}
const aktif = () => db.users.filter(u => u.aktif);
function kasOf(w) {
  if (!db.kas[w]) db.kas[w] = { nominal: db.kasNominal, paid: {} };
  return db.kas[w];
}
function weeksRange() {
  const keys = [...Object.keys(db.kas), thisWeek()].sort();
  const out = []; let k = keys[0];
  while (k <= thisWeek()) { out.push(k); k = addWeeks(k, 1); }
  return out;
}
function totalKasMasuk() {
  return Object.values(db.kas).reduce((s, w) => s + w.nominal * Object.values(w.paid).filter(Boolean).length, 0);
}
function saldo() {
  const m = db.transaksi.filter(t => t.tipe === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const k = db.transaksi.filter(t => t.tipe === 'keluar').reduce((s, t) => s + t.jumlah, 0);
  return totalKasMasuk() + m - k;
}

/* Absensi harian: db.absen[tanggal][idAnggota] = true (hadir) | false (tidak hadir) | tidak ada (belum diisi) */
const recordedDays = () => Object.keys(db.absen).filter(d => Object.keys(db.absen[d]).length).sort();
function statUser(id) {
  const marked = recordedDays().filter(d => typeof db.absen[d][id] === 'boolean');
  let h = 0, t = 0, streak = 0;
  marked.forEach(d => (db.absen[d][id] ? h++ : t++));
  for (let i = marked.length - 1; i >= 0 && db.absen[marked[i]][id]; i--) streak++;
  const n = h + t;
  return { h, t, n, pct: n ? Math.round(h / n * 100) : null, streak };
}
function countDay(d) {
  const a = db.absen[d] || {}, ak = aktif();
  const h = ak.filter(u => a[u.id] === true).length, t = ak.filter(u => a[u.id] === false).length;
  return { h, t, b: ak.length - h - t, total: ak.length };
}

async function init() {
  ui.week = thisWeek(); ui.day = today();
  if (REMOTE) {
    $('#app').innerHTML = '<div class="login"><div class="card">Memuat data…</div></div>';
    window.addEventListener('hashchange', render);
    if (localStorage.getItem(TOK)) {
      try { adopt(await api('load')); } catch (e) { if (e.status === 401) localStorage.removeItem(TOK); else toast(e.error || 'Gagal memuat data.'); }
    }
    render();
    setInterval(segarkan, 30000);
    return;
  }
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
  if (!db || !Array.isArray(db.users)) {
    db = {
      users: [{ id: uid(), nama: 'Administrator', username: 'admin', pass: await sha('admin123'), role: 'admin', aktif: true }],
      info: [], absen: {}, kas: {}, kasNominal: 5000, transaksi: [], log: []
    };
    db.info.push({ id: uid(), judul: 'Selamat datang!', isi: 'Ini web kelas Pendidikan Teknologi Informasi. Informasi kelas akan diumumkan di sini.', tanggal: Date.now(), penulis: 'Administrator' });
    save();
  }
  const s = localStorage.getItem(SES);
  if (s) me = db.users.find(u => u.id === s && u.aktif) || null;
  window.addEventListener('hashchange', render);
  render();
}

/* ---------- Login ---------- */
function loginView() {
  return `<div class="login"><form class="card" onsubmit="masuk(event)">
    <div class="logo">🎓</div>
    <h1>Kelas <span class="gt">Pendidikan Teknologi Informasi</span></h1>
    <p class="muted">Masuk pakai akun yang dikasih admin ya ✨</p>
    <label>Nama pengguna</label><input id="lu" autocomplete="username" required>
    <label>Kata sandi</label><input id="lp" type="password" autocomplete="current-password" required>
    <div id="le" class="err"></div>
    <button class="btn" style="width:100%;margin-top:8px;padding:13px">Masuk 🚀</button>
    <p class="muted" style="margin-top:16px">Pertama kali? Pakai <b>admin</b> / <b>admin123</b>, lalu segera ganti kata sandi.</p>
  </form></div>`;
}
async function masuk(e) {
  e.preventDefault();
  const un = $('#lu').value.trim().toLowerCase();
  if (REMOTE) {
    $('#le').textContent = 'Memeriksa…';
    try {
      const j = await api('login', { username: un, password: $('#lp').value });
      localStorage.setItem(TOK, j.token); adopt(j);
      location.hash = 'beranda'; render();
    } catch (err) { $('#le').textContent = err.error || 'Gagal masuk.'; }
    return;
  }
  const h = await sha($('#lp').value);
  const u = db.users.find(x => x.username.toLowerCase() === un && x.pass === h);
  if (!u) { $('#le').textContent = 'Nama pengguna atau kata sandi salah.'; return; }
  if (!u.aktif) { $('#le').textContent = 'Akun dinonaktifkan. Hubungi admin.'; return; }
  me = u; localStorage.setItem(SES, u.id);
  log('Masuk ke aplikasi'); save();
  location.hash = 'beranda'; render();
}
async function keluar() {
  if (REMOTE) {
    await flush();
    localStorage.removeItem(TOK); me = null; location.hash = ''; render(); return;
  }
  log('Keluar dari aplikasi'); save();
  me = null; localStorage.removeItem(SES); location.hash = ''; render();
}
async function gantiSandi() {
  const lama = prompt('Masukkan kata sandi lama:');
  if (lama === null) return;
  if (!REMOTE && await sha(lama) !== me.pass) return toast('Kata sandi lama salah');
  const baru = prompt('Masukkan kata sandi baru (minimal 6 karakter):');
  if (!baru) return;
  if (baru.length < 6) return toast('Kata sandi minimal 6 karakter');
  if (REMOTE) {
    try { await flush(); const j = await api('password', { lama, baru }); ver = j.version; toast('Kata sandi berhasil diganti ✅'); }
    catch (e) { toast(e.error || 'Gagal mengganti kata sandi'); }
    return;
  }
  me.pass = await sha(baru);
  log('Mengganti kata sandi'); save(); toast('Kata sandi berhasil diganti ✅');
}

/* ---------- Render utama ---------- */
function navItems() {
  const n = [['beranda', 'Beranda', '🏠'], ['informasi', 'Info', '📢'], ['kehadiran', 'Absen', '✅'], ['keuangan', 'Kas', '💰'], ['anggota', 'Anggota', '👥']];
  if (isStaff()) n.push(['analitik', 'Analitik', '📊'], ['riwayat', 'Riwayat', '🕘']);
  return n;
}
const NAMA_HAL = { beranda: 'Beranda', informasi: 'Informasi', kehadiran: 'Daftar Hadir', keuangan: 'Keuangan', anggota: 'Anggota', analitik: 'Analitik', riwayat: 'Riwayat' };
function render() {
  const app = $('#app');
  if (!me) { app.innerHTML = loginView(); return; }
  const items = navItems();
  const page = location.hash.slice(1) || 'beranda';
  const cur = items.find(i => i[0] === page) || items[0];
  const y = window.scrollY, same = ui.page === cur[0];
  ui.page = cur[0];
  const brand = `<div class="brand"><div class="logo">🎓</div><div>Kelas PTI<small>Pendidikan Teknologi Informasi</small></div></div>`;
  app.innerHTML = `<div class="layout">
    <aside>${brand}
      ${items.map(i => `<a href="#${i[0]}" class="${i[0] === cur[0] ? 'on' : ''}"><span class="ic">${i[2]}</span>${NAMA_HAL[i[0]]}</a>`).join('')}
      <div class="me"><div class="who">${avatar(me.nama, 'sm')}<div><b>${esc(me.nama)}</b><br><span class="badge role ${me.role}">${ROLE_ICON[me.role]} ${ROLE[me.role]}</span></div></div>
        <button class="btn sec sm" onclick="toggleTema()">${tema() === 'dark' ? '☀️ Mode terang' : '🌙 Mode gelap'}</button>
        <button class="btn sec sm" onclick="gantiSandi()">🔑 Ganti sandi</button>
        <button class="btn red sm" onclick="keluar()">Keluar</button></div>
    </aside>
    <main>
      <div class="topbar">${brand}
        <button class="chip" onclick="toggleTema()">${tema() === 'dark' ? '☀️' : '🌙'}</button>
        <button class="chip" onclick="gantiSandi()">🔑</button>
        <button class="chip" onclick="keluar()">⎋</button></div>
      ${pages[cur[0]]()}
    </main>
    <nav class="bnav">${items.map(i => `<a href="#${i[0]}" class="${i[0] === cur[0] ? 'on' : ''}"><span class="ic">${i[2]}</span>${i[1]}</a>`).join('')}</nav>
  </div>`;
  if (same) window.scrollTo(0, y); else window.scrollTo(0, 0);
}

const statusBadge = (ok, yes, no) => ok ? `<span class="badge ok">✔ ${yes}</span>` : `<span class="badge bad">✘ ${no}</span>`;
const absenBadge = v => v === true ? '<span class="badge ok">✔ Hadir</span>' : v === false ? '<span class="badge bad">✘ Tidak hadir</span>' : '<span class="badge none">• Belum diisi</span>';

function weekNav() {
  return `<div class="weeknav">
    <button class="chip" onclick="gantiMinggu(-1)">‹</button>
    <b>${weekLabel(ui.week)}</b>
    <button class="chip" onclick="gantiMinggu(1)">›</button>
    <button class="chip on" onclick="gantiMinggu(0)">Minggu ini</button></div>`;
}
function gantiMinggu(n) { ui.week = n === 0 ? thisWeek() : addWeeks(ui.week, n); render(); }

function dayNav() {
  const t = today();
  return `<div class="daynav">
    <button class="chip" onclick="gantiHari(-1)">‹</button>
    <div class="daytitle">${fmtHari(ui.day)}${ui.day === t ? '<span class="pill">Hari ini</span>' : ''}</div>
    <button class="chip" onclick="gantiHari(1)" ${ui.day >= t ? 'disabled' : ''}>›</button>
    <input type="date" value="${ui.day}" max="${t}" onchange="pilihHari(this.value)" aria-label="Pilih tanggal">
    <button class="chip on" onclick="gantiHari(0)">Hari ini</button></div>`;
}
function gantiHari(n) {
  const t = today();
  ui.day = n === 0 ? t : addDays(ui.day, n);
  if (ui.day > t) ui.day = t;
  render();
}
function pilihHari(v) { if (v) { ui.day = v > today() ? today() : v; render(); } }

const pages = {};

/* ---------- Beranda ---------- */
pages.beranda = () => {
  const d = today(), c = countDay(d), w = thisWeek(), ak = aktif();
  const lunas = ak.filter(u => db.kas[w]?.paid?.[u.id]).length;
  const s = statUser(me.id);
  const infoTerbaru = db.info.slice(0, 3).map(infoCard).join('') || '<p class="muted">Belum ada informasi.</p>';
  return `<div class="card hero"><h2>Halo, ${esc(me.nama.split(' ')[0])}! 👋</h2>
      <p>${fmtHari(d)} · kamu masuk sebagai ${ROLE_ICON[me.role]} ${ROLE[me.role]}</p>
      <div class="row"><span class="badge" style="background:rgba(255,255,255,.22);color:#fff">Absen hari ini: ${c.h + c.t ? (db.absen[d]?.[me.id] === true ? '✔ Hadir' : db.absen[d]?.[me.id] === false ? '✘ Tidak hadir' : '• Belum diisi') : '• Belum diisi'}</span>
      <span class="badge" style="background:rgba(255,255,255,.22);color:#fff">🔥 Streak ${s.streak} hari</span>
      <span class="badge" style="background:rgba(255,255,255,.22);color:#fff">Kas minggu ini: ${db.kas[w]?.paid?.[me.id] ? '✔ Lunas' : '✘ Belum bayar'}</span></div></div>
    <div class="grid">
      <div class="stat"><div class="e">✅</div><div class="n">${c.h}/${c.total}</div><div class="l">Hadir hari ini</div><div class="s">${c.t} tidak hadir · ${c.b} belum diisi</div></div>
      <div class="stat"><div class="e">📈</div><div class="n">${s.pct === null ? '-' : s.pct + '%'}</div><div class="l">Kehadiran kamu</div><div class="s">${s.h} hadir dari ${s.n} hari tercatat</div></div>
      <div class="stat"><div class="e">💸</div><div class="n">${lunas}/${ak.length}</div><div class="l">Lunas kas minggu ini</div></div>
      <div class="stat"><div class="e">🏦</div><div class="n">${rp(saldo())}</div><div class="l">Saldo kas kelas</div></div>
    </div><h3>📢 Informasi terbaru</h3>${infoTerbaru}`;
};

/* ---------- Informasi ---------- */
function infoCard(i) {
  return `<div class="card info"><h3>${esc(i.judul)}</h3>
    <span class="muted">${fmtWaktu(i.tanggal)} • ${esc(i.penulis)}</span>
    <p>${esc(i.isi)}</p>
    ${isAdmin() ? `<button class="btn red sm" onclick="hapusInfo('${i.id}')">Hapus</button>` : ''}</div>`;
}
pages.informasi = () => `<h2>📢 Daftar Isi Informasi</h2>
  ${isStaff() ? `<form class="card" onsubmit="tambahInfo(event)"><h3>Tambah informasi</h3>
    <label>Judul</label><input id="ij" required maxlength="100">
    <label>Isi informasi</label><textarea id="ii" required></textarea>
    <button class="btn" style="margin-top:14px">Terbitkan ✨</button></form>` : ''}
  ${db.info.map(infoCard).join('') || '<p class="muted">Belum ada informasi.</p>'}`;
function tambahInfo(e) {
  e.preventDefault();
  db.info.unshift({ id: uid(), judul: $('#ij').value.trim(), isi: $('#ii').value.trim(), tanggal: Date.now(), penulis: me.nama });
  log('Menambah informasi: ' + $('#ij').value.trim()); save(); toast('Informasi diterbitkan'); render();
}
function hapusInfo(id) {
  if (!confirm('Hapus informasi ini?')) return;
  const i = db.info.find(x => x.id === id);
  db.info = db.info.filter(x => x.id !== id);
  log('Menghapus informasi: ' + (i ? i.judul : '')); save(); render();
}

/* ---------- Kehadiran harian ---------- */
pages.kehadiran = () => {
  if (!isStaff()) return kehadiranMember();
  const d = ui.day, a = db.absen[d] || {}, c = countDay(d);
  return `<h2>✅ Daftar Hadir Harian</h2>
    <p class="muted sub">Tekan <b>Hadir</b> atau <b>Tidak hadir</b> di tiap nama. Tekan lagi untuk membatalkan.</p>
    ${dayNav()}
    <div class="chips"><span class="badge ok">✔ Hadir ${c.h}</span><span class="badge bad">✘ Tidak hadir ${c.t}</span><span class="badge none">• Belum diisi ${c.b}</span></div>
    <div class="bulk">
      <button class="btn green sm" onclick="semuaHadir()">✔ Semua hadir</button>
      <button class="btn red sm" onclick="sisanyaTidak()">✘ Sisanya tidak hadir</button>
      <button class="btn sec sm" onclick="kosongkanHari()">↺ Kosongkan hari ini</button></div>
    ${aktif().map(u => {
      const v = a[u.id];
      return `<div class="prow ${v === true ? 'ok' : v === false ? 'bad' : ''}">${avatar(u.nama)}
        <div class="pn"><b>${esc(u.nama)}</b><small>${ROLE_ICON[u.role]} ${ROLE[u.role]}</small></div>
        <div class="seg"><button class="h ${v === true ? 'on' : ''}" onclick="setAbsen('${u.id}',true)">✔ Hadir</button>
        <button class="t ${v === false ? 'on' : ''}" onclick="setAbsen('${u.id}',false)">✘ Tidak hadir</button></div></div>`;
    }).join('') || '<p class="muted">Belum ada anggota.</p>'}`;
};
function kehadiranMember() {
  const s = statUser(me.id);
  const hari = recordedDays().filter(d => typeof db.absen[d][me.id] === 'boolean').reverse().slice(0, 30);
  return `<h2>✅ Kehadiran Saya</h2>
    <div class="grid">
      <div class="stat"><div class="e">🔥</div><div class="n">${s.streak}</div><div class="l">Streak hadir</div></div>
      <div class="stat"><div class="e">📈</div><div class="n">${s.pct === null ? '-' : s.pct + '%'}</div><div class="l">Persentase hadir</div></div>
      <div class="stat"><div class="e">✔</div><div class="n">${s.h}</div><div class="l">Hari hadir</div></div>
      <div class="stat"><div class="e">✘</div><div class="n">${s.t}</div><div class="l">Hari tidak hadir</div></div></div>
    <h3>Hari ini · ${fmtHari(today())}</h3><p>${absenBadge(db.absen[today()]?.[me.id])}</p>
    <h3>Riwayat 30 hari tercatat terakhir</h3>
    <div class="card tw"><table><thead><tr><th>Tanggal</th><th>Status</th></tr></thead><tbody>
    ${hari.map(d => `<tr class="${db.absen[d][me.id] ? 'ok' : 'bad'}"><td>${fmtHari(d)}</td><td>${absenBadge(db.absen[d][me.id])}</td></tr>`).join('') || '<tr><td colspan="2">Belum ada catatan kehadiran.</td></tr>'}
    </tbody></table></div>`;
}
function setAbsen(id, val) {
  const d = ui.day, a = (db.absen[d] = db.absen[d] || {});
  const u = db.users.find(x => x.id === id);
  if (a[id] === val) {
    delete a[id]; if (!Object.keys(a).length) delete db.absen[d];
    log(`Kehadiran ${u.nama} (${fmtHari(d)}) dikosongkan`);
  } else {
    a[id] = val;
    log(`Kehadiran ${u.nama} (${fmtHari(d)}): ${val ? 'Hadir' : 'Tidak hadir'}`);
  }
  save(); render();
}
function semuaHadir() {
  const a = (db.absen[ui.day] = db.absen[ui.day] || {});
  aktif().forEach(u => (a[u.id] = true));
  log(`Menandai semua hadir (${fmtHari(ui.day)})`); save(); render();
}
function sisanyaTidak() {
  const a = (db.absen[ui.day] = db.absen[ui.day] || {});
  let n = 0;
  aktif().forEach(u => { if (typeof a[u.id] !== 'boolean') { a[u.id] = false; n++; } });
  if (!n) { if (!Object.keys(a).length) delete db.absen[ui.day]; return toast('Semua sudah terisi'); }
  log(`Menandai sisanya tidak hadir (${fmtHari(ui.day)}): ${n} orang`); save(); render();
}
function kosongkanHari() {
  if (!db.absen[ui.day] || !confirm(`Kosongkan semua absen ${fmtHari(ui.day)}?`)) return;
  delete db.absen[ui.day];
  log(`Mengosongkan kehadiran (${fmtHari(ui.day)})`); save(); render();
}

/* ---------- Keuangan (kas mingguan) ---------- */
pages.keuangan = () => {
  const w = ui.week;
  const trx = db.transaksi.slice().sort((a, b) => b.tanggal - a.tanggal);
  const trxHtml = `<h3>Transaksi lain</h3><div class="card tw"><table><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jumlah</th></tr></thead><tbody>
    ${trx.map(t => `<tr><td>${fmtWaktu(t.tanggal)}</td><td>${esc(t.ket)}</td>
      <td style="color:var(--${t.tipe === 'masuk' ? 'ok' : 'bad'});font-weight:700">${t.tipe === 'masuk' ? '+' : '−'}${rp(t.jumlah)}</td></tr>`).join('') || '<tr><td colspan="3">Belum ada transaksi.</td></tr>'}
    </tbody></table></div>`;
  const ringkas = `<div class="grid">
    <div class="stat"><div class="e">🏦</div><div class="n">${rp(saldo())}</div><div class="l">Saldo kas kelas</div></div>
    <div class="stat"><div class="e">💸</div><div class="n">${rp(totalKasMasuk())}</div><div class="l">Total kas mingguan terkumpul</div></div></div>`;
  if (!isStaff()) {
    const ws = weeksRange().reverse().slice(0, 16);
    return `<h2>💰 Keuangan</h2>${ringkas}<h3>Kas mingguan saya</h3>
      <div class="card tw"><table><thead><tr><th>Minggu</th><th>Nominal</th><th>Status</th></tr></thead><tbody>
      ${ws.map(x => { const ok = db.kas[x]?.paid?.[me.id]; return `<tr class="${ok ? 'ok' : 'bad'}"><td>${weekLabel(x)}</td><td>${rp(db.kas[x]?.nominal ?? db.kasNominal)}</td><td>${statusBadge(ok, 'Lunas', 'Belum bayar')}</td></tr>`; }).join('')}
      </tbody></table></div>${trxHtml}`;
  }
  const k = db.kas[w] || { nominal: db.kasNominal, paid: {} };
  const ak = aktif(), belum = ak.filter(u => !k.paid[u.id]);
  return `<h2>💰 Keuangan</h2>${ringkas}${weekNav()}
    <div class="card"><h3>Kas mingguan</h3>
      <div class="row"><label style="margin:0">Nominal kas per minggu</label>
      <input id="nom" type="number" min="0" step="500" value="${k.nominal}" style="width:150px">
      <button class="btn sm" onclick="setNominal()">Simpan nominal</button></div>
      <p><span class="badge ok">Lunas: ${ak.length - belum.length}</span> <span class="badge bad">Belum bayar: ${belum.length}</span></p>
      <div class="tw"><table><thead><tr><th>Nama</th><th>Status</th><th>Aksi</th></tr></thead><tbody>
      ${ak.map(u => `<tr class="${k.paid[u.id] ? 'ok' : 'bad'}"><td>${esc(u.nama)}</td>
        <td>${statusBadge(k.paid[u.id], 'Lunas', 'Belum bayar')}</td>
        <td><button class="btn sm ${k.paid[u.id] ? 'sec' : 'green'}" onclick="toggleKas('${u.id}')">${k.paid[u.id] ? 'Batalkan' : 'Tandai lunas'}</button></td></tr>`).join('') || '<tr><td colspan="3">Belum ada anggota.</td></tr>'}
      </tbody></table></div></div>
    <form class="card" onsubmit="tambahTrx(event)"><h3>Catat pemasukan / pengeluaran lain</h3>
      <div class="row"><select id="tt" style="width:160px"><option value="masuk">Pemasukan</option><option value="keluar">Pengeluaran</option></select>
      <input id="tk" placeholder="Keterangan" required style="width:240px">
      <input id="tj" type="number" min="1" placeholder="Jumlah (Rp)" required style="width:160px">
      <button class="btn">Simpan</button></div></form>${trxHtml}`;
};
function setNominal() {
  const n = parseInt($('#nom').value, 10);
  if (isNaN(n) || n < 0) return toast('Nominal tidak valid');
  kasOf(ui.week).nominal = n; db.kasNominal = n;
  log(`Mengubah nominal kas (${weekLabel(ui.week)}) menjadi ${rp(n)}`); save(); toast('Nominal disimpan'); render();
}
function toggleKas(id) {
  const k = kasOf(ui.week);
  k.paid[id] = !k.paid[id];
  const u = db.users.find(x => x.id === id);
  log(`Kas ${u.nama} (${weekLabel(ui.week)}): ${k.paid[id] ? 'Lunas' : 'Belum bayar'}`);
  save(); render();
}
function tambahTrx(e) {
  e.preventDefault();
  const t = { id: uid(), tipe: $('#tt').value, ket: $('#tk').value.trim(), jumlah: parseInt($('#tj').value, 10), tanggal: Date.now() };
  db.transaksi.push(t);
  log(`${t.tipe === 'masuk' ? 'Pemasukan' : 'Pengeluaran'} ${rp(t.jumlah)}: ${t.ket}`); save(); toast('Transaksi dicatat'); render();
}

/* ---------- Analitik ---------- */
pages.analitik = () => {
  const ak = aktif(), days = recordedDays(), last = days.slice(-14);
  const per = ak.map(u => ({ u, ...statUser(u.id) }));
  const counted = per.filter(p => p.n);
  const avgH = counted.length ? Math.round(counted.reduce((s, p) => s + p.pct, 0) / counted.length) : 0;
  const ws = weeksRange();
  const perK = ak.map(u => { const k = ws.filter(w => db.kas[w]?.paid?.[u.id]).length; return { u, k, pk: Math.round(k / ws.length * 100) }; });
  const avgK = perK.length ? Math.round(perK.reduce((s, p) => s + p.pk, 0) / perK.length) : 0;
  const warna = p => p >= 75 ? 'var(--ok-solid)' : p >= 50 ? 'var(--warn)' : 'var(--bad-solid)';
  const maxN = Math.max(1, ak.length);
  const tren = last.map(d => {
    const c = countDay(d);
    return `<div class="bcol" title="${fmtHari(d)}: ${c.h} hadir, ${c.t} tidak hadir"><div class="stack"><i class="b" style="height:${c.t / maxN * 100}%"></i><i class="g" style="height:${c.h / maxN * 100}%"></i></div>${fmtPendek(d)}</div>`;
  }).join('');
  const kasTren = ws.slice(-8).map(w => {
    const n = ak.filter(u => db.kas[w]?.paid?.[u.id]).length;
    return `<div class="bcol" title="${weekLabel(w)}: ${n} lunas"><div class="stack"><i class="k" style="height:${n / maxN * 100}%"></i></div>${fmt(w, { day: 'numeric', month: 'short' })}</div>`;
  }).join('');
  const podium = counted.slice().sort((a, b) => b.pct - a.pct || b.streak - a.streak).slice(0, 3);
  const medal = ['🥇', '🥈', '🥉'];
  const perhatian = ak.map((u, i) => ({ u, ph: per[i].pct, pk: perK[i].pk })).filter(p => (p.ph !== null && p.ph < 60) || p.pk < 60);
  const t = countDay(today());
  return `<h2>📊 Analitik</h2><p class="muted sub">Berdasarkan ${days.length} hari absen tercatat dan ${ws.length} minggu kas.</p>
    <div class="grid">
      <div class="stat"><div class="donut" style="background:conic-gradient(#8b5cf6 ${avgH * 3.6}deg,rgba(128,128,160,.25) 0)"><div>${avgH}%</div></div><div class="l" style="text-align:center">Rata-rata kehadiran</div></div>
      <div class="stat"><div class="donut" style="background:conic-gradient(#10b981 ${avgK * 3.6}deg,rgba(128,128,160,.25) 0)"><div>${avgK}%</div></div><div class="l" style="text-align:center">Kepatuhan bayar kas</div></div>
      <div class="stat"><div class="e">📅</div><div class="n">${t.h}/${t.total}</div><div class="l">Hadir hari ini</div><div class="s">${t.t} tidak hadir · ${t.b} belum diisi</div></div>
      <div class="stat"><div class="e">🏦</div><div class="n">${rp(saldo())}</div><div class="l">Saldo kas</div><div class="s">Total kas masuk ${rp(totalKasMasuk())}</div></div>
    </div>
    <div class="card"><h3>🏆 Paling rajin hadir</h3>
      ${podium.length ? `<div class="podium">${podium.map((p, i) => `<div class="pc"><div class="m">${medal[i]}</div>${avatar(p.u.nama, 'lg')}<div style="margin-top:6px"><b>${esc(p.u.nama)}</b></div><div class="muted">${p.pct}% · 🔥 ${p.streak} hari</div></div>`).join('')}</div>` : '<p class="muted">Belum ada data absen.</p>'}</div>
    <div class="card"><h3>Tren kehadiran 14 hari tercatat terakhir</h3><div class="bars">${tren || '<p class="muted">Belum ada data.</p>'}</div>
      <div class="legend"><span style="--c:#10b981">Hadir</span><span style="--c:#f43f5e">Tidak hadir</span></div></div>
    <div class="card"><h3>Peta kehadiran per anggota</h3>
      <div class="tw"><table><thead><tr><th>Nama</th><th>${last.length ? fmtPendek(last[0]) + ' → ' + fmtPendek(last[last.length - 1]) : 'Hari'}</th></tr></thead><tbody>
      ${per.map(p => `<tr><td>${esc(p.u.nama)}</td><td class="hm">${last.map(d => { const v = db.absen[d][p.u.id]; return `<i class="${v === true ? 'g' : v === false ? 'r' : 'n'}" title="${fmtHari(d)}"></i>`; }).join('')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="legend"><span style="--c:#10b981">Hadir</span><span style="--c:#f43f5e">Tidak hadir</span><span style="--c:rgba(128,128,160,.35)">Belum diisi</span></div></div>
    <div class="card"><h3>Pembayaran kas 8 minggu terakhir</h3><div class="bars">${kasTren}</div>
      <div class="legend"><span style="--c:#8b5cf6">Jumlah yang lunas</span></div></div>
    <div class="card"><h3>⚠ Perlu perhatian (kehadiran atau kas di bawah 60%)</h3>
      ${perhatian.length ? `<div class="row">${perhatian.map(p => `<span class="badge bad">${esc(p.u.nama)} · hadir ${p.ph === null ? '-' : p.ph + '%'} · kas ${p.pk}%</span>`).join('')}</div>` : '<span class="badge ok">Semua anggota aman 🎉</span>'}</div>
    <div class="card tw"><h3>Rekap per anggota</h3><table><thead><tr><th>Nama</th><th>Hadir</th><th>Kehadiran</th><th>Streak</th><th>Kas lunas</th><th>Kepatuhan kas</th></tr></thead><tbody>
    ${per.map((p, i) => `<tr><td>${esc(p.u.nama)}</td><td>${p.h}/${p.n}</td>
      <td><div class="prog"><i style="width:${p.pct || 0}%;background:${warna(p.pct || 0)}"></i></div>${p.pct === null ? '-' : p.pct + '%'}</td>
      <td>🔥 ${p.streak}</td><td>${perK[i].k}/${ws.length}</td>
      <td><div class="prog"><i style="width:${perK[i].pk}%;background:${warna(perK[i].pk)}"></i></div>${perK[i].pk}%</td></tr>`).join('')}
    </tbody></table></div>`;
};

/* ---------- Riwayat ---------- */
const KAT = [['semua', 'Semua'], ['hadir', '✅ Absen'], ['kas', '💰 Kas'], ['info', '📢 Info'], ['anggota', '👥 Anggota']];
function kategori(a) {
  if (/^(Kehadiran|Menandai|Mengosongkan)/.test(a)) return 'hadir';
  if (/^(Kas |Pemasukan|Pengeluaran|Mengubah nominal)/.test(a)) return 'kas';
  if (/informasi/i.test(a)) return 'info';
  if (/anggota|akun|sandi|Masuk|Keluar|Mencadangkan/.test(a)) return 'anggota';
  return 'lain';
}
const IKON = { hadir: '✅', kas: '💰', info: '📢', anggota: '👥', lain: '•' };
function setFilter(f) { ui.filter = f; render(); }
pages.riwayat = () => {
  const list = db.log.filter(l => ui.filter === 'semua' || kategori(l.aksi) === ui.filter).slice(0, 200);
  let lastDay = '', html = '';
  const t0 = today(), t1 = addDays(t0, -1);
  list.forEach(l => {
    const dk = iso(new Date(l.t));
    if (dk !== lastDay) {
      lastDay = dk;
      html += `<div class="dayhead">${dk === t0 ? 'Hari ini' : dk === t1 ? 'Kemarin' : fmtHari(dk)}</div>`;
    }
    html += `<div class="ev"><div class="ei">${IKON[kategori(l.aksi)]}</div><div><div>${esc(l.aksi)}</div><small>${esc(l.oleh)} · ${jam(l.t)}</small></div></div>`;
  });
  return `<h2>🕘 Riwayat Aktivitas</h2><p class="muted sub">Semua perubahan absen, kas, info, dan akun tercatat di sini.</p>
    <div class="chips">${KAT.map(k => `<button class="chip ${ui.filter === k[0] ? 'on' : ''}" onclick="setFilter('${k[0]}')">${k[1]}</button>`).join('')}</div>
    ${html || '<p class="muted">Belum ada riwayat.</p>'}`;
};

/* ---------- Anggota (dilihat semua, dikelola admin) ---------- */
pages.anggota = () => {
  const grup = [['admin', '👑 Admin'], ['spesial', '⭐ Spesial'], ['member', '🎓 Member']];
  const semua = db.users.filter(u => u.aktif || isAdmin());
  return `<h2>👥 Anggota Kelas</h2><p class="muted sub">${aktif().length} anggota aktif di kelas ini.</p>
    ${isAdmin() ? `<div class="row" style="margin-bottom:16px">
      <button class="btn" onclick="formUser()">+ Tambah anggota</button>
      <button class="btn sec" onclick="eksporData()">⬇ Cadangkan data</button>
      <label class="btn sec" style="margin:0;cursor:pointer;color:var(--text)">⬆ Pulihkan data<input type="file" accept=".json" hidden onchange="imporData(event)"></label></div>` : ''}
    <div class="roles">
      <div class="card"><div class="e">👑</div><h3>Admin</h3><p class="muted">Kelola akun &amp; anggota, isi absen dan kas, lihat analitik &amp; riwayat.</p></div>
      <div class="card"><div class="e">⭐</div><h3>Spesial</h3><p class="muted">Pengurus: isi absen, kas, dan informasi, serta lihat analitik &amp; riwayat.</p></div>
      <div class="card"><div class="e">🎓</div><h3>Member</h3><p class="muted">Lihat informasi, daftar anggota, serta absen dan kas milik sendiri.</p></div></div>
    ${grup.map(([r, judul]) => {
      const us = semua.filter(u => u.role === r);
      if (!us.length) return '';
      return `<div class="gh"><h3>${judul}</h3><span class="badge role ${r}">${us.length}</span></div>
        <div class="members">${us.map(u => `<div class="mcard ${u.id === me.id ? 'self' : ''}">${avatar(u.nama, 'lg')}
          <div class="mn"><b>${esc(u.nama)}${u.id === me.id ? ' (kamu)' : ''}</b>
            <span class="badge role ${u.role}">${ROLE_ICON[u.role]} ${ROLE[u.role]}</span>
            ${isAdmin() ? `<div class="muted">@${esc(u.username)} · ${u.aktif ? 'Aktif' : 'Nonaktif'}</div>
              <div class="acts"><button class="btn sec sm" onclick="formUser('${u.id}')">Ubah</button>
              ${u.id !== me.id ? `<button class="btn red sm" onclick="hapusUser('${u.id}')">Hapus</button>` : ''}</div>` : ''}
          </div></div>`).join('')}</div>`;
    }).join('')}`;
};

function formUser(id) {
  const u = id ? db.users.find(x => x.id === id) : { nama: '', username: '', role: 'member', aktif: true };
  const m = $('#modal');
  m.hidden = false;
  m.onclick = e => { if (e.target === m) tutup(); };
  m.innerHTML = `<form class="card" onsubmit="simpanUser(event,'${id || ''}')">
    <h3>${id ? 'Ubah anggota' : 'Tambah anggota'}</h3>
    <label>Nama lengkap</label><input id="un" required value="${esc(u.nama)}">
    <label>Nama pengguna (untuk login)</label><input id="uu" required value="${esc(u.username)}" autocomplete="off">
    <label>Kata sandi ${id ? '(kosongkan jika tidak diubah)' : ''}</label><input id="up" type="text" ${id ? '' : 'required'} minlength="6" autocomplete="off" placeholder="Minimal 6 karakter">
    <label>Peran</label><select id="ur">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${ROLE_ICON[k]} ${v}</option>`).join('')}</select>
    <label>Status</label><select id="ua"><option value="1" ${u.aktif ? 'selected' : ''}>Aktif</option><option value="0" ${!u.aktif ? 'selected' : ''}>Nonaktif</option></select>
    <div class="row" style="margin-top:18px"><button class="btn">Simpan</button><button type="button" class="btn sec" onclick="tutup()">Batal</button></div></form>`;
}
function tutup() { $('#modal').hidden = true; }
async function simpanUser(e, id) {
  e.preventDefault();
  const un = $('#uu').value.trim().toLowerCase();
  if (db.users.some(x => x.username.toLowerCase() === un && x.id !== id)) return toast('Nama pengguna sudah dipakai');
  const data = { nama: $('#un').value.trim(), username: un, role: $('#ur').value, aktif: $('#ua').value === '1' };
  const sandi = $('#up').value;
  if (id) {
    const u = db.users.find(x => x.id === id);
    if (u.id === me.id && (data.role !== 'admin' || !data.aktif)) return toast('Tidak dapat menurunkan atau menonaktifkan akun sendiri');
    Object.assign(u, data);
    if (sandi) { if (REMOTE) u.newPass = sandi; else u.pass = await sha(sandi); }
    log('Mengubah akun anggota: ' + u.nama);
  } else {
    db.users.push(REMOTE ? { id: uid(), ...data, newPass: sandi } : { id: uid(), ...data, pass: await sha(sandi) });
    log('Menambah anggota: ' + data.nama);
  }
  save(); tutup(); toast('Data anggota disimpan ✅'); render();
}
function hapusUser(id) {
  const u = db.users.find(x => x.id === id);
  if (!confirm(`Hapus ${u.nama}? Catatan absen dan kas miliknya tidak akan ditampilkan lagi.`)) return;
  db.users = db.users.filter(x => x.id !== id);
  log('Menghapus anggota: ' + u.nama); save(); render();
}
function eksporData() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
  a.download = `cadangan-kelas-pti-${today()}.json`; a.click();
  log('Mencadangkan data'); save();
}
function imporData(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!Array.isArray(d.users) || !d.users.some(u => u.role === 'admin')) throw 0;
      if (!confirm('Data saat ini akan diganti dengan data cadangan. Lanjutkan?')) return;
      db = d; me = db.users.find(u => u.id === me.id) || null;
      if (!me) { localStorage.removeItem(SES); localStorage.removeItem(TOK); }
      save(); toast('Data berhasil dipulihkan'); render();
    } catch { toast('Berkas cadangan tidak valid'); }
  };
  r.readAsText(f);
}

init();
