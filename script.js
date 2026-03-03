/* ============================================================
   AUS TRANSPORT — BILLING SCRIPT
   - Multi-trip live sync (T1–T6)
   - Auto calc: Running KM, Trip Amount, Grand Total, Words
   - Firebase Firestore: save/load/delete bills cross-device
   - Login: austransport / Aus@2005
   ============================================================ */

/* ══════════════════════════════════════════════════
   FIREBASE CONFIG
   ──────────────────────────────────────────────────
   ONE-TIME SETUP (5 minutes, free):
   1. Go to https://console.firebase.google.com
   2. Click "Add project" → name it "aus-transport"
   3. Firestore Database → Create database → Start in TEST MODE
   4. Click </> Web icon → Register app → Copy config values below
   ══════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyD6X285IzrCeqByieZBkCG562edth3rVsg",
    authDomain:        "aus-transport.firebaseapp.com",
    projectId:         "aus-transport",
    storageBucket:     "aus-transport.firebasestorage.app",
    messagingSenderId: "22348866774",
    appId:             "1:22348866774:web:64ecf60c66849951ac5577",
    measurementId:     "G-SFM2J95QKC"
};

/* Email tied to austransport / Aus@2005 in Firebase Auth */
const AUTH_EMAIL = 'austransport@austransport.com';

let db            = null;
let auth          = null;
let currentBillId = null;   // null = new bill, string = editing existing

/* ── Init Firebase ── */
function initFirebase() {
    try {
        if (!firebase.apps || !firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        auth = firebase.auth();
        db   = firebase.firestore();
        /* Auto-restore session if Firebase still has a signed-in user */
        auth.onAuthStateChanged(user => {
            if (user) {
                showScreen('dashboard-screen');
                loadDashboard();
            }
        });
        return true;
    } catch (e) {
        console.error('Firebase init failed:', e);
        return false;
    }
}

/* ── Screen switcher ── */
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
    if (id === 'workspace-screen') setTimeout(resizeA4Preview, 50);
}

/* ── A4 preview — dynamic zoom to fit any screen width ── */
function resizeA4Preview() {
    const wrapper = document.querySelector('.preview-wrapper');
    const a4      = document.querySelector('.a4-container');
    if (!wrapper || !a4) return;
    a4.style.zoom = '';                          // reset to measure natural width
    const natural   = a4.offsetWidth || 794;    // 210 mm ≈ 794 px @ 96 dpi
    const available = wrapper.clientWidth - 8;  // 4 px breathing room each side
    if (available > 0 && available < natural) {
        a4.style.zoom = (available / natural).toFixed(3);
    }
}

/* ── Debounce helper ── */
function _debounce(fn, ms) {
    let timer;
    return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
}
window.addEventListener('resize', _debounce(resizeA4Preview, 80));
window.addEventListener('orientationchange', () => setTimeout(resizeA4Preview, 200));

/* ── Login / Logout ── */
async function doLogin() {
    const user  = document.getElementById('login-user').value.trim();
    const pass  = document.getElementById('login-pass').value;
    const errEl = document.getElementById('login-error');
    const btn   = document.getElementById('login-btn');
    /* Accept username OR email */
    const email = user.includes('@') ? user : AUTH_EMAIL;
    if (!auth) { errEl.textContent = 'Firebase not configured.'; errEl.style.display = 'block'; return; }
    btn.textContent = 'Signing in...';
    btn.disabled = true;
    try {
        await auth.signInWithEmailAndPassword(email, pass);
        errEl.style.display = 'none';
        showScreen('dashboard-screen');
        loadDashboard();
    } catch (e) {
        errEl.textContent = 'Invalid credentials. Please try again.';
        errEl.style.display = 'block';
    }
    btn.textContent = 'Sign In →';
    btn.disabled = false;
}

function doLogout() {
    if (auth) auth.signOut();
    showScreen('login-screen');
}

/* ── Collect all editor values into a plain object ── */
function getBillData() {
    const trips = [];
    for (let t = 1; t <= 6; t++) {
        trips.push({
            date:   txt(`t${t}-date`),
            dc:     txt(`t${t}-dc`),
            chicks: txt(`t${t}-chicks`),
            place:  txt(`t${t}-place`),
            start:  document.getElementById(`t${t}-start`)?.value || '',
            close:  document.getElementById(`t${t}-close`)?.value || '',
            amt:    document.getElementById(`t${t}-amt`)?.value   || '',
            toll:   document.getElementById(`t${t}-toll`)?.value  || '',
        });
    }
    return {
        billNo:      txt('in-bill'),
        billDate:    txt('in-date'),
        vehicle:     txt('in-vehicle'),
        dieselRate:  document.getElementById('in-diesel-rate')?.value  || '',
        freightRate: document.getElementById('in-freight-rate')?.value || '',
        keralaOn:    document.getElementById('kerala-toggle')?.checked ?? true,
        kerala:      document.getElementById('in-kerala')?.value || '',
        trips,
        grandTotal:  document.getElementById('out-final-total')?.innerText || '',
        savedAt:     firebase.firestore.FieldValue.serverTimestamp(),
    };
}

/* ── Populate editor from a saved bill object ── */
function setBillData(data) {
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v ?? ''); };
    setV('in-bill',         data.billNo);
    setV('in-date',         data.billDate);
    setV('in-vehicle',      data.vehicle);
    setV('in-diesel-rate',  data.dieselRate);
    setV('in-freight-rate', data.freightRate);
    setV('in-kerala',       data.kerala);
    const toggle = document.getElementById('kerala-toggle');
    if (toggle) { toggle.checked = data.keralaOn !== false; toggleKerala(); }
    (data.trips || []).forEach((trip, i) => {
        const t = i + 1;
        setV(`t${t}-date`,   trip.date);
        setV(`t${t}-dc`,     trip.dc);
        setV(`t${t}-chicks`, trip.chicks);
        setV(`t${t}-place`,  trip.place);
        setV(`t${t}-start`,  trip.start);
        setV(`t${t}-close`,  trip.close);
        setV(`t${t}-amt`,    trip.amt);
        setV(`t${t}-toll`,   trip.toll);
        const amtEl = document.getElementById(`t${t}-amt`);
        if (amtEl) amtEl.dataset.manual = trip.amt ? 'true' : 'false';
    });
    recalcAll();
    syncField('in-bill',    'out-bill');
    syncDateAll();
    syncField('in-vehicle', 'out-vehicle');
    for (let t = 1; t <= 6; t++) {
        ['date','dc','chicks','place'].forEach(f => set(`b-t${t}-${f}`, txt(`t${t}-${f}`)));
    }
}

/* ── Load bills list into dashboard ── */
async function loadDashboard() {
    const list = document.getElementById('bills-list');
    if (!db) {
        list.innerHTML = '<div class="bills-error">⚠ Firebase not configured. Open script.js and fill in your FIREBASE_CONFIG values.</div>';
        return;
    }
    list.innerHTML = '<div class="bills-loading">⏳ Loading bills...</div>';
    try {
        const snap = await db.collection('bills').orderBy('savedAt', 'desc').get();
        if (snap.empty) {
            list.innerHTML = '<div class="bills-empty">No bills yet. Click "+ New Bill" to create one.</div>';
            return;
        }
        list.innerHTML = '';
        snap.forEach(doc => {
            const d    = doc.data();
            const card = document.createElement('div');
            card.className = 'bill-card';
            card.innerHTML = `
                <div class="bill-card-info">
                    <span class="bill-card-no">Bill #${d.billNo || '—'}</span>
                    <span class="bill-card-date">${d.billDate || '—'}</span>
                    <span class="bill-card-vehicle">${d.vehicle || '—'}</span>
                    <span class="bill-card-total">₹ ${d.grandTotal || '0'}</span>
                </div>
                <div class="bill-card-actions">
                    <button class="btn-edit"   onclick="openBill('${doc.id}')">✏ Edit</button>
                    <button class="btn-delete" onclick="deleteBill('${doc.id}', this)">🗑 Delete</button>
                </div>`;
            list.appendChild(card);
        });
    } catch (e) {
        list.innerHTML = `<div class="bills-error">❌ Error: ${e.message}</div>`;
    }
}

/* ── Save current bill ── */
async function saveBill() {
    if (!db) { showToast('⚠ Firebase not configured!', 'warn'); return; }
    const btn = document.getElementById('save-btn');
    btn.textContent = '⏳ Saving...';
    btn.disabled = true;
    try {
        const data = getBillData();
        if (currentBillId) {
            await db.collection('bills').doc(currentBillId).set(data);
        } else {
            const ref  = await db.collection('bills').add(data);
            currentBillId = ref.id;
        }
        showToast('✅ Bill saved!', 'success');
    } catch (e) {
        showToast('❌ Save failed: ' + e.message, 'warn');
    }
    btn.textContent = '💾 Save';
    btn.disabled = false;
}

/* ── Open a saved bill into the editor ── */
async function openBill(id) {
    currentBillId = id;
    if (!db) return;
    try {
        const doc = await db.collection('bills').doc(id).get();
        if (doc.exists) { setBillData(doc.data()); showScreen('workspace-screen'); }
    } catch (e) {
        showToast('❌ Could not load bill: ' + e.message, 'warn');
    }
}

/* ── Delete a bill ── */
async function deleteBill(id, btnEl) {
    if (!confirm('Delete this bill? This cannot be undone.')) return;
    if (!db) return;
    try {
        await db.collection('bills').doc(id).delete();
        const card = btnEl.closest('.bill-card');
        if (card) card.remove();
        showToast('🗑 Bill deleted.', 'info');
        const list = document.getElementById('bills-list');
        if (list && !list.querySelector('.bill-card')) {
            list.innerHTML = '<div class="bills-empty">No bills yet. Click "+ New Bill" to create one.</div>';
        }
    } catch (e) {
        showToast('❌ Delete failed: ' + e.message, 'warn');
    }
}

/* ── Start a brand-new blank bill ── */
function newBill() {
    currentBillId = null;
    [['in-bill',''],['in-date',''],['in-vehicle',''],
     ['in-diesel-rate','93.38'],['in-freight-rate','20.27'],['in-kerala','280']
    ].forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.value = v; });
    for (let t = 1; t <= 6; t++) {
        ['date','dc','chicks','place','start','close','amt','toll'].forEach(f => {
            const el = document.getElementById(`t${t}-${f}`); if (el) { el.value = ''; el.dataset.manual = 'false'; }
        });
    }
    const toggle = document.getElementById('kerala-toggle');
    if (toggle) { toggle.checked = true; toggleKerala(); }
    recalcAll();
    syncField('in-bill', 'out-bill');
    syncDateAll();
    syncField('in-vehicle', 'out-vehicle');
    for (let t = 1; t <= 6; t++) {
        ['date','dc','chicks','place'].forEach(f => set(`b-t${t}-${f}`, ''));
    }
    showScreen('workspace-screen');
}

/* ── Number → Indian Words ── */
function numToWords(num) {
    if (!num || num === 0) return '';
    const a = ['','ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE',
                'TEN','ELEVEN','TWELVE','THIRTEEN','FOURTEEN','FIFTEEN','SIXTEEN',
                'SEVENTEEN','EIGHTEEN','NINETEEN'];
    const b = ['','','TWENTY','THIRTY','FORTY','FIFTY','SIXTY','SEVENTY','EIGHTY','NINETY'];
    const n = ('000000000' + Math.floor(num)).substr(-9)
               .match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
    if (!n) return '';
    let s = '';
    const w = (v) => a[+v] || b[v[0]] + (a[v[1]] ? ' ' + a[v[1]] : '');
    if (+n[1]) s += w(n[1]) + ' CRORE ';
    if (+n[2]) s += w(n[2]) + ' LAKH ';
    if (+n[3]) s += w(n[3]) + ' THOUSAND ';
    if (+n[4]) s += w(n[4]) + ' HUNDRED ';
    if (+n[5]) s += (s ? 'AND ' : '') + w(n[5]);
    return s.trim() + ' ONLY.';
}

/* ── Helper: get value safely ── */
function val(id) {
    const el = document.getElementById(id);
    return el ? (parseFloat(el.value) || 0) : 0;
}
function txt(id) {
    const el = document.getElementById(id);
    return el ? (el.value || '') : '';
}
function set(id, v) {
    const el = document.getElementById(id);
    if (el) el.innerText = v;
}

/* ── Sync a single field straight to bill ── */
function syncField(inputId, outputId) {
    const v = txt(inputId);
    set(outputId, v);
}

/* ── Sync bill date ── */
function syncDateAll() {
    const d = txt('in-date');
    set('out-date', d);
}

/* ── Sync a trip-level field to the bill ── */
function syncTripField(t, field) {
    const v = txt(`t${t}-${field}`);
    set(`b-t${t}-${field}`, v);
    recalcAll();
}

/* ── Recalculate one trip: running KM + auto amount ── */
function recalcTrip(t) {
    const start = val(`t${t}-start`);
    const close = val(`t${t}-close`);
    const run   = close > start ? (close - start) : 0;
    const freight = val('in-freight-rate');

    // Set running KM in editor
    const runEl = document.getElementById(`t${t}-run`);
    if (runEl) runEl.value = run;

    // Auto-fill amount only if user hasn't manually changed it
    const autoAmt = Math.round(run * freight);
    const amtEl = document.getElementById(`t${t}-amt`);
    if (amtEl && (!amtEl.dataset.manual || amtEl.dataset.manual === 'false')) {
        amtEl.value = autoAmt || '';
        amtEl.dataset.manual = 'false';
    }

    // Sync to bill preview
    set(`b-t${t}-start`, start || '');
    set(`b-t${t}-close`, close || '');
    set(`b-t${t}-run`,   run   || '');

    recalcAll();
}

/* ── Mark amount as manually overridden ── */
function markManual(t) {
    const amtEl = document.getElementById(`t${t}-amt`);
    if (amtEl) amtEl.dataset.manual = 'true';
}

/* ── Recalculate everything and refresh bill ── */
function recalcAll() {
    const dieselRate  = val('in-diesel-rate');
    const freightRate = val('in-freight-rate');

    let tripTotal = 0;
    let tollTotal = 0;

    for (let t = 1; t <= 6; t++) {
        const start = val(`t${t}-start`);
        const close = val(`t${t}-close`);
        const run   = close > start ? (close - start) : 0;
        const amt   = val(`t${t}-amt`);
        const toll  = val(`t${t}-toll`);

        // update running KM display in editor
        const runEl = document.getElementById(`t${t}-run`);
        if (runEl && !start && !close) { runEl.value = ''; }
        else if (runEl) { runEl.value = run; }

        // push to bill — chicks & place are synced separately via syncTripField
        set(`b-t${t}-start`,   start  ? start  : '');
        set(`b-t${t}-close`,   close  ? close  : '');
        set(`b-t${t}-run`,     run    ? run    : '');
        set(`b-t${t}-diesel`,  amt || run ? dieselRate : '');
        set(`b-t${t}-freight`, amt || run ? freightRate : '');
        set(`b-t${t}-amt`,     amt    ? amt    : '');
        set(`b-t${t}-toll`,    toll   ? toll   : '');

        // toll label — show only if there's a toll value
        const tollLblEl = document.getElementById(`b-t${t}-toll-lbl`);
        if (tollLblEl) {
            tollLblEl.innerText = toll ? 'TOLL GATE EXPENSES' : '';
        }

        tripTotal += amt;
        tollTotal += toll;
    }

    const keralaOn = document.getElementById('kerala-toggle') ? document.getElementById('kerala-toggle').checked : true;
    const kerala = keralaOn ? val('in-kerala') : 0;
    if (keralaOn) tollTotal += kerala;
    set('out-kerala', kerala ? kerala : '');

    const grandTotal = tripTotal + tollTotal;

    // Diesel avg display
    set('out-diesel-avg', dieselRate);

    // Grand total + words
    set('out-final-total', grandTotal ? grandTotal : '');
    set('out-words', grandTotal ? numToWords(grandTotal) : '');

    // Summary panel
    set('summary-trips', tripTotal ? '₹ ' + tripTotal.toLocaleString('en-IN') : '₹ 0');
    set('summary-exp',   tollTotal ? '₹ ' + tollTotal.toLocaleString('en-IN') : '₹ 0');
    set('summary-total', grandTotal ? '₹ ' + grandTotal.toLocaleString('en-IN') : '₹ 0');
}

/* ── Trip tab switcher ── */
function switchTrip(t, btn) {
    document.querySelectorAll('.trip-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.trip-form').forEach(f => f.classList.remove('active'));
    btn.classList.add('active');
    const form = document.getElementById(`trip-form-${t}`);
    if (form) form.classList.add('active');
}

/* ── Toast notification ── */
function toggleKerala() {
    const on = document.getElementById('kerala-toggle').checked;
    document.querySelector('.kerala-row').classList.toggle('hidden', !on);
    document.getElementById('in-kerala').style.display = on ? '' : 'none';
    recalcAll();
}

function showToast(msg, type = 'info') {
    const existing = document.querySelector('.aus-toast');
    if (existing) existing.remove();
    const colors = {
        success: 'linear-gradient(135deg,#10b981,#059669)',
        info:    'linear-gradient(135deg,#3b82f6,#6366f1)',
        warn:    'linear-gradient(135deg,#f59e0b,#d97706)',
    };
    const t = document.createElement('div');
    t.className = 'aus-toast';
    t.innerHTML = msg;
    Object.assign(t.style, {
        position: 'fixed', bottom: '28px', left: '50%',
        transform: 'translateX(-50%) translateY(20px)',
        background: colors[type] || colors.info,
        color: 'white', padding: '11px 24px',
        borderRadius: '10px', fontFamily: 'Inter,sans-serif',
        fontWeight: '600', fontSize: '0.87rem',
        boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
        zIndex: '9999', opacity: '0', whiteSpace: 'nowrap',
        transition: 'all 0.35s cubic-bezier(.22,1,.36,1)',
    });
    document.body.appendChild(t);
    requestAnimationFrame(() => {
        t.style.opacity = '1';
        t.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateX(-50%) translateY(10px)';
        setTimeout(() => t.remove(), 350);
    }, 3200);
}

/* ── DOMContentLoaded ── */
document.addEventListener('DOMContentLoaded', () => {

    /* ── Init Firebase ── */
    initFirebase();

    /* ── Login button ── */
    document.getElementById('login-btn').addEventListener('click', doLogin);
    document.getElementById('login-pass').addEventListener('keydown', e => {
        if (e.key === 'Enter') doLogin();
    });
    document.getElementById('login-user').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('login-pass').focus();
    });

    /* ── Dashboard buttons ── */
    document.getElementById('new-bill-btn').addEventListener('click', newBill);
    document.getElementById('logout-btn-dash').addEventListener('click', doLogout);

    /* ── Workspace buttons ── */
    document.getElementById('save-btn').addEventListener('click', saveBill);
    document.getElementById('back-btn').addEventListener('click', () => {
        showScreen('dashboard-screen');
        loadDashboard();
    });
    document.getElementById('logout-btn-ws').addEventListener('click', doLogout);

    /* ── Mark trip amounts as manual when user types ── */
    for (let t = 1; t <= 6; t++) {
        const amtEl = document.getElementById(`t${t}-amt`);
        if (amtEl) amtEl.addEventListener('focus', function() { this.dataset.manual = 'true'; });
    }

    /* ── Freight rate change: reset auto-calc for all trips ── */
    const freightEl = document.getElementById('in-freight-rate');
    if (freightEl) {
        freightEl.addEventListener('input', () => {
            for (let t = 1; t <= 6; t++) {
                const amtEl = document.getElementById(`t${t}-amt`);
                if (amtEl) amtEl.dataset.manual = 'false';
            }
            recalcAll();
        });
    }

    /* ── Sync bill header fields live ── */
    document.getElementById('in-bill').addEventListener('input',    () => syncField('in-bill',    'out-bill'));
    document.getElementById('in-date').addEventListener('input',    () => syncDateAll());
    document.getElementById('in-vehicle').addEventListener('input', () => syncField('in-vehicle', 'out-vehicle'));

    /* ── Complete button ── */
    document.getElementById('complete-btn').addEventListener('click', () => {
        showToast('✓ Bill marked as complete — ready for PDF download.', 'success');
    });

    /* ── Download PDF ── */
    document.getElementById('download-btn').addEventListener('click', () => window.print());

    /* ── Initial A4 scale ── */
    resizeA4Preview();

    /* ── Initial calculation ── */
    recalcAll();
    syncField('in-bill', 'out-bill');
    syncDateAll();
    syncField('in-vehicle', 'out-vehicle');
    for (let t = 1; t <= 6; t++) {
        ['date','dc','chicks','place'].forEach(f => set(`b-t${t}-${f}`, txt(`t${t}-${f}`)));
    }
});
