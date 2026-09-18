// app.js
// ระบบตรวจสอบความปลอดภัยถังดับเพลิงและไฟฉุกเฉิน โรงพยาบาลพยุหะคีรี (Pyuha Safety System)

import {
  db, storage, auth, isFirebaseReady,
  collection, addDoc, getDocs, doc, setDoc, getDoc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp, ref, uploadBytes, getDownloadURL,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut
} from './firebase-config.js';

// ข้อมูลผังอาคารทั้ง 6 โซนของ รพ.พยุหะคีรี
const floorConfigs = {
  building_hpc: {
    name: 'อาคารส่งเสริมสุขภาพ',
    imageUrl: 'maps/hpc_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [724, 1024]]
  },
  building_ipd: {
    name: 'อาคารผู้ป่วยใน (IPD)',
    imageUrl: 'maps/ipd_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [576, 1024]]
  },
  building_nisit: {
    name: 'อาคารนิสิตคุณากร (Covid 19)',
    imageUrl: 'maps/nisit_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [576, 1024]]
  },
  building_er_upper: {
    name: 'อาคารอุบัติเหตุ (ชั้นบน)',
    imageUrl: 'maps/er_upper_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [576, 1024]]
  },
  building_er_lower: {
    name: 'อาคารอุบัติเหตุ (ชั้นล่าง)',
    imageUrl: 'maps/er_lower_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [576, 1024]]
  },
  building_opd_dm: {
    name: 'ตึกแก้วกัลยา (ผู้ป่วยนอก OPD)',
    imageUrl: 'maps/opd_dm_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [723, 1024]]
  },
  building_pharma_rehab: {
    name: 'อาคารเวชศาสตร์ฟื้นฟู-โภชนาการ-คลังยา-จ่ายกลาง',
    imageUrl: 'maps/pharma_rehab_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [724, 1024]]
  },
  building_thai_med: {
    name: 'อาคารแพทย์แผนไทย',
    imageUrl: 'maps/thai_med_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [576, 1024]]
  },
  building_canteen: {
    name: 'อาคารโรงอาหาร',
    imageUrl: 'maps/canteen_floorplan.webp?v=' + Date.now(),
    bounds: [[0, 0], [723, 1024]]
  }
};

function getCleanName(str) {
  if (!str) return '';
  return str.replace(/\s*\([^)]*\)/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ฟังก์ชันมาตรฐานแปลงชื่อประเภทอุปกรณ์ให้ตรงตามมาตรฐานใหม่:
// 1. ถังดับเพลิง ผงเคมีแห้ง -> "ถังดับเพลิงสีแดง"
// 2. ถังดับเพลิง คาร์บอนไดออกไซด์ / CO2 -> "ถังดับเพลิงสีเขียว"
// 3. ไฟส่องสว่างฉุกเฉิน -> "ไฟฉุกเฉิน"
function cleanAssetType(typeStr) {
  if (!typeStr) return '';
  let str = typeStr.trim();
  if (str.includes('เขียว') || str.includes('CO2') || str.includes('co2') || str.includes('คาร์บอน') || str.includes('Clean Agent') || str.includes('clean agent')) {
    return 'ถังดับเพลิงสีเขียว';
  }
  if (str.includes('แดง') || str.includes('ผงเคมี') || str.includes('Dry Chemical') || str.includes('dry chemical')) {
    return 'ถังดับเพลิงสีแดง';
  }
  if (str.includes('ไฟ') || str.includes('Emergency') || str.includes('emergency')) {
    return 'ไฟฉุกเฉิน';
  }
  return str.replace(/\s*\([^)]*\)/g, '').trim();
}

// ฟังก์ชันแปลงวันที่ให้เป็นรูปแบบภาษาไทยทางการ เช่น "8 กันยายน พ.ศ. 2569"
function formatThaiFullDate(dateObj = new Date()) {
  const thaiMonths = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
  ];
  const d = dateObj.getDate();
  const m = thaiMonths[dateObj.getMonth()];
  const y = dateObj.getFullYear() + 543;
  return `วันที่ ${d} ${m} พ.ศ. ${y}`;
}

// ล้างค่าเก่าใน localStorage ที่อาจมีตำแหน่งติดมาในวงเล็บโดยอัตโนมัติ
try {
  if (localStorage.getItem('pyh_officer')) {
    localStorage.setItem('pyh_officer', getCleanName(localStorage.getItem('pyh_officer')));
  }
  const rawTech = localStorage.getItem('pyh_tech_certification');
  if (rawTech) {
    const obj = JSON.parse(rawTech);
    if (obj && obj.officer) {
      obj.officer = getCleanName(obj.officer);
      localStorage.setItem('pyh_tech_certification', JSON.stringify(obj));
    }
  }
  const rawChef = localStorage.getItem('pyh_chef_certification');
  if (rawChef) {
    const obj = JSON.parse(rawChef);
    if (obj && obj.officer) {
      obj.officer = getCleanName(obj.officer);
      localStorage.setItem('pyh_chef_certification', JSON.stringify(obj));
    }
  }

  // ปรับปรุงฐานข้อมูลอุปกรณ์ในเครื่อง (localStorage) ให้เป็นชื่อมาตรฐานใหม่ทันที
  const rawAssets = localStorage.getItem('pyh_assets_data');
  if (rawAssets) {
    const arr = JSON.parse(rawAssets);
    if (Array.isArray(arr)) {
      let changed = false;
      arr.forEach(a => {
        if (a && a.type) {
          const nType = cleanAssetType(a.type);
          if (nType !== a.type) {
            a.type = nType;
            changed = true;
          }
        }
      });
      if (changed) {
        localStorage.setItem('pyh_assets_data', JSON.stringify(arr));
      }
    }
  }
} catch (e) { }

let currentOfficer = getCleanName(localStorage.getItem('pyh_officer')) || "นายสุวิทย์ พวงสมบัติ";
let currentUserRole = localStorage.getItem('pyh_role') || "inspector";
let assetsList = [];
let inspectionLogs = [];
let map = null;
let currentTileLayer = null;
let currentOverlayLayer = null;
let markers = [];
let html5QrCode = null;
let currentMapMode = 'building_er_lower'; // เริ่มต้นที่อาคารอุบัติเหตุชั้นล่าง หรือ campus


// ==========================================
// 0. Auth Guard — บังคับ Login ก่อนเข้าใช้ (พร้อม Session Timeout 1 ชม. & Activity Tracking)
// ==========================================

const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 ชั่วโมง (60 นาที)

// ตรวจ session ที่ยังมีอยู่ และเช็คว่าหมดอายุหรือยัง (1 ชม. นับจากกิจกรรมล่าสุด)
function getSession() {
  try {
    const raw = localStorage.getItem('pyh_active_session');
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.officer) return null;

    const now = Date.now();
    // ถ้ามี lastActivity ให้ตรวจ expiration
    if (session.lastActivity) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        // Session หมดอายุแล้ว!
        console.warn("Session expired due to inactivity (> 1 hour).");
        clearSession();
        return null;
      }
    }

    // อัปเดต timestamp กิจกรรมล่าสุด
    updateSessionActivity();
    return session;
  } catch (e) { return null; }
}

function setSession(officer, role) {
  const now = Date.now();
  const sessionData = {
    officer,
    role,
    loginAt: now,
    lastActivity: now
  };
  localStorage.setItem('pyh_active_session', JSON.stringify(sessionData));
  localStorage.setItem('pyh_officer', officer);
  localStorage.setItem('pyh_role', role);
}

function clearSession() {
  localStorage.removeItem('pyh_active_session');
  localStorage.removeItem('pyh_officer');
  localStorage.removeItem('pyh_role');
}

// อัปเดตเวลากิจกรรมล่าสุด (Activity Tracking)
let _lastActivityUpdate = 0;
function updateSessionActivity() {
  const now = Date.now();
  // throttle การเขียน localStorage ไม่ให้เขียนถี่เกินไป (ทุก 10 วินาที)
  if (now - _lastActivityUpdate < 10000) return;
  _lastActivityUpdate = now;

  try {
    const raw = localStorage.getItem('pyh_active_session');
    if (raw) {
      const session = JSON.parse(raw);
      if (session && session.officer) {
        session.lastActivity = now;
        localStorage.setItem('pyh_active_session', JSON.stringify(session));
      }
    }
  } catch (e) { }
}

// ตรวจสอบการหมดอายุของ Session เป็นระยะ (Periodic Expiration Checker)
function checkSessionExpiration() {
  try {
    const raw = localStorage.getItem('pyh_active_session');
    if (!raw) return;
    const session = JSON.parse(raw);
    if (session && session.lastActivity) {
      if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
        console.warn("Session expired! Logging out automatically.");
        clearSession();
        currentOfficer = '';
        currentUserRole = '';
        if (typeof applyUserSession === 'function') {
          applyUserSession('ผู้เยี่ยมชม (Guest)', 'guest');
        }
        alert("⏰ เซสชันของคุณหมดอายุเนื่องจากไม่มีการใช้งานเกิน 1 ชั่วโมง\nระบบได้ออกจากระบบเพื่อความปลอดภัย กรุณาเข้าสู่ระบบใหม่อีกครั้ง");
        showLoginScreen();
      }
    }
  } catch (e) { }
}

// ตั้ง Interval ตรวจสอบทุก 1 นาที
setInterval(checkSessionExpiration, 60 * 1000);

// ดักจับ User Activity (คลิก, แตะหน้าจอ, กดปุ่มคีย์บอร์ด, เลื่อนหน้าจอ) เพื่อรีเฟรชเวลา
['click', 'keydown', 'touchstart', 'scroll'].forEach(eventType => {
  window.addEventListener(eventType, () => {
    updateSessionActivity();
  }, { passive: true });
});

function showLoginScreen() {
  const screen = document.getElementById('login-screen');
  if (screen) screen.style.display = 'flex';
}

function hideLoginScreen() {
  const screen = document.getElementById('login-screen');
  if (screen) {
    screen.style.opacity = '0';
    screen.style.transition = 'opacity 0.4s ease';
    setTimeout(() => screen.style.display = 'none', 400);
  }
}

// เรียกเมื่อ login สำเร็จ — ซ่อน login screen แล้วเริ่ม app
async function onLoginSuccess(officer, role) {
  setSession(officer, role);
  currentOfficer = officer;
  currentUserRole = role;

  if (typeof applyUserSession === 'function') {
    applyUserSession(officer, role);
  } else {
    const nameEl = document.getElementById('display-user-name');
    const roleEl = document.getElementById('display-user-role');
    if (nameEl) nameEl.innerText = officer;
    if (roleEl) roleEl.innerText = role === 'admin' ? 'ผู้ดูแลระบบ (Admin)' :
      role === 'executive' ? 'ผู้บริหาร' : 'เจ้าหน้าที่ผู้ตรวจ';
  }

  hideLoginScreen();
  await initAssets(); // โหลดข้อมูลหลัง login เท่านั้น
}

// ฟังก์ชัน login จากหน้า Login Screen (ไม่ใช่ modal)
window.loginScreenSubmit = async function () {
  const emailInput = document.getElementById('ls-email');
  const pwdInput = document.getElementById('ls-pwd');
  const errBox = document.getElementById('login-screen-error');
  const btn = document.getElementById('ls-submit-btn');
  const email = emailInput ? emailInput.value.trim() : '';
  const pwd = pwdInput ? pwdInput.value : '';

  if (!email || !pwd) {
    if (errBox) { errBox.textContent = 'กรุณากรอกอีเมลและรหัสผ่าน'; errBox.style.display = 'block'; }
    return;
  }
  if (errBox) errBox.style.display = 'none';
  if (btn) { btn.textContent = 'กำลังเข้าสู่ระบบ...'; btn.disabled = true; }

  // โหลด users จาก Firestore ก่อนเสมอ
  const users = await loadUsersFromFirestore();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

  if (user) {
    if (user.password !== pwd) {
      if (errBox) { errBox.textContent = '❌ รหัสผ่านไม่ถูกต้อง'; errBox.style.display = 'block'; }
      if (btn) { btn.textContent = '🔑 เข้าสู่ระบบ'; btn.disabled = false; }
      return;
    }
    if (!user.verified) {
      if (errBox) { errBox.textContent = '❌ บัญชียังไม่ได้รับการยืนยันจาก Admin'; errBox.style.display = 'block'; }
      if (btn) { btn.textContent = '🔑 เข้าสู่ระบบ'; btn.disabled = false; }
      return;
    }
    const officer = user.name + ' (' + user.dept + ')';
    await onLoginSuccess(officer, user.role);
    if (emailInput) emailInput.value = '';
    if (pwdInput) pwdInput.value = '';
    return;
  }

  // ถ้าไม่มีใน local ลองผ่าน Firebase Auth
  if (isFirebaseReady() && auth) {
    try {
      const cred = await signInWithEmailAndPassword(auth, email, pwd);
      const officer = cred.user.email;
      await onLoginSuccess(officer, 'inspector');
      if (emailInput) emailInput.value = '';
      if (pwdInput) pwdInput.value = '';
    } catch (err) {
      const msg = err.code === 'auth/invalid-credential' ? '❌ อีเมลหรือรหัสผ่านไม่ถูกต้อง' : '❌ ' + err.message;
      if (errBox) { errBox.textContent = msg; errBox.style.display = 'block'; }
      if (btn) { btn.textContent = '🔑 เข้าสู่ระบบ'; btn.disabled = false; }
    }
    return;
  }

  if (errBox) { errBox.textContent = '❌ ไม่พบบัญชีผู้ใช้นี้ในระบบ'; errBox.style.display = 'block'; }
  if (btn) { btn.textContent = '🔑 เข้าสู่ระบบ'; btn.disabled = false; }
};

// กด Enter ใน input ก็ submit ได้
document.addEventListener('DOMContentLoaded', () => {
  ['ls-email', 'ls-pwd'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') window.loginScreenSubmit(); });
  });

  // โหมด Guest — เปิดให้ดูได้ทันทีโดยไม่ต้อง login
  // ถ้ามี session เดิมอยู่ ให้ใช้ต่อ (ไม่ต้องพิมพ์ใหม่แม้จะกด F5)
  const session = getSession();
  if (session && session.officer) {
    currentOfficer = session.officer;
    currentUserRole = session.role;
    applyUserSession(session.officer, session.role);
  } else {
    // Guest — กำหนดสิทธิ์และซ่อนปุ่มการกระทำทั้งหมด
    currentOfficer = '';
    currentUserRole = 'guest';
    applyUserSession('ผู้เยี่ยมชม (Guest)', 'guest');
  }

  // โหลดข้อมูลและแสดงแอปทันที (ไม่บังคับ login)
  initAssets();

  // เรนเดอร์คู่มือขั้นตอนการตรวจ
  if (typeof window.renderInspectionGuideUI === 'function') {
    window.renderInspectionGuideUI();
  }

  // โหลดคู่มือฉบับอัปเดตจาก Firestore (ถ้ามี)
  if (isFirebaseReady() && db) {
    try {
      getDoc(doc(db, "system_configs", "inspection_guide")).then(docSnap => {
        if (docSnap.exists()) {
          const cloudGuide = docSnap.data();
          if (cloudGuide && cloudGuide.feSteps && cloudGuide.emSteps) {
            localStorage.setItem('pyh_inspection_guide', JSON.stringify(cloudGuide));
            if (typeof window.renderInspectionGuideUI === 'function') {
              window.renderInspectionGuideUI();
            }
          }
        }
      }).catch(() => {});
    } catch (e) {}
  }
});

// ออกจากระบบ — ล้าง session แล้วแสดงหน้า Login ใหม่
window.logoutUser = async function () {
  if (!confirm('ต้องการออกจากระบบใช่ไหม?')) return;
  clearSession();
  currentOfficer = '';
  currentUserRole = '';
  if (isFirebaseReady() && auth) {
    try { await signOut(auth); } catch (e) { }
  }
  // กลับเป็น Guest Mode อย่างสมบูรณ์
  if (typeof applyUserSession === 'function') {
    applyUserSession('ผู้เยี่ยมชม (Guest)', 'guest');
  } else {
    const nameEl = document.getElementById('display-user-name');
    const roleEl = document.getElementById('display-user-role');
    if (nameEl) nameEl.innerText = 'ผู้เยี่ยมชม (Guest)';
    if (roleEl) roleEl.innerText = 'ดูข้อมูลเท่านั้น';
  }
};

// ==========================================
// Guard: เช็คก่อนทำ action ที่ต้องการ login
// ใช้งาน: if (!requireLogin('บันทึกข้อมูล')) return;
// ==========================================
function requireLogin(actionName = 'ดำเนินการนี้') {
  const session = getSession();
  if (session && session.officer) return true; // login อยู่แล้ว ✅

  // ยังไม่ login — แสดง login screen พร้อมข้อความแจ้ง
  const errBox = document.getElementById('login-screen-error');
  const screen = document.getElementById('login-screen');
  if (errBox) {
    errBox.textContent = `🔒 กรุณาเข้าสู่ระบบก่อน${actionName}`;
    errBox.style.display = 'block';
  }
  if (screen) {
    screen.style.display = 'flex';
    screen.style.opacity = '1';
    screen.style.transition = 'none';
  }
  return false;
}

// ==========================================
// 1. การสลับแท็บเมนู
// ==========================================
window.switchTab = function (tabId) {
  // บล็อกไม่ให้ Guest สลับไปแท็บอื่นนอกจาก Dashboard & แผนผัง
  if ((currentUserRole === 'guest' || !currentUserRole) && tabId !== 'dashboard') {
    tabId = 'dashboard';
  }

  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(`tab-${tabId}`);
  if (targetTab) targetTab.classList.add('active');

  const activeBtn = document.getElementById(`tab-nav-${tabId}`) || Array.from(document.querySelectorAll('.tab-btn'))
    .find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(tabId));
  if (activeBtn) activeBtn.classList.add('active');

  if (tabId === 'dashboard') {
    if (map) setTimeout(() => map.invalidateSize(), 200);
  }
  if (tabId === 'scanner') {
    startScanner();
  } else {
    stopScanner();
  }
  if (tabId === 'register') {
    setTimeout(() => {
      if (typeof window.initRegisterMap === 'function') window.initRegisterMap();
      if (typeof window.autoSuggestRegisterId === 'function') window.autoSuggestRegisterId();
    }, 150);
  }
  if (tabId === 'assets') {
    if (typeof window.renderAssetListTable === 'function') window.renderAssetListTable();
  }
  if (tabId === 'history') {
    if (typeof renderHistoryTable === 'function') renderHistoryTable();
  }
  if (tabId === 'report') {
    if (typeof window.autoLoadExecutiveFullReport === 'function') {
      window.autoLoadExecutiveFullReport();
    }
  }
  if (tabId === 'admin') {
    if (typeof window.renderAdminUserList === 'function') {
      window.renderAdminUserList();
    }
  }
};

// ==========================================
// ฟังก์ชันคัดกรองข้อมูลอุปกรณ์ที่ซ้ำซ้อน และปรับปรุงชื่อประเภทให้อยู่ในมาตรฐานเดียวกัน
function deduplicateAssets(list) {
  if (!Array.isArray(list)) return [];
  const map = new Map();
  for (const item of list) {
    if (!item || !item.assetId) continue;
    // ปรับประเภทอุปกรณ์ให้เป็นชื่อมาตรฐานทางการ
    if (item.type) {
      item.type = cleanAssetType(item.type);
    }
    const key = item.assetId.trim().toUpperCase();
    if (!map.has(key)) {
      map.set(key, item);
    } else {
      // หากพบซ้ำ ให้เลือกล่าสุดหรือที่มีข้อมูลสมบูรณ์กว่า
      const existing = map.get(key);
      const chosen = (item.lastChecked && (!existing.lastChecked || item.lastChecked > existing.lastChecked)) ? item : existing;
      map.set(key, chosen);
    }
  }
  return Array.from(map.values());
}

// 2. จัดการข้อมูลอุปกรณ์ (Assets Initialization)
// ==========================================
async function initAssets() {
  const localSaved = localStorage.getItem('pyh_assets_data');
  if (localSaved) {
    try {
      assetsList = deduplicateAssets(JSON.parse(localSaved));
      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
    } catch (e) {
      console.warn("Failed to parse local assets", e);
    }
  }

  // หากไม่มีข้อมูลและยังไม่เคยเริ่มระบบ ให้โหลดจาก initial_assets.json เป็นค่าเริ่มต้นครั้งแรก
  const hasInitialized = localStorage.getItem('pyh_has_initialized');
  if (!hasInitialized && (!assetsList || assetsList.length === 0)) {
    try {
      const resp = await fetch('initial_assets.json');
      const data = await resp.json();
      assetsList = deduplicateAssets(data.assets || []);
      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
      localStorage.setItem('pyh_has_initialized', 'true');
    } catch (e) {
      console.error("Could not load initial_assets.json", e);
    }
  } else if (!hasInitialized && assetsList && assetsList.length > 0) {
    localStorage.setItem('pyh_has_initialized', 'true');
  }

  // โหลดประวัติการตรวจที่มีในเครื่อง
  const localLogs = localStorage.getItem('pyh_inspection_logs');
  if (localLogs) {
    try {
      inspectionLogs = JSON.parse(localLogs);
    } catch (e) { }
  }

  // หากเปิดใช้ Firebase จริง ให้ซิงก์จาก Firestore
  if (isFirebaseReady() && db) {
    try {
      const q = collection(db, "assets");
      onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
          const rawAssets = [];
          snapshot.forEach(d => {
            const data = d.data();
            const originalType = data.type || '';
            const normalizedType = cleanAssetType(originalType);
            // หากใน Firestore ยังเป็นประเภทรูปแบบเก่า ให้อัปเดตเป็นชื่อทางการใหม่เฉพาะเมื่อมีล็อกอินมีสิทธิ์เขียน
            const canWrite = auth && auth.currentUser && (currentUserRole === 'admin' || currentUserRole === 'inspector');
            if (canWrite && originalType !== normalizedType && d.id) {
              updateDoc(doc(db, "assets", d.id), { type: normalizedType }).catch(() => {});
            }
            rawAssets.push({ firestoreId: d.id, ...data, type: normalizedType });
          });
          assetsList = deduplicateAssets(rawAssets);
          localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
        } else {
          // หากบน Cloud ว่างเปล่า (ถูกลบออกหมดแล้ว) ให้เคลียร์ข้อมูลในเครื่องด้วย
          assetsList = [];
          localStorage.setItem('pyh_assets_data', JSON.stringify([]));
        }
        updateDashboardUI();
        renderMapPins();
        if (typeof renderAssetListTable === 'function') renderAssetListTable();
        if (typeof autoSuggestRegisterId === 'function') autoSuggestRegisterId();
      });

      const qLogs = query(collection(db, "inspection_logs"), orderBy("timestamp", "desc"));
      onSnapshot(qLogs, (snapshot) => {
        inspectionLogs = [];
        snapshot.forEach(d => inspectionLogs.push({ id: d.id, ...d.data() }));
        renderHistoryTable();
      });

      // ซิงก์สถานะตราประทับและคำสั่งการดิจิทัล (Digital Signatures) ทั้ง 3 ฝ่ายจาก Firestore แบบ Realtime
      const certDocRef = doc(db, "system_state", "report_certifications");
      onSnapshot(certDocRef, (docSnap) => {
        if (docSnap.exists()) {
          const cloudCert = docSnap.data();
          if (cloudCert.tech_cert) {
            localStorage.setItem('pyh_tech_certification', JSON.stringify(cloudCert.tech_cert));
          } else if (cloudCert.tech_cert === null) {
            localStorage.removeItem('pyh_tech_certification');
          }

          if (cloudCert.chef_cert) {
            localStorage.setItem('pyh_chef_certification', JSON.stringify(cloudCert.chef_cert));
          } else if (cloudCert.chef_cert === null) {
            localStorage.removeItem('pyh_chef_certification');
          }

          if (cloudCert.exec_cert) {
            localStorage.setItem('pyh_exec_certification', JSON.stringify(cloudCert.exec_cert));
          } else if (cloudCert.exec_cert === null) {
            localStorage.removeItem('pyh_exec_certification');
          }

          if (cloudCert.exec_decision) {
            localStorage.setItem('pyh_executive_decision', JSON.stringify(cloudCert.exec_decision));
          } else if (cloudCert.exec_decision === null) {
            localStorage.removeItem('pyh_executive_decision');
          }

          // อัปเดต UI ที่แสดงผลทันทีทุกเครื่องที่เปิดอยู่
          if (typeof window.renderTechCertificationUI === 'function') window.renderTechCertificationUI();
          if (typeof window.renderChefCertificationUI === 'function') window.renderChefCertificationUI();
          if (typeof window.renderExecutiveCertificationUI === 'function') window.renderExecutiveCertificationUI();
          // อัปเดตมุมมอง decision ในหน้าจอรายงาน (ถ้าเปิดอยู่) โดยไม่ sync ซ้ำ
          if (cloudCert.exec_decision && cloudCert.exec_decision.decision) {
            const dec = cloudCert.exec_decision.decision;
            const isAck = (dec === 'acknowledge');
            const radAck = document.getElementById('rad-appr-ack');
            const radRepair = document.getElementById('rad-appr-repair');
            if (radAck) radAck.checked = isAck;
            if (radRepair) radRepair.checked = !isAck;
            const printAck = document.getElementById('print-appr-ack');
            const printRepair = document.getElementById('print-appr-repair');
            if (printAck) printAck.innerHTML = isAck ? '<b>[ ✓ ] รับทราบ</b>' : '[ &nbsp; ] รับทราบ';
            if (printRepair) printRepair.innerHTML = !isAck ? '<b>[ ✓ ] อนุมัติซ่อมแซม</b>' : '[ &nbsp; ] อนุมัติซ่อมแซม';
            const screenAck = document.getElementById('screen-view-ack');
            const screenRepair = document.getElementById('screen-view-repair');
            if (screenAck) screenAck.innerHTML = isAck ? '<b style="color:#0284c7;">[ ✓ ] รับทราบ</b>' : '[ &nbsp; ] รับทราบ';
            if (screenRepair) screenRepair.innerHTML = !isAck ? '<b style="color:#059669;">[ ✓ ] อนุมัติซ่อมแซม</b>' : '[ &nbsp; ] อนุมัติซ่อมแซม';
          }
        }
      });
    } catch (e) {
      console.warn("Firebase sync error, using local fallback", e);
    }
  }

  updateDashboardUI();
  renderHistoryTable();
  initMap();
  if (typeof window.autoSuggestRegisterId === 'function') {
    window.autoSuggestRegisterId();
  }
}

// อัปเดตข้อมูลสรุป Dashboard & KPIs
function updateDashboardUI() {
  const total = assetsList.length;
  const ready = assetsList.filter(a => a.status === 'READY').length;
  const repairing = assetsList.filter(a => a.status === 'REPAIRING').length;
  const issue = assetsList.filter(a => a.status === 'ISSUE').length;
  const checkedThisMonth = assetsList.filter(a => a.lastChecked).length;
  const coverageRate = total > 0 ? Math.round((checkedThisMonth / total) * 100) : 0;

  const totalEl = document.getElementById('total-count');
  const readyEl = document.getElementById('ready-count');
  const repairEl = document.getElementById('repair-count');
  const issueEl = document.getElementById('issue-count');
  const rateEl = document.getElementById('coverage-rate');

  if (totalEl) totalEl.innerText = total;
  if (readyEl) readyEl.innerText = ready;
  if (repairEl) repairEl.innerText = repairing;
  if (issueEl) issueEl.innerText = issue;
  if (rateEl) rateEl.innerText = `${coverageRate}%`;
}

// ==========================================
// 3. แผนที่ Leaflet (Campus + 6 Floor Plans)
// ==========================================
function initMap() {
  const mapElem = document.getElementById('floor-map');
  if (!mapElem) return;
  if (map) return; // ป้องกัน initialize ซ้ำ

  // สร้าง Map Instance เริ่มต้น (ตั้งค่า Zoom ให้คมชัดและนุ่มนวล)
  map = L.map('floor-map', {
    crs: L.CRS.Simple,
    minZoom: -1,
    maxZoom: 2,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120
  });

  changeMapLevel();
}

window.selectBuildingFloor = function (buildingId) {
  const select = document.getElementById('map-mode-select');
  if (select) {
    select.value = buildingId;
    window.changeMapLevel();
  }
};

function updateBuildingButtonStates(activeMode) {
  const buttons = document.querySelectorAll('.bldg-nav-btn');
  buttons.forEach(btn => {
    const isCampus = btn.getAttribute('onclick')?.includes(`'campus'`);
    const isActive = btn.getAttribute('onclick')?.includes(`'${activeMode}'`);
    if (isActive) {
      btn.style.background = '#0284c7';
      btn.style.color = '#ffffff';
      btn.style.borderColor = '#0284c7';
      btn.style.boxShadow = '0 2px 5px rgba(2,132,199,0.35)';
    } else {
      btn.style.background = '#ffffff';
      btn.style.color = '#0f766e';
      btn.style.borderColor = '#cbd5e1';
      btn.style.boxShadow = 'none';
    }
  });
}

window.changeMapLevel = function () {
  const selectedMode = document.getElementById('map-mode-select').value;
  currentMapMode = selectedMode;
  updateBuildingButtonStates(selectedMode);

  const targetCRS = (selectedMode === 'campus') ? L.CRS.EPSG3857 : L.CRS.Simple;

  // Leaflet ไม่รองรับการเปลี่ยน map.options.crs ในอินสแตนซ์เดิมแบบไดนามิก (จะทำให้พิกัดและการแปลง Projection พัง/กลายเป็นสีว่างเปล่า)
  // หากมีการสลับระหว่าง Campus (พิกัดดาวเทียมจริง EPSG3857) กับ ผังอาคาร (พิกัดพิกเซลราบ Simple) จำเป็นต้อง re-create map instance ใหม่
  if (map && map.options.crs !== targetCRS) {
    if (currentTileLayer && map.hasLayer(currentTileLayer)) map.removeLayer(currentTileLayer);
    if (currentOverlayLayer && map.hasLayer(currentOverlayLayer)) map.removeLayer(currentOverlayLayer);
    markers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
    markers = [];
    map.remove();
    map = null;
  }

  if (!map) {
    const isCampus = (selectedMode === 'campus');
    map = L.map('floor-map', {
      crs: targetCRS,
      minZoom: isCampus ? 16 : -1,
      maxZoom: isCampus ? 20 : 4,
      zoomSnap: isCampus ? 1 : 0.25,
      zoomDelta: isCampus ? 1 : 0.5,
      wheelPxPerZoomLevel: 120
    });
  } else {
    // ปลดล็อคขอบเขตเดิมก่อนเปลี่ยนโหมด เพื่อไม่ให้ถูกตีกรอบหลุด
    map.setMaxBounds(null);
    if (currentTileLayer && map.hasLayer(currentTileLayer)) map.removeLayer(currentTileLayer);
    if (currentOverlayLayer && map.hasLayer(currentOverlayLayer)) map.removeLayer(currentOverlayLayer);
    markers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
    markers = [];
  }

  if (selectedMode === 'campus') {
    map.options.maxBoundsViscosity = 0.8;
    
    // ขอบเขตพิกัดจริงของโรงพยาบาลพยุหะคีรีตามที่ระบุ:
    // จุดอ้างอิง: [15.4765487, 100.1371425] ถึง [15.4776960, 100.1384024]
    const hospitalBounds = L.latLngBounds(
      [15.4750, 100.1355], // ทิศตะวันตกเฉียงใต้ (ครอบคลุมทางเข้า-ออก)
      [15.4795, 100.1400]  // ทิศตะวันออกเฉียงเหนือ (ครอบคลุมอาคารทั้งหมด)
    );

    map.setMaxBounds(hospitalBounds);
    map.setMinZoom(16); // ซูมออกได้พอดีกับขอบเขตพื้นที่โรงพยาบาล
    map.setMaxZoom(20); // ซูมเข้าได้ถึงระดับ 20 เห็นหลังคาตึกชัดเจน
    
    // แผนที่ภาพถ่ายดาวเทียมความคมชัดสูงเฉพาะบริเวณโรงพยาบาลพยุหะคีรี
    currentTileLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
      subdomains: ['0', '1', '2', '3'],
      minZoom: 16,
      maxZoom: 20,
      bounds: hospitalBounds,
      attribution: '© Google Maps Satellite - โรงพยาบาลพยุหะคีรี'
    }).addTo(map);

    // เล็งจุดกึ่งกลางพื้นที่โรงพยาบาลพยุหะคีรี
    map.setView([15.47712, 100.13777], 18);
  } else {
    const cfg = floorConfigs[selectedMode];
    if (!cfg) return;

    currentOverlayLayer = L.imageOverlay(cfg.imageUrl, cfg.bounds).addTo(map);
    
    // ล็อคขอบเขตไม่ให้เลื่อนหลุดผัง และคำนวณการย่อสุดให้พอดีจอพอดี
    map.options.maxBoundsViscosity = 1.0;
    map.setMaxBounds(cfg.bounds);
    map.setMaxZoom(4); // ขยายได้เต็มที่ระดับ 4 เพื่อส่องดูรายละเอียดชัดเจน
    
    map.fitBounds(cfg.bounds);
    const fitZoom = map.getBoundsZoom(cfg.bounds);
    map.setMinZoom(fitZoom); // ล็อคระดับย่อสุดให้หยุดที่พอดีกับหน้าจอ ไม่หลุดขอบ
  }

  setTimeout(() => {
    if (map) map.invalidateSize();
  }, 100);

  renderMapPins();
};

function showMapToast(msg) {
  let toast = document.getElementById('map-toast-notification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'map-toast-notification';
    toast.className = 'map-toast';
    document.body.appendChild(toast);
  }
  toast.innerText = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

let activeRelocateAssetId = null;

window.startRelocatePin = function (assetId) {
  const item = assetsList.find(a => a.assetId === assetId);
  if (!item) return;

  activeRelocateAssetId = assetId;
  if (map) map.closePopup();

  let relocateBanner = document.getElementById('map-relocate-banner');
  if (!relocateBanner) {
    relocateBanner = document.createElement('div');
    relocateBanner.id = 'map-relocate-banner';
    relocateBanner.style.cssText = 'background:#0284c7; color:white; padding:10px 16px; border-radius:8px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; font-weight:600; font-size:13px; box-shadow:0 2px 8px rgba(0,0,0,0.2);';
    const floorMapElem = document.getElementById('floor-map');
    if (floorMapElem && floorMapElem.parentNode) {
      floorMapElem.parentNode.insertBefore(relocateBanner, floorMapElem);
    }
  }

  relocateBanner.innerHTML = `
    <div>📍 <b>กำลังย้ายจุด [${item.assetId}]:</b> กรุณาคลิกบนแผนที่ ณ จุดติดตั้งใหม่ที่ต้องการ</div>
    <button onclick="cancelRelocatePin()" class="btn-sm" style="background:#ffffff; color:#0284c7; border:none; padding:4px 12px; font-weight:700; border-radius:6px; cursor:pointer;">✕ ยกเลิก</button>
  `;
  relocateBanner.style.display = 'flex';

  if (map) {
    map.getContainer().style.cursor = 'crosshair';
    map.once('click', function (e) {
      if (!activeRelocateAssetId) return;

      if (currentMapMode === 'campus') {
        item.campusCoord = { lat: e.latlng.lat, lng: e.latlng.lng };
      } else {
        const newY = Math.round(e.latlng.lat);
        const newX = Math.round(e.latlng.lng);
        item.floorCoord = [newY, newX];
      }

      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
      if (isFirebaseReady() && db && item.firestoreId) {
        const updateData = (currentMapMode === 'campus') ? { campusCoord: item.campusCoord } : { floorCoord: item.floorCoord };
        updateDoc(doc(db, "assets", item.firestoreId), updateData).catch(err => console.warn(err));
      }

      window.cancelRelocatePin();
      renderMapPins();
      showMapToast('📍 ย้ายตำแหน่ง [' + item.assetId + '] เรียบร้อยแล้ว');
    });
  }
};

window.cancelRelocatePin = function () {
  activeRelocateAssetId = null;
  const relocateBanner = document.getElementById('map-relocate-banner');
  if (relocateBanner) relocateBanner.style.display = 'none';
  if (map) map.getContainer().style.cursor = '';
};

// ==========================================
// การเพิ่มจุดติดตั้งใหม่บนแดชบอร์ดโดย Admin (Quick Add on Dashboard)
// ==========================================
let isAddingAssetOnDashboard = false;
let quickAddFloorCoord = [280, 500];
let quickAddCampusCoord = { lat: 15.4544, lng: 100.1347 };

window.startAddAssetOnDashboard = function () {
  if (currentUserRole !== 'admin') {
    alert("ขออภัย: ฟังก์ชันนี้เฉพาะผู้ดูแลระบบ (Admin) เท่านั้น");
    return;
  }

  isAddingAssetOnDashboard = true;
  if (map) map.closePopup();

  let addBanner = document.getElementById('map-add-asset-banner');
  if (!addBanner) {
    addBanner = document.createElement('div');
    addBanner.id = 'map-add-asset-banner';
    const floorMapElem = document.getElementById('floor-map');
    if (floorMapElem && floorMapElem.parentNode) {
      floorMapElem.parentNode.insertBefore(addBanner, floorMapElem);
    }
  }

  const currentBuildingName = (currentMapMode === 'campus')
    ? 'ภาพรวมวิทยาเขต (GPS)'
    : (floorConfigs[currentMapMode]?.name || 'ผังอาคารปัจจุบัน');

  addBanner.style.cssText = 'background:linear-gradient(135deg, #059669, #10b981); color:white; padding:12px 16px; border-radius:8px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; font-weight:600; font-size:13px; box-shadow:0 3px 10px rgba(0,0,0,0.2);';
  addBanner.innerHTML = `
    <div>➕ <b>โหมดเพิ่มอุปกรณ์ [${currentBuildingName}]:</b> กรุณาคลิกบนตำแหน่งที่ต้องการติดตั้งบนผัง</div>
    <button onclick="cancelAddAssetOnDashboard()" class="btn-sm" style="background:#ffffff; color:#059669; border:none; padding:4px 12px; font-weight:700; border-radius:6px; cursor:pointer;">✕ ยกเลิก</button>
  `;
  addBanner.style.display = 'flex';

  if (map) {
    map.getContainer().style.cursor = 'crosshair';
    map.once('click', function (e) {
      if (!isAddingAssetOnDashboard) return;

      if (currentMapMode === 'campus') {
        quickAddCampusCoord = { lat: e.latlng.lat, lng: e.latlng.lng };
        quickAddFloorCoord = [280, 500];
      } else {
        const newY = Math.round(e.latlng.lat);
        const newX = Math.round(e.latlng.lng);
        quickAddFloorCoord = [newY, newX];
        quickAddCampusCoord = { lat: 15.47712, lng: 100.13777 };
      }

      window.cancelAddAssetOnDashboard();
      window.openQuickAddModal();
    });
  }
};

window.cancelAddAssetOnDashboard = function () {
  isAddingAssetOnDashboard = false;
  const addBanner = document.getElementById('map-add-asset-banner');
  if (addBanner) addBanner.style.display = 'none';
  if (map) map.getContainer().style.cursor = '';
};

window.openQuickAddModal = function () {
  const modal = document.getElementById('quick-add-modal');
  if (!modal) return;

  const currentBuildingName = (currentMapMode === 'campus')
    ? 'อาคารอุบัติเหตุ (ชั้นล่าง)'
    : (floorConfigs[currentMapMode]?.name || 'อาคารอุบัติเหตุ (ชั้นล่าง)');

  const buildingLabel = document.getElementById('quick-add-building-label');
  if (buildingLabel) buildingLabel.innerText = currentBuildingName;

  const coordLabel = document.getElementById('quick-add-coord-label');
  if (coordLabel) {
    if (currentMapMode === 'campus') {
      coordLabel.innerText = `GPS: ${quickAddCampusCoord.lat.toFixed(5)}, ${quickAddCampusCoord.lng.toFixed(5)}`;
    } else {
      coordLabel.innerText = `ผังชั้น: Y: ${quickAddFloorCoord[0]}, X: ${quickAddFloorCoord[1]}`;
    }
  }

  window.autoSuggestQuickAddId();
  modal.classList.remove('hidden');
};

window.closeQuickAddModal = function () {
  const modal = document.getElementById('quick-add-modal');
  if (modal) modal.classList.add('hidden');
  isAddingAssetOnDashboard = false;
};

const buildingZoneMap = {
  building_er_lower: 'ER1',
  building_er_upper: 'ER2',
  building_hpc: 'HPC',
  building_ipd: 'IPD',
  building_nisit: 'NSK',
  building_opd_dm: 'OPD',
  building_pharma_rehab: 'PRC',
  building_thai_med: 'TTM',
  building_canteen: 'CAN'
};

window.getNextAssetId = function (buildingId, typeName) {
  const zone = buildingZoneMap[buildingId] || 'ER1';
  const typeStr = (typeName || '').toLowerCase();
  const isFE = typeStr.includes('ถังดับเพลิง') || typeStr.includes('clean') || typeStr.includes('co2') || typeStr.includes('dry') || typeStr.includes('fe') || typeStr.includes('เคมี');
  const typeCode = isFE ? 'FE' : 'EM';
  const prefix = `PYH-${typeCode}-${zone}-`;

  let maxNum = 0;
  if (Array.isArray(assetsList)) {
    assetsList.forEach(a => {
      if (!a.assetId) return;
      const id = a.assetId.trim().toUpperCase();
      if (id.startsWith(prefix)) {
        const numPart = id.slice(prefix.length);
        const n = parseInt(numPart, 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    });
  }

  const nextSeq = String(maxNum + 1).padStart(2, '0');
  return `${prefix}${nextSeq}`;
};

window.autoSuggestQuickAddId = function () {
  const typeSelect = document.getElementById('quick-add-type');
  const idInput = document.getElementById('quick-add-id');
  if (!idInput) return;

  const targetBuildingId = (currentMapMode === 'campus') ? 'building_er_lower' : currentMapMode;
  const type = typeSelect ? typeSelect.value : '';
  const nextId = window.getNextAssetId(targetBuildingId, type);
  idInput.value = nextId;

  const quickBadge = document.getElementById('quick-add-id-auto-badge');
  if (quickBadge) {
    quickBadge.innerText = `⚡ รันต่ออัตโนมัติ: ${nextId}`;
  }
};

window.autoSuggestRegisterId = function () {
  const regIdInput = document.getElementById('reg-id');
  const buildingSelect = document.getElementById('reg-building-select');
  const typeSelect = document.getElementById('reg-type');
  if (!regIdInput || !buildingSelect || !typeSelect) return;

  const buildingId = buildingSelect.value;
  const type = typeSelect.value;
  const nextId = window.getNextAssetId(buildingId, type);
  regIdInput.value = nextId;

  const autoBadge = document.getElementById('reg-id-auto-badge');
  if (autoBadge) {
    autoBadge.innerText = `⚡ รันต่ออัตโนมัติ: ${nextId}`;
  }
};

window.submitQuickAddAsset = async function () {
  if (!requireLogin('เพิ่มอุปกรณ์ใหม่')) return;
  const idInput = document.getElementById('quick-add-id');
  const typeSelect = document.getElementById('quick-add-type');
  const locationInput = document.getElementById('quick-add-location');

  const assetId = idInput ? idInput.value.trim() : '';
  const type = typeSelect ? typeSelect.value : 'ถังดับเพลิง ผงเคมีแห้ง (Dry Chemical)';
  const location = locationInput ? locationInput.value.trim() : 'บริเวณจุดติดตั้งใหม่';

  if (!assetId) {
    alert('กรุณาระบุรหัสประจำอุปกรณ์');
    return;
  }

  if (assetsList.some(a => a.assetId.toUpperCase() === assetId.toUpperCase())) {
    alert(`ขออภัย: รหัสอุปกรณ์ "${assetId}" มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น`);
    return;
  }

  const targetBuildingId = (currentMapMode === 'campus') ? 'building_er_lower' : currentMapMode;
  const targetBuildingName = floorConfigs[targetBuildingId]?.name || 'อาคารอุบัติเหตุ (ชั้นล่าง)';

  const newAsset = {
    assetId: assetId,
    type: type,
    building: targetBuildingName,
    buildingId: targetBuildingId,
    floor: 1,
    location: location,
    status: 'READY',
    lastChecked: new Date().toISOString(),
    lastInspector: currentOfficer,
    notes: 'ติดตั้งใหม่โดยผู้ดูแลระบบ',
    floorCoord: [quickAddFloorCoord[0], quickAddFloorCoord[1]],
    campusCoord: { lat: quickAddCampusCoord.lat, lng: quickAddCampusCoord.lng }
  };

  assetsList.push(newAsset);
  assetsList = deduplicateAssets(assetsList);
  localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

  if (isFirebaseReady() && db) {
    try {
      const docId = assetId.replace(/[^a-zA-Z0-9]/g, '_');
      await setDoc(doc(db, "assets", docId), {
        ...newAsset,
        createdAt: serverTimestamp()
      });
      newAsset.firestoreId = docId;
    } catch (err) {
      console.warn("Firestore save asset error:", err);
    }
  }

  window.closeQuickAddModal();
  updateDashboardUI();
  renderMapPins();
  showMapToast(`✅ บันทึกอุปกรณ์ [${assetId}] บนผังเรียบร้อยแล้ว!`);
};

function renderMapPins() {
  if (!map) return;
  markers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
  markers = [];

  const isAdmin = currentUserRole === 'admin';
  const isGuest = (!currentUserRole || currentUserRole === 'guest');

  if (currentMapMode === 'campus') {
    // โหลดตำแหน่งแลนด์มาร์กอาคารจาก localStorage (หรือค่าเริ่มต้น) เพื่อให้ปรับย้ายตำแหน่งได้
    const defaultLandmarks = [
      { id: 'building_er_lower', name: '🏢 ตึกอุบัติเหตุ (ชั้นล่าง)', sub: 'ER 1', lat: 15.47715, lng: 100.13780 },
      { id: 'building_er_upper', name: '🏢 ตึกอุบัติเหตุ (ชั้นบน)', sub: 'ห้องบริหารทั่วไป', lat: 15.47732, lng: 100.13780 },
      { id: 'building_hpc', name: '🏥 ส่งเสริมสุขภาพ (HPC)', sub: 'ตรวจสุขภาพ & ทันตกรรม', lat: 15.47675, lng: 100.13735 },
      { id: 'building_ipd', name: '🛏️ ผู้ป่วยใน (IPD)', sub: 'หอผู้ป่วยใน', lat: 15.47738, lng: 100.13825 },
      { id: 'building_nisit', name: '🩺 ตึกนิสิตคุณากร', sub: 'Covid-19 / ARI Clinic', lat: 15.47648, lng: 100.13752 },
      { id: 'building_opd_dm', name: '🏥 ตึกแก้วกัลยา (OPD)', sub: 'อาคารผู้ป่วยนอก', lat: 15.47762, lng: 100.13798 },
      { id: 'building_pharma_rehab', name: '💊 เวชศาสตร์ฯ-โภชนาการ-คลังยา', sub: 'เวชศาสตร์ฟื้นฟู-คลังยา-จ่ายกลาง', lat: 15.47690, lng: 100.13845 },
      { id: 'building_thai_med', name: '🌿 อาคารแพทย์แผนไทย', sub: 'แพทย์แผนไทยและแพทย์ทางเลือก', lat: 15.47660, lng: 100.13815 },
      { id: 'building_canteen', name: '🍲 อาคารโรงอาหาร', sub: 'ศูนย์อาหารและร้านค้า', lat: 15.47635, lng: 100.13785 }
    ];

    let campusLandmarks = defaultLandmarks;
    try {
      const savedLandmarks = localStorage.getItem('pyh_campus_landmarks');
      if (savedLandmarks) {
        const parsed = JSON.parse(savedLandmarks);
        campusLandmarks = defaultLandmarks.map(def => {
          const found = parsed.find(p => p.id === def.id);
          return found ? { ...def, lat: found.lat, lng: found.lng } : def;
        });
      }
    } catch (e) { }

    window.saveCampusLandmarkCoord = function(bldgId, newLat, newLng) {
      let saved = [];
      try {
        const raw = localStorage.getItem('pyh_campus_landmarks');
        if (raw) saved = JSON.parse(raw);
      } catch (e) { }
      const idx = saved.findIndex(s => s.id === bldgId);
      if (idx >= 0) {
        saved[idx].lat = newLat;
        saved[idx].lng = newLng;
      } else {
        saved.push({ id: bldgId, lat: newLat, lng: newLng });
      }
      localStorage.setItem('pyh_campus_landmarks', JSON.stringify(saved));
      if (isFirebaseReady() && db) {
        setDoc(doc(db, "system_settings", "campus_landmarks"), { landmarks: saved }, { merge: true }).catch(err => console.warn(err));
      }
    };

    campusLandmarks.forEach(bldg => {
      const bldgIcon = L.divIcon({
        html: `
          <div style="background:linear-gradient(135deg, #0284c7, #0369a1); color:white; padding:4px 8px; border-radius:14px; font-size:11px; font-weight:bold; white-space:nowrap; border:2px solid #ffffff; box-shadow:0 3px 8px rgba(0,0,0,0.4); display:flex; align-items:center; gap:4px; cursor:${isAdmin ? 'grab' : 'pointer'};">
            ${isAdmin ? '<span style="opacity:0.8;">⠿</span>' : ''}<span>${bldg.name}</span>
          </div>
        `,
        className: 'campus-building-label',
        iconAnchor: [50, 15]
      });

      const bldgMarker = L.marker([bldg.lat, bldg.lng], {
        icon: bldgIcon,
        zIndexOffset: 500,
        draggable: isAdmin
      }).addTo(map);

      if (isAdmin) {
        bldgMarker.on('dragstart', function () {
          bldgMarker.closePopup();
          if (map) map.dragging.disable();
        });

        bldgMarker.on('dragend', function (e) {
          if (map) map.dragging.enable();
          const newPos = e.target.getLatLng();
          bldg.lat = newPos.lat;
          bldg.lng = newPos.lng;
          window.saveCampusLandmarkCoord(bldg.id, newPos.lat, newPos.lng);
          showMapToast(`📍 ย้ายตำแหน่งป้าย [${bldg.name}] เรียบร้อยแล้ว`);
        });
      }

      bldgMarker.bindPopup(`
        <div style="font-size:13px; text-align:center; min-width:180px; padding:4px;">
          <b style="color:#0284c7; font-size:14px;">${bldg.name}</b><br>
          <span style="color:#64748b; font-size:11.5px;">${bldg.sub}</span>
          ${isAdmin ? `
            <div style="margin-top:6px; font-size:10.5px; color:#16a34a; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:4px; padding:3px 6px;">
              🛠️ <b>สิทธิ์แอดมิน:</b> คลิกลากป้ายเพื่อขยับจุดได้ทันที
            </div>
          ` : ''}
          <div style="margin-top:8px;">
            <button onclick="selectBuildingFloor('${bldg.id}')" class="btn-sm" style="width:100%; background:#0284c7; color:white; border:none; padding:8px 12px; font-weight:700; border-radius:6px; cursor:pointer;">
              🗺️ คลิกเปิดดูผังอาคารนี้
            </button>
          </div>
        </div>
      `);
      markers.push(bldgMarker);
    });

    const campusAssets = assetsList.filter(a => a.campusCoord);
    campusAssets.forEach((item, index) => {
      const isReady = item.status === 'READY';
      const color = isReady ? '#16a34a' : '#dc2626';

      let marker;
      if (isAdmin) {
        const pinIcon = L.divIcon({
          html: '<div class="admin-draggable-pin" style="background:' + color + '; border:2.5px solid #ffffff; box-shadow:0 0 10px rgba(0,0,0,0.6); width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; font-size:12px; font-weight:bold; cursor:grab;"><span style="pointer-events:none;">⠿</span></div>',
          className: 'custom-pin-container',
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });

        marker = L.marker([item.campusCoord.lat, item.campusCoord.lng], {
          icon: pinIcon,
          draggable: true,
          title: '[แอดมิน] คลิกลากเพื่อย้าย ' + item.assetId
        }).addTo(map);

        marker.on('dragstart', function () {
          marker.closePopup();
          if (map) map.dragging.disable();
        });

        marker.on('dragend', function (e) {
          if (map) map.dragging.enable();
          const newLatLng = e.target.getLatLng();
          item.campusCoord = { lat: newLatLng.lat, lng: newLatLng.lng };
          localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
          if (isFirebaseReady() && db && item.firestoreId) {
            updateDoc(doc(db, "assets", item.firestoreId), { campusCoord: item.campusCoord }).catch(err => console.warn(err));
          }
          showMapToast('📍 ย้ายพิกัดดาวเทียมของ [' + item.assetId + '] เรียบร้อยแล้ว');
        });
      } else {
        marker = L.circleMarker([item.campusCoord.lat, item.campusCoord.lng], {
          color: '#ffffff',
          fillColor: color,
          fillOpacity: 0.9,
          weight: 2,
          radius: 8
        }).addTo(map);
      }

      const adminPopupHtml = isAdmin ? `
        <div style="margin:8px 0; padding:8px 10px; background:#f0fdf4; border:1px solid #86efac; border-radius:6px; text-align:left;">
          <div style="font-size:12px; color:#166534; font-weight:700; margin-bottom:3px;">🛠️ สิทธิ์แอดมิน: ย้ายจุดติดตั้ง</div>
          <div style="font-size:11px; color:#15803d; line-height:1.3;">• คลิกลากหมุด <b>⠿</b> บนแผนที่ หรือ</div>
          <button onclick="startRelocatePin('${item.assetId}')" class="btn-sm" style="margin-top:5px; width:100%; background:#0284c7; color:white; font-size:11.5px; padding:6px 10px; font-weight:600; border:none; border-radius:5px; cursor:pointer;">
            📍 คลิกที่นี่เพื่อย้ายตำแหน่งจุดนี้
          </button>
        </div>
      ` : '';

      marker.bindPopup(`
        <div style="font-size:13px;">
          <div style="display:inline-block; background:#e0f2fe; color:#0369a1; font-weight:bold; padding:2px 8px; border-radius:4px; font-size:11px; margin-bottom:4px;">ลำดับที่ ${index + 1}</div><br>
          <b>${item.assetId}</b><br>
          ${item.type}<br>
          ${item.building} (${item.location})<br>
          สถานะ: <b style="color:${color}">${isReady ? '✅ พร้อมใช้งาน' : item.status === 'REPAIRING' ? '🛠️ อยู่ระหว่างส่งซ่อม' : '⚠️ ชำรุด/แจ้งซ่อม'}</b><br>
          ${adminPopupHtml}
          ${(!isGuest && item.status === 'ISSUE') ? `<button onclick="markAssetRepairing('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background:#f59e0b; color:white;">🔧 ส่งซ่อมบำรุง</button>` : ''}
          ${(!isGuest && item.status === 'REPAIRING') ? `<button onclick="openRepairCompleteModal('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background:#10b981; color:white;">✅ ซ่อมเสร็จแล้ว</button>` : ''}
          ${!isGuest ? `<button onclick="handleScanned('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background:#00695c; color:white;">ตรวจเช็กจุดนี้</button>` : ''}
        </div>
      `);
      markers.push(marker);
    });
  } else {
    // ปักหมุดบนผังอาคาร
    const buildingAssets = assetsList.filter(a => a.buildingId === currentMapMode);
    buildingAssets.forEach((item, index) => {
      if (!item.floorCoord) return;
      const isReady = item.status === 'READY';
      const pinColor = isReady ? '#16a34a' : '#dc2626';

      let marker;
      if (isAdmin) {
        const pinIcon = L.divIcon({
          html: '<div class="admin-draggable-pin" style="background:' + pinColor + '; border:2.5px solid #ffffff; box-shadow:0 0 10px rgba(0,0,0,0.6); width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; font-size:12px; font-weight:bold; cursor:grab;"><span style="pointer-events:none;">⠿</span></div>',
          className: 'custom-pin-container',
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });

        marker = L.marker(item.floorCoord, {
          icon: pinIcon,
          draggable: true,
          title: '[แอดมิน] คลิกลากเพื่อย้าย ' + item.assetId
        }).addTo(map);

        marker.on('dragstart', function () {
          marker.closePopup();
          if (map) map.dragging.disable();
        });

        marker.on('dragend', function (e) {
          if (map) map.dragging.enable();
          const newLatLng = e.target.getLatLng();
          const newY = Math.round(newLatLng.lat);
          const newX = Math.round(newLatLng.lng);
          item.floorCoord = [newY, newX];
          localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
          if (isFirebaseReady() && db && item.firestoreId) {
            updateDoc(doc(db, "assets", item.firestoreId), { floorCoord: [newY, newX] }).catch(err => console.warn(err));
          }
          showMapToast('📍 ย้ายตำแหน่ง [' + item.assetId + '] ไปยังพิกัด [Y: ' + newY + ', X: ' + newX + '] เรียบร้อยแล้ว');
        });
      } else {
        marker = L.circleMarker(item.floorCoord, {
          radius: 9,
          fillColor: pinColor,
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.95
        }).addTo(map);
      }

      const adminPopupHtml = isAdmin ? `
        <div style="margin:8px 0; padding:8px 10px; background:#f0fdf4; border:1px solid #86efac; border-radius:6px; text-align:left;">
          <div style="font-size:12px; color:#166534; font-weight:700; margin-bottom:3px;">🛠️ สิทธิ์แอดมิน: ย้ายจุดติดตั้ง</div>
          <div style="font-size:11px; color:#15803d; line-height:1.3;">• คลิกลากหมุด <b>⠿</b> บนแผนที่ หรือ</div>
          <button onclick="startRelocatePin('${item.assetId}')" class="btn-sm" style="margin-top:5px; width:100%; background:#0284c7; color:white; font-size:11.5px; padding:6px 10px; font-weight:600; border:none; border-radius:5px; cursor:pointer;">
            📍 คลิกที่นี่เพื่อย้ายตำแหน่งจุดนี้
          </button>
        </div>
      ` : '';

      marker.bindPopup(`
        <div style="font-size: 13px;">
          <div style="display:inline-block; background:#e0f2fe; color:#0369a1; font-weight:bold; padding:2px 8px; border-radius:4px; font-size:11px; margin-bottom:4px;">ลำดับที่ ${index + 1}</div><br>
          <strong style="color: #0284c7;">${item.assetId}</strong><br>
          <b>ประเภท:</b> ${item.type}<br>
          <b>จุดติดตั้ง:</b> ${item.location}<br>
          <b>สถานะ:</b> <span style="color:${pinColor}; font-weight:bold;">
            ${isReady ? '✅ พร้อมใช้งาน' : item.status === 'REPAIRING' ? '🛠️ อยู่ระหว่างส่งซ่อม' : '⚠️ ชำรุด/แจ้งซ่อม'}
          </span><br>
          ${adminPopupHtml}
          ${(!isGuest && item.status === 'ISSUE') ? `<button onclick="markAssetRepairing('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background:#f59e0b; color:white;">🔧 ส่งซ่อมบำรุง</button>` : ''}
          ${(!isGuest && item.status === 'REPAIRING') ? `<button onclick="openRepairCompleteModal('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background:#10b981; color:white;">✅ ซ่อมเสร็จแล้ว (คืนสถานะปกติ)</button>` : ''}
          ${!isGuest ? `
          <button onclick="handleScanned('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background: #00695c; color: white;">
            บันทึกตรวจเช็กจุดนี้
          </button>
          ` : ''}
        </div>
      `);
      markers.push(marker);
    });
  }

  // อัปเดตการ์ดลำดับจุดติดตั้งด้านล่างแผนที่ (Dashboard Asset Quick Chips)
  renderDashboardAssetChips();
}

// ฟังก์ชันแสดงการ์ดลำดับอุปกรณ์ประจำโซน/อาคารปัจจุบัน
function renderDashboardAssetChips() {
  const chipsContainer = document.getElementById('dashboard-asset-chips');
  const countEl = document.getElementById('dashboard-zone-count');
  if (!chipsContainer) return;

  const currentAssets = currentMapMode === 'campus'
    ? assetsList.filter(a => a.campusCoord)
    : assetsList.filter(a => a.buildingId === currentMapMode);

  if (countEl) countEl.innerText = currentAssets.length;
  chipsContainer.innerHTML = '';

  if (currentAssets.length === 0) {
    chipsContainer.innerHTML = '<span style="font-size:0.82rem; color:#94a3b8;">ยังไม่มีอุปกรณ์ที่ระบุพิกัดในอาคารนี้</span>';
    return;
  }

  currentAssets.forEach((item, idx) => {
    const isReady = item.status === 'READY';
    const chip = document.createElement('div');
    chip.style.cssText = `
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-radius: 6px; font-size: 0.8rem;
      background: ${isReady ? '#f0fdf4' : '#fef2f2'};
      border: 1px solid ${isReady ? '#bbf7d0' : '#fecaca'};
      color: #1e293b; cursor: pointer; transition: all 0.2s;
    `;
    chip.title = `คลิกเพื่อซูมดู [${item.assetId}] ${item.location || ''}`;
    chip.innerHTML = `
      <span style="background:${isReady ? '#16a34a' : '#dc2626'}; color:white; font-size:0.7rem; font-weight:700; padding:1px 6px; border-radius:4px;">#${idx + 1}</span>
      <b>${item.assetId}</b>
      <span style="color:#64748b; font-size:0.75rem;">(${item.location || '-'})</span>
    `;

    chip.onmouseenter = () => chip.style.transform = 'translateY(-2px)';
    chip.onmouseleave = () => chip.style.transform = 'translateY(0)';
    chip.onclick = () => {
      // ซูมและเปิด popup ของหมุดตัวนี้
      const marker = markers[idx];
      if (marker && map) {
        if (currentMapMode === 'campus' && item.campusCoord) {
          map.setView([item.campusCoord.lat, item.campusCoord.lng], 19);
        } else if (item.floorCoord) {
          map.setView(item.floorCoord, 1);
        }
        marker.openPopup();
      }
    };
    chipsContainer.appendChild(chip);
  });
}

window.locateUserGPS = function () {
  if (currentMapMode !== 'campus') {
    alert("ระบบ GPS ระบุพิกัดดาวเทียมจะใช้งานในมุมมอง 'ภาพรวมโรงพยาบาล'");
    document.getElementById('map-mode-select').value = 'campus';
    changeMapLevel();
  }
  map.locate({ setView: true, maxZoom: 19 });
};

// ==========================================
// 4. สแกน QR Code (Html5Qrcode)
// ==========================================
window.startScanner = async function () {
  const qrBox = document.getElementById("qr-reader");
  if (!qrBox) return;

  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("qr-reader");
  }

  // ตรวจสอบว่าเครื่องมีกล้องหรือไม่ก่อนเรียก start เพื่อไม่ให้เกิด error unhandled
  try {
    const devices = await Html5Qrcode.getCameras();
    if (!devices || devices.length === 0) {
      showNoCameraUI();
      return;
    }

    // มีกล้อง — เริ่มการสแกน
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        stopScanner();
        handleScanned(decodedText.trim());
      },
      () => { }
    );
  } catch (err) {
    const isNotFound = err && (
      err.name === 'NotFoundError' ||
      err.name === 'NotAllowedError' ||
      err.name === 'DevicesNotFoundError' ||
      String(err).includes('not found') ||
      String(err).includes('Requested device')
    );
    if (isNotFound) {
      showNoCameraUI();
    } else {
      console.warn('Scanner warning:', err);
    }
  }
};

function showNoCameraUI() {
  const qrBox = document.getElementById('qr-reader');
  if (qrBox) {
    qrBox.innerHTML = `
      <div style="padding:28px 16px; text-align:center; color:#64748b; background:rgba(255,255,255,0.7); border-radius:14px; border:2px dashed #cbd5e1;">
        <div style="font-size:2.8rem; margin-bottom:6px;">📵</div>
        <b style="color:#1e293b; font-size:1rem;">ไม่พบอุปกรณ์กล้องบนเครื่องนี้</b><br>
        <span style="font-size:0.86rem; color:#64748b; display:inline-block; margin-top:4px;">
          ระบบกำลังเปิดใช้งานบนคอมพิวเตอร์ที่ไม่มีเว็บแคม หรือยังไม่อนุญาตสิทธิ์การเข้าถึงกล้อง
        </span><br>
        <div style="margin-top:12px; font-size:0.84rem; color:#00695c; font-weight:600;">
          👉 คุณสามารถพิมพ์รหัสอุปกรณ์ในช่องด้านล่างเพื่อเปิดตรวจเช็กได้ทันที
        </div>
      </div>`;
  }
}

window.submitManualScanId = function () {
  const input = document.getElementById('manual-scan-asset-id');
  if (!input) return;
  const assetId = input.value.trim();
  if (!assetId) {
    alert("กรุณากรอกรหัสอุปกรณ์");
    return;
  }
  handleScanned(assetId);
};

const DEFAULT_INSPECTION_GUIDE = {
  feSteps: [
    "<b>ตรวจสอบสภาพภายนอก:</b> ตัวถังต้องไม่บุบ ไม่ผุกร่อน ไม่เป็นสนิม คันบีบและด้ามจับมั่นคง",
    "<b>ตรวจสอบสลักล็อก & ซีลรัด:</b> สลักนิรภัย (Pull Pin) และซีลล็อกพลาสติกต้องอยู่ในสภาพสมบูรณ์ ไม่หลุดหาย",
    "<b>ตรวจสอบสายฉีด & หัวฉีด:</b> สายยางไม่แตกกรอบ ไม่ฉีกขาด และไม่มีเศษขยะหรือแมลงอุดตันในปากกระบอกฉีด",
    "<b>ตรวจเกจวัดแรงดัน:</b> เข็มวัดแรงดันต้องชี้อยู่ใน <b>\"แถบสีเขียว\" (ปกติ)</b> หากตกแถบแดงแสดงว่าแรงดันรั่วซึม",
    "<b>ตรวจพื้นที่การติดตั้ง:</b> ไม่มีสิ่งของตั้งวางกีดขวาง ต้องสามารถเข้าถึงและหยิบใช้งานได้ทันทีใน 5 วินาที"
  ],
  emSteps: [
    "<b>ตรวจสอบตัวเครื่อง & แหล่งจ่ายไฟ:</b> โครงสร้างโคมไฟไม่แตกร้าว เสียบปลั๊กแน่นหนา สายไฟไม่มีรอยหนูกัดแทะ",
    "<b>ตรวจสอบไฟแสดงผล (AC / On):</b> หลอดไฟสัญญาณสีเขียว/แดง (AC Indicator) ต้องติดสว่าง บ่งบอกว่ามีกระแสไฟเข้าชาร์จแบตเตอรี่",
    "<b>ทดสอบระบบสำรองไฟ (Push to Test):</b> กดปุ่ม <b>\"TEST\"</b> ค้างไว้ประมาณ 5-10 วินาที เพื่อจำลองสถานการณ์ไฟดับ",
    "<b>ประเมินความสว่าง:</b> หลอดไฟ LED ต้อง <b>ติดสว่างพร้อมกันทั้ง 2 ดวง</b> แสงไฟไม่กะพริบหรือริบหรี่",
    "<b>ปรับทิศทางโคมไฟ:</b> ปรับหน้าโคมให้ส่องสว่างไปยังเส้นทางหนีไฟ ป้ายทางออก หรือโถงบันไดหนีไฟอย่างชัดเจน"
  ],
  updatedAt: new Date().toISOString()
};

function getStoredInspectionGuide() {
  try {
    const raw = localStorage.getItem('pyh_inspection_guide');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.feSteps && parsed.emSteps) return parsed;
    }
  } catch (e) { }
  return DEFAULT_INSPECTION_GUIDE;
}

window.renderInspectionGuideUI = function () {
  const container = document.getElementById('inspection-guide-content');
  if (!container) return;

  const guide = getStoredInspectionGuide();
  const feHtml = guide.feSteps.map(step => `<li>${step}</li>`).join('');
  const emHtml = guide.emSteps.map(step => `<li>${step}</li>`).join('');

  container.innerHTML = `
    <!-- 1. ขั้นตอนตรวจถังดับเพลิง -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:12px 14px; box-shadow:0 1px 4px rgba(0,0,0,0.02);">
      <div style="font-weight:700; color:#b91c1c; font-size:0.92rem; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        <span>🧯 ขั้นตอนการตรวจถังดับเพลิง (Fire Extinguisher)</span>
      </div>
      <ol style="margin:0; padding-left:20px; font-size:0.84rem; color:#334155; line-height:1.65;">
        ${feHtml}
      </ol>
    </div>

    <!-- 2. ขั้นตอนตรวจโคมไฟฉุกเฉิน -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:12px 14px; box-shadow:0 1px 4px rgba(0,0,0,0.02);">
      <div style="font-weight:700; color:#0284c7; font-size:0.92rem; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        <span>💡 ขั้นตอนการตรวจไฟฉุกเฉิน (Emergency Light)</span>
      </div>
      <ol style="margin:0; padding-left:20px; font-size:0.84rem; color:#334155; line-height:1.65;">
        ${emHtml}
      </ol>
    </div>
  `;
};

window.openEditGuideModal = function () {
  if (!requireLogin('แก้ไขคู่มือขั้นตอนการตรวจ')) return;
  const guide = getStoredInspectionGuide();
  const feArea = document.getElementById('edit-guide-fe');
  const emArea = document.getElementById('edit-guide-em');
  const modal = document.getElementById('edit-guide-modal');

  // แปลง array กลับเป็น text ทีละบรรทัด (ตัด tag HTML หยาบๆ ให้แก้ไขง่าย)
  if (feArea) {
    feArea.value = guide.feSteps.map(s => s.replace(/<[^>]*>/g, '')).join('\n');
  }
  if (emArea) {
    emArea.value = guide.emSteps.map(s => s.replace(/<[^>]*>/g, '')).join('\n');
  }
  if (modal) modal.style.display = 'flex';
};

window.closeEditGuideModal = function () {
  const modal = document.getElementById('edit-guide-modal');
  if (modal) modal.style.display = 'none';
};

window.submitEditGuide = async function () {
  if (!requireLogin('แก้ไขคู่มือขั้นตอนการตรวจ')) return;
  const feArea = document.getElementById('edit-guide-fe');
  const emArea = document.getElementById('edit-guide-em');
  const submitBtn = document.getElementById('edit-guide-submit-btn');

  const feLines = (feArea ? feArea.value : '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const emLines = (emArea ? emArea.value : '').split('\n').map(l => l.trim()).filter(l => l.length > 0);

  if (feLines.length === 0 || emLines.length === 0) {
    alert("กรุณาระบุขั้นตอนการตรวจอย่างน้อยประเภทละ 1 ข้อ");
    return;
  }

  // แปลงข้อความให้มีตัวหนาในคำแรก (ก่อนเครื่องหมายโคลอน :)
  const formatStep = (line) => {
    if (line.includes(':')) {
      const parts = line.split(':');
      return `<b>${parts[0].trim()}:</b> ${parts.slice(1).join(':').trim()}`;
    }
    return line;
  };

  const newGuide = {
    feSteps: feLines.map(formatStep),
    emSteps: emLines.map(formatStep),
    updatedAt: new Date().toISOString(),
    updatedBy: currentOfficer || 'เจ้าหน้าที่'
  };

  try {
    if (submitBtn) {
      submitBtn.innerText = "กำลังบันทึก...";
      submitBtn.disabled = true;
    }

    localStorage.setItem('pyh_inspection_guide', JSON.stringify(newGuide));

    // ซิงก์ขึ้น Firestore (ถ้าพร้อมใช้งาน)
    if (isFirebaseReady() && db) {
      try {
        await setDoc(doc(db, "system_configs", "inspection_guide"), {
          ...newGuide,
          timestamp: serverTimestamp()
        });
      } catch (cloudErr) {
        console.warn("Firestore sync guide warning:", cloudErr);
      }
    }

    renderInspectionGuideUI();
    closeEditGuideModal();
    alert("✅ บันทึกและอัปเดตคู่มือขั้นตอนวิธีการตรวจเช็กเรียบร้อยแล้ว");

  } catch (err) {
    alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.innerText = "💾 บันทึกคู่มือ";
      submitBtn.disabled = false;
    }
  }
};

window.resetGuideToDefault = function () {
  if (!confirm("ต้องการรีเซ็ตขั้นตอนและคู่มือตรวจเช็กกลับเป็นค่าเริ่มต้นใช่หรือไม่?")) return;
  const feArea = document.getElementById('edit-guide-fe');
  const emArea = document.getElementById('edit-guide-em');
  if (feArea) {
    feArea.value = DEFAULT_INSPECTION_GUIDE.feSteps.map(s => s.replace(/<[^>]*>/g, '')).join('\n');
  }
  if (emArea) {
    emArea.value = DEFAULT_INSPECTION_GUIDE.emSteps.map(s => s.replace(/<[^>]*>/g, '')).join('\n');
  }
};

window.toggleInspectionGuide = function () {
  const content = document.getElementById('inspection-guide-content');
  const txt = document.getElementById('guide-toggle-text');
  const icon = document.getElementById('guide-toggle-icon');
  if (!content) return;

  if (content.style.display === 'none') {
    content.style.display = 'grid';
    if (txt) txt.innerText = 'ซ่อนคู่มือ';
    if (icon) icon.innerText = '▲';
  } else {
    content.style.display = 'none';
    if (txt) txt.innerText = 'แสดงขั้นตอนวิธีตรวจ';
    if (icon) icon.innerText = '▼';
  }
};

window.stopScanner = function () {
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => { });
  }
};

// ==========================================
// 5. จัดการแบบฟอร์มตรวจสอบ (Checklist FE vs EM)
// ==========================================
window.handleScanned = function (assetId) {
  if (!requireLogin('บันทึกผลการตรวจ')) return;
  const asset = assetsList.find(a => a.assetId.toLowerCase() === assetId.toLowerCase());
  if (!asset) {
    alert(`ไม่พบอุปกรณ์รหัส "${assetId}" ในระบบ กรุณาตรวจสอบหรือลงทะเบียนใหม่`);
    return;
  }

  switchTab('scanner');

  document.getElementById('inspect-id').value = asset.assetId;
  document.getElementById('inspect-title').innerText = `ตรวจเช็ก: ${asset.assetId}`;
  document.getElementById('inspect-desc').innerText = `ประเภท: ${asset.type} | ตำแหน่ง: ${asset.building} - ${asset.location}`;

  // เติมชื่อและตำแหน่งช่างผู้ตรวจเช็กอัตโนมัติ (สามารถแก้ไขได้)
  const nameInput = document.getElementById('inspect-inspector-name');
  const roleInput = document.getElementById('inspect-inspector-role');
  if (nameInput && roleInput) {
    if (!nameInput.value) {
      nameInput.value = getCleanName(currentOfficer) || 'นายสุวิทย์ พวงสมบัติ';
      roleInput.value = 'นายช่างเทคนิค';
    }
  }

  const feFields = document.getElementById('fe-checklist-fields');
  const emFields = document.getElementById('em-checklist-fields');

  // ตรวจสอบชนิดอุปกรณ์ว่าขึ้นต้นด้วย PYH-FE- หรือ PYH-EM-
  if (asset.assetId.startsWith('PYH-FE') || asset.type.includes('ถังดับเพลิง')) {
    feFields.classList.remove('hidden');
    emFields.classList.add('hidden');
  } else {
    feFields.classList.add('hidden');
    emFields.classList.remove('hidden');
  }

  document.getElementById('inspection-form-card').classList.remove('hidden');
  document.getElementById('inspection-form-card').scrollIntoView({ behavior: 'smooth' });
};

// บันทึกผลการตรวจเช็ก
const inspectForm = document.getElementById('inspection-form');
if (inspectForm) {
  inspectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireLogin('บันทึกผลการตรวจเช็ก')) return;
    const btn = document.getElementById('btn-save-inspect');
    btn.innerText = "กำลังบันทึกข้อมูล...";
    btn.disabled = true;

    try {
      const assetId = document.getElementById('inspect-id').value;
      const assetIndex = assetsList.findIndex(a => a.assetId === assetId);
      if (assetIndex === -1) throw new Error("ไม่พบข้อมูลอุปกรณ์");

      const isFE = assetId.startsWith('PYH-FE');
      let isPass = true;
      let checkDetails = {};

      if (isFE) {
        const body = document.getElementById('fe-body').value;
        const pressure = document.getElementById('fe-pressure').value;
        const access = document.getElementById('fe-access').value;
        isPass = (body === 'PASS' && pressure === 'PASS' && access === 'PASS');
        checkDetails = { body, pressure, access };
      } else {
        const light = document.getElementById('em-light').value;
        const test = document.getElementById('em-test').value;
        const plug = document.getElementById('em-plug').value;
        isPass = (light === 'PASS' && test === 'PASS' && plug === 'PASS');
        checkDetails = { light, test, plug };
      }

      const notes = document.getElementById('inspect-notes').value || "-";
      const photoFile = document.getElementById('inspect-photo').files[0];
      let photoURL = "";

      // จัดการภาพถ่าย: บีบอัดภาพก่อนเพื่อป้องกันไฟล์ใหญ่ และอัปโหลดขึ้น Firebase Cloud Storage
      if (photoFile) {
        btn.innerText = "กำลังประมวลผลรูปภาพ...";
        const optimizedFile = await compressImageFile(photoFile, 1024, 0.75);

        if (isFirebaseReady() && storage) {
          try {
            btn.innerText = "กำลังอัปโหลดรูปภาพขึ้น Cloud Storage...";
            const storageRef = ref(storage, `inspections/${assetId}_${Date.now()}.jpg`);
            const uploadRes = await uploadBytes(storageRef, optimizedFile);
            photoURL = await getDownloadURL(uploadRes.ref);
          } catch (storageErr) {
            console.warn("Firebase Storage upload failed, falling back to local compressed data URL:", storageErr);
            photoURL = await readFileAsDataURL(optimizedFile);
          }
        } else {
          photoURL = await readFileAsDataURL(optimizedFile);
        }
      }

      // ดึงชื่อช่างที่กรอกจากแบบฟอร์ม (ใช้เฉพาะชื่อ-นามสกุล ไม่นำตำแหน่งมาต่อท้ายในวงเล็บ)
      const inspectorName = getCleanName(document.getElementById('inspect-inspector-name')?.value.trim() || 'นายสุวิทย์ พวงสมบัติ');
      const inspectorRole = document.getElementById('inspect-inspector-role')?.value.trim() || 'นายช่างเทคนิค';
      currentOfficer = inspectorName;
      saveUserSession(currentOfficer, currentUserRole);

      const now = new Date();
      const logEntry = {
        id: `LOG_${Date.now()}`,
        assetId: assetId,
        inspector: inspectorName,
        status: isPass ? "READY" : "ISSUE",
        details: checkDetails,
        notes: notes,
        photoURL: photoURL,
        timestampStr: now.toLocaleString('th-TH'),
        timestampISO: now.toISOString()
      };

      // 1. เพิ่มเข้า Inspection Logs
      if (isFirebaseReady() && db) {
        await addDoc(collection(db, "inspection_logs"), {
          ...logEntry,
          timestamp: serverTimestamp()
        });
      }
      inspectionLogs.unshift(logEntry);
      localStorage.setItem('pyh_inspection_logs', JSON.stringify(inspectionLogs));

      // 2. อัปเดตสถานะใน Assets List
      assetsList[assetIndex].status = isPass ? "READY" : "ISSUE";
      assetsList[assetIndex].lastChecked = now.toISOString();
      assetsList[assetIndex].lastInspector = inspectorName;
      assetsList[assetIndex].lastPhoto = photoURL;
      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

      if (isFirebaseReady() && db && assetsList[assetIndex].firestoreId) {
        await updateDoc(doc(db, "assets", assetsList[assetIndex].firestoreId), {
          status: isPass ? "READY" : "ISSUE",
          lastChecked: serverTimestamp(),
          lastInspector: inspectorName,
          lastPhoto: photoURL
        });
      }

      alert(isPass ? "✅ บันทึกผลการตรวจเช็กเรียบร้อย อุปกรณ์พร้อมใช้งาน" : "⚠️ อุปกรณ์ชำรุด บันทึกแจ้งซ่อมเข้าสู่ระบบเรียบร้อย");

      inspectForm.reset();
      document.getElementById('inspection-form-card').classList.add('hidden');
      updateDashboardUI();
      renderMapPins();
      renderHistoryTable();
      switchTab('dashboard');

    } catch (err) {
      alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
    } finally {
      btn.innerText = "บันทึกผลการตรวจสอบ";
      btn.disabled = false;
    }
  });
}

// บีบอัดภาพก่อนจัดเก็บ เพื่อความรวดเร็วและป้องกัน LocalStorage / Memory ล้น
function compressImageFile(file, maxWidth = 1024, quality = 0.75) {
  return new Promise((resolve) => {
    // ถ้าไม่ใช่รูปภาพ ให้คืนกลับตามเดิม
    if (!file || !file.type.startsWith('image/')) {
      resolve(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob) {
              const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
                type: 'image/jpeg',
                lastModified: Date.now()
              });
              resolve(compressedFile);
            } else {
              resolve(file);
            }
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

// ==========================================
// 6. ลงทะเบียนอุปกรณ์ใหม่ & พิมพ์ QR Code (พร้อมแผนที่เลือกพิกัด)
// ==========================================
let registerMap = null;
let registerMarker = null;
let registerOverlayLayer = null;
let registerExistingMarkers = [];

window.initRegisterMap = function () {
  const regMapElem = document.getElementById('register-map');
  if (!regMapElem) return;

  if (!registerMap) {
    registerMap = L.map('register-map', {
      crs: L.CRS.Simple,
      minZoom: -1,
      maxZoom: 1
    });

    registerMap.on('click', function (e) {
      const y = Math.round(e.latlng.lat);
      const x = Math.round(e.latlng.lng);
      setRegisterCoords(y, x);
    });
  }

  window.updateRegisterMapFloor();
};

window.renderRegisterExistingMarkers = function () {
  if (!registerMap) return;

  // ล้างหมุดอุปกรณ์เดิมออกก่อน
  registerExistingMarkers.forEach(m => {
    if (registerMap.hasLayer(m)) registerMap.removeLayer(m);
  });
  registerExistingMarkers = [];

  const buildingSelect = document.getElementById('reg-building-select');
  if (!buildingSelect) return;
  const buildingId = buildingSelect.value;

  // กรองอุปกรณ์เดิมที่อยู่ในอาคารนี้และมี floorCoord
  const existingAssets = (assetsList || []).filter(a => a.buildingId === buildingId && a.floorCoord && Array.isArray(a.floorCoord));

  // อัปเดตข้อความสถิติอุปกรณ์เดิม
  const countBadge = document.getElementById('reg-existing-count-badge');
  if (countBadge) {
    countBadge.innerText = `📦 มีอุปกรณ์เดิมในอาคารนี้ ${existingAssets.length} จุด`;
  }

  existingAssets.forEach(item => {
    const isReady = item.status === 'READY';
    const statusColor = isReady ? '#16a34a' : '#dc2626';

    const existingIcon = L.divIcon({
      html: `
        <div style="background:${statusColor}; border:2px solid #ffffff; box-shadow:0 0 6px rgba(0,0,0,0.45); width:14px; height:14px; border-radius:50%; opacity:0.88;" title="[อุปกรณ์เดิม] ${item.assetId} - ${item.location}"></div>
      `,
      className: 'existing-asset-pin-container',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });

    const m = L.marker(item.floorCoord, {
      icon: existingIcon,
      interactive: true,
      zIndexOffset: 10
    }).addTo(registerMap);

    m.bindPopup(`
      <div style="font-size:12px; line-height:1.4;">
        <span style="display:inline-block; background:#f1f5f9; color:#475569; font-size:10px; font-weight:700; padding:1px 6px; border-radius:4px; border:1px solid #cbd5e1; margin-bottom:4px;">📌 อุปกรณ์เดิมในระบบ</span><br>
        <b style="color:#0f172a;">${item.assetId}</b><br>
        <span style="color:#334155;">${item.type || 'อุปกรณ์ความปลอดภัย'}</span><br>
        <span style="color:#64748b; font-size:11px;">จุดติดตั้ง: ${item.location || '-'} (ชั้น ${item.floor || 1})</span><br>
        <span style="color:${statusColor}; font-weight:600; font-size:11px;">สถานะ: ${isReady ? 'พร้อมใช้งาน' : 'ต้องตรวจสอบ/ชำรุด'}</span>
      </div>
    `);

    registerExistingMarkers.push(m);
  });
};

window.updateRegisterMapFloor = function () {
  if (!registerMap) return;
  const buildingSelect = document.getElementById('reg-building-select');
  if (!buildingSelect) return;
  const buildingId = buildingSelect.value;
  const cfg = floorConfigs[buildingId];
  if (!cfg) return;

  if (registerOverlayLayer && registerMap.hasLayer(registerOverlayLayer)) {
    registerMap.removeLayer(registerOverlayLayer);
  }

  registerOverlayLayer = L.imageOverlay(cfg.imageUrl, cfg.bounds).addTo(registerMap);
  registerMap.options.maxBoundsViscosity = 1.0;
  registerMap.setMaxBounds(cfg.bounds);
  registerMap.setMaxZoom(3);
  registerMap.fitBounds(cfg.bounds);
  const regFitZoom = registerMap.getBoundsZoom(cfg.bounds);
  registerMap.setMinZoom(regFitZoom);

  // แสดงหมุดอุปกรณ์เดิมที่มีอยู่ในอาคารนี้
  window.renderRegisterExistingMarkers();

  const curY = parseInt(document.getElementById('reg-coord-y').value) || 280;
  const curX = parseInt(document.getElementById('reg-coord-x').value) || 500;
  setRegisterCoords(curY, curX);
  setTimeout(() => {
    registerMap.invalidateSize();
    const updatedZoom = registerMap.getBoundsZoom(cfg.bounds);
    registerMap.setMinZoom(updatedZoom);
  }, 250);
};

function setRegisterCoords(y, x) {
  const yInput = document.getElementById('reg-coord-y');
  const xInput = document.getElementById('reg-coord-x');
  const badge = document.getElementById('reg-coord-badge');

  if (yInput) yInput.value = y;
  if (xInput) xInput.value = x;
  if (badge) badge.innerText = 'พิกัดผัง: Y: ' + y + ', X: ' + x;

  if (registerMarker && registerMap && registerMap.hasLayer(registerMarker)) {
    registerMap.removeLayer(registerMarker);
  }

  if (registerMap) {
    const pinIcon = L.divIcon({
      html: '<div class="admin-draggable-pin" style="background:#0284c7; border:2.5px solid #ffffff; box-shadow:0 0 10px rgba(2,132,199,0.7); width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; font-size:11px; font-weight:bold; cursor:grab;">★</div>',
      className: 'custom-pin-container',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    registerMarker = L.marker([y, x], {
      icon: pinIcon,
      draggable: true,
      zIndexOffset: 1000,
      title: 'หมุดอุปกรณ์ใหม่ (คลิกลากเพื่อกำหนดตำแหน่งติดตั้ง)'
    }).addTo(registerMap);

    registerMarker.on('dragend', function (e) {
      const latlng = e.target.getLatLng();
      const newY = Math.round(latlng.lat);
      const newX = Math.round(latlng.lng);
      if (yInput) yInput.value = newY;
      if (xInput) xInput.value = newX;
      if (badge) badge.innerText = 'พิกัดผัง: Y: ' + newY + ', X: ' + newX;
    });
  }
}

const regForm = document.getElementById('reg-form');
if (regForm) {
  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const assetId = document.getElementById('reg-id').value.trim();
    if (!assetId) {
      alert("กรุณาระบุรหัสประจำอุปกรณ์");
      return;
    }

    if (assetsList.some(a => a.assetId?.trim().toUpperCase() === assetId.toUpperCase())) {
      alert(`⚠️ ขออภัย: รหัสอุปกรณ์ "${assetId}" มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น`);
      return;
    }

    const type = document.getElementById('reg-type').value;
    const buildingSelect = document.getElementById('reg-building-select');
    const buildingId = buildingSelect.value;
    const buildingName = buildingSelect.options[buildingSelect.selectedIndex].text;
    const location = document.getElementById('reg-location').value.trim();
    const floor = parseInt(document.getElementById('reg-floor').value) || 1;

    // คำนวณพิกัดจากหมุดที่กำหนดไว้บนแผนที่
    const coordY = parseInt(document.getElementById('reg-coord-y').value) || 280;
    const coordX = parseInt(document.getElementById('reg-coord-x').value) || 500;
    const floorCoord = [coordY, coordX];
    const campusCoord = { lat: 15.47712, lng: 100.13777 };

    const newAsset = {
      assetId,
      type,
      building: buildingName,
      buildingId,
      floor,
      location,
      status: "READY",
      floorCoord,
      campusCoord,
      createdAt: new Date().toISOString()
    };

    if (isFirebaseReady() && db) {
      try {
        const docId = assetId.replace(/[^a-zA-Z0-9]/g, '_');
        await setDoc(doc(db, "assets", docId), {
          ...newAsset,
          serverCreated: serverTimestamp()
        });
        newAsset.firestoreId = docId;
      } catch (err) {
        console.warn("Firestore add error:", err);
      }
    }

    assetsList.push(newAsset);
    assetsList = deduplicateAssets(assetsList);
    localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

    // แสดง QR Code
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
      text: assetId,
      width: 150,
      height: 150,
      colorDark: "#000000",
      colorLight: "#ffffff"
    });

    document.getElementById('qr-label').innerHTML = `
      <b>${assetId}</b><br>
      ${type}<br>
      ${buildingName} - ${location}
    `;
    document.getElementById('qr-output').classList.remove('hidden');

    updateDashboardUI();
    renderMapPins();
    if (typeof window.renderRegisterExistingMarkers === 'function') {
      window.renderRegisterExistingMarkers();
    }
    alert(`ลงทะเบียนอุปกรณ์ ${assetId} สำเร็จ! พร้อมพิมพ์สติกเกอร์`);

    document.getElementById('reg-location').value = '';
    if (typeof window.autoSuggestRegisterId === 'function') {
      window.autoSuggestRegisterId();
    }
  });
}

// ==========================================
// 7. ประวัติการตรวจ (Audit Trail)
// ==========================================
window.renderHistoryTable = function () {
  const tbody = document.getElementById('history-rows');
  if (!tbody) return;
  tbody.innerHTML = "";

  const filterStatus = document.getElementById('history-filter-status')?.value || '';
  const keyword = (document.getElementById('history-search')?.value || '').toLowerCase();

  let logs = [...inspectionLogs];

  // กรองตามสถานะ
  if (filterStatus) logs = logs.filter(l => l.status === filterStatus);
  // กรองตามรหัสอุปกรณ์
  if (keyword) logs = logs.filter(l => l.assetId?.toLowerCase().includes(keyword));

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b; padding:20px;">ไม่พบรายการที่ตรงกัน</td></tr>`;
    return;
  }

  logs.slice(0, 100).forEach((log, index) => {
    const isPass = log.status === 'READY';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align:center; color:#94a3b8; font-size:0.8rem; width:40px;">${index + 1}</td>
      <td style="font-size:0.82rem;">${log.timestampStr || log.timestampISO || '-'}</td>
      <td><b>${log.assetId}</b></td>
      <td style="font-size:0.82rem;">${log.inspector || '-'}</td>
      <td><span class="badge ${isPass ? 'badge-ready' : 'badge-issue'}">${isPass ? '✅ ปกติ' : '⚠️ ชำรุด'}</span></td>
      <td>${log.photoURL ? `<a href="${log.photoURL}" target="_blank"><img class="img-thumb" src="${log.photoURL}" alt="ภาพหลักฐาน"></a>` : '-'}</td>
      <td style="font-size:0.82rem;">${log.notes || '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================
// 7.5 ตารางรายการอุปกรณ์ + QR Code
// ==========================================
let _qrModalAsset = null; // เก็บ asset ที่เปิด QR modal อยู่

window.renderAssetListTable = function () {
  const tbody = document.getElementById('asset-list-rows');
  if (!tbody) return;

  const keyword = (document.getElementById('asset-search')?.value || '').toLowerCase();
  const sortMode = document.getElementById('asset-sort')?.value || 'default';

  let filtered = assetsList.filter(a =>
    !keyword ||
    a.assetId?.toLowerCase().includes(keyword) ||
    a.type?.toLowerCase().includes(keyword) ||
    a.location?.toLowerCase().includes(keyword) ||
    a.building?.toLowerCase().includes(keyword)
  );

  // เรียงลำดับ
  if (sortMode === 'issue-first') {
    filtered = [...filtered].sort((a, b) => {
      if (a.status === 'ISSUE' && b.status !== 'ISSUE') return -1;
      if (a.status !== 'ISSUE' && b.status === 'ISSUE') return 1;
      return 0;
    });
  } else if (sortMode === 'building') {
    filtered = [...filtered].sort((a, b) => (a.building || '').localeCompare(b.building || ''));
  } else if (sortMode === 'id') {
    filtered = [...filtered].sort((a, b) => (a.assetId || '').localeCompare(b.assetId || ''));
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#64748b; padding:20px;">ไม่พบอุปกรณ์</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((a, idx) => {
    const statusBadge = a.status === 'READY'
      ? `<span class="badge badge-ready">✅ พร้อมใช้</span>`
      : a.status === 'REPAIRING'
        ? `<span class="badge badge-repair">🛠️ ส่งซ่อม</span>`
        : a.status === 'ISSUE'
          ? `<span class="badge badge-issue">⚠️ แจ้งซ่อม</span>`
          : `<span style="color:#94a3b8;">-</span>`;

    // นับจำนวนครั้งที่เคยตรวจอุปกรณ์ชิ้นนี้
    const checkCount = inspectionLogs.filter(l => l.assetId?.toLowerCase() === a.assetId?.toLowerCase()).length;

    // ปุ่มส่งซ่อม / บันทึกซ่อมเสร็จ (สำหรับช่างและแอดมิน)
    let repairBtnHtml = '';
    if (currentUserRole !== 'guest' && currentUserRole !== 'executive') {
      if (a.status === 'ISSUE') {
        repairBtnHtml = `
          <button onclick="markAssetRepairing('${a.assetId}')"
            title="กดส่งซ่อมบำรุง"
            style="background:#f59e0b; color:white; border:none; border-radius:6px;
                   padding:4px 9px; font-size:0.75rem; cursor:pointer; font-weight:600; white-space:nowrap; margin-bottom:4px;">
            🔧 ส่งซ่อม
          </button>
        `;
      } else if (a.status === 'REPAIRING') {
        repairBtnHtml = `
          <button onclick="openRepairCompleteModal('${a.assetId}')"
            title="กดบันทึกเมื่อซ่อมเสร็จสิ้น"
            style="background:#10b981; color:white; border:none; border-radius:6px;
                   padding:4px 9px; font-size:0.75rem; cursor:pointer; font-weight:600; white-space:nowrap; margin-bottom:4px;">
            ✅ ซ่อมเสร็จแล้ว
          </button>
        `;
      }
    }

    // ปุ่มแก้ไขข้อมูลอุปกรณ์ (สำหรับช่าง, ผู้ตรวจ, และแอดมิน)
    let editBtnHtml = '';
    if (currentUserRole !== 'guest' && currentUserRole !== 'executive') {
      editBtnHtml = `
        <button onclick="openEditAssetModal('${a.assetId}')"
          title="แก้ไขข้อมูลอุปกรณ์ชิ้นนี้"
          style="background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; border-radius:6px;
                 padding:4px 9px; font-size:0.75rem; cursor:pointer; font-weight:600; white-space:nowrap; transition:all 0.15s;"
          onmouseenter="this.style.background='#dcfce7'"
          onmouseleave="this.style.background='#f0fdf4'">
          ✏️ แก้ไข
        </button>
      `;
    }

    // ปุ่มลบอุปกรณ์ (เฉพาะสิทธิ์ Admin เท่านั้น)
    const deleteBtnHtml = (currentUserRole === 'admin')
      ? `<button onclick="adminDeleteAsset('${a.assetId}')"
           title="ลบอุปกรณ์ชิ้นนี้ (สิทธิ์แอดมิน)"
           style="background:#fee2e2; color:#dc2626; border:1px solid #fca5a5; border-radius:6px;
                  padding:4px 8px; font-size:0.75rem; cursor:pointer; font-weight:600; white-space:nowrap; transition:all 0.15s;"
           onmouseenter="this.style.background='#fecaca'"
           onmouseleave="this.style.background='#fee2e2'">
           🗑️ ลบ
         </button>`
      : '';

    return `<tr>
      <td style="text-align:center; color:#94a3b8; font-size:0.8rem; width:40px;">${idx + 1}</td>
      <td><b>${a.assetId}</b></td>
      <td style="font-size:0.82rem;">${a.type || '-'}</td>
      <td style="font-size:0.82rem;">${a.building || ''} ${a.location ? '— ' + a.location : ''}</td>
      <td>${statusBadge}</td>
      <td style="text-align:center;">
        <button onclick="showAssetHistoryModal('${a.assetId}')"
          style="background:#f1f5f9; color:#0f172a; border:1px solid #cbd5e1; border-radius:6px;
                 padding:4px 10px; font-size:0.8rem; cursor:pointer; font-weight:600; transition:all 0.2s;"
          onmouseenter="this.style.background='#e2e8f0'"
          onmouseleave="this.style.background='#f1f5f9'">
          📜 ดูประวัติ (${checkCount})
        </button>
      </td>
      <td style="text-align:center;">
        <div id="qr-mini-${a.assetId.replace(/[^a-zA-Z0-9]/g, '-')}"
          style="display:inline-block; cursor:pointer;"
          onclick="showQRModal('${a.assetId}')">
        </div>
      </td>
      <td style="text-align:center;">
        <div style="display:flex; flex-direction:column; gap:4px; align-items:center;">
          <button onclick="showQRModal('${a.assetId}')"
            style="background:#00695c; color:white; border:none; border-radius:6px;
                   padding:4px 10px; font-size:0.78rem; cursor:pointer; white-space:nowrap;">
            ${(currentUserRole === 'guest' || !currentUserRole) ? '🔍 ดู QR' : '🖨️ ดู / พิมพ์'}
          </button>
          ${editBtnHtml}
          ${repairBtnHtml}
          ${deleteBtnHtml}
        </div>
      </td>
    </tr>`;
  }).join('');

  // สร้าง QR เล็กๆ ในแต่ละแถว
  filtered.forEach(a => {
    const containerId = `qr-mini-${a.assetId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const el = document.getElementById(containerId);
    if (el && el.innerHTML === '') {
      try { new QRCode(el, { text: a.assetId, width: 48, height: 48 }); } catch (e) { }
    }
  });
};

// ==========================================
// การส่งซ่อมบำรุง & บันทึกซ่อมเสร็จสิ้น (Technician Repair Flow)
// ==========================================
window.markAssetRepairing = async function (assetId) {
  const asset = assetsList.find(a => a.assetId?.toLowerCase() === assetId?.toLowerCase());
  if (!asset) return;

  if (!confirm(`ต้องการส่งซ่อมอุปกรณ์ [${assetId}] ใช่ไหม?\nสถานะจะเปลี่ยนเป็น "🛠️ อยู่ระหว่างส่งซ่อม"`)) {
    return;
  }

  const now = new Date();
  asset.status = 'REPAIRING';
  asset.repairSentAt = now.toISOString();
  asset.repairSentBy = currentOfficer || 'ช่างเทคนิค';

  // บันทึกประวัติการส่งซ่อมเข้า inspectionLogs
  const repairLog = {
    id: `REPAIR_LOG_${Date.now()}`,
    assetId: assetId,
    inspector: currentOfficer || 'ช่างเทคนิค',
    status: 'REPAIRING',
    details: 'ส่งซ่อมบำรุง / นำส่งแก้ไข',
    notes: 'ส่งซ่อมบำรุงอุปกรณ์เนื่องจากมีรายงานข้อบกพร่อง',
    photoURL: '',
    timestampStr: now.toLocaleString('th-TH'),
    timestampISO: now.toISOString()
  };

  inspectionLogs.unshift(repairLog);
  localStorage.setItem('pyh_inspection_logs', JSON.stringify(inspectionLogs));
  localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

  if (isFirebaseReady() && db) {
    try {
      if (asset.firestoreId) {
        await updateDoc(doc(db, "assets", asset.firestoreId), {
          status: 'REPAIRING',
          repairSentAt: serverTimestamp(),
          repairSentBy: asset.repairSentBy
        });
      }
      await addDoc(collection(db, "inspection_logs"), {
        ...repairLog,
        timestamp: serverTimestamp()
      });
    } catch (err) {
      console.warn("Firestore update error on markAssetRepairing", err);
    }
  }

  alert(`🛠️ นำส่งซ่อมอุปกรณ์ [${assetId}] เรียบร้อยแล้ว`);
  renderAssetListTable();
  updateDashboardUI();
  renderMapPins();
  renderHistoryTable();
};

window.openRepairCompleteModal = function (assetId) {
  const asset = assetsList.find(a => a.assetId?.toLowerCase() === assetId?.toLowerCase());
  if (!asset) return;

  const modal = document.getElementById('repair-complete-modal');
  const targetIdInput = document.getElementById('repair-target-asset-id');
  const modalTitle = document.getElementById('repair-modal-title');
  const techNameInput = document.getElementById('repair-technician-name');
  const notesInput = document.getElementById('repair-notes-input');

  if (targetIdInput) targetIdInput.value = assetId;
  if (modalTitle) modalTitle.innerText = `✅ รายงานผลการซ่อม: ${assetId}`;
  if (techNameInput) techNameInput.value = currentOfficer || '';
  if (notesInput) notesInput.value = '';

  if (modal) modal.style.display = 'flex';
};

window.closeRepairCompleteModal = function () {
  const modal = document.getElementById('repair-complete-modal');
  if (modal) modal.style.display = 'none';
};

window.submitAssetRepaired = async function () {
  const assetId = document.getElementById('repair-target-asset-id')?.value;
  const techName = document.getElementById('repair-technician-name')?.value.trim();
  const notes = document.getElementById('repair-notes-input')?.value.trim();
  const submitBtn = document.getElementById('repair-submit-btn');

  if (!assetId || !techName || !notes) {
    alert("กรุณากรอกข้อมูลช่างผู้ซ่อมและรายละเอียดการแก้ไขให้ครบถ้วน");
    return;
  }

  const asset = assetsList.find(a => a.assetId?.toLowerCase() === assetId?.toLowerCase());
  if (!asset) return;

  if (submitBtn) {
    submitBtn.innerText = "กำลังบันทึก...";
    submitBtn.disabled = true;
  }

  try {
    const now = new Date();
    asset.status = 'READY';
    asset.lastRepairedAt = now.toISOString();
    asset.lastRepairedBy = techName;
    asset.lastRepairedNotes = notes;
    asset.lastChecked = now.toISOString();
    asset.lastInspector = techName;

    // บันทึก log เข้า inspectionLogs
    const logEntry = {
      id: `REPAIRED_LOG_${Date.now()}`,
      assetId: assetId,
      inspector: techName + ' (บันทึกซ่อมเสร็จ)',
      status: 'READY',
      details: `ซ่อมแซมเสร็จสิ้น: ${notes}`,
      notes: `[การซ่อมบำรุง] ${notes}`,
      photoURL: '',
      timestampStr: now.toLocaleString('th-TH'),
      timestampISO: now.toISOString()
    };

    inspectionLogs.unshift(logEntry);
    localStorage.setItem('pyh_inspection_logs', JSON.stringify(inspectionLogs));
    localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

    if (isFirebaseReady() && db) {
      if (asset.firestoreId) {
        await updateDoc(doc(db, "assets", asset.firestoreId), {
          status: 'READY',
          lastRepairedAt: serverTimestamp(),
          lastRepairedBy: techName,
          lastRepairedNotes: notes,
          lastChecked: serverTimestamp(),
          lastInspector: techName
        });
      }
      await addDoc(collection(db, "inspection_logs"), {
        ...logEntry,
        timestamp: serverTimestamp()
      });
    }

    alert(`🎉 ซ่อมแซมอุปกรณ์ [${assetId}] เสร็จสมบูรณ์แล้ว!\nสถานะอุปกรณ์กลับมาเป็น: ✅ พร้อมใช้งาน`);
    closeRepairCompleteModal();
    renderAssetListTable();
    updateDashboardUI();
    renderMapPins();
    renderHistoryTable();

  } catch (err) {
    alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.innerText = "✅ ยืนยันซ่อมเสร็จ & คืนสถานะปกติ";
      submitBtn.disabled = false;
    }
  }
};

// ==========================================
// แก้ไขข้อมูลอุปกรณ์ (Edit Asset)
// ==========================================
window.openEditAssetModal = function (assetId) {
  const asset = assetsList.find(a => a.assetId?.toLowerCase() === assetId?.toLowerCase());
  if (!asset) {
    alert("ไม่พบข้อมูลอุปกรณ์");
    return;
  }

  const modal = document.getElementById('edit-asset-modal');
  const origIdInput = document.getElementById('edit-asset-orig-id');
  const idInput = document.getElementById('edit-asset-id');
  const typeSelect = document.getElementById('edit-asset-type');
  const statusSelect = document.getElementById('edit-asset-status');
  const bldgSelect = document.getElementById('edit-asset-building');
  const floorInput = document.getElementById('edit-asset-floor');
  const locInput = document.getElementById('edit-asset-location');

  if (origIdInput) origIdInput.value = asset.assetId;
  if (idInput) idInput.value = asset.assetId;
  if (typeSelect) typeSelect.value = asset.type || 'ถังดับเพลิงสีแดง';
  if (statusSelect) statusSelect.value = asset.status || 'READY';
  if (bldgSelect) {
    if (asset.buildingId && bldgSelect.querySelector(`option[value="${asset.buildingId}"]`)) {
      bldgSelect.value = asset.buildingId;
    } else {
      // ค้นหาจากชื่ออาคาร
      const opt = Array.from(bldgSelect.options).find(o => o.text.includes(asset.building || '') || (asset.building || '').includes(o.text));
      if (opt) bldgSelect.value = opt.value;
    }
  }
  if (floorInput) floorInput.value = asset.floor || 1;
  if (locInput) locInput.value = asset.location || '';

  const modalTitle = document.getElementById('edit-asset-modal-title');
  if (modalTitle) modalTitle.innerText = `✏️ แก้ไขข้อมูล: ${asset.assetId}`;

  if (modal) modal.style.display = 'flex';
};

window.closeEditAssetModal = function () {
  const modal = document.getElementById('edit-asset-modal');
  if (modal) modal.style.display = 'none';
};

window.submitEditAsset = async function () {
  const origAssetId = document.getElementById('edit-asset-orig-id')?.value;
  const newAssetId = document.getElementById('edit-asset-id')?.value.trim();
  const type = document.getElementById('edit-asset-type')?.value;
  const status = document.getElementById('edit-asset-status')?.value;
  const bldgSelect = document.getElementById('edit-asset-building');
  const buildingId = bldgSelect?.value;
  const buildingName = bldgSelect?.options[bldgSelect.selectedIndex]?.text || '';
  const floor = parseInt(document.getElementById('edit-asset-floor')?.value) || 1;
  const location = document.getElementById('edit-asset-location')?.value.trim();
  const submitBtn = document.getElementById('edit-asset-submit-btn');

  if (!newAssetId || !location) {
    alert("กรุณากรอกรหัสอุปกรณ์และตำแหน่งติดตั้งให้ครบถ้วน");
    return;
  }

  // หากเปลี่ยนรหัส ตรวจสอบว่าไม่ไปซ้ำกับตัวอื่น
  if (newAssetId.toUpperCase() !== origAssetId.toUpperCase()) {
    const isDuplicate = assetsList.some(a =>
      a.assetId?.toUpperCase() === newAssetId.toUpperCase() &&
      a.assetId?.toUpperCase() !== origAssetId.toUpperCase()
    );
    if (isDuplicate) {
      alert(`⚠️ รหัสอุปกรณ์ "${newAssetId}" มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น`);
      return;
    }
  }

  const assetIndex = assetsList.findIndex(a => a.assetId?.toLowerCase() === origAssetId?.toLowerCase());
  if (assetIndex === -1) {
    alert("ไม่พบข้อมูลอุปกรณ์เดิมในระบบ");
    return;
  }

  const asset = assetsList[assetIndex];

  try {
    if (submitBtn) {
      submitBtn.innerText = "⏳ กำลังบันทึก...";
      submitBtn.disabled = true;
    }

    const oldAssetId = asset.assetId;
    const oldBuildingId = asset.buildingId;

    // อัปเดตข้อมูลใน object
    asset.assetId = newAssetId;
    asset.type = type;
    asset.status = status;
    asset.building = buildingName;
    asset.buildingId = buildingId;
    asset.floor = floor;
    asset.location = location;
    asset.updatedAt = new Date().toISOString();

    // บันทึกลง LocalStorage
    localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

    // หากมีการเปลี่ยนรหัสอุปกรณ์ ให้อัปเดตรหัสในประวัติการตรวจ (inspectionLogs) ด้วย เพื่อไม่ให้ประวัติหลุด
    if (oldAssetId.toUpperCase() !== newAssetId.toUpperCase()) {
      inspectionLogs.forEach(l => {
        if (l.assetId?.toLowerCase() === oldAssetId.toLowerCase()) {
          l.assetId = newAssetId;
        }
      });
      localStorage.setItem('pyh_inspection_logs', JSON.stringify(inspectionLogs));
    }

    // ซิงค์ Cloud Database (Firestore) หากเปิดใช้งานอยู่
    if (isFirebaseReady() && db) {
      try {
        if (asset.firestoreId) {
          await updateDoc(doc(db, "assets", asset.firestoreId), {
            assetId: newAssetId,
            type,
            status,
            building: buildingName,
            buildingId,
            floor,
            location,
            updatedAt: serverTimestamp()
          });
        }
      } catch (cloudErr) {
        console.warn("Firestore update error in submitEditAsset:", cloudErr);
      }
    }

    alert(`💾 แก้ไขข้อมูลอุปกรณ์ [${newAssetId}] เรียบร้อยแล้ว`);
    closeEditAssetModal();

    // อัปเดต UI ทั่วทั้งระบบ
    renderAssetListTable();
    updateDashboardUI();
    renderMapPins();
    if (typeof window.renderRegisterExistingMarkers === 'function') {
      window.renderRegisterExistingMarkers();
    }
    renderHistoryTable();

  } catch (err) {
    alert("เกิดข้อผิดพลาดในการบันทึก: " + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.innerText = "💾 บันทึกการแก้ไข";
      submitBtn.disabled = false;
    }
  }
};

// ==========================================
// สิทธิ์ Admin: ลบอุปกรณ์ (Admin Delete Asset)
// ==========================================
window.adminDeleteAsset = async function (assetId) {
  if (currentUserRole !== 'admin') {
    alert("❌ คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้ (สำหรับแอดมินเท่านั้น)");
    return;
  }

  const assetIndex = assetsList.findIndex(a => a.assetId?.toLowerCase() === assetId?.toLowerCase());
  if (assetIndex === -1) {
    alert("ไม่พบข้อมูลอุปกรณ์");
    return;
  }

  const asset = assetsList[assetIndex];
  const confirmMsg = `⚠️ ยืนยันการลบอุปกรณ์ [${asset.assetId}] หรือไม่?\n\n• ประเภท: ${asset.type || '-'}\n• อาคาร/จุดติดตั้ง: ${asset.building || ''} (${asset.location || '-'})\n\nการลบนี้จะลบออกจากระบบและ Cloud Database ทันที`;
  if (!confirm(confirmMsg)) return;

  try {
    // ลบจาก Firestore หากเชื่อมต่ออยู่
    if (isFirebaseReady() && db && asset.firestoreId) {
      try {
        await deleteDoc(doc(db, "assets", asset.firestoreId));
      } catch (err) {
        console.warn("Firestore deleteDoc error:", err);
      }
    }

    // ลบจาก Local Array
    assetsList.splice(assetIndex, 1);
    localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

    alert(`🗑️ ลบอุปกรณ์ [${assetId}] ออกจากระบบเรียบร้อยแล้ว`);
    renderAssetListTable();
    updateDashboardUI();
    renderMapPins();
  } catch (e) {
    alert("เกิดข้อผิดพลาดในการลบอุปกรณ์: " + e.message);
  }
};

// ==========================================
// สิทธิ์ Admin: ลบอุปกรณ์ทั้งหมด (Admin Delete All Assets)
// ==========================================
window.adminDeleteAllAssets = async function () {
  if (currentUserRole !== 'admin') {
    alert("❌ คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้ (สำหรับแอดมินเท่านั้น)");
    return;
  }

  const currentCount = assetsList.length;
  if (currentCount === 0) {
    alert("⚠️ ขณะนี้ไม่มีรายการอุปกรณ์ในระบบ");
    return;
  }

  const confirmFirst = confirm(`🚨 คำเตือนสำคัญมาก! (ลบอุปกรณ์ทั้งหมด)\n\nคุณกำลังจะลบอุปกรณ์ทั้งหมด ${currentCount} จุด ออกจากระบบและฐานข้อมูล Cloud อย่างถาวร!\n\nคุณแน่ใจหรือไม่ว่าต้องการดำเนินการต่อ?`);
  if (!confirmFirst) return;

  const confirmText = prompt(`⚠️ เพื่อยืนยันการลบอุปกรณ์ทั้งหมด ${currentCount} จุด\nกรุณาพิมพ์คำว่า "DELETE ALL" หรือ "ลบทั้งหมด" ในช่องด้านล่าง:`);
  if (confirmText !== 'DELETE ALL' && confirmText !== 'ลบทั้งหมด') {
    alert("❌ การยืนยันไม่ถูกต้อง ยกเลิกคำสั่งลบอุปกรณ์ทั้งหมดแล้ว");
    return;
  }

  try {
    let cloudDeleted = 0;

    // 1. ลบข้อมูลจาก Firestore Cloud
    if (isFirebaseReady() && db) {
      const snap = await getDocs(collection(db, "assets"));
      for (const docSnap of snap.docs) {
        try {
          await deleteDoc(doc(db, "assets", docSnap.id));
          cloudDeleted++;
        } catch (err) {
          console.warn("Error deleting cloud asset doc:", docSnap.id, err);
        }
      }
    }

    // 2. เคลียร์ข้อมูลอุปกรณ์ใน LocalStorage และ Array
    assetsList = [];
    localStorage.setItem('pyh_assets_data', JSON.stringify([]));

    // 3. อัปเดต UI ทั้งระบบ
    updateDashboardUI();
    renderMapPins();
    if (typeof renderAssetListTable === 'function') renderAssetListTable();
    if (typeof autoSuggestRegisterId === 'function') autoSuggestRegisterId();

    alert(`🗑️ ดำเนินการลบอุปกรณ์ทั้งหมดเรียบร้อยแล้ว!\n- ลบออกจากเครื่อง: ${currentCount} จุด\n- ลบออกจาก Firestore Cloud: ${cloudDeleted} รายการ\n\n(หากต้องการข้อมูลเริ่มต้นกลับมา สามารถกด 'นำเข้าข้อมูลสู่ระบบใหม่' หรือ 'โหลดข้อมูลเริ่มต้น' ได้เสมอ)`);
  } catch (err) {
    alert("❌ เกิดข้อผิดพลาดในการลบอุปกรณ์ทั้งหมด: " + err.message);
  }
};

// ฟังก์ชันเปิดดูประวัติการตรวจเฉพาะอุปกรณ์ชิ้นนี้
window.showAssetHistoryModal = function (assetId) {
  const asset = assetsList.find(a => a.assetId?.toLowerCase() === assetId?.toLowerCase());
  const modal = document.getElementById('asset-history-modal');
  const titleEl = document.getElementById('asset-modal-title');
  const subEl = document.getElementById('asset-modal-subtitle');
  const rowsEl = document.getElementById('asset-history-modal-rows');

  if (!modal || !rowsEl) return;

  const logs = inspectionLogs.filter(l => l.assetId?.toLowerCase() === assetId?.toLowerCase());

  titleEl.innerText = `📜 ประวัติการตรวจ: ${assetId}`;
  subEl.innerText = `${asset?.type || 'อุปกรณ์ความปลอดภัย'} • ${asset?.building || ''} (${asset?.location || '-'})`;

  if (logs.length === 0) {
    rowsEl.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center; color:#64748b; padding:28px 16px;">
          ยังไม่เคยมีบันทึกการตรวจเช็กสำหรับอุปกรณ์ <b>${assetId}</b>
        </td>
      </tr>
    `;
  } else {
    rowsEl.innerHTML = logs.map((log, i) => {
      const isPass = log.status === 'READY';
      return `
        <tr>
          <td style="text-align:center; color:#94a3b8; font-size:0.8rem;">${i + 1}</td>
          <td style="font-size:0.82rem; white-space:nowrap;">${log.timestampStr || log.timestampISO || '-'}</td>
          <td style="font-size:0.82rem;">${log.inspector || '-'}</td>
          <td><span class="badge ${isPass ? 'badge-ready' : 'badge-issue'}">${isPass ? '✅ ปกติ' : '⚠️ ชำรุด'}</span></td>
          <td>${log.photoURL ? `<a href="${log.photoURL}" target="_blank"><img class="img-thumb" src="${log.photoURL}" alt="หลักฐาน"></a>` : '-'}</td>
          <td style="font-size:0.82rem;">${log.notes || '-'}</td>
        </tr>
      `;
    }).join('');
  }

  modal.style.display = 'flex';
};

window.closeAssetHistoryModal = function () {
  const modal = document.getElementById('asset-history-modal');
  if (modal) modal.style.display = 'none';
};

window.showQRModal = function (assetId) {
  const asset = assetsList.find(a => a.assetId === assetId);
  if (!asset) return;
  _qrModalAsset = asset;

  const modal = document.getElementById('qr-modal');
  const title = document.getElementById('qr-modal-title');
  const canvas = document.getElementById('qr-modal-canvas');
  const label = document.getElementById('qr-modal-label');

  title.textContent = `QR Code — ${asset.assetId}`;
  label.innerHTML = `<b>${asset.assetId}</b><br>${asset.type || ''}<br>${asset.building || ''} ${asset.location ? '— ' + asset.location : ''}`;
  canvas.innerHTML = '';

  new QRCode(canvas, {
    text: asset.assetId,
    width: 200,
    height: 200,
    colorDark: '#000000',
    colorLight: '#ffffff'
  });

  // ซ่อนปุ่มพิมพ์และบันทึกภาพสำหรับ Guest
  const isGuest = (!currentUserRole || currentUserRole === 'guest');
  const printBtn = document.getElementById('qr-modal-print-btn');
  const downloadBtn = document.getElementById('qr-modal-download-btn');
  if (printBtn) printBtn.style.display = isGuest ? 'none' : 'inline-block';
  if (downloadBtn) downloadBtn.style.display = isGuest ? 'none' : 'inline-block';

  modal.style.display = 'flex';
};

window.closeQRModal = function () {
  document.getElementById('qr-modal').style.display = 'none';
  _qrModalAsset = null;
};

window.downloadQR = function () {
  const canvas = document.querySelector('#qr-modal-canvas canvas');
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = `QR-${_qrModalAsset?.assetId || 'asset'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
};

window.printQRModal = function () {
  if (!requireLogin('สั่งพิมพ์ QR Code')) return;
  const canvas = document.querySelector('#qr-modal-canvas canvas');
  if (!canvas || !_qrModalAsset) return;
  const a = _qrModalAsset;
  const win = window.open('', '_blank');
  win.document.write(`
    <html><head><title>QR - ${a.assetId}</title>
    <style>
      body { font-family: 'Sarabun', sans-serif; text-align:center; padding:30px; }
      img { width:200px; height:200px; }
      h2 { margin:10px 0 4px; font-size:1.1rem; }
      p  { margin:2px 0; font-size:0.85rem; color:#444; }
    </style></head><body>
    <img src="${canvas.toDataURL()}">
    <h2>${a.assetId}</h2>
    <p>${a.type || ''}</p>
    <p>${a.building || ''} ${a.location ? '— ' + a.location : ''}</p>
    <script>window.onload=()=>{ window.print(); window.close(); }<\/script>
    </body></html>`);
  win.document.close();
};

window.printAllQR = function () {
  if (!requireLogin('สั่งพิมพ์ QR Code')) return;
  const keyword = (document.getElementById('asset-search')?.value || '').toLowerCase();
  const filtered = assetsList.filter(a =>
    !keyword ||
    a.assetId?.toLowerCase().includes(keyword) ||
    a.type?.toLowerCase().includes(keyword) ||
    a.location?.toLowerCase().includes(keyword)
  );
  if (filtered.length === 0) { alert('ไม่พบอุปกรณ์ในรายการ'); return; }

  const win = window.open('', '_blank');
  const items = filtered.map(a => `
    <div class="qr-item">
      <div id="qr-${a.assetId.replace(/[^a-zA-Z0-9]/g, '-')}"></div>
      <b>${a.assetId}</b><br>
      <span>${a.type || ''}</span><br>
      <span>${a.building || ''} ${a.location ? '— ' + a.location : ''}</span>
    </div>`).join('');

  win.document.write(`
    <html><head><title>QR ทั้งหมด</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
    <style>
      body { font-family: 'Sarabun', sans-serif; }
      .grid { display:flex; flex-wrap:wrap; gap:8px; padding:16px; }
      .qr-item { border:1px solid #ccc; border-radius:6px; padding:10px; text-align:center;
                 width:160px; font-size:0.75rem; break-inside:avoid; }
      .qr-item b { font-size:0.85rem; display:block; margin:6px 0 2px; }
      @media print { body { margin:0; } }
    </style></head>
    <body><div class="grid">${items}</div>
    <script>
      const assets = ${JSON.stringify(filtered)};
      assets.forEach(a => {
        const el = document.getElementById('qr-' + a.assetId.replace(/[^a-zA-Z0-9]/g,'-'));
        if (el) new QRCode(el, { text: a.assetId, width: 120, height: 120 });
      });
      setTimeout(() => window.print(), 1200);
    <\/script></body></html>`);
  win.document.close();
};

// เรียก render เมื่อเข้า tab history
const _origSwitchTab = window.switchTab;

// ==========================================
// 8. การสำรองข้อมูลและการโอนย้าย (Backup & Migration)
// ==========================================
// ฟังก์ชันอัปโหลดข้อมูลอุปกรณ์ทั้งหมด 48-56 จุด และผู้ใช้เริ่มต้นขึ้น Firebase Firestore ทันที
window.syncAllAssetsToFirestore = async function () {
  if (!isFirebaseReady() || !db) {
    alert("⚠️ ระบบยังไม่ได้เชื่อมต่อกับ Firebase หรือการตั้งค่า Config ไม่ถูกต้อง");
    return;
  }

  if (!confirm("ต้องการอัปโหลดข้อมูลอุปกรณ์ทั้งหมดและบัญชีผู้ใช้งานขึ้น Firebase Firestore ใช่หรือไม่?")) return;

  try {
    let count = 0;
    // 1. อัปโหลดอุปกรณ์
    for (const asset of assetsList) {
      const docId = asset.assetId.replace(/[^a-zA-Z0-9]/g, '_');
      const cleanAsset = { ...asset };
      delete cleanAsset.firestoreId;
      await setDoc(doc(db, "assets", docId), cleanAsset);
      count++;
    }

    // 2. อัปโหลดผู้ใช้เริ่มต้น
    const defaultUsers = [
      {
        name: "ผู้ดูแลระบบไอทีและอาคาร",
        dept: "ศูนย์สารสนเทศและเทคโนโลยี รพ.พยุหะคีรี",
        email: "admin@pyuhahospital.go.th",
        password: "Admin@Pyuha2026!",
        role: "admin",
        verified: true,
        createdAt: new Date().toISOString()
      },
      {
        name: "นายสุวิทย์ พวงสมบัติ",
        dept: "นายช่างเทคนิค",
        email: "suwit@pyuhahospital.go.th",
        password: "Suwit@2026!",
        role: "inspector",
        verified: true,
        createdAt: new Date().toISOString()
      },
      {
        name: "นายคมสันต์ ศรีสิงห์",
        dept: "นักเทคนิคการแพทย์ปฏิบัติการ รักษาราชการแทน <br>หัวหน้าฝ่ายบริหารทั่วไป",
        email: "komsan@pyuhahospital.go.th",
        password: "Komsan@2026!",
        role: "chef_inspector",
        verified: true,
        createdAt: new Date().toISOString()
      },
      {
        name: "นางสาวศิริพรรณ ชมพูภู่",
        dept: "ผู้อำนวยการโรงพยาบาลพยุหะคีรี",
        email: "director@pyuhahospital.go.th",
        password: "Director@2026!",
        role: "executive",
        verified: true,
        createdAt: new Date().toISOString()
      }
    ];

    for (const u of defaultUsers) {
      const docId = u.email.replace(/[^a-zA-Z0-9]/g, '_');
      await setDoc(doc(db, "system_users", docId), u);
    }

    alert(`✅ อัปโหลดข้อมูลสำเร็จเรียบร้อย!\n- อุปกรณ์ขึ้น Firestore: ${count} จุด\n- บัญชีผู้ใช้งานระบบ: 4 บัญชี\n\nสามารถเปิดดูใน Firebase Console ได้ทันที`);
  } catch (err) {
    alert("❌ เกิดข้อผิดพลาดในการอัปโหลด: " + err.message);
  }
};

// ฟังก์ชันทำความสะอาดข้อมูลอุปกรณ์ที่ซ้ำซ้อนใน Firestore และ LocalStorage (Clean Duplicate Assets)
window.cleanDuplicateAssetsFromCloud = async function () {
  if (currentUserRole !== 'admin') {
    alert("❌ ฟังก์ชันนี้สงวนไว้สำหรับผู้ดูแลระบบ (Admin) เท่านั้น");
    return;
  }

  if (!confirm("ต้องการสแกนและลบรายการอุปกรณ์ที่ซ้ำซ้อนกันในฐานข้อมูลทั้งหมดใช่หรือไม่?\n(ระบบจะเก็บเฉพาะรายการล่าสุดไว้เพียง 1 จุดต่อ 1 รหัสอุปกรณ์)")) {
    return;
  }

  try {
    let deletedCount = 0;

    // 1. ตรวจสอบและลบใน Firestore (ถ้าเชื่อมต่ออยู่)
    if (isFirebaseReady() && db) {
      const snap = await getDocs(collection(db, "assets"));
      const seen = new Map();

      for (const docSnap of snap.docs) {
        const data = docSnap.data();
        const assetId = (data.assetId || '').trim().toUpperCase();
        if (!assetId) continue;

        if (!seen.has(assetId)) {
          seen.set(assetId, { docId: docSnap.id, data: data });
        } else {
          // พบตัวซ้ำ! เลือกลบตัวที่เก่ากว่าหรือตัวที่ซ้ำ
          const prev = seen.get(assetId);
          let toDeleteId = docSnap.id;
          // ถ้าตัวใหม่มี lastChecked ใหม่กว่า ให้ลบตัวเดิมแล้วเก็บตัวใหม่แทน
          if (data.lastChecked && (!prev.data.lastChecked || data.lastChecked > prev.data.lastChecked)) {
            toDeleteId = prev.docId;
            seen.set(assetId, { docId: docSnap.id, data: data });
          }
          await deleteDoc(doc(db, "assets", toDeleteId));
          deletedCount++;
        }
      }
    }

    // 2. เคลียร์ใน LocalStorage
    const beforeCount = assetsList.length;
    assetsList = deduplicateAssets(assetsList);
    localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
    const localRemoved = beforeCount - assetsList.length;

    updateDashboardUI();
    renderMapPins();
    if (typeof renderAssetListTable === 'function') renderAssetListTable();

    alert(`✨ ล้างรายการซ้ำเรียบร้อยแล้ว!\n- ลบข้อมูลซ้ำใน Firestore Cloud: ${deletedCount} รายการ\n- ลบข้อมูลซ้ำในเครื่องนี้: ${localRemoved} รายการ\n\nปัจจุบันมีอุปกรณ์พร้อมใช้งานทั้งหมด: ${assetsList.length} จุด`);
  } catch (err) {
    alert("❌ เกิดข้อผิดพลาดในการลบรายการซ้ำ: " + err.message);
  }
};

window.exportSystemData = function () {
  try {
    const backupData = {
      hospital: "โรงพยาบาลพยุหะคีรี",
      system: "Pyuha Smart Fire & Safety Cloud",
      exportedAt: new Date().toISOString(),
      assets: assetsList,
      inspection_logs: inspectionLogs
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup_pyuha_safety_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    alert("ดาวน์โหลดไฟล์สำรองข้อมูล (JSON) สำเร็จแล้ว สามารถนำไปใช้ในระบบของโรงพยาบาลได้ทันที");
  } catch (e) {
    alert("เกิดข้อผิดพลาดในการส่งออกข้อมูล: " + e.message);
  }
};

window.importSystemData = function (event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.assets) throw new Error("รูปแบบไฟล์ JSON ไม่ถูกต้อง");

      if (!confirm(`พบข้อมูลอุปกรณ์ ${data.assets.length} จุด ยืนยันการนำเข้าข้อมูลหรือไม่?`)) return;

      assetsList = deduplicateAssets(data.assets);
      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

      if (data.inspection_logs) {
        inspectionLogs = data.inspection_logs;
        localStorage.setItem('pyh_inspection_logs', JSON.stringify(inspectionLogs));
      }

      // หากมี Firebase พร้อม ให้บันทึกลง Cloud
      if (isFirebaseReady() && db) {
        for (const item of assetsList) {
          const { firestoreId, ...cleanAsset } = item;
          const docId = cleanAsset.assetId ? cleanAsset.assetId.replace(/[^a-zA-Z0-9]/g, '_') : null;
          if (docId) {
            await setDoc(doc(db, "assets", docId), cleanAsset);
          }
        }
      }

      alert("นำเข้าข้อมูลสำเร็จครบถ้วน!");
      location.reload();
    } catch (err) {
      alert("นำเข้าข้อมูลไม่สำเร็จ: " + err.message);
    }
  };
  reader.readAsText(file);
};

// ==========================================
// 9. ระบบจัดการผู้ใช้และระดับสิทธิ์ (RBAC) — ดึงจาก Firestore
// ==========================================

const DEFAULT_SYSTEM_USERS = [
  {
    name: "ผู้ดูแลระบบไอทีและอาคาร",
    dept: "ศูนย์สารสนเทศและเทคโนโลยี รพ.พยุหะคีรี",
    email: "admin@pyuhahospital.go.th",
    password: "Admin@Pyuha2026!",
    role: "admin",
    verified: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  },
  {
    name: "นายสุวิทย์ พวงสมบัติ",
    dept: "นายช่างเทคนิค",
    email: "suwit@pyuhahospital.go.th",
    password: "Suwit@2026!",
    role: "inspector",
    verified: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  },
  {
    name: "นายคมสันต์ ศรีสิงห์",
    dept: "นักเทคนิคการแพทย์ปฏิบัติการ รักษาราชการแทน <br>หัวหน้าฝ่ายบริหารทั่วไป",
    email: "komsan@pyuhahospital.go.th",
    password: "Komsan@2026!",
    role: "chef_inspector",
    verified: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  },
  {
    name: "นางสาวศิริพรรณ ชมพูภู่",
    dept: "ผู้อำนวยการโรงพยาบาลพยุหะคีรี",
    email: "director@pyuhahospital.go.th",
    password: "Director@2026!",
    role: "executive",
    verified: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  }
];

// cache users ที่โหลดมาจาก Firestore ไว้ใน memory (เริ่มต้นด้วยผู้ใช้มาตรฐาน 4 ท่าน)
let _cachedUsers = [...DEFAULT_SYSTEM_USERS];

// โหลด users จาก Firestore (เรียกครั้งแรก หรือเมื่อต้องการ refresh)
async function loadUsersFromFirestore() {
  if (!isFirebaseReady() || !db) return _cachedUsers;
  try {
    const snapshot = await getDocs(collection(db, "system_users"));
    const users = [];
    snapshot.forEach(d => users.push({ id: d.id, ...d.data() }));
    if (users.length > 0) {
      _cachedUsers = users;
    }
    return _cachedUsers;
  } catch (e) {
    console.warn("Cannot load users from Firestore:", e.message);
    return _cachedUsers;
  }
}

// ดึง users (จาก cache ถ้ามีแล้ว, ถ้าไม่มีให้ return DEFAULT_SYSTEM_USERS และโหลด async)
function getStoredUsers() {
  if (_cachedUsers && _cachedUsers.length > 0) return _cachedUsers;
  loadUsersFromFirestore().then(users => { _cachedUsers = users; });
  return DEFAULT_SYSTEM_USERS;
}

// บันทึก users กลับขึ้น Firestore
async function saveStoredUsers(users) {
  _cachedUsers = users; // อัปเดต cache ทันที
  if (!isFirebaseReady() || !db) return;
  // เขียนทีละ doc ด้วย email เป็น ID
  for (const u of users) {
    try {
      const docId = u.email.replace(/[^a-zA-Z0-9]/g, '_');
      await setDoc(doc(db, "system_users", docId), u);
    } catch (e) {
      console.warn("Failed to save user to Firestore:", e.message);
    }
  }
}


window.openAuthModal = function () {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('hidden');
};

window.closeAuthModal = function () {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('hidden');
};

window.toggleAuthMode = function (mode) {
  const loginSec = document.getElementById('login-section');
  const regSec = document.getElementById('register-section');
  const tabLogin = document.getElementById('tab-btn-login');
  const tabRegister = document.getElementById('tab-btn-register');

  if (mode === 'register') {
    if (loginSec) loginSec.classList.add('hidden');
    if (regSec) regSec.classList.remove('hidden');
    if (tabLogin) tabLogin.classList.remove('active');
    if (tabRegister) tabRegister.classList.add('active');
  } else {
    if (loginSec) loginSec.classList.remove('hidden');
    if (regSec) regSec.classList.add('hidden');
    if (tabLogin) tabLogin.classList.add('active');
    if (tabRegister) tabRegister.classList.remove('active');
  }
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.closeAuthModal();
  }
});

window.loginWithEmail = async function () {
  const emailInput = document.getElementById('login-email');
  const pwdInput = document.getElementById('login-pwd');
  const email = emailInput ? emailInput.value.trim() : "";
  const pwd = pwdInput ? pwdInput.value : "";

  if (!email || !pwd) {
    alert("กรุณากรอกอีเมลและรหัสผ่าน");
    return;
  }

  // 1. ตรวจสอบในฐานข้อมูลระบบ Local Users (Admin, ช่างสุวิทย์, ผอ.ศิริพรรณ และบัญชีที่แอดมินสร้าง)
  const users = getStoredUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

  if (user) {
    if (user.password !== pwd) {
      alert("รหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง");
      return;
    }
    if (!user.verified) {
      alert("❌ บัญชีนี้ยังไม่ได้รับการยืนยันตัวตนจากผู้ดูแลระบบ (Admin)\nกรุณาติดต่อผู้ดูแลระบบเพื่อทำการยืนยันสิทธิ์ก่อนเริ่มใช้งาน");
      return;
    }

    currentOfficer = getCleanName(user.name);
    currentUserRole = user.role;
    saveUserSession(currentOfficer, currentUserRole);
    window.closeAuthModal();

    if (emailInput) emailInput.value = "";
    if (pwdInput) pwdInput.value = "";

    if (currentUserRole === 'admin') {
      window.switchTab('admin');
      alert("เข้าสู่ระบบสำเร็จในฐานะ: " + user.name + "\nระดับสิทธิ์: ผู้ดูแลระบบ (System Admin)");
    } else if (currentUserRole === 'executive') {
      window.switchTab('report');
      alert("เข้าสู่ระบบสำเร็จในฐานะ: " + user.name + "\nระดับสิทธิ์: ผู้บริหาร (Executive)");
    } else if (currentUserRole === 'chef_inspector' || currentUserRole === 'chef inspector') {
      window.switchTab('report');
      alert("เข้าสู่ระบบสำเร็จในฐานะ: " + user.name + "\nระดับสิทธิ์: หัวหน้าผู้ตรวจสอบ (Chef Inspector)");
    } else {
      window.switchTab('scanner');
      alert("เข้าสู่ระบบสำเร็จในฐานะ: " + user.name + "\nระดับสิทธิ์: เจ้าหน้าที่ผู้ตรวจเช็ก (Inspector)");
    }
    return;
  }

  // 2. หากเชื่อมต่อกับ Firebase Cloud Auth
  if (isFirebaseReady() && auth) {
    try {
      await signInWithEmailAndPassword(auth, email, pwd);
      window.closeAuthModal();
    } catch (err) {
      alert("เข้าสู่ระบบไม่สำเร็จ: " + err.message);
    }
  } else {
    alert("ไม่พบบัญชีผู้ใช้งานนี้ในระบบ\nหากเพิ่งลงทะเบียน กรุณาติดต่อผู้ดูแลระบบ (Admin) เพื่อยืนยันตัวตน");
  }
};

window.registerUser = async function () {
  const nameInput = document.getElementById('reg-name');
  const deptInput = document.getElementById('reg-dept');
  const roleInput = document.getElementById('reg-role');
  const emailInput = document.getElementById('reg-email');
  const pwdInput = document.getElementById('reg-pwd');

  const name = nameInput ? nameInput.value.trim() : "";
  const dept = deptInput ? deptInput.value.trim() : "";
  const role = roleInput ? roleInput.value : "inspector";
  const email = emailInput ? emailInput.value.trim() : "";
  const pwd = pwdInput ? pwdInput.value : "";

  if (!name || !email || pwd.length < 6) {
    alert("กรุณากรอกข้อมูลให้ครบถ้วน และรหัสผ่านอย่างน้อย 6 ตัวอักษร");
    return;
  }

  const users = getStoredUsers();
  if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    alert("อีเมลนี้มีอยู่ในระบบแล้ว กรุณาใช้อีเมลอื่น หรือติดต่อผู้ดูแลระบบ");
    return;
  }

  const newUser = {
    name: name,
    dept: dept || "หน่วยงาน รพ.พยุหะคีรี",
    email: email,
    password: pwd,
    role: role,
    verified: false,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveStoredUsers(users);

  if (isFirebaseReady() && auth && db) {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pwd);
      await setDoc(doc(db, "users", cred.user.uid), {
        uid: cred.user.uid,
        name: name,
        department: dept,
        role: role,
        email: email,
        verified: false,
        createdAt: serverTimestamp()
      });
    } catch (err) {
      console.warn("Firebase create user warning:", err.message);
    }
  }

  if (nameInput) nameInput.value = "";
  if (deptInput) deptInput.value = "";
  if (emailInput) emailInput.value = "";
  if (pwdInput) pwdInput.value = "";

  window.toggleAuthMode('login');
  alert("ลงทะเบียนเจ้าหน้าที่เรียบร้อยแล้ว!\n\n🛡️ เนื่องจากเป็นระบบความปลอดภัยของโรงพยาบาล บัญชีของคุณอยู่ในสถานะ 'รอการยืนยันตัวตนจากผู้ดูแลระบบ (Admin)'\nกรุณาแจ้งผู้ดูแลระบบเพื่อกดยืนยันสิทธิ์ก่อนจึงจะสามารถล็อกอินได้");

  if (currentUserRole === 'admin') {
    window.renderAdminUserList();
  }
};

// ฟังก์ชันสำหรับแอดมิน: สร้างช่างคนใหม่ พร้อมเปิดใช้งานทันที
window.adminCreateTechnician = function () {
  if (!requireLogin('จัดการบัญชีผู้ใช้')) return;
  const nameEl = document.getElementById('admin-tech-name');
  const deptEl = document.getElementById('admin-tech-dept');
  const emailEl = document.getElementById('admin-tech-email');
  const pwdEl = document.getElementById('admin-tech-pwd');

  const name = nameEl ? nameEl.value.trim() : "";
  const dept = deptEl ? deptEl.value.trim() : "";
  const email = emailEl ? emailEl.value.trim() : "";
  const pwd = pwdEl ? pwdEl.value : "";

  if (!name || !dept || !email || pwd.length < 6) {
    alert("กรุณากรอกข้อมูลช่างให้ครบถ้วน และรหัสผ่านอย่างน้อย 6 ตัวอักษร");
    return;
  }

  const users = getStoredUsers();
  if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    alert("อีเมลนี้มีอยู่ในระบบแล้ว กรุณาใช้อีเมลอื่น");
    return;
  }

  const newTech = {
    name: name,
    dept: dept,
    email: email,
    password: pwd,
    role: "inspector",
    verified: true,
    createdAt: new Date().toISOString()
  };

  users.push(newTech);
  saveStoredUsers(users);

  if (nameEl) nameEl.value = "";
  if (deptEl) deptEl.value = "";
  if (emailEl) emailEl.value = "";
  if (pwdEl) pwdEl.value = "";

  window.renderAdminUserList();
  alert("สร้างบัญชีช่างเทคนิค: " + name + "\nอีเมล: " + email + "\nสถานะ: ได้รับการยืนยันตัวตนเรียบร้อย พร้อมใช้งานทันที!");
};

// ฟังก์ชันสำหรับแอดมิน: ยืนยันตัวตนผู้ใช้
window.adminVerifyUser = function (userEmail) {
  const users = getStoredUsers();
  const user = users.find(u => u.email.toLowerCase() === userEmail.toLowerCase());
  if (!user) return;

  user.verified = true;
  saveStoredUsers(users);
  window.renderAdminUserList();
  alert("ยืนยันตัวตนและอนุมัติสิทธิ์ให้: " + user.name + " เรียบร้อยแล้ว");
};

// ฟังก์ชันสำหรับแอดมิน: รีเซ็ตรหัสผ่าน
window.adminResetPassword = function (userEmail) {
  const users = getStoredUsers();
  const user = users.find(u => u.email.toLowerCase() === userEmail.toLowerCase());
  if (!user) return;

  const newPwd = prompt("กำหนดรหัสผ่านใหม่สำหรับ: " + user.name + " " + String.fromCharCode(40) + user.email + String.fromCharCode(41) + "\n(อย่างน้อย 6 ตัวอักษร)");
  if (newPwd && newPwd.trim().length >= 6) {
    user.password = newPwd.trim();
    saveStoredUsers(users);
    window.renderAdminUserList();
    alert("รีเซ็ตรหัสผ่านสำหรับ " + user.name + " สำเร็จเรียบร้อย");
  } else if (newPwd !== null) {
    alert("รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร");
  }
};

// ฟังก์ชันสำหรับแอดมิน: ลบบัญชี
window.adminDeleteUser = function (userEmail) {
  if (userEmail.toLowerCase() === 'admin@pyuhahospital.go.th') {
    alert("ไม่สามารถลบบัญชีผู้ดูแลระบบหลักได้");
    return;
  }

  if (confirm("คุณต้องการลบหรือยกเลิกสิทธิ์บัญชี: " + userEmail + " ใช่หรือไม่?")) {
    let users = getStoredUsers();
    users = users.filter(u => u.email.toLowerCase() !== userEmail.toLowerCase());
    saveStoredUsers(users);
    window.renderAdminUserList();
    alert("ลบบัญชีผู้ใช้งานเรียบร้อยแล้ว");
  }
};

// ฟังก์ชันสำหรับแอดมิน: เรนเดอร์ตารางผู้ใช้งาน
window.renderAdminUserList = function () {
  const tbody = document.getElementById('admin-users-table-body');
  if (!tbody) return;

  const users = getStoredUsers();
  let html = '';

  users.forEach(u => {
    const roleLabel = u.role === 'admin'
      ? '👨‍💼 ผู้ดูแลระบบ'
      : u.role === 'executive'
        ? '👩‍⚕️ ผู้บริหาร / ผอ.'
        : (u.role === 'chef_inspector' || u.role === 'chef inspector')
          ? '📋 หัวหน้าผู้ตรวจสอบ (Chef Inspector)'
          : '👷‍♂️ ช่างผู้ตรวจเช็ก';

    const statusBadge = u.verified
      ? '<span class="badge badge-verified">✓ อนุมัติแล้ว</span>'
      : '<span class="badge badge-pending">⏳ รอแอดมินยืนยัน</span>';

    const verifyBtn = !u.verified
      ? `<button class="btn-action-verify" onclick="adminVerifyUser('${u.email}')" title="ยืนยันตัวตน">✓ ยืนยัน</button>`
      : '';

    const resetBtn = `<button class="btn-action-reset" onclick="adminResetPassword('${u.email}')" title="ตั้งรหัสผ่านใหม่">🔑 รีเซ็ตรหัส</button>`;

    const deleteBtn = u.role !== 'admin'
      ? `<button class="btn-action-delete" onclick="adminDeleteUser('${u.email}')" title="ลบบัญชี">🗑️ ลบ</button>`
      : '';

    html += `
      <tr>
        <td><b>${u.name}</b></td>
        <td><code>${u.email}</code></td>
        <td>${u.dept}</td>
        <td>${roleLabel}</td>
        <td>${statusBadge}</td>
        <td style="text-align:center;">
          <div class="admin-actions-cell">
            ${verifyBtn}
            ${resetBtn}
            ${deleteBtn}
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
};

function saveUserSession(name, role) {
  setSession(name, role);
  applyUserSession(name, role);
}

function applyUserSession(name, role) {
  const userBar = document.getElementById('user-bar');
  if (userBar) userBar.style.display = 'flex';

  const nameEl = document.getElementById('display-user-name');
  const roleEl = document.getElementById('display-user-role');
  const badgeOfficer = document.getElementById('current-officer-name');

  if (nameEl) nameEl.innerText = name;
  if (roleEl) {
    if (role === 'guest' || !role) roleEl.innerText = 'ดูข้อมูลเท่านั้น';
    else if (role === 'admin') roleEl.innerText = 'ผู้ดูแลระบบ (Admin)';
    else if (role === 'executive') roleEl.innerText = 'ผู้อำนวยการ / ผู้บริหาร รพ.';
    else if (role === 'chef_inspector' || role === 'chef inspector') roleEl.innerText = 'หัวหน้าผู้ตรวจสอบ (Chef Inspector)';
    else if (role === 'inspector') roleEl.innerText = 'เจ้าหน้าที่ผู้ตรวจเช็ก (Inspector)';
    else roleEl.innerText = role;
  }
  if (badgeOfficer) {
    badgeOfficer.innerText = (role === 'guest' || !role) ? 'โหมดดูข้อมูล (ยังไม่ได้เข้าสู่ระบบ)' : name;
  }

  // ควบคุมแท็บเมนูตามสิทธิ์การใช้งาน (RBAC)
  const navDashboard = document.getElementById('tab-nav-dashboard');
  const navScanner = document.getElementById('tab-nav-scanner');
  const navRegister = document.getElementById('tab-nav-register');
  const navAssets = document.getElementById('tab-nav-assets');
  const navHistory = document.getElementById('tab-nav-history');
  const navReport = document.getElementById('tab-nav-report');
  const navBackup = document.getElementById('tab-nav-backup');
  const navAdmin = document.getElementById('tab-nav-admin');

  const btnChangeOfficer = document.getElementById('btn-change-officer');
  const btnSimulateFull = document.getElementById('btn-simulate-full');
  const reportControlsCard = document.getElementById('report-controls-card');
  const execToolbar = document.getElementById('executive-report-toolbar');
  const adminNotice = document.getElementById('admin-map-drag-notice');
  const adminAddAssetBtn = document.getElementById('admin-add-asset-btn');

  currentUserRole = role;
  document.body.classList.remove('role-admin', 'role-executive', 'role-inspector', 'role-chef_inspector', 'role-chef-inspector');
  const normalizedRole = (role || '').replace(/[\s-]+/g, '_');
  document.body.classList.add('role-' + normalizedRole);
  if (normalizedRole === 'chef_inspector') {
    document.body.classList.add('role-chef-inspector');
  }

  // แถบเครื่องมือรายงานแบบคลีน แสดงผลสำหรับทุกสิทธิ์
  if (execToolbar) execToolbar.style.display = 'block';
  if (reportControlsCard) reportControlsCard.style.display = 'none';

  if (role === 'executive') {
    // 1. ผอ.: แสดงแค่ แดชบอร์ด, ประวัติการตรวจ, และรายงาน
    if (navDashboard) navDashboard.style.display = 'inline-block';
    if (navHistory) navHistory.style.display = 'inline-block';
    if (navReport) navReport.style.display = 'inline-block';

    if (navScanner) navScanner.style.display = 'none';
    if (navRegister) navRegister.style.display = 'none';
    if (navBackup) navBackup.style.display = 'none';
    if (navAdmin) navAdmin.style.display = 'none';

    if (adminNotice) adminNotice.classList.add('hidden');
    if (adminAddAssetBtn) adminAddAssetBtn.style.display = 'none';

    // ตรวจสอบแท็บปัจจุบัน ถ้าเป็นแท็บที่ไม่มีสิทธิ์ให้สลับไป dashboard
    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && ['tab-scanner', 'tab-register', 'tab-backup', 'tab-admin'].includes(currentActiveTab.id)) {
      window.switchTab('dashboard');
    }

    // เรียกรายงานทั้งหมดอัตโนมัติ ไม่ต้องระบุอะไรเลย
    if (typeof window.autoLoadExecutiveFullReport === 'function') {
      window.autoLoadExecutiveFullReport();
    }

  } else if (role === 'chef_inspector' || role === 'chef inspector') {
    // 2. หัวหน้าผู้ตรวจสอบ: แสดง แดชบอร์ด, สแกนตรวจ, ลงทะเบียน, ประวัติการตรวจ, และรายงาน
    if (navDashboard) navDashboard.style.display = 'inline-block';
    if (navScanner) navScanner.style.display = 'inline-block';
    if (navRegister) navRegister.style.display = 'inline-block';
    if (navHistory) navHistory.style.display = 'inline-block';
    if (navReport) navReport.style.display = 'inline-block';

    if (navBackup) navBackup.style.display = 'none';
    if (navAdmin) navAdmin.style.display = 'none';

    if (adminNotice) adminNotice.classList.add('hidden');
    if (adminAddAssetBtn) adminAddAssetBtn.style.display = 'none';

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && ['tab-backup', 'tab-admin'].includes(currentActiveTab.id)) {
      window.switchTab('report');
    }

    if (typeof window.autoLoadExecutiveFullReport === 'function') {
      window.autoLoadExecutiveFullReport();
    }

  } else if (role === 'inspector') {
    // 2. ช่างตรวจ: แสดง แดชบอร์ด, สแกนตรวจ, ลงทะเบียน, ประวัติการตรวจ (และรายงาน)
    // แต่ไม่มี สำรองและย้ายข้อมูล และไม่มี Admin
    if (navDashboard) navDashboard.style.display = 'inline-block';
    if (navScanner) navScanner.style.display = 'inline-block';
    if (navRegister) navRegister.style.display = 'inline-block';
    if (navHistory) navHistory.style.display = 'inline-block';
    if (navReport) navReport.style.display = 'inline-block';

    if (navBackup) navBackup.style.display = 'none';
    if (navAdmin) navAdmin.style.display = 'none';

    if (adminNotice) adminNotice.classList.add('hidden');
    if (adminAddAssetBtn) adminAddAssetBtn.style.display = 'none';

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && ['tab-backup', 'tab-admin'].includes(currentActiveTab.id)) {
      window.switchTab('dashboard');
    }

  } else if (role === 'guest' || !role) {
    // 0. Guest Mode: ดูได้เฉพาะหน้าแดชบอร์ด & แผนผังเท่านั้น ซ่อนแท็บและฟังก์ชันอื่นทั้งหมด
    if (navDashboard) navDashboard.style.display = 'inline-block';

    if (navScanner) navScanner.style.display = 'none';
    if (navRegister) navRegister.style.display = 'none';
    if (navAssets) navAssets.style.display = 'none';
    if (navHistory) navHistory.style.display = 'none';
    if (navReport) navReport.style.display = 'none';
    if (navBackup) navBackup.style.display = 'none';
    if (navAdmin) navAdmin.style.display = 'none';

    if (adminNotice) adminNotice.classList.add('hidden');
    if (adminAddAssetBtn) adminAddAssetBtn.style.display = 'none';

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && currentActiveTab.id !== 'tab-dashboard') {
      window.switchTab('dashboard');
    }
  } else {
    // 3. แอดมิน (admin): แสดงครบทุกแท็บ และเปิดโหมดขยับจุดติดตั้ง + ปุ่มเพิ่มจุดติดตั้งบนผัง
    if (navDashboard) navDashboard.style.display = 'inline-block';
    if (navScanner) navScanner.style.display = 'inline-block';
    if (navRegister) navRegister.style.display = 'inline-block';
    if (navAssets) navAssets.style.display = 'inline-block';
    if (navHistory) navHistory.style.display = 'inline-block';
    if (navReport) navReport.style.display = 'inline-block';
    if (navBackup) navBackup.style.display = 'inline-block';
    if (navAdmin) navAdmin.style.display = 'inline-block';

    if (adminNotice) adminNotice.classList.remove('hidden');
    if (adminAddAssetBtn) adminAddAssetBtn.style.display = 'inline-block';
  }

  // ควบคุมการแสดงปุ่ม 'ลบอุปกรณ์ทั้งหมด' เฉพาะสิทธิ์แอดมิน
  const adminDeleteAllBtn = document.getElementById('admin-delete-all-btn');
  if (adminDeleteAllBtn) {
    adminDeleteAllBtn.style.display = (role === 'admin') ? 'inline-block' : 'none';
  }

  // ควบคุมการแสดงปุ่มพิมพ์รายงาน, จำลองผลตรวจ, พิมพ์ QR, เปลี่ยนชื่อผู้ตรวจ สำหรับเจ้าหน้าที่ที่ล็อกอินแล้วเท่านั้น (Guest ดูได้อย่างเดียว)
  const isGuest = (!role || role === 'guest');
  if (btnChangeOfficer) {
    btnChangeOfficer.style.display = isGuest ? 'none' : 'inline-block';
  }
  if (btnSimulateFull) {
    btnSimulateFull.style.display = isGuest ? 'none' : 'inline-block';
  }
  const btnPrintReport = document.getElementById('btn-print-executive-report');
  if (btnPrintReport) {
    btnPrintReport.style.display = isGuest ? 'none' : 'inline-block';
  }
  const btnPrintAllQR = document.getElementById('btn-print-all-qr');
  if (btnPrintAllQR) {
    btnPrintAllQR.style.display = isGuest ? 'none' : 'inline-block';
  }
  const btnEditGuide = document.getElementById('btn-edit-guide');
  if (btnEditGuide) {
    btnEditGuide.style.display = isGuest ? 'none' : 'inline-flex';
  }

  // อัปเดตหมุดบนแผนที่ตามสิทธิ์ (Admin สามารถลากได้)
  if (typeof renderMapPins === 'function') {
    renderMapPins();
  }
}

window.setOfficerProfile = function () {
  if (currentUserRole === 'guest' || !currentUserRole) {
    alert("🔒 โหมดผู้เยี่ยมชม (Guest) ดูข้อมูลได้อย่างเดียวเท่านั้น\nกรุณาเข้าสู่ระบบเพื่อเปลี่ยนชื่อผู้ตรวจ");
    return;
  }
  const newName = prompt("กรุณาระบุชื่อและนามสกุลผู้ตรวจเช็ก:", getCleanName(currentOfficer));
  if (newName && newName.trim()) {
    currentOfficer = getCleanName(newName.trim());
    saveUserSession(currentOfficer, currentUserRole);
  }
};

// ==========================================
// 10. เริ่มต้นการทำงาน (Window Load)
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
  getStoredUsers();
  if (currentUserRole === 'admin' && typeof window.renderAdminUserList === 'function') {
    window.renderAdminUserList();
  }

  if (isFirebaseReady() && auth) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (userDoc.exists()) {
          const profile = userDoc.data();
          currentOfficer = getCleanName(profile.name);
          currentUserRole = profile.role || 'inspector';
          saveUserSession(currentOfficer, currentUserRole);
          document.getElementById('auth-modal').classList.add('hidden');
        }
      }
    });
  }
});

// ==========================================
// 11. ระบบสร้างรายงานการตรวจสอบเพื่อเสนอผู้บริหาร (Executive Inspection Report)
// ==========================================

const buildingMetadata = {
  building_er_lower: { name: 'อาคารอุบัติเหตุ (ชั้นล่าง)', short: 'ER ล่าง' },
  building_er_upper: { name: 'อาคารอุบัติเหตุ (ชั้นบน)', short: 'ER บน' },
  building_hpc: { name: 'อาคารส่งเสริมสุขภาพ', short: 'ส่งเสริมฯ' },
  building_ipd: { name: 'อาคารผู้ป่วยใน (IPD)', short: 'IPD' },
  building_nisit: { name: 'อาคารนิสิตคุณากร (Covid 19)', short: 'นิสิตคุณากร' },
  building_opd_dm: { name: 'ตึกแก้วกัลยา (ผู้ป่วยนอก OPD)', short: 'ตึกแก้วกัลยา' },
  building_pharma_rehab: { name: 'อาคารเวชศาสตร์ฟื้นฟู-โภชนาการ-คลังยา-จ่ายกลาง', short: 'เวชศาสตร์ฯ-คลังยา' },
  building_thai_med: { name: 'อาคารแพทย์แผนไทย', short: 'แพทย์แผนไทย' },
  building_canteen: { name: 'อาคารโรงอาหาร', short: 'โรงอาหาร' }
};

// สถานะการจัดรูปแบบรายงานและเอกสาร
let currentReportFormat = 'memo'; // 'memo' = บันทึกข้อความราชการ, 'detailed' = รายงานสถิติละเอียด
let memoLineSpacing = 1.45; // ระยะห่างบรรทัด
// ระยะขอบ 4 ทิศทาง (มาตรฐานงานสารบรรณไทย: บน 2.0 ซม., ซ้าย 2.5 ซม., ขวา 2.0 ซม., ล่าง 2.0 ซม.)
let memoMargins = {
  top: 2.0,
  bottom: 2.0,
  left: 2.5,
  right: 2.0
};
let memoMarginCm = 2.5; // fallback compat
let memoExecBoxPosition = 'left'; // 'left' = ซ้ายล่าง, 'right' = ขวาล่าง
let memoExecBoxOffset = { x: 0, y: 0 }; // ลากอิสระด้วยเมาส์
let memoExecBoxMarginTop = 16; // px
let memoChefBoxOffset = { x: 0, y: 0 }; // ลากอิสระสำหรับกล่องหัวหน้ากลุ่มงาน

// การปรับขนาดตัวอักษรแยกเฉพาะส่วน (Granular Font Sizes)
let memoFontConfig = {
  title: 29,  // ข้อความ "บันทึกข้อความ"
  header: 16, // หัวหนังสือ: ส่วนราชการ, ที่, วันที่, เรื่อง, เรียน
  body: 16,   // เนื้อหา: ความเป็นมา, ข้อพิจารณา, ข้อเสนอ
  sign: 15    // ส่วนลงนาม: ผู้รายงาน, กล่องเสนอ ผอ., คำสั่งการ ผอ.
};

// ฟังก์ชันปรับขนาดฟอนต์แบบตรงตามค่าตัวเลข (พิมพ์เลขได้เหมือน MS Word)
window.setMemoFontExact = function(val) {
  const target = document.getElementById('memo-font-target')?.value || 'all';
  const size = Math.max(8, Math.min(48, parseFloat(val) || 16));

  if (target === 'all') {
    memoFontConfig.header = size;
    memoFontConfig.body = size;
    memoFontConfig.sign = Math.max(8, size - 1);
  } else {
    memoFontConfig[target] = size;
  }

  window.updateMemoFontDisplay();
  window.applyMemoStyles();
};

// ฟังก์ชันปรับระยะขอบ 4 ด้านแบบระบุตัวเลขโดยตรง (Top / Bottom / Left / Right)
window.setMemoMarginExact = function(side, val) {
  const num = Math.max(0.5, Math.min(5.0, parseFloat(val) || 2.0));
  if (memoMargins[side] !== undefined) {
    memoMargins[side] = parseFloat(num.toFixed(1));
  }
  window.applyMemoStyles();
};

// คืนค่าระยะขอบเป็นมาตรฐานหนังสือราชการไทย (บน 2.0, ล่าง 2.0, ซ้าย 2.5, ขวา 2.0 ซม.)
window.setMemoMarginPresetStandard = function() {
  memoMargins = {
    top: 2.0,
    bottom: 2.0,
    left: 2.5,
    right: 2.0
  };
  window.applyMemoStyles();
};

// จัดการตำแหน่งกล่องคำสั่งการของ ผอ.
window.setExecBoxPosition = function(pos) {
  memoExecBoxPosition = pos;
  memoExecBoxOffset = { x: 0, y: 0 }; // รีเซ็ตการลากเมื่อกดสลับฝั่ง
  const btnLeft = document.getElementById('btn-exec-pos-left');
  const btnRight = document.getElementById('btn-exec-pos-right');
  if (btnLeft && btnRight) {
    if (pos === 'left') {
      btnLeft.style.background = '#ffffff';
      btnLeft.style.color = '#004d40';
      btnLeft.style.fontWeight = '700';
      btnRight.style.background = 'rgba(255,255,255,0.2)';
      btnRight.style.color = '#ffffff';
      btnRight.style.fontWeight = '600';
    } else {
      btnRight.style.background = '#ffffff';
      btnRight.style.color = '#004d40';
      btnRight.style.fontWeight = '700';
      btnLeft.style.background = 'rgba(255,255,255,0.2)';
      btnLeft.style.color = '#ffffff';
      btnLeft.style.fontWeight = '600';
    }
  }
  window.renderOfficialMemo();
};

window.adjustExecBoxMarginTop = function(delta) {
  memoExecBoxMarginTop = Math.max(-20, Math.min(80, memoExecBoxMarginTop + delta));
  const box = document.getElementById('memo-exec-box-card');
  if (box) box.style.marginTop = `${memoExecBoxMarginTop}px`;
};

// ระบบลากย้ายกล่องคำสั่งการ ผอ. ด้วยเมาส์ / สัมผัส (Drag & Drop)
let isDraggingExecBox = false;
let dragStartX = 0;
let dragStartY = 0;
let boxStartOffsetX = 0;
let boxStartOffsetY = 0;

window.initExecBoxDraggable = function() {
  const box = document.getElementById('memo-exec-box-card');
  const handle = document.getElementById('memo-exec-box-drag-handle');
  if (!box) return;

  const targetEl = handle || box;

  const onStart = (e) => {
    // ไม่ลากเมื่อคลิกที่ปุ่ม, input หรือข้อความที่คลิกได้
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('span[onclick]')) {
      return;
    }
    isDraggingExecBox = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;
    boxStartOffsetX = memoExecBoxOffset.x || 0;
    boxStartOffsetY = memoExecBoxOffset.y || 0;

    box.style.cursor = 'grabbing';
    box.style.zIndex = '30';
    box.style.opacity = '0.92';
    box.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!isDraggingExecBox) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    memoExecBoxOffset.x = Math.round(boxStartOffsetX + dx);
    memoExecBoxOffset.y = Math.round(boxStartOffsetY + dy);

    box.style.transform = `translate(${memoExecBoxOffset.x}px, ${memoExecBoxOffset.y}px)`;
  };

  const onEnd = () => {
    if (!isDraggingExecBox) return;
    isDraggingExecBox = false;
    box.style.cursor = 'grab';
    box.style.zIndex = '1';
    box.style.opacity = '1';
    box.style.boxShadow = 'none';

    // บันทึกตำแหน่งกล่อง ผอ. ลงใน localStorage
    try {
      localStorage.setItem('pyh_memo_exec_box_offset', JSON.stringify(memoExecBoxOffset));
    } catch(e) {}
  };

  targetEl.onmousedown = onStart;
  targetEl.ontouchstart = onStart;

  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('touchend', onEnd);
};

// ระบบลากย้ายกล่องเสนอ ผอ. (หน.กลุ่มงาน) ด้วยเมาส์ / สัมผัส (Drag & Drop)
let isDraggingChefBox = false;
let chefDragStartX = 0;
let chefDragStartY = 0;
let chefBoxStartOffsetX = 0;
let chefBoxStartOffsetY = 0;

window.initChefBoxDraggable = function() {
  const box = document.getElementById('memo-chef-box-card');
  const handle = document.getElementById('memo-chef-box-drag-handle');
  if (!box) return;

  const targetEl = handle || box;

  const onStart = (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('span[onclick]')) {
      return;
    }
    isDraggingChefBox = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    chefDragStartX = clientX;
    chefDragStartY = clientY;
    chefBoxStartOffsetX = memoChefBoxOffset.x || 0;
    chefBoxStartOffsetY = memoChefBoxOffset.y || 0;

    box.style.cursor = 'grabbing';
    box.style.zIndex = '30';
    box.style.opacity = '0.92';
    box.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!isDraggingChefBox) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - chefDragStartX;
    const dy = clientY - chefDragStartY;

    memoChefBoxOffset.x = Math.round(chefBoxStartOffsetX + dx);
    memoChefBoxOffset.y = Math.round(chefBoxStartOffsetY + dy);

    box.style.transform = `translate(${memoChefBoxOffset.x}px, ${memoChefBoxOffset.y}px)`;
  };

  const onEnd = () => {
    if (!isDraggingChefBox) return;
    isDraggingChefBox = false;
    box.style.cursor = 'grab';
    box.style.zIndex = '1';
    box.style.opacity = '1';
    box.style.boxShadow = 'none';

    try {
      localStorage.setItem('pyh_memo_chef_box_offset', JSON.stringify(memoChefBoxOffset));
    } catch(e) {}
  };

  targetEl.onmousedown = onStart;
  targetEl.ontouchstart = onStart;

  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('touchend', onEnd);
};

// ==============================================
// ระบบบันทึกลายมือชื่อเจ้าหน้าที่ (Signature Pad)
// ==============================================
let sigCanvas = null;
let sigCtx = null;
let isDrawingSig = false;
let currentSigDataUrl = null;
let sigTargetRole = 'inspector'; // 'inspector' or 'executive'

window.openSignatureModal = function(target = 'inspector') {
  sigTargetRole = target;
  currentSigDataUrl = null;
  const modal = document.getElementById('signature-modal');
  if (!modal) return;

  const modalTitle = document.getElementById('signature-modal-title');
  const modalSubtitle = document.getElementById('signature-modal-subtitle');
  if (modalTitle) {
    if (target === 'executive') {
      modalTitle.innerText = 'บันทึกลายมือชื่อผู้อำนวยการ';
    } else if (target === 'chef') {
      modalTitle.innerText = 'บันทึกลายมือชื่อหัวหน้ากลุ่มงานบริหารทั่วไป';
    } else {
      modalTitle.innerText = 'บันทึกลายมือชื่อเจ้าหน้าที่ช่าง';
    }
  }
  if (modalSubtitle) {
    if (target === 'executive') {
      modalSubtitle.innerText = 'วาดลายเซ็นหรืออัปโหลดรูปภาพลายเซ็น ผอ. เพื่อใส่ลงในเอกสาร';
    } else if (target === 'chef') {
      modalSubtitle.innerText = 'วาดลายเซ็นหรืออัปโหลดรูปภาพลายเซ็นของหัวหน้ากลุ่มงาน เพื่อเสนอ ผอ.';
    } else {
      modalSubtitle.innerText = 'วาดลายเซ็นหรืออัปโหลดรูปภาพลายเซ็นเพื่อใส่ลงในเอกสาร';
    }
  }

  // เคลียร์พรีวิวรูปถ้ามี
  const previewWrapper = document.getElementById('sig-preview-wrapper');
  const previewImg = document.getElementById('sig-preview-img');
  const fileInput = document.getElementById('sig-file-input');
  if (previewWrapper) previewWrapper.style.display = 'none';
  if (previewImg) previewImg.src = '';
  if (fileInput) fileInput.value = '';

  modal.classList.remove('hidden');

  setTimeout(() => {
    initSignatureCanvas();
  }, 100);
};

window.closeSignatureModal = function() {
  const modal = document.getElementById('signature-modal');
  if (modal) modal.classList.add('hidden');
};

function initSignatureCanvas() {
  sigCanvas = document.getElementById('signature-canvas');
  if (!sigCanvas) return;
  sigCtx = sigCanvas.getContext('2d');

  // ปรับความละเอียด Retina / High DPI
  const rect = sigCanvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  sigCanvas.width = (rect.width || 380) * scale;
  sigCanvas.height = 150 * scale;
  sigCtx.scale(scale, scale);

  sigCtx.strokeStyle = "#0f172a";
  sigCtx.lineWidth = 2.5;
  sigCtx.lineCap = "round";
  sigCtx.lineJoin = "round";

  // Event Listeners สำหรับเมาส์และทัชสกรีน
  const getPos = (e) => {
    const cRect = sigCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - cRect.left,
      y: clientY - cRect.top
    };
  };

  const startDraw = (e) => {
    e.preventDefault();
    isDrawingSig = true;
    const pos = getPos(e);
    sigCtx.beginPath();
    sigCtx.moveTo(pos.x, pos.y);
  };

  const draw = (e) => {
    if (!isDrawingSig) return;
    e.preventDefault();
    const pos = getPos(e);
    sigCtx.lineTo(pos.x, pos.y);
    sigCtx.stroke();
  };

  const stopDraw = (e) => {
    if (!isDrawingSig) return;
    isDrawingSig = false;
  };

  sigCanvas.onmousedown = startDraw;
  sigCanvas.onmousemove = draw;
  window.onmouseup = stopDraw;

  sigCanvas.ontouchstart = startDraw;
  sigCanvas.ontouchmove = draw;
  sigCanvas.ontouchend = stopDraw;

  window.clearSignature();
}

window.clearSignature = function() {
  if (!sigCanvas || !sigCtx) return;
  const rect = sigCanvas.getBoundingClientRect();
  sigCtx.clearRect(0, 0, rect.width || 380, 150);
  currentSigDataUrl = null;
};

window.switchSigTab = function(mode) {
  const drawTab = document.getElementById('sig-draw-container');
  const uploadTab = document.getElementById('sig-upload-container');
  const drawBtn = document.getElementById('tab-sig-draw');
  const uploadBtn = document.getElementById('tab-sig-upload');

  if (mode === 'draw') {
    if (drawTab) drawTab.style.display = 'block';
    if (uploadTab) uploadTab.style.display = 'none';
    if (drawBtn) { drawBtn.style.background = 'white'; drawBtn.style.color = '#0284c7'; drawBtn.style.fontWeight = '700'; }
    if (uploadBtn) { uploadBtn.style.background = 'transparent'; uploadBtn.style.color = '#64748b'; uploadBtn.style.fontWeight = '600'; }
    setTimeout(initSignatureCanvas, 50);
  } else {
    if (drawTab) drawTab.style.display = 'none';
    if (uploadTab) uploadTab.style.display = 'block';
    if (uploadBtn) { uploadBtn.style.background = 'white'; uploadBtn.style.color = '#0284c7'; uploadBtn.style.fontWeight = '700'; }
    if (drawBtn) { drawBtn.style.background = 'transparent'; drawBtn.style.color = '#64748b'; drawBtn.style.fontWeight = '600'; }
  }
};

window.handleSigFileUpload = function(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    currentSigDataUrl = e.target.result;
    const previewWrapper = document.getElementById('sig-preview-wrapper');
    const previewImg = document.getElementById('sig-preview-img');
    if (previewImg && previewWrapper) {
      previewImg.src = currentSigDataUrl;
      previewWrapper.style.display = 'block';
    }
  };
  reader.readAsDataURL(file);
};

window.saveSignature = async function() {
  const uploadTab = document.getElementById('sig-upload-container');
  const isUploadMode = uploadTab && uploadTab.style.display !== 'none';

  let finalSigUrl = null;
  if (isUploadMode) {
    finalSigUrl = currentSigDataUrl;
  } else if (sigCanvas) {
    finalSigUrl = sigCanvas.toDataURL("image/png");
  }

  if (!finalSigUrl) {
    alert("กรุณาวาดลายเซ็นหรืออัปโหลดรูปภาพก่อนบันทึก");
    return;
  }

  const now = new Date();
  const fullThaiDateStr = formatThaiFullDate(now);

  if (sigTargetRole === 'executive') {
    // บันทึกลายเซ็นผู้อำนวยการ
    const defaultApprover = getCleanName(document.getElementById('report-approver-name')?.value.trim() || (currentUserRole === 'executive' ? currentOfficer : "นางสาวศิริพรรณ ชมพูภู่"));
    
    // ดึง decision ที่เคยเลือกไว้ หรือตั้งเป็น acknowledge
    let prevDecision = 'acknowledge';
    try {
      const rawDec = localStorage.getItem('pyh_executive_decision');
      if (rawDec) {
        const d = JSON.parse(rawDec);
        if (d && d.decision) prevDecision = d.decision;
      }
    } catch(e) {}

    const certData = {
      approver: defaultApprover,
      decision: prevDecision,
      decisionLabel: (prevDecision === 'acknowledge') ? 'รับทราบ' : 'อนุมัติซ่อมแซม',
      signatureImg: finalSigUrl,
      certifiedAt: now.toISOString(),
      certifiedDateStr: fullThaiDateStr,
      certifiedTimeStr: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    };

    localStorage.setItem('pyh_exec_certification', JSON.stringify(certData));
    localStorage.setItem('pyh_executive_decision', JSON.stringify({
      decision: prevDecision,
      savedAt: now.toISOString()
    }));

    if (isFirebaseReady() && db) {
      try {
        await setDoc(doc(db, "system_state", "report_certifications"), {
          exec_cert: certData,
          exec_decision: { decision: prevDecision, savedAt: now.toISOString() },
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn("Firestore sync exec_cert error:", e);
      }
    }

    closeSignatureModal();
    renderExecutiveCertificationUI();
    alert("✍️ บันทึกลายมือชื่อของผู้อำนวยการลงในเอกสารเรียบร้อยแล้ว!");
  } else if (sigTargetRole === 'chef') {
    // บันทึกลายเซ็นหัวหน้ากลุ่มงานบริหารทั่วไป (นายคมสัน ศรีสิงห์)
    const defaultChef = getCleanName(document.getElementById('report-reviewer-name')?.value.trim() || "นายคมสัน ศรีสิงห์");
    const certData = {
      officer: defaultChef,
      role: 'chef_inspector',
      signatureImg: finalSigUrl,
      certifiedAt: now.toISOString(),
      certifiedDateStr: fullThaiDateStr,
      certifiedTimeStr: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    };

    localStorage.setItem('pyh_chef_certification', JSON.stringify(certData));

    if (isFirebaseReady() && db) {
      try {
        await setDoc(doc(db, "system_state", "report_certifications"), {
          chef_cert: certData,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn("Firestore sync chef_cert error:", e);
      }
    }

    closeSignatureModal();
    renderChefCertificationUI();
    alert("✍️ บันทึกลายมือชื่อของหัวหน้ากลุ่มงานบริหารทั่วไปลงในเอกสารเรียบร้อยแล้ว!");
  } else {
    // บันทึกลายเซ็นของช่างผู้ตรวจลง localStorage
    const cleanName = getCleanName(currentOfficer) || "นายสุวิทย์ พวงสมบัติ";
    const certData = {
      officer: cleanName,
      role: 'inspector',
      signatureImg: finalSigUrl,
      certifiedAt: now.toISOString(),
      certifiedDateStr: fullThaiDateStr,
      certifiedTimeStr: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    };

    localStorage.setItem('pyh_tech_certification', JSON.stringify(certData));

    if (isFirebaseReady() && db) {
      try {
        await setDoc(doc(db, "system_state", "report_certifications"), {
          tech_cert: certData,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn("Firestore sync tech_cert error:", e);
      }
    }

    closeSignatureModal();
    renderTechCertificationUI();
    alert("✍️ บันทึกลายมือชื่อของเจ้าหน้าที่ช่างลงในเอกสารเรียบร้อยแล้ว!");
  }
};

// แปลงเลขอารบิกเป็นเลขไทยสำหรับหนังสือราชการ
function toThaiNumerals(num) {
  if (num === null || num === undefined) return '';
  const thaiDigits = ['๐', '๑', '๒', '๓', '๔', '๕', '๖', '๗', '๘', '๙'];
  return String(num).replace(/[0-9]/g, d => thaiDigits[d]);
}

window.setReportFormat = function (mode) {
  currentReportFormat = mode;
  const btnMemo = document.getElementById('btn-mode-memo');
  const btnDetailed = document.getElementById('btn-mode-detailed');
  const editToolbar = document.getElementById('memo-edit-toolbar');

  if (btnMemo && btnDetailed) {
    if (mode === 'memo') {
      btnMemo.style.background = '#ffffff';
      btnMemo.style.color = '#004d40';
      btnMemo.style.fontWeight = '700';

      btnDetailed.style.background = 'transparent';
      btnDetailed.style.color = '#ffffff';
      btnDetailed.style.fontWeight = '600';

      if (editToolbar) editToolbar.style.display = 'flex';
      const btnToggle = document.getElementById('btn-toggle-memo-toolbar');
      if (btnToggle) btnToggle.style.display = 'inline-flex';
    } else {
      btnDetailed.style.background = '#ffffff';
      btnDetailed.style.color = '#004d40';
      btnDetailed.style.fontWeight = '700';

      btnMemo.style.background = 'transparent';
      btnMemo.style.color = '#ffffff';
      btnMemo.style.fontWeight = '600';

      if (editToolbar) editToolbar.style.display = 'none';
      const btnToggle = document.getElementById('btn-toggle-memo-toolbar');
      if (btnToggle) btnToggle.style.display = 'none';
    }
  }

  window.renderSelectedReport();
};

window.toggleMemoEditToolbar = function () {
  const editToolbar = document.getElementById('memo-edit-toolbar');
  if (!editToolbar) return;
  const isHidden = (window.getComputedStyle(editToolbar).display === 'none');
  editToolbar.style.display = isHidden ? 'flex' : 'none';
};

// ฟังก์ชันปรับขนาดตัวอักษรเฉพาะส่วนที่เลือก หรือ ทั้งเอกสาร
window.adjustTargetMemoFont = function (delta) {
  const target = document.getElementById('memo-font-target')?.value || 'all';

  if (target === 'all') {
    memoFontConfig.header = Math.max(12, Math.min(22, memoFontConfig.header + delta));
    memoFontConfig.body = Math.max(12, Math.min(22, memoFontConfig.body + delta));
    memoFontConfig.sign = Math.max(11, Math.min(20, memoFontConfig.sign + delta));
  } else if (target === 'title') {
    memoFontConfig.title = Math.max(18, Math.min(48, (memoFontConfig.title || 29) + delta));
  } else if (target === 'header') {
    memoFontConfig.header = Math.max(12, Math.min(22, memoFontConfig.header + delta));
  } else if (target === 'body') {
    memoFontConfig.body = Math.max(12, Math.min(22, memoFontConfig.body + delta));
  } else if (target === 'sign') {
    memoFontConfig.sign = Math.max(11, Math.min(20, memoFontConfig.sign + delta));
  }

  window.updateMemoFontDisplay();
  window.applyMemoStyles();
};

window.updateMemoFontDisplay = function () {
  const target = document.getElementById('memo-font-target')?.value || 'all';
  const input = document.getElementById('memo-font-size-input');
  const disp = document.getElementById('memo-font-size-display');
  const currentVal = (target === 'all') ? memoFontConfig.body : (memoFontConfig[target] || 16);
  if (input) input.value = currentVal;
  if (disp) disp.innerText = `${currentVal}pt`;
};

window.applyMemoStyles = function () {
  const memoPaper = document.querySelector('.memo-paper');
  if (!memoPaper) return;

  // ระยะขอบ 4 ทิศทาง (มาตรฐาน: บน 2cm, ล่าง 2cm, ซ้าย 2.5cm, ขวา 2cm)
  memoPaper.style.paddingTop = `${memoMargins.top}cm`;
  memoPaper.style.paddingBottom = `${memoMargins.bottom}cm`;
  memoPaper.style.paddingLeft = `${memoMargins.left}cm`;
  memoPaper.style.paddingRight = `${memoMargins.right}cm`;

  // อัปเดตช่องตัวเลขขอบ 4 ด้านในแถบเครื่องมือ
  const inTop = document.getElementById('margin-in-top');
  const inBottom = document.getElementById('margin-in-bottom');
  const inLeft = document.getElementById('margin-in-left');
  const inRight = document.getElementById('margin-in-right');
  if (inTop) inTop.value = memoMargins.top;
  if (inBottom) inBottom.value = memoMargins.bottom;
  if (inLeft) inLeft.value = memoMargins.left;
  if (inRight) inRight.value = memoMargins.right;

  // ระยะบรรทัด
  memoPaper.style.lineHeight = memoLineSpacing;

  // ปรับขนาดฟอนต์หัวกระดาษ "บันทึกข้อความ"
  memoPaper.querySelectorAll('.memo-title-banner h1').forEach(el => {
    el.style.fontSize = `${memoFontConfig.title || 29}pt`;
  });

  // ปรับขนาดฟอนต์หัวหนังสือ
  memoPaper.querySelectorAll('.memo-info-table td, .memo-info-table td *').forEach(el => {
    el.style.fontSize = `${memoFontConfig.header}pt`;
  });

  // ปรับขนาดฟอนต์เนื้อหา
  memoPaper.querySelectorAll('.memo-section-heading, .memo-para').forEach(el => {
    el.style.fontSize = `${memoFontConfig.body}pt`;
  });

  // ปรับขนาดฟอนต์ส่วนลงนาม & กล่องเสนอ/อนุมัติ
  memoPaper.querySelectorAll('.memo-sign-table, .memo-sign-table td, .memo-sign-table td *, #memo-chef-box-card, #memo-chef-box-card *, #memo-exec-box-card, #memo-exec-box-card *').forEach(el => {
    if (!el.classList.contains('no-print') && !el.closest('.no-print')) {
      el.style.fontSize = `${memoFontConfig.sign}pt`;
    }
  });

  // บันทึกการตั้งค่าลง localStorage
  try {
    localStorage.setItem('pyh_memo_margins', JSON.stringify(memoMargins));
    localStorage.setItem('pyh_memo_fonts', JSON.stringify(memoFontConfig));
  } catch(e) {}
};

// ฟังก์ชันปรับระยะกั้นหน้า-กั้นหลัง (Margin ซ้าย-ขวา แบบปุ่มกด)
window.adjustMemoMargin = function (deltaMm) {
  const newLeft = parseFloat((memoMargins.left + (deltaMm / 10)).toFixed(1));
  const newRight = parseFloat((memoMargins.right + (deltaMm / 10)).toFixed(1));
  if (newLeft < 1.0 || newLeft > 4.5) return;
  memoMargins.left = newLeft;
  memoMargins.right = Math.max(1.0, newRight);
  window.applyMemoStyles();
};

window.adjustMemoSpacing = function (delta) {
  memoLineSpacing = Math.max(1.15, Math.min(1.85, parseFloat((memoLineSpacing + delta).toFixed(2))));
  window.applyMemoStyles();
};

window.resetMemoContent = function () {
  if (confirm("ต้องการคืนค่าข้อความและการจัดหน้าเริ่มต้นใช่ไหม?")) {
    localStorage.removeItem('pyh_custom_memo_data');
    localStorage.removeItem('pyh_memo_exec_box_offset');
    localStorage.removeItem('pyh_memo_chef_box_offset');
    localStorage.removeItem('pyh_memo_margins');
    localStorage.removeItem('pyh_memo_fonts');
    memoFontConfig = { title: 29, header: 16, body: 16, sign: 15 };
    memoMargins = { top: 2.0, bottom: 2.0, left: 2.5, right: 2.0 };
    memoLineSpacing = 1.45;
    memoExecBoxOffset = { x: 0, y: 0 };
    memoChefBoxOffset = { x: 0, y: 0 };
    memoExecBoxPosition = 'left';
    window.updateMemoFontDisplay();
    renderOfficialMemo();
  }
};

// บันทึกข้อความที่ผู้ใช้พิมพ์แก้ไขลงใน localStorage อัตโนมัติ
window.saveMemoEdits = function () {
  const paper = document.querySelector('.memo-paper');
  if (!paper) return;

  const data = {
    dept: document.getElementById('memo-dept')?.innerText || '',
    tel: document.getElementById('memo-tel')?.innerText || '',
    docNo: document.getElementById('memo-doc-no')?.innerText || '',
    docDate: document.getElementById('memo-doc-date')?.innerText || '',
    subject: document.getElementById('memo-subject')?.innerText || '',
    to: document.getElementById('memo-to')?.innerText || '',
    bgText: document.getElementById('memo-para-bg')?.innerText || '',
    considerText: document.getElementById('memo-para-consider')?.innerText || '',
    proposeText: document.getElementById('memo-para-propose')?.innerText || '',
    savedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem('pyh_custom_memo_data', JSON.stringify(data));
  } catch (e) { }
};

window.renderSelectedReport = function () {
  if (currentReportFormat === 'memo') {
    window.renderOfficialMemo();
  } else {
    window.generateExecutiveReport();
  }
};

// เรนเดอร์เอกสาร "แบบบันทึกข้อความราชการ" (Official Memo)
window.renderOfficialMemo = function () {
  const container = document.getElementById('report-content-body');
  if (!container) return;

  // คำนวณยอดสถิติจริงของอุปกรณ์ในระบบ
  const totalAssets = assetsList.length;
  const checkedAssets = assetsList.filter(a => a.lastChecked);
  const checkedCount = checkedAssets.length;
  const readyCount = assetsList.filter(a => a.status === 'READY' && a.lastChecked).length;
  const issueAssets = assetsList.filter(a => a.status === 'ISSUE');
  const issueCount = issueAssets.length;

  const feTotal = assetsList.filter(a => a.assetId.startsWith('PYH-FE') || a.type.includes('ถังดับเพลิง')).length;
  const emTotal = assetsList.filter(a => a.assetId.startsWith('PYH-EM') || a.type.includes('ไฟฉุกเฉิน')).length;

  // ผู้จัดทำและผู้บริหาร
  // ผู้จัดทำ, ผู้ตรวจสอบ (หัวหน้ากลุ่มงาน), และผู้บริหาร
  const authorName = getCleanName(currentOfficer) || "นายสุวิทย์ พวงสมบัติ";
  const authorPos = "นายช่างเทคนิค";
  const chefReviewerName = getCleanName(document.getElementById('report-reviewer-name')?.value.trim() || "นายคมสัน ศรีสิงห์");
  const chefReviewerPos1 = "นักเทคนิคการแพทย์ปฏิบัติการ รักษาการในตำแหน่ง";
  const chefReviewerPos2 = "หัวหน้ากลุ่มงานบริหารทั่วไป";
  const approverName = "นางสาวศิริพรรณ ชมพูภู่";
  const approverPos = "ผู้อำนวยการโรงพยาบาลพยุหะคีรี";

  // วันที่ปัจจุบันแบบไทย
  const now = new Date();
  const thaiDay = toThaiNumerals(now.getDate());
  const thaiMonth = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'][now.getMonth()];
  const thaiYear = toThaiNumerals(now.getFullYear() + 543);
  const thaiDateFormatted = `${thaiDay}   ${thaiMonth}  ${thaiYear}`;

  // ดึงข้อมูลที่เคยแก้ไขไว้ (ถ้ามี)
  let saved = null;
  try {
    const raw = localStorage.getItem('pyh_custom_memo_data');
    if (raw) saved = JSON.parse(raw);
  } catch (e) { }

  // ดึงการตั้งค่าขอบและฟอนต์ที่เคยบันทึกไว้ (ถ้ามี)
  try {
    const rawMarg = localStorage.getItem('pyh_memo_margins');
    if (rawMarg) memoMargins = Object.assign(memoMargins, JSON.parse(rawMarg));
    const rawFonts = localStorage.getItem('pyh_memo_fonts');
    if (rawFonts) memoFontConfig = Object.assign(memoFontConfig, JSON.parse(rawFonts));
  } catch(e) {}

  const deptVal = saved?.dept || "กลุ่มงานบริหารทั่วไปและงานซ่อมบำรุง โรงพยาบาลพยุหะคีรี อำเภอพยุหะคีรี จังหวัดนครสวรรค์";
  const docNoVal = saved?.docNo || `นว ๐๐๓๓.๓/พิเศษ`;
  const docDateVal = saved?.docDate || thaiDateFormatted;
  const subjectVal = saved?.subject || `รายงานผลการตรวจสอบความพร้อมอุปกรณ์ความปลอดภัยอัคคีภัยและโคมไฟฉุกเฉิน ประจำงวดปีงบประมาณ ${thaiYear}`;
  const toVal = saved?.to || "ผู้อำนวยการโรงพยาบาลพยุหะคีรี";

  const defaultBgText = `ด้วย งานอาคารสถานที่และซ่อมบำรุง กลุ่มงานบริหารทั่วไป โรงพยาบาลพยุหะคีรี มีภารกิจในการดูแล บำรุงรักษา และกำกับความพร้อมใช้งานของระบบความปลอดภัยด้านกายภาพและสิ่งแวดล้อม ตามเกณฑ์ MOIT ๒ ข้อ ๒ (๒.๒) และมาตรฐาน HA ตอนที่ II (ENV 1-4) เพื่อประโยชน์และความปลอดภัยสูงสุดต่อผู้ป่วย ญาติ และบุคลากรผู้ปฏิบัติงาน ให้เป็นไปตามพระราชบัญญัติควบคุมอาคาร และมาตรฐานความปลอดภัยด้านอัคคีภัยในสถานพยาบาลอย่างเคร่งครัด`;

  let defectSummaryThai = "";
  if (issueCount > 0) {
    const issueIds = issueAssets.map(a => a.assetId).join(', ');
    defectSummaryThai = ` ทั้งนี้ ตรวจพบอุปกรณ์ที่มีข้อบกพร่อง/ชำรุดจำนวน ${toThaiNumerals(issueCount)} จุด ได้แก่ ${issueIds} ซึ่งได้ดำเนินการจัดเตรียมถังสำรองเปลี่ยนทดแทน และประสานงานส่งซ่อมแซม/อัดบรรจุสารเคมีใหม่เรียบร้อยแล้ว`;
  } else {
    defectSummaryThai = ` โดยไม่พบความชำรุดเสียหาย อุปกรณ์ทั้งหมดอยู่ในเกณฑ์พร้อมใช้งานตามมาตรฐานความปลอดภัยอย่างครบถ้วน`;
  }

  const defaultConsiderText = `งานอาคารสถานที่และซ่อมบำรุง ขอรายงานผลการตรวจสอบความพร้อมใช้งานของถังดับเพลิงมือถือและโคมไฟส่องสว่างฉุกเฉินทั่วทั้งโรงพยาบาลพยุหะคีรี ครอบคลุมทั้งสิ้น ๖ อาคาร รวม ${toThaiNumerals(totalAssets)} จุดตรวจ (ถังดับเพลิง ${toThaiNumerals(feTotal)} จุด และโคมไฟฉุกเฉิน ${toThaiNumerals(emTotal)} จุด) ได้ดำเนินการตรวจเช็กสภาพความสมบูรณ์ แรงดันเกจ์ สลักนิรภัย และแบตเตอรี่สำรองแล้วเสร็จจำนวน ${toThaiNumerals(checkedCount)} จุด (${toThaiNumerals(Math.round((checkedCount / (totalAssets || 1)) * 100))}%) พบอุปกรณ์พร้อมใช้งานสมบูรณ์ ${toThaiNumerals(readyCount)} จุด${defectSummaryThai} เพื่อให้ระบบความปลอดภัยของโรงพยาบาลพยุหะคีรีมีมาตรฐานและความพร้อมใช้งานในระดับสูงสุดตลอด ๒๔ ชั่วโมง`;

  const defaultProposeText = `จึงเรียนมาเพื่อโปรดทราบ และพิจารณาอนุมัติดำเนินการตามมาตรการบำรุงรักษาอุปกรณ์ความปลอดภัยดังกล่าวต่อไป`;

  let bgText = saved?.bgText || defaultBgText;
  if (bgText && bgText.includes('(Environmental and Safety: HA ENV)')) {
    bgText = defaultBgText;
  }
  const considerText = saved?.considerText || defaultConsiderText;
  const proposeText = saved?.proposeText || defaultProposeText;

  const memoHtml = `
    <div class="memo-paper" style="padding-top:${memoMargins.top}cm; padding-bottom:${memoMargins.bottom}cm; padding-left:${memoMargins.left}cm; padding-right:${memoMargins.right}cm; line-height:${memoLineSpacing};" oninput="saveMemoEdits()">
      
      <!-- ส่วนหัวตราครุฑและคำว่า บันทึกข้อความ -->
      <div class="memo-header-top">
        <img src="garuda.svg" alt="ตราครุฑ" class="memo-garuda-img">
        <div class="memo-title-banner">
          <h1 style="font-size:${memoFontConfig.title || 29}pt;">บันทึกข้อความ</h1>
        </div>
      </div>

      <!-- ส่วนหัวหนังสือราชการ -->
      <table class="memo-info-table" style="font-size:${memoFontConfig.header}pt;">
        <tr>
          <td colspan="2" style="padding-bottom:5px;">
            <div style="display:flex; align-items:flex-start;">
              <span class="memo-label" style="font-size:${memoFontConfig.header}pt; min-width:85px; flex-shrink:0;">ส่วนราชการ</span>
              <div style="flex:1; line-height:1.4; font-size:${memoFontConfig.header}pt;">
                <span id="memo-dept" class="memo-editable" contenteditable="true" style="font-size:${memoFontConfig.header}pt;">${deptVal}</span>
              </div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="width:52%; padding-bottom:5px;">
            <div style="display:flex; align-items:center;">
              <span class="memo-label" style="font-size:${memoFontConfig.header}pt; min-width:30px; flex-shrink:0;">ที่</span>
              <span id="memo-doc-no" class="memo-editable" contenteditable="true" style="margin-left:8px; min-width:140px; font-size:${memoFontConfig.header}pt;">${docNoVal}</span>
            </div>
          </td>
          <td style="width:48%; padding-bottom:5px;">
            <div style="display:flex; align-items:center;">
              <span class="memo-label" style="font-size:${memoFontConfig.header}pt; min-width:45px; flex-shrink:0;">วันที่</span>
              <span id="memo-doc-date" class="memo-editable" contenteditable="true" style="margin-left:8px; min-width:140px; font-size:${memoFontConfig.header}pt;">${docDateVal}</span>
            </div>
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding-bottom:5px;">
            <div style="display:flex; align-items:flex-start;">
              <span class="memo-label" style="font-size:${memoFontConfig.header}pt; min-width:45px; flex-shrink:0;">เรื่อง</span>
              <div style="flex:1; line-height:1.4; font-size:${memoFontConfig.header}pt;">
                <span id="memo-subject" class="memo-editable" contenteditable="true" style="font-size:${memoFontConfig.header}pt; font-weight:700;">${subjectVal}</span>
              </div>
            </div>
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:2px; padding-bottom:12px;">
            <div style="display:flex; align-items:center;">
              <span class="memo-label" style="font-size:${memoFontConfig.header}pt; min-width:45px; flex-shrink:0;">เรียน</span>
              <span id="memo-to" class="memo-editable" contenteditable="true" style="margin-left:8px; font-size:${memoFontConfig.header}pt;">${toVal}</span>
            </div>
          </td>
        </tr>
      </table>

      <!-- ย่อหน้าที่ 1: ความเป็นมา -->
      <div class="memo-section-heading" style="font-size:${memoFontConfig.body}pt;">ความเป็นมา</div>
      <div id="memo-para-bg" class="memo-para memo-editable-block" contenteditable="true" style="font-size:${memoFontConfig.body}pt;">
        ${bgText}
      </div>

      <!-- ย่อหน้าที่ 2: ข้อพิจารณา -->
      <div class="memo-section-heading" style="font-size:${memoFontConfig.body}pt;">ข้อพิจารณา</div>
      <div id="memo-para-consider" class="memo-para memo-editable-block" contenteditable="true" style="font-size:${memoFontConfig.body}pt;">
        ${considerText}
      </div>

      <!-- ย่อหน้าที่ 3: ข้อเสนอ / ข้อสั่งการ -->
      <div id="memo-para-propose" class="memo-para memo-editable-block" contenteditable="true" style="font-size:${memoFontConfig.body}pt; margin-top:14px; margin-bottom:20px;">
        ${proposeText}
      </div>

      <!-- ส่วนลงนามผู้รายงาน, กล่องเสนอ ผอ. (หน.กลุ่มงาน), และคำสั่งการผู้อำนวยการ -->
      ${(() => {
        // ดึง offset ที่บันทึกไว้สำหรับกล่อง ผอ.
        try {
          const rawOff = localStorage.getItem('pyh_memo_exec_box_offset');
          if (rawOff) memoExecBoxOffset = JSON.parse(rawOff);
        } catch(e) {}

        // ดึง offset ที่บันทึกไว้สำหรับกล่อง หน.กลุ่มงาน
        try {
          const rawChefOff = localStorage.getItem('pyh_memo_chef_box_offset');
          if (rawChefOff) memoChefBoxOffset = JSON.parse(rawChefOff);
        } catch(e) {}

        const transformStyle = (memoExecBoxOffset.x || memoExecBoxOffset.y) 
          ? `transform: translate(${memoExecBoxOffset.x}px, ${memoExecBoxOffset.y}px);` 
          : '';

        const chefTransformStyle = (memoChefBoxOffset.x || memoChefBoxOffset.y)
          ? `transform: translate(${memoChefBoxOffset.x}px, ${memoChefBoxOffset.y}px);`
          : '';

        // กล่องคำสั่งการ / การอนุมัติของ ผอ. (รองรับการใช้เมาส์ลากย้ายตำแหน่งได้อิสระ)
        const execBoxHtml = `
          <div id="memo-exec-box-card" style="margin-top:${memoExecBoxMarginTop}px; padding:10px 14px; border:1px solid #cbd5e1; border-radius:8px; background:#fafafa; text-align:left; cursor:grab; position:relative; ${transformStyle}">
            <div id="memo-exec-box-drag-handle" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; user-select:none;">
              <span style="font-weight:700; font-size:${memoFontConfig.sign}pt; color:#0f172a;">คำสั่งการ / การอนุมัติ</span>
              <span class="no-print" style="font-size:11px; color:#94a3b8; display:flex; align-items:center; gap:3px; background:#f1f5f9; padding:2px 6px; border-radius:4px;" title="คลิกค้างแล้วลากเมาส์เพื่อย้ายตำแหน่งกล่อง ผอ. ได้อย่างอิสระ">
                ✥ ลากย้ายได้
              </span>
            </div>
            
            <!-- ตัวเลือกคำสั่งการแบบช่องเช็ก [ ✓ ] รับทราบ [   ] อนุมัติซ่อมแซม (คลิกสลับได้โดยตรง) -->
            <div style="margin-bottom:10px; font-size:${memoFontConfig.sign}pt; display:flex; flex-wrap:wrap; gap:16px; align-items:center;">
              <span id="print-appr-ack" onclick="setExecutiveApproval('acknowledge')" style="cursor:pointer; user-select:none; font-family:'TH Sarabun New', 'Sarabun', sans-serif;">[ &nbsp; ] รับทราบ</span>
              <span id="print-appr-repair" onclick="setExecutiveApproval('repair')" style="cursor:pointer; user-select:none; font-family:'TH Sarabun New', 'Sarabun', sans-serif;">[ ✓ ] อนุมัติซ่อมแซม</span>
            </div>

            <!-- ช่องลงนาม ผอ. (ไม่มีบรรทัดวันที่) -->
            <div style="text-align:center; margin-top:10px;">
              <div id="exec-cert-container" style="min-height:28px;">
                <!-- เติมโดย renderExecutiveCertificationUI() -->
              </div>
              <div style="border-bottom:1px dotted #94a3b8; width:80%; margin:4px auto 4px auto;"></div>
              <div style="font-weight:700; font-size:${memoFontConfig.sign}pt;" id="report-display-exec-name">( ${approverName} )</div>
              <div style="font-size:${memoFontConfig.sign - 2}pt; color:#475569;">${approverPos}</div>
            </div>
          </div>
        `;

        // ส่วนลงนามผู้จัดทำ / ผู้รายงาน (ช่างเทคนิค - ไม่มีบรรทัดวันที่)
        const techSignHtml = `
          <div style="margin-top:6px; text-align:center;">
            <!-- ลายเซ็นดิจิทัลของช่าง/ผู้รายงาน -->
            <div id="tech-cert-container" style="min-height:36px;">
              <!-- เติมโดย renderTechCertificationUI() -->
            </div>

            <div style="border-bottom:1px dotted #94a3b8; width:75%; margin:4px auto 6px auto;"></div>
            <div style="font-weight:700; font-size:${memoFontConfig.sign}pt;" id="report-display-tech-name">( ${authorName} )</div>
            <div style="font-size:${memoFontConfig.sign - 1}pt; color:#334155;" id="report-display-tech-pos">${authorPos}</div>
          </div>
        `;

        // กล่องข้อความหัวหน้ากลุ่มงานบริหารทั่วไป (เสนอ ผอ.)
        const chefBoxHtml = `
          <div id="memo-chef-box-card" style="margin-top:${memoExecBoxMarginTop}px; padding:10px 14px; border:1px solid #cbd5e1; border-radius:8px; background:#fafafa; text-align:left; cursor:grab; position:relative; ${chefTransformStyle}">
            <div id="memo-chef-box-drag-handle" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; user-select:none;">
              <span style="font-weight:700; font-size:${memoFontConfig.sign}pt; color:#0f172a;">เรียน ผู้อำนวยการโรงพยาบาลพยุหะคีรี</span>
              <span class="no-print" style="font-size:11px; color:#94a3b8; display:flex; align-items:center; gap:3px; background:#f1f5f9; padding:2px 6px; border-radius:4px;" title="คลิกค้างแล้วลากเมาส์เพื่อย้ายตำแหน่งกล่องนี้ได้อย่างอิสระ">
                ✥ ลากย้ายได้
              </span>
            </div>

            <!-- ข้อความเพื่อรับทราบ / พิจารณาอนุมัติ (คลิกสลับได้) -->
            <div style="margin-bottom:10px; font-size:${memoFontConfig.sign}pt; display:flex; flex-wrap:wrap; gap:14px; align-items:center;">
              <span style="font-weight:600;">เพื่อ</span>
              <span id="memo-chef-opt-ack" onclick="setChefApproval('ack')" style="cursor:pointer; user-select:none; font-family:'TH Sarabun New', 'Sarabun', sans-serif;">[ ✓ ] โปรดรับทราบ</span>
              <span id="memo-chef-opt-approve" onclick="setChefApproval('approve')" style="cursor:pointer; user-select:none; font-family:'TH Sarabun New', 'Sarabun', sans-serif;">[ &nbsp; ] โปรดพิจารณาอนุมัติ</span>
            </div>

            <!-- ช่องลายเซ็นหัวหน้ากลุ่มงาน -->
            <div style="text-align:center; margin-top:8px;">
              <div id="memo-chef-cert-container" style="min-height:28px;">
                <!-- เติมโดย renderChefCertificationUI() -->
              </div>
              <div style="border-bottom:1px dotted #94a3b8; width:80%; margin:4px auto 4px auto;"></div>
              <div style="font-weight:700; font-size:${memoFontConfig.sign}pt;" id="memo-display-chef-name">( ${chefReviewerName} )</div>
              <div style="font-size:${memoFontConfig.sign - 2}pt; color:#475569;">${chefReviewerPos1}</div>
              <div style="font-size:${memoFontConfig.sign - 2}pt; color:#475569;">${chefReviewerPos2}</div>
            </div>
          </div>
        `;

        if (memoExecBoxPosition === 'right') {
          // ถ้าเลือกตำแหน่ง 'ขวา': วางช่างทางขวา, กล่อง หน.กลุ่มงาน ถัดลงมา, แล้วตามด้วยกล่อง ผอ.
          return `
            <table class="memo-sign-table" style="width:100%; font-size:${memoFontConfig.sign}pt; border-collapse:collapse;">
              <tr>
                <td style="width:40%;"></td>
                <td style="width:60%; vertical-align:top; text-align:center;">
                  ${techSignHtml}
                </td>
              </tr>
              <tr>
                <td style="width:40%;"></td>
                <td style="width:60%; vertical-align:top;">
                  ${chefBoxHtml}
                </td>
              </tr>
              <tr>
                <td style="width:40%;"></td>
                <td style="width:60%; vertical-align:top;">
                  ${execBoxHtml}
                </td>
              </tr>
            </table>
          `;
        } else {
          // ตำแหน่ง 'ซ้าย' (มาตรฐาน 2 คอลัมน์):
          // ฝั่งซ้าย: กล่อง ผอ. (คำสั่งการ / การอนุมัติ)
          // ฝั่งขวา: ลายเซ็นช่างผู้รายงาน + กล่อง หน.กลุ่มงาน (เรียน ผอ. เพื่อโปรดรับทราบ/อนุมัติ)
          return `
            <table class="memo-sign-table" style="width:100%; font-size:${memoFontConfig.sign}pt; border-collapse:collapse;">
              <tr>
                <td style="width:48%; vertical-align:top; padding-right:12px;">
                  ${execBoxHtml}
                </td>
                <td style="width:52%; vertical-align:top; padding-left:8px;">
                  ${techSignHtml}
                  <div style="margin-top:14px;">
                    ${chefBoxHtml}
                  </div>
                </td>
              </tr>
            </table>
          `;
        }
      })()}
    </div>
  `;

  container.innerHTML = memoHtml;

  // เปิดใช้งานฟังก์ชันลากย้ายกล่อง ผอ. และกล่อง หน.กลุ่มงาน ด้วยเมาส์
  if (typeof window.initExecBoxDraggable === 'function') {
    window.initExecBoxDraggable();
  }
  if (typeof window.initChefBoxDraggable === 'function') {
    window.initChefBoxDraggable();
  }

  // ซิงก์ลายเซ็นและคำสั่งการที่มีอยู่ในระบบ
  if (typeof window.renderTechCertificationUI === 'function') {
    window.renderTechCertificationUI();
  }
  if (typeof window.renderChefCertificationUI === 'function') {
    window.renderChefCertificationUI();
  }
  if (typeof window.renderExecutiveCertificationUI === 'function') {
    window.renderExecutiveCertificationUI();
  }
  if (typeof window.restoreExecutiveApproval === 'function') {
    window.restoreExecutiveApproval();
  }

  // อัปเดตการแสดงผลขนาดฟอนต์และขอบกระดาษให้ตรงกับค่าปัจจุบัน
  if (typeof window.applyMemoStyles === 'function') {
    window.applyMemoStyles();
  }
  if (typeof window.updateMemoFontDisplay === 'function') {
    window.updateMemoFontDisplay();
  }
};

window.generateExecutiveReport = function () {
  const container = document.getElementById('report-content-body');
  if (!container) return;

  const period = document.getElementById('report-period')?.value || "กันยายน 2569";
  const buildingFilter = document.getElementById('report-building-filter')?.value || "all";

  // ส่วนที่ 1: ผู้จัดทำและเสนอรายงาน
  const authorName = getCleanName(document.getElementById('report-author-name')?.value.trim() || "นายสุวิทย์ พวงสมบัติ");
  const authorPos = document.getElementById('report-author-pos')?.value.trim() || "นายช่างเทคนิค";
  const author = authorName;

  // ส่วนที่ 2: ผู้ตรวจสอบ (Chef Inspector)
  const reviewerName = getCleanName(document.getElementById('report-reviewer-name')?.value.trim() || "นายคมสันต์ ศรีสิงห์");
  const reviewerPos = document.getElementById('report-reviewer-pos')?.value.trim() || "นักเทคนิคการแพทย์ปฏิบัติการ รักษาราชการแทน หัวหน้าฝ่ายบริหารทั่วไป";
  const reviewer = reviewerName;

  // ส่วนที่ 3: ผู้บริหารผู้อนุมัติคำสั่งการ
  const approverName = getCleanName(document.getElementById('report-approver-name')?.value.trim() || "นางสาวศิริพรรณ ชมพูภู่");
  const approverPos = document.getElementById('report-approver-pos')?.value.trim() || "ผู้อำนวยการโรงพยาบาลพยุหะคีรี";
  const approver = approverName;

  const includeAllItems = document.getElementById('report-include-all-items')?.checked ?? true;

  // เรียงลำดับอุปกรณ์ตาม: 1. ตึก/อาคาร 2. ชั้น/ห้อง/จุดติดตั้ง 3. รหัสลำดับอุปกรณ์ (Natural sorting)
  const buildingOrder = [
    'building_er_lower',
    'building_er_upper',
    'building_hpc',
    'building_ipd',
    'building_nisit',
    'building_opd_dm'
  ];

  const rawTargetAssets = (buildingFilter === 'all')
    ? [...assetsList]
    : assetsList.filter(a => a.buildingId === buildingFilter);

  const targetAssets = rawTargetAssets.sort((a, b) => {
    // 1. เรียงตามลำดับตึก/อาคาร
    const bIdxA = buildingOrder.indexOf(a.buildingId);
    const bIdxB = buildingOrder.indexOf(b.buildingId);
    const orderA = bIdxA !== -1 ? bIdxA : 999;
    const orderB = bIdxB !== -1 ? bIdxB : 999;
    if (orderA !== orderB) return orderA - orderB;

    // 2. เรียงตามชั้น (ถ้ามี)
    const floorA = a.floor || 1;
    const floorB = b.floor || 1;
    if (floorA !== floorB) return floorA - floorB;

    // 3. เรียงตามรหัสอุปกรณ์ (Asset ID) ลำดับ 01, 02, 03... (Natural Numeric Sorting)
    const idComp = (a.assetId || '').localeCompare(b.assetId || '', undefined, { numeric: true, sensitivity: 'base' });
    if (idComp !== 0) return idComp;

    // 4. เรียงตามห้อง / จุดติดตั้ง
    return (a.location || '').localeCompare(b.location || '', 'th');
  });

  const totalAssets = targetAssets.length;
  const checkedAssets = targetAssets.filter(a => a.lastChecked);
  const checkedCount = checkedAssets.length;
  const readyCount = targetAssets.filter(a => a.status === 'READY' && a.lastChecked).length;
  const issueAssets = targetAssets.filter(a => a.status === 'ISSUE');
  const issueCount = issueAssets.length;
  const uninspectedCount = totalAssets - checkedCount;

  const coverageRate = totalAssets > 0 ? Math.round((checkedCount / totalAssets) * 100) : 0;
  const readinessRate = checkedCount > 0 ? Math.round((readyCount / checkedCount) * 100) : 0;

  // จำแนกตามประเภทอุปกรณ์
  const feAssets = targetAssets.filter(a => a.assetId.startsWith('PYH-FE') || a.type.includes('ถังดับเพลิง'));
  const feChecked = feAssets.filter(a => a.lastChecked).length;
  const feReady = feAssets.filter(a => a.status === 'READY' && a.lastChecked).length;
  const feIssue = feAssets.filter(a => a.status === 'ISSUE').length;

  const emAssets = targetAssets.filter(a => a.assetId.startsWith('PYH-EM') || a.type.includes('ไฟฉุกเฉิน'));
  const emChecked = emAssets.filter(a => a.lastChecked).length;
  const emReady = emAssets.filter(a => a.status === 'READY' && a.lastChecked).length;
  const emIssue = emAssets.filter(a => a.status === 'ISSUE').length;

  const filterName = (buildingFilter === 'all')
    ? 'ทุกอาคารทั่วทั้งโรงพยาบาลพยุหะคีรี (6 อาคาร 48 จุดตรวจ)'
    : (buildingMetadata[buildingFilter]?.name || buildingFilter);

  const reportDate = new Date().toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  // สร้างแถวตารางวิเคราะห์รายอาคาร
  let buildingRowsHtml = '';
  const buildingKeys = (buildingFilter === 'all')
    ? Object.keys(buildingMetadata)
    : [buildingFilter];

  buildingKeys.forEach((bId, idx) => {
    const meta = buildingMetadata[bId] || { name: bId };
    const bAssets = assetsList.filter(a => a.buildingId === bId);
    const bTotal = bAssets.length;
    const bChecked = bAssets.filter(a => a.lastChecked).length;
    const bReady = bAssets.filter(a => a.status === 'READY' && a.lastChecked).length;
    const bIssue = bAssets.filter(a => a.status === 'ISSUE').length;
    const bRate = bChecked > 0 ? Math.round((bReady / bChecked) * 100) : 0;

    let statusBadge = '';
    if (bIssue > 0) {
      statusBadge = `<span class="badge badge-issue">พบชำรุด ${bIssue} จุด</span>`;
    } else if (bChecked === bTotal && bTotal > 0) {
      statusBadge = `<span class="badge badge-ready">พร้อมใช้งาน 100%</span>`;
    } else {
      statusBadge = `<span style="color:#d97706; font-size:12px; font-weight:600;">ตรวจแล้ว ${bChecked}/${bTotal} จุด</span>`;
    }

    buildingRowsHtml += `
      <tr>
        <td style="text-align:center;">${idx + 1}</td>
        <td><b>${meta.name}</b></td>
        <td style="text-align:center;">${bTotal}</td>
        <td style="text-align:center;">${bChecked}</td>
        <td style="text-align:center; color:#15803d; font-weight:bold;">${bReady}</td>
        <td style="text-align:center; color:#dc2626; font-weight:bold;">${bIssue}</td>
        <td style="text-align:center;"><b>${bRate}%</b></td>
        <td style="text-align:center;">${statusBadge}</td>
      </tr>
    `;
  });

  // สร้างตารางรายการข้อบกพร่อง / แผนซ่อมบำรุง
  let defectHtml = '';
  if (issueAssets.length === 0) {
    defectHtml = `
      <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:14px; color:#166534; font-size:13px; margin-bottom:16px;">
        ✅ <b>ผลการประเมินความปลอดภัย:</b> ไม่พบอุปกรณ์ที่มีข้อบกพร่องหรือชำรุดในงวดนี้ อุปกรณ์ทั้งหมดที่ได้รับการตรวจเช็กอยู่ในเกณฑ์พร้อมใช้งาน 100% ตามมาตรฐาน HA ENV
      </div>
    `;
  } else {
    defectHtml = `
      <table class="report-table">
        <thead>
          <tr style="background:#fee2e2;">
            <th style="width:40px; text-align:center;">ที่</th>
            <th style="width:110px;">รหัสอุปกรณ์</th>
            <th style="width:140px;">ประเภท</th>
            <th>ตำแหน่งติดตั้ง / อาคาร</th>
            <th>อาการผิดปกติที่ตรวจพบ</th>
            <th style="width:120px;">ผู้ตรวจ</th>
            <th style="width:150px;">มาตรการแก้ไขเร่งด่วน</th>
            <th style="width:80px; text-align:center;">ระดับความเร่งด่วน</th>
          </tr>
        </thead>
        <tbody>
    `;

    issueAssets.forEach((item, index) => {
      const lastLog = inspectionLogs.find(l => l.assetId === item.assetId);
      const note = lastLog?.notes || "ตรวจพบความผิดปกติระหว่างการตรวจเช็ก";

      let actionPlan = "ส่งซ่อมบำรุง / ตรวจสภาพโดยช่างผู้ชำนาญการ";
      if (item.assetId.startsWith('PYH-FE')) {
        if (note.includes('แรงดัน') || note.includes('ขีดเขียว')) {
          actionPlan = "ส่งอัดบรรจุผงเคมี/ก๊าซใหม่ทันที และตรวจเช็กซีลวาล์ว";
        } else if (note.includes('สลัก') || note.includes('ซีล')) {
          actionPlan = "เปลี่ยนสลักนิรภัย (Safety Pin) และซีลล็อคใหม่";
        } else {
          actionPlan = "จัดหาถังสำรองเปลี่ยนทดแทน และส่งซ่อมบำรุง";
        }
      } else {
        actionPlan = "เปลี่ยนแบตเตอรี่สำรอง / หลอด LED โคมไฟฉุกเฉิน";
      }

      defectHtml += `
        <tr>
          <td style="text-align:center;">${index + 1}</td>
          <td><b style="color:#b91c1c;">${item.assetId}</b></td>
          <td>${cleanAssetType(item.type)}</td>
          <td><b>${item.building}</b><br><span style="color:#64748b; font-size:11.5px;">${item.location}</span></td>
          <td style="color:#b91c1c;">${note}</td>
          <td>${getCleanName(item.lastInspector) || '-'}</td>
          <td style="color:#00695c; font-weight:600;">${actionPlan}</td>
          <td style="text-align:center;"><span class="badge badge-issue" style="background:#ef4444; color:white;">เร่งด่วน</span></td>
        </tr>
      `;
    });

    defectHtml += `
        </tbody>
      </table>
    `;
  }

  // สร้างตารางรายการอุปกรณ์ทั้งหมด (Full Checklist Register)
  let allItemsRowsHtml = '';
  targetAssets.forEach((a, i) => {
    const isReady = a.status === 'READY';
    let checkedDate = 'ยังไม่ได้ตรวจ';
    if (a.lastChecked) {
      const dt = new Date(a.lastChecked);
      if (!isNaN(dt.getTime())) {
        checkedDate = dt.toLocaleDateString('th-TH');
      } else {
        checkedDate = new Date().toLocaleDateString('th-TH');
      }
    }
    const inspectorName = getCleanName(a.lastInspector) || '-';
    const cleanedType = cleanAssetType(a.type);
    allItemsRowsHtml += `
      <tr>
        <td style="text-align:center; font-size:11px;">${i + 1}</td>
        <td><b>${a.assetId}</b></td>
        <td>${cleanedType}</td>
        <td>${a.building} - ${a.location}</td>
        <td style="text-align:center; font-size:11.5px; font-weight:700; color:${isReady ? '#16a34a' : '#dc2626'};">
          ${isReady ? 'พร้อมใช้งาน' : 'ชำรุด/แจ้งซ่อม'}
        </td>
        <td style="text-align:center; font-size:11.5px;">${checkedDate}</td>
        <td style="font-size:11.5px;">${inspectorName}</td>
      </tr>
    `;
  });

  const fullReportHtml = `
    <div class="report-paper">
      
      <!-- ส่วนหัวเอกสารราชการ -->
      <div class="report-header-banner">
        <div>
          <div style="font-size:12px; font-weight:700; color:#00695c; letter-spacing:0.5px; text-transform:uppercase;">
            Pyuha Kiri Hospital • Environmental and Safety Committee (HA ENV)
          </div>
          <h2 class="report-title">รายงานสรุปผลการตรวจสอบความพร้อมใช้งานระบบความปลอดภัยและอัคคีภัย</h2>
          <p class="report-subtitle">
            ถังดับเพลิงมือถือ (Fire Extinguishers) และโคมไฟส่องสว่างฉุกเฉิน (Emergency Lights) • ประจำงวด ${period}
          </p>
        </div>
        <div style="text-align:right;">
          <span style="display:inline-block; border:1px solid #cbd5e1; padding:4px 8px; border-radius:4px; font-size:11px; background:#f8fafc; font-weight:600;">
            เลขที่เอกสาร: PYH-ENV-${new Date().getFullYear() + 543}-${String(new Date().getMonth() + 1).padStart(2, '0')}
          </span>
          <div style="font-size:11.5px; color:#64748b; margin-top:4px;">
            วันที่ออกรายงาน: ${reportDate}
          </div>
        </div>
      </div>

      <!-- กล่องข้อมูลการตรวจสอบ (แสดงบนหน้าจอ แต่ซ่อนอัตโนมัติเวลาสั่งพิมพ์เพื่อประหยัดพื้นที่กระดาษ) -->
      <div class="report-meta-box no-print">
        <div><b>📅 รอบการตรวจสอบ:</b> ประจำงวด ${period}</div>
        <div><b>🏢 ขอบเขตการประเมิน:</b> ${filterName}</div>
        <div><b>👤 ผู้จัดทำรายงาน:</b> ${author}</div>
        <div><b>🎯 เรียนเสนอ:</b> ${approver}</div>
        <div style="grid-column: 1 / -1; border-top: 1px dashed #cbd5e1; padding-top: 6px; color:#475569;">
          <b>📜 อ้างอิงเกณฑ์มาตรฐาน:</b> มาตรฐานโรงพยาบาลและบริการสุขภาพ (HA) ตอนที่ II ระบบกายภาพและความปลอดภัย (ENV 1-4), NFPA 10 (Portable Fire Extinguishers) และมาตรฐาน วสท. 022002-22
        </div>
      </div>

      <!-- สรุปดัชนีชี้วัดหลัก (Executive KPIs) -->
      <div class="report-section-title">1. สรุปดัชนีชี้วัดความพร้อมใช้งานตามมาตรฐาน HA (Executive Safety KPIs)</div>
      <div class="report-summary-cards">
        <div class="report-stat">
          <span class="report-stat-num" style="color:#0f172a;">${totalAssets}</span>
          <span class="report-stat-label">อุปกรณ์เป้าหมายทั้งหมด (จุด)</span>
        </div>
        <div class="report-stat">
          <span class="report-stat-num" style="color:#0284c7;">${coverageRate}%</span>
          <span class="report-stat-label">อัตราการตรวจเช็ก (${checkedCount}/${totalAssets})</span>
        </div>
        <div class="report-stat">
          <span class="report-stat-num" style="color:#16a34a;">${readinessRate}%</span>
          <span class="report-stat-label">อัตราความพร้อมใช้งาน (${readyCount}/${checkedCount || totalAssets})</span>
        </div>
        <div class="report-stat" style="background:${issueCount > 0 ? '#fef2f2' : '#f0fdf4'};">
          <span class="report-stat-num" style="color:${issueCount > 0 ? '#dc2626' : '#16a34a'};">${issueCount}</span>
          <span class="report-stat-label">รายการชำรุด / ต้องซ่อมบำรุง</span>
        </div>
      </div>

      <!-- แยกประเภทอุปกรณ์ -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
        <div style="border:1px solid #e2e8f0; border-radius:6px; padding:10px 14px; background:#f8fafc;">
          <b style="color:#00695c; font-size:13px;">🧯 ระบบถังดับเพลิง (Fire Extinguishers)</b>
          <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
            <span>เป้าหมายทั้งหมด: <b>${feAssets.length} จุด</b></span>
            <span>ตรวจแล้ว: <b>${feChecked}</b></span>
            <span>พร้อมใช้งาน: <b style="color:#15803d;">${feReady}</b></span>
            <span>ชำรุด: <b style="color:#dc2626;">${feIssue}</b></span>
          </div>
        </div>
        <div style="border:1px solid #e2e8f0; border-radius:6px; padding:10px 14px; background:#f8fafc;">
          <b style="color:#0284c7; font-size:13px;">💡 ระบบไฟฉุกเฉิน (Emergency Lights)</b>
          <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
            <span>เป้าหมายทั้งหมด: <b>${emAssets.length} จุด</b></span>
            <span>ตรวจแล้ว: <b>${emChecked}</b></span>
            <span>พร้อมใช้งาน: <b style="color:#15803d;">${emReady}</b></span>
            <span>ชำรุด: <b style="color:#dc2626;">${emIssue}</b></span>
          </div>
        </div>
      </div>

      <!-- ตารางวิเคราะห์รายอาคาร -->
      <div class="report-section-title">2. ตารางสรุปผลการตรวจสอบจำแนกตามอาคาร (Building Compliance Summary)</div>
      <table class="report-table">
        <thead>
          <tr>
            <th style="width:40px; text-align:center;">ลำดับ</th>
            <th>อาคาร / พื้นที่บริการ</th>
            <th style="width:70px; text-align:center;">ทั้งหมด</th>
            <th style="width:70px; text-align:center;">ตรวจแล้ว</th>
            <th style="width:70px; text-align:center;">ปกติ</th>
            <th style="width:70px; text-align:center;">ชำรุด</th>
            <th style="width:90px; text-align:center;">ความพร้อม (%)</th>
            <th style="width:140px; text-align:center;">สถานะประเมิน</th>
          </tr>
        </thead>
        <tbody>
          ${buildingRowsHtml}
        </tbody>
      </table>

      <!-- รายการข้อบกพร่องและแผนแก้ไข -->
      <div class="report-section-title">3. รายการข้อบกพร่องและแผนปฏิบัติการแก้ไขเร่งด่วน (Defect Log & Action Required)</div>
      ${defectHtml}

      <!-- สรุปเชิงนโยบายและข้อเสนอแนะ -->
      <div class="report-section-title">4. ข้อคิดเห็นและข้อเสนอแนะของคณะทำงานความปลอดภัย (ENV Committee Remarks)</div>
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:12px 14px; font-size:12.5px; line-height:1.6; color:#334155;">
        <p style="margin:0 0 6px 0;">
          1. <b>ภาพรวมความพร้อมใช้งาน:</b> อุปกรณ์ความปลอดภัยในส่วนหอผู้ป่วยและแผนกบริการวิกฤต (ICU, ER, ห้องผ่าตัด) มีความพร้อมใช้งานอยู่ในเกณฑ์ปลอดภัยสูง สอดคล้องกับข้อกำหนดการรับรองมาตรฐาน HA
        </p>
        <p style="margin:0 0 6px 0;">
          2. <b>มาตรการแก้ไขเร่งด่วน:</b> สำหรับรายการที่พบข้อบกพร่อง (${issueCount} รายการ) งานอาคารสถานที่ได้ดำเนินการนำถังดับเพลิงสำรองไปติดตั้งสับเปลี่ยนในจุดที่ชำรุดเรียบร้อยแล้ว เพื่อมิให้เกิดช่องว่างความเสี่ยงในระหว่างรอส่งอัดบรรจุสารดับเพลิงและเปลี่ยนแบตเตอรี่
        </p>
        <p style="margin:0;">
          3. <b>การบริหารจัดการงบประมาณ:</b> ขอเสนอขออนุมัติงบประมาณหมวดค่าบำรุงรักษาและซ่อมแซมครุภัณฑ์ ประจำปีงบประมาณ เพื่อดำเนินการจัดซื้อแบตเตอรี่สำรองและค่าบริการอัดบรรจุสารเคมีดับเพลิงตามตารางข้างต้น
        </p>
      </div>

      <!-- 5. ส่วนลงนามผู้ตรวจเช็ก ผู้ตรวจสอบ และผู้อนุมัติสั่งการ (ต่อท้ายข้อ 4 ทันที) -->
      <div class="report-section-title" style="margin-top:16px;">5. การรับรองผลการตรวจสอบและคำสั่งการผู้บริหาร (Sign-Off & Approval)</div>
      <div style="margin-top:8px; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; break-inside:avoid;">
        <table style="width:100%; border-collapse:collapse; border:none;">
          <tr>
            <!-- ลำดับที่ 1: ผู้จัดทำรายงาน / ช่างผู้ตรวจ -->
            <td style="width:33.33%; text-align:center; vertical-align:top; padding:0 8px;">
              <p style="margin:0 0 6px 0; font-size:12px; color:#334155; font-weight:600;">ผู้จัดทำรายงาน / ผู้ตรวจเช็ก</p>
              
              <!-- ลายเซ็น/สถานะการลงนามของช่างผู้ตรวจ -->
              <div id="tech-cert-container" style="margin-bottom:4px; min-height:26px;">
                <!-- จะถูกเติมแบบไดนามิกโดย renderTechCertificationUI() -->
              </div>

              <div style="border-bottom:1px dotted #64748b; width:75%; margin:0 auto 4px auto;"></div>
              <p style="margin:0; font-size:12px; font-weight:700; color:#0f172a;" id="report-display-tech-name">( ${authorName} )</p>
              <p style="margin:2px 0 0 0; font-size:11px; color:#64748b;" id="report-display-tech-pos">${authorPos}</p>
              <p style="margin:3px 0 0 0; font-size:11px; color:#64748b;" id="tech-sign-date-str">วันที่ ........ / ........ / ................</p>
            </td>

            <!-- ลำดับที่ 2: ผู้ตรวจสอบ / หัวหน้ากลุ่มงาน (Chef Inspector)  -->
            <td style="width:33.33%; text-align:center; vertical-align:top; padding:0 8px;">
              <p style="margin:0 0 6px 0; font-size:12px; color:#334155; font-weight:600;">ผู้ตรวจสอบ</p>

              <!-- ลายเซ็น/สถานะการลงนามของผู้ตรวจสอบ -->
              <div id="chef-cert-container" style="margin-bottom:4px; min-height:26px;">
                <!-- จะถูกเติมแบบไดนามิกโดย renderChefCertificationUI() -->
              </div>

              <div style="border-bottom:1px dotted #64748b; width:75%; margin:0 auto 4px auto;"></div>
              <p style="margin:0; font-size:12px; font-weight:700; color:#0f172a;" id="report-display-chef-name">( ${reviewerName} )</p>
              <p style="margin:2px 0 0 0; font-size:11px; color:#64748b;" id="report-display-chef-pos">${reviewerPos}</p>
              <p style="margin:3px 0 0 0; font-size:11px; color:#64748b;" id="chef-sign-date-str">วันที่ ........ / ........ / ................</p>
            </td>

            <!-- ลำดับที่ 3: ผู้อนุมัติ / ผู้อำนวยการโรงพยาบาล -->
            <td style="width:33.33%; text-align:center; vertical-align:top; padding:0 8px;">
              <p style="margin:0 0 4px 0; font-size:12px; color:#334155; font-weight:600;">คำสั่งการ / ผู้อนุมัติ</p>
              
              <!-- ปุ่มกดเลือกคำสั่งการบนหน้าจอ (สำหรับผู้บริหาร executive หรือ admin) -->
              ${(currentUserRole === 'executive' || currentUserRole === 'admin') ? `
                <div class="no-print" style="display:inline-flex; gap:6px; margin-bottom:4px; background:#f1f5f9; padding:2px 6px; border-radius:9999px; border:1px solid #cbd5e1;">
                  <label style="display:flex; align-items:center; gap:4px; font-size:11px; font-weight:600; cursor:pointer; padding:2px 8px; border-radius:9999px; user-select:none; margin:0;"
                    id="lbl-appr-ack" onclick="setExecutiveApproval('acknowledge')">
                    <input type="radio" name="exec-decision" id="rad-appr-ack" value="acknowledge" style="cursor:pointer; accent-color:#0284c7; margin:0;" onchange="setExecutiveApproval('acknowledge')">
                    <span>รับทราบ</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:4px; font-size:11px; font-weight:600; cursor:pointer; padding:2px 8px; border-radius:9999px; user-select:none; margin:0;"
                    id="lbl-appr-repair" onclick="setExecutiveApproval('repair')">
                    <input type="radio" name="exec-decision" id="rad-appr-repair" value="repair" style="cursor:pointer; accent-color:#059669; margin:0;" onchange="setExecutiveApproval('repair')">
                    <span>อนุมัติซ่อมแซม</span>
                  </label>
                </div>
              ` : `
                <div class="no-print" style="display:inline-flex; gap:8px; margin-bottom:4px; padding:2px 8px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:6px; font-size:11px; color:#64748b;">
                  <span id="screen-view-ack">[ &nbsp; ] รับทราบ</span>
                  <span id="screen-view-repair">[ &nbsp; ] อนุมัติซ่อมแซม</span>
                </div>
              `}

              <!-- การแสดงผลคำสั่งการเวลาสั่งพิมพ์กระดาษ (Print View: ติ๊กถูกอัตโนมัติตามที่สั่งการ) -->
              <div class="only-print" style="margin-bottom:4px; font-size:11.5px; color:#1e293b;">
                <span style="margin-right:10px;" id="print-appr-ack">[ &nbsp; ] รับทราบ</span>
                <span id="print-appr-repair">[ &nbsp; ] อนุมัติซ่อมแซม</span>
              </div>

              <!-- ลายเซ็น/สถานะการลงนามคำสั่งการของผู้บริหาร -->
              <div id="exec-cert-container" style="margin-bottom:4px; min-height:26px;">
                <!-- จะถูกเติมแบบไดนามิกโดย renderExecutiveCertificationUI() -->
              </div>

              <div style="border-bottom:1px dotted #64748b; width:75%; margin:0 auto 4px auto;"></div>
              <p style="margin:0; font-size:12px; font-weight:700; color:#0f172a;" id="report-display-exec-name">( ${approverName} )</p>
              <p style="margin:2px 0 0 0; font-size:11px; color:#64748b;">${approverPos}</p>
              <p style="margin:3px 0 0 0; font-size:11px; color:#64748b;" id="exec-approval-date-str">วันที่ ........ / ........ / ................</p>
            </td>
          </tr>
        </table>
      </div>

      <!-- เอกสารแนบท้าย: บัญชีทะเบียนการตรวจสอบอุปกรณ์ทั้งหมดในงวด (ถ้ามี จะขึ้นหน้าใหม่ต่อจากส่วนลงนาม) -->
      ${includeAllItems ? `
        <div class="page-break"></div>
        <div class="report-section-title" style="margin-top:30px;">
          เอกสารแนบท้าย: บัญชีทะเบียนการตรวจสอบอุปกรณ์ทั้งหมดในงวด (${totalAssets} จุด)
        </div>
        <p style="font-size:12px; color:#475569; margin:0 0 10px 0;">
          รายละเอียดผลการประเมินสภาพความพร้อมใช้งานถังดับเพลิงและโคมไฟฉุกเฉินรายจุด ตามเกณฑ์มาตรฐาน HA (Part II: ENV)
        </p>
        <div class="report-table-scroll">
          <table class="report-table" style="margin:0;">
            <thead>
              <tr style="position:sticky; top:0; background:#f1f5f9; z-index:2;">
                <th style="width:35px; text-align:center;">#</th>
                <th style="width:110px;">รหัสอุปกรณ์</th>
                <th>ประเภท</th>
                <th>อาคาร / จุดติดตั้ง</th>
                <th style="width:90px; text-align:center;">สถานะ</th>
                <th style="width:90px; text-align:center;">วันที่ตรวจ</th>
                <th style="width:110px;">ผู้ตรวจ</th>
              </tr>
            </thead>
            <tbody>
              ${allItemsRowsHtml}
            </tbody>
          </table>
        </div>
      ` : `
        <div style="font-size:12px; color:#64748b; margin-top:20px; padding:10px 14px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:6px; font-style:italic;">
          📌 <b>หมายเหตุ:</b> บัญชีทะเบียนผลการตรวจอุปกรณ์รายจุดครบทั้ง ${totalAssets} จุด ถูกบันทึกและจัดเก็บไว้ในฐานข้อมูลดิจิทัล (สามารถเลือกติ๊ก 'รวมบัญชีทะเบียนอุปกรณ์ทั้งหมด' ด้านบน หากต้องการพิมพ์เอกสารแนบท้ายฉบับสมบูรณ์)
        </div>
      `}

    </div>
  `;

  container.innerHTML = fullReportHtml;
  window.restoreExecutiveApproval();
  if (typeof window.renderTechCertificationUI === 'function') {
    window.renderTechCertificationUI();
  }
  if (typeof window.renderChefCertificationUI === 'function') {
    window.renderChefCertificationUI();
  }
  if (typeof window.renderExecutiveCertificationUI === 'function') {
    window.renderExecutiveCertificationUI();
  }
  container.scrollIntoView({ behavior: 'smooth' });
};

window.simulateFullInspection = function () {
  if (currentUserRole === 'guest' || !currentUserRole) {
    alert("🔒 โหมดผู้เยี่ยมชม (Guest) ดูข้อมูลได้อย่างเดียวเท่านั้น\nกรุณาเข้าสู่ระบบด้วยบัญชีเจ้าหน้าที่เพื่อดำเนินการนี้");
    return;
  }
  if (!assetsList || assetsList.length === 0) {
    alert("ไม่พบข้อมูลอุปกรณ์ในระบบ กำลังโหลดข้อมูลเริ่มต้น...");
    initAssets();
    return;
  }

  const now = new Date();
  const officer = currentOfficer || "นายสมหมาย ใจดี (ช่างซ่อมบำรุง)";
  const nowStr = now.toLocaleString('th-TH');
  const nowIso = now.toISOString();

  // สร้าง simulated logs ใหม่
  const simLogs = [];

  assetsList.forEach((asset, idx) => {
    let status = "READY";
    let notes = "ตรวจเช็กสภาพสมบูรณ์ พร้อมใช้งาน 100%";
    let details = {};

    const isFE = asset.assetId.startsWith('PYH-FE') || asset.type.includes('ถังดับเพลิง');

    // จำลอง 3 จุดที่มีข้อบกพร่องตามสภาพการใช้งานจริงในโรงพยาบาล
    if (asset.assetId === 'PYH-FE-ER1-01') {
      status = "ISSUE";
      details = { body: "PASS", pressure: "FAIL", access: "PASS" };
      notes = "เกจ์วัดแรงดันตกต่ำกว่าขีดเขียว (Undercharged) และสายฉีดเริ่มมีรอยแตกลายงา";
    } else if (asset.assetId === 'PYH-EM-HPC-02') {
      status = "ISSUE";
      details = { light: "PASS", test: "FAIL", plug: "PASS" };
      notes = "กดปุ่มทดสอบ Test Switch แล้วไฟไม่สว่าง แบตเตอรี่เสื่อมสภาพไม่สำรองไฟ";
    } else if (asset.assetId === 'PYH-FE-IPD-03') {
      status = "ISSUE";
      details = { body: "FAIL", pressure: "PASS", access: "PASS" };
      notes = "สลักนิรภัย (Safety Pin) และสายซีลล็อคหลุดหาย ตัวถังมีรอยครูดถลอก";
    } else {
      if (isFE) {
        details = { body: "PASS", pressure: "PASS", access: "PASS" };
      } else {
        details = { light: "PASS", test: "PASS", plug: "PASS" };
      }
    }

    asset.status = status;
    asset.lastChecked = nowIso;
    asset.lastInspector = officer;

    simLogs.push({
      id: `SIM_LOG_${Date.now()}_${idx}`,
      assetId: asset.assetId,
      inspector: officer,
      status: status,
      details: details,
      notes: notes,
      photoURL: "",
      timestampStr: nowStr,
      timestampISO: nowIso
    });
  });

  inspectionLogs = simLogs;
  localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
  localStorage.setItem('pyh_inspection_logs', JSON.stringify(inspectionLogs));

  updateDashboardUI();
  renderMapPins();
  renderHistoryTable();
  window.renderSelectedReport();

  alert(`⚡ จำลองผลการตรวจเช็กเสร็จสิ้นครบ 100% (${assetsList.length} จุดตรวจ)\n• ผลปกติพร้อมใช้งาน: ${assetsList.filter(a => a.status === 'READY').length} จุด\n• พบข้อบกพร่องแจ้งซ่อม: ${assetsList.filter(a => a.status === 'ISSUE').length} จุด (ER1-01, HPC-02, IPD-03)\nระบบได้ประมวลผลรายงานสรุปเสนอผู้บริหารให้ทันทีด้านล่าง!`);
};

window.printExecutiveReport = function () {
  if (!requireLogin('สั่งพิมพ์รายงานสรุปผล')) return;
  const reportContainer = document.getElementById('report-content-body');
  if (!reportContainer || !reportContainer.innerHTML.trim()) {
    window.renderSelectedReport();
  }
  window.print();
};

window.setExecutiveApproval = async function (decision, syncCloud = true) {
  const radAck = document.getElementById('rad-appr-ack');
  const radRepair = document.getElementById('rad-appr-repair');
  const lblAck = document.getElementById('lbl-appr-ack');
  const lblRepair = document.getElementById('lbl-appr-repair');
  const printAck = document.getElementById('print-appr-ack');
  const printRepair = document.getElementById('print-appr-repair');
  const dateStrEl = document.getElementById('exec-approval-date-str');

  const isAck = (decision === 'acknowledge');

  if (radAck) radAck.checked = isAck;
  if (radRepair) radRepair.checked = !isAck;

  // ปรับสไตล์ปุ่มที่ถูกเลือกบนหน้าจอ
  if (lblAck) {
    if (isAck) {
      lblAck.style.background = '#0284c7';
      lblAck.style.color = '#ffffff';
      lblAck.style.boxShadow = '0 2px 6px rgba(2, 132, 199, 0.35)';
    } else {
      lblAck.style.background = 'transparent';
      lblAck.style.color = '#334155';
      lblAck.style.boxShadow = 'none';
    }
  }

  if (lblRepair) {
    if (!isAck) {
      lblRepair.style.background = '#059669';
      lblRepair.style.color = '#ffffff';
      lblRepair.style.boxShadow = '0 2px 6px rgba(5, 150, 105, 0.35)';
    } else {
      lblRepair.style.background = 'transparent';
      lblRepair.style.color = '#334155';
      lblRepair.style.boxShadow = 'none';
    }
  }

  // อัปเดตข้อความที่จะออกเวลาสั่งพิมพ์ลงกระดาษ A4
  if (printAck) {
    printAck.innerHTML = isAck ? '<b>[ ✓ ] รับทราบ</b>' : '[ &nbsp; ] รับทราบ';
  }
  if (printRepair) {
    printRepair.innerHTML = !isAck ? '<b>[ ✓ ] อนุมัติซ่อมแซม</b>' : '[ &nbsp; ] อนุมัติซ่อมแซม';
  }

  // อัปเดตมุมมองบนหน้าจอสำหรับผู้ใช้ทั่วไปที่ไม่ใช่ผู้บริหาร (Read-only)
  const screenAck = document.getElementById('screen-view-ack');
  const screenRepair = document.getElementById('screen-view-repair');
  if (screenAck) {
    screenAck.innerHTML = isAck ? '<b style="color:#0284c7;">[ ✓ ] รับทราบ</b>' : '[ &nbsp; ] รับทราบ';
  }
  if (screenRepair) {
    screenRepair.innerHTML = !isAck ? '<b style="color:#059669;">[ ✓ ] อนุมัติซ่อมแซม</b>' : '[ &nbsp; ] อนุมัติซ่อมแซม';
  }

  // บันทึกวันที่ปัจจุบัน (รูปแบบทางการ: วันที่ 8 กันยายน พ.ศ. 2569)
  const today = new Date();
  const fullThaiDateStr = formatThaiFullDate(today);
  if (dateStrEl) {
    dateStrEl.innerText = fullThaiDateStr;
  }

  // ลงนามดิจิทัลคำสั่งการของผู้บริหาร (ใช้เฉพาะชื่อ-นามสกุล)
  const approverName = getCleanName(document.getElementById('report-approver-name')?.value.trim() || (currentUserRole === 'executive' ? currentOfficer : "นางสาวศิริพรรณ ชมพูภู่"));
  const certData = {
    approver: approverName,
    decision: decision,
    decisionLabel: isAck ? 'รับทราบ' : 'อนุมัติซ่อมแซม',
    certifiedAt: today.toISOString(),
    certifiedDateStr: fullThaiDateStr,
    certifiedTimeStr: today.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  };

  try {
    localStorage.setItem('pyh_executive_decision', JSON.stringify({
      decision: decision,
      savedAt: today.toISOString()
    }));
    localStorage.setItem('pyh_exec_certification', JSON.stringify(certData));
  } catch (e) { }

  // ซิงก์ขึ้น Firestore กลางทันที เฉพาะเมื่อ syncCloud เป็นจริง และผู้ใช้ได้ล็อกอินมีสิทธิ์เท่านั้น
  const isExecOrAdmin = (currentUserRole === 'executive' || currentUserRole === 'admin');
  if (syncCloud && isExecOrAdmin && isFirebaseReady() && db && auth && auth.currentUser) {
    try {
      await setDoc(doc(db, "system_state", "report_certifications"), {
        exec_cert: certData,
        exec_decision: { decision: decision, savedAt: today.toISOString() },
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("Firestore sync exec_cert error:", e);
    }
  }

  renderExecutiveCertificationUI();
};

window.revokeExecutiveApproval = async function () {
  if (!confirm("ต้องการยกเลิกการลงนามคำสั่งการของผู้บริหารเพื่อแก้ไขใหม่ใช่ไหม?")) return;
  localStorage.removeItem('pyh_exec_certification');
  localStorage.removeItem('pyh_executive_decision');

  if (isFirebaseReady() && db) {
    try {
      await setDoc(doc(db, "system_state", "report_certifications"), {
        exec_cert: null,
        exec_decision: null,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("Firestore revoke exec_cert error:", e);
    }
  }

  const printAck = document.getElementById('print-appr-ack');
  const printRepair = document.getElementById('print-appr-repair');
  if (printAck) printAck.innerHTML = '[ &nbsp; ] รับทราบ';
  if (printRepair) printRepair.innerHTML = '[ &nbsp; ] อนุมัติซ่อมแซม';
  const screenAck = document.getElementById('screen-view-ack');
  const screenRepair = document.getElementById('screen-view-repair');
  if (screenAck) screenAck.innerHTML = '[ &nbsp; ] รับทราบ';
  if (screenRepair) screenRepair.innerHTML = '[ &nbsp; ] อนุมัติซ่อมแซม';
  const dateStrEl = document.getElementById('exec-approval-date-str');
  if (dateStrEl) dateStrEl.innerText = 'วันที่ ........ / ........ / ................';
  renderExecutiveCertificationUI();
};

window.renderExecutiveCertificationUI = function () {
  const container = document.getElementById('exec-cert-container');
  const nameEl = document.getElementById('report-display-exec-name');
  const dateEl = document.getElementById('exec-approval-date-str');
  if (!container) return;

  let cert = null;
  try {
    const raw = localStorage.getItem('pyh_exec_certification');
    if (raw) cert = JSON.parse(raw);
  } catch (e) { }

  const defaultApprover = getCleanName(document.getElementById('report-approver-name')?.value.trim() || "นางสาวศิริพรรณ ชมพูภู่");
  const canManage = (currentUserRole === 'executive' || currentUserRole === 'admin');

  if (cert && cert.approver) {
    const cleanName = getCleanName(cert.approver) || defaultApprover;
    if (nameEl) nameEl.innerHTML = `( ${cleanName} )`;
    
    // แปลงวันที่ให้เป็นรูปแบบ "วันที่ 8 กันยายน พ.ศ. 2569" เสมอ
    let displayDate = cert.certifiedDateStr;
    if (!displayDate || displayDate.includes('/')) {
      const dt = cert.certifiedAt ? new Date(cert.certifiedAt) : new Date();
      displayDate = formatThaiFullDate(isNaN(dt.getTime()) ? new Date() : dt);
    }
    if (dateEl) dateEl.innerText = displayDate;

    let sigVisualHtml = '';
    if (cert.signatureImg) {
      sigVisualHtml = `<img src="${cert.signatureImg}" alt="ลายมือชื่อ ผอ." style="max-height:48px; max-width:140px; object-fit:contain; display:block; margin:0 auto;">`;
    } else {
      sigVisualHtml = `
        <span style="font-family:'TH Sarabun New', 'Sarabun', 'Cordia New', sans-serif; font-size:16px; font-weight:700; color:#0f172a; letter-spacing:0.5px; font-style:italic; line-height:1.2;">
          ${cleanName}
        </span>
      `;
    }

    // แสดงเฉพาะลายมือชื่อ/รูปภาพลายเซ็นเหนือเส้นประ
    container.innerHTML = `
      <div style="min-height:36px; display:flex; flex-direction:column; align-items:center; justify-content:flex-end;">
        ${sigVisualHtml}
        ${canManage ? `
          <div class="no-print" style="display:flex; gap:6px; margin-top:2px;">
            <button onclick="openSignatureModal('executive')"
              style="background:none; border:none; color:#0284c7; font-size:9.5px; cursor:pointer; text-decoration:underline; padding:0;">
              (วาด/เปลี่ยนลายเซ็น)
            </button>
            <button onclick="revokeExecutiveApproval()"
              style="background:none; border:none; color:#dc2626; font-size:9.5px; cursor:pointer; text-decoration:underline; padding:0;">
              (ยกเลิก)
            </button>
          </div>
        ` : ''}
      </div>
    `;
  } else {
    if (nameEl) nameEl.innerHTML = `( ${defaultApprover} )`;
    if (canManage) {
      container.innerHTML = `
        <div class="no-print" style="margin-bottom:4px; display:flex; gap:4px; justify-content:center;">
          <button onclick="openSignatureModal('executive')" class="btn-sm"
            style="background:linear-gradient(135deg, #0284c7, #0369a1); color:white; font-size:10.5px; padding:3px 10px; font-weight:700; border:none; border-radius:9999px; cursor:pointer; box-shadow:0 2px 5px rgba(2,132,199,0.25);">
            ✍️ วาดลายเซ็น
          </button>
          <button onclick="setExecutiveApproval('acknowledge')" class="btn-sm"
            style="background:linear-gradient(135deg, #00897b, #004d40); color:white; font-size:10.5px; padding:3px 10px; font-weight:700; border:none; border-radius:9999px; cursor:pointer; box-shadow:0 2px 5px rgba(0,105,92,0.25);">
            ลงนามชื่อ
          </button>
        </div>
        <div class="only-print" style="height:20px;"></div>
      `;
    } else {
      container.innerHTML = `
        <div class="no-print" style="display:inline-block; padding:3px 8px; background:#fffbeb; border:1px dashed #f59e0b; border-radius:6px; font-size:10.5px; color:#b45309;">
          ⏳ รอผู้บริหารลงนามคำสั่งการ
        </div>
        <div class="only-print" style="height:20px;"></div>
      `;
    }
  }
};

// ฟังก์ชันดึงค่าที่เคยเลือกไว้กลับมาแสดง
window.restoreExecutiveApproval = function () {
  try {
    const rawCert = localStorage.getItem('pyh_exec_certification');
    if (rawCert) {
      const data = JSON.parse(rawCert);
      if (data && data.decision) {
        window.setExecutiveApproval(data.decision, false);
        return;
      }
    }
    const raw = localStorage.getItem('pyh_executive_decision');
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.decision) {
        window.setExecutiveApproval(data.decision, false);
        return;
      }
    }
  } catch (e) { }

  if (currentUserRole === 'executive') {
    const hasIssue = assetsList.some(a => a.status === 'ISSUE');
    window.setExecutiveApproval(hasIssue ? 'repair' : 'acknowledge', false);
  } else {
    renderExecutiveCertificationUI();
  }
};

window.autoLoadExecutiveFullReport = function () {
  const reportControlsCard = document.getElementById('report-controls-card');
  const execToolbar = document.getElementById('executive-report-toolbar');

  if (reportControlsCard) reportControlsCard.style.display = 'none';
  if (execToolbar) execToolbar.style.display = 'block';

  if (typeof window.renderSelectedReport === 'function') {
    window.renderSelectedReport();
  }
};

// ==========================================
// 12. การรับรองผลการตรวจเช็กโดยนายช่าง (Digital Technician Certification)
// ==========================================
window.certifyTechnicianInspection = async function () {
  if (currentUserRole !== 'inspector' && currentUserRole !== 'admin') {
    alert("❌ เฉพาะเจ้าหน้าที่ช่างตรวจเช็กหรือผู้ดูแลระบบเท่านั้นที่สามารถกดรับรองผลตรวจได้");
    return;
  }

  const cleanName = getCleanName(currentOfficer) || "นายสุวิทย์ พวงสมบัติ";
  const now = new Date();
  const fullThaiDateStr = formatThaiFullDate(now);
  const certData = {
    officer: cleanName,
    role: currentUserRole,
    certifiedAt: now.toISOString(),
    certifiedDateStr: fullThaiDateStr,
    certifiedTimeStr: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  };

  localStorage.setItem('pyh_tech_certification', JSON.stringify(certData));

  // ซิงก์ขึ้น Firestore กลางทันที เพื่อให้อุปกรณ์เครื่องอื่นเห็นตราประทับตรงกัน
  if (isFirebaseReady() && db) {
    try {
      await setDoc(doc(db, "system_state", "report_certifications"), {
        tech_cert: certData,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("Firestore sync tech_cert error:", e);
    }
  }

  alert(`✍️ นายช่าง [${certData.officer}] ได้ลงนามรับรองผลการตรวจเช็กเรียบร้อยแล้ว!\nระบบได้ส่งข้อมูลนี้ไปยังรายงานของผู้บริหารแล้ว`);
  renderTechCertificationUI();
};

window.revokeTechnicianInspection = async function () {
  if (!confirm("ต้องการยกเลิกการลงนามรับรองผลตรวจเพื่อแก้ไขข้อมูลใหม่ใช่ไหม?")) return;
  localStorage.removeItem('pyh_tech_certification');

  if (isFirebaseReady() && db) {
    try {
      await setDoc(doc(db, "system_state", "report_certifications"), {
        tech_cert: null,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("Firestore revoke tech_cert error:", e);
    }
  }

  const dateEl = document.getElementById('tech-sign-date-str');
  if (dateEl) dateEl.innerText = 'วันที่ ........ / ........ / ................';
  renderTechCertificationUI();
};

window.renderTechCertificationUI = function () {
  const container = document.getElementById('tech-cert-container');
  const nameEl = document.getElementById('report-display-tech-name');
  const dateEl = document.getElementById('tech-sign-date-str');
  if (!container) return;

  let cert = null;
  try {
    const raw = localStorage.getItem('pyh_tech_certification');
    if (raw) cert = JSON.parse(raw);
  } catch (e) { }

  const defaultTech = getCleanName(document.getElementById('report-author-name')?.value.trim() || "นายสุวิทย์ พวงสมบัติ");

  if (cert && cert.officer) {
    const cleanName = getCleanName(cert.officer) || defaultTech;
    if (nameEl) nameEl.innerHTML = `( ${cleanName} )`;

    // แปลงวันที่ให้เป็นรูปแบบ "วันที่ 8 กันยายน พ.ศ. 2569" เสมอ
    let displayDate = cert.certifiedDateStr;
    if (!displayDate || displayDate.includes('/')) {
      const dt = cert.certifiedAt ? new Date(cert.certifiedAt) : new Date();
      displayDate = formatThaiFullDate(isNaN(dt.getTime()) ? new Date() : dt);
    }
    if (dateEl) dateEl.innerText = displayDate;

    const canRevoke = (currentUserRole === 'inspector' || currentUserRole === 'admin');

    let sigVisualHtml = '';
    if (cert.signatureImg) {
      sigVisualHtml = `<img src="${cert.signatureImg}" alt="ลายมือชื่อ" style="max-height:48px; max-width:140px; object-fit:contain; display:block; margin:0 auto;">`;
    } else {
      sigVisualHtml = `
        <span style="font-family:'TH Sarabun New', 'Sarabun', 'Cordia New', sans-serif; font-size:16px; font-weight:700; color:#0f172a; letter-spacing:0.5px; font-style:italic; line-height:1.2;">
          ${cleanName}
        </span>
      `;
    }

    // แสดงเฉพาะลายมือชื่อ/ชื่อผู้ลงนามเหนือเส้นประ เหมือนลงนามในเอกสารราชการจริง (ไม่มีกรอบตราประทับ ไม่มีเวลา)
    container.innerHTML = `
      <div style="min-height:36px; display:flex; flex-direction:column; align-items:center; justify-content:flex-end;">
        ${sigVisualHtml}
        ${canRevoke ? `
          <div class="no-print" style="display:flex; gap:6px; margin-top:2px;">
            <button onclick="openSignatureModal('inspector')"
              style="background:none; border:none; color:#0284c7; font-size:9.5px; cursor:pointer; text-decoration:underline; padding:0;">
              (วาด/เปลี่ยนลายเซ็น)
            </button>
            <button onclick="revokeTechnicianInspection()"
              style="background:none; border:none; color:#dc2626; font-size:9.5px; cursor:pointer; text-decoration:underline; padding:0;">
              (ยกเลิก)
            </button>
          </div>
        ` : ''}
      </div>
    `;
  } else {
    if (nameEl) nameEl.innerHTML = `( ${defaultTech} )`;
    if (currentUserRole === 'inspector' || currentUserRole === 'admin') {
      container.innerHTML = `
        <div class="no-print" style="margin-bottom:4px; display:flex; gap:4px; justify-content:center;">
          <button onclick="openSignatureModal('inspector')" class="btn-sm"
            style="background:linear-gradient(135deg, #0284c7, #0369a1); color:white; font-size:10.5px; padding:3px 10px; font-weight:700; border:none; border-radius:9999px; cursor:pointer; box-shadow:0 2px 5px rgba(2,132,199,0.25);">
            ✍️ วาดลายเซ็น
          </button>
          <button onclick="certifyTechnicianInspection()" class="btn-sm"
            style="background:linear-gradient(135deg, #00897b, #004d40); color:white; font-size:10.5px; padding:3px 10px; font-weight:700; border:none; border-radius:9999px; cursor:pointer; box-shadow:0 2px 5px rgba(0,105,92,0.25);">
            รับรองชื่อ
          </button>
        </div>
        <div class="only-print" style="height:20px;"></div>
      `;
    } else {
      container.innerHTML = `
        <div class="no-print" style="display:inline-block; padding:3px 8px; background:#fffbeb; border:1px dashed #f59e0b; border-radius:6px; font-size:10.5px; color:#b45309;">
          ⏳ รอช่างเทคนิคลงนามรับรองผล
        </div>
        <div class="only-print" style="height:20px;"></div>
      `;
    }
  }
};

// ==========================================
// 13. การรับรองผลการตรวจสอบโดยหัวหน้าผู้ตรวจสอบ (Digital Reviewer / Chef Inspector Certification)
// ==========================================
window.certifyChefInspection = async function () {
  const isChefOrAdmin = (currentUserRole === 'chef_inspector' || currentUserRole === 'chef inspector' || currentUserRole === 'admin');
  if (!isChefOrAdmin) {
    alert("❌ เฉพาะหัวหน้าผู้ตรวจสอบ (Chef Inspector) หรือผู้ดูแลระบบเท่านั้นที่สามารถกดรับรองผลการตรวจสอบได้");
    return;
  }

  const cleanName = getCleanName(currentOfficer) || "นายคมสันต์ ศรีสิงห์";
  const now = new Date();
  const fullThaiDateStr = formatThaiFullDate(now);
  const certData = {
    officer: cleanName,
    role: currentUserRole,
    certifiedAt: now.toISOString(),
    certifiedDateStr: fullThaiDateStr,
    certifiedTimeStr: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  };

  localStorage.setItem('pyh_chef_certification', JSON.stringify(certData));

  // ซิงก์ขึ้น Firestore กลางทันที เพื่อให้อุปกรณ์เครื่องอื่นเห็นตราประทับตรงกัน
  if (isFirebaseReady() && db) {
    try {
      await setDoc(doc(db, "system_state", "report_certifications"), {
        chef_cert: certData,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("Firestore sync chef_cert error:", e);
    }
  }

  alert(`✍️ ผู้ตรวจสอบ [${certData.officer}] ได้ลงนามรับรองผลการตรวจสอบเรียบร้อยแล้ว!\nระบบได้ส่งข้อมูลนี้ไปยังรายงานของผู้บริหารแล้ว`);
  renderChefCertificationUI();
};

window.revokeChefInspection = async function () {
  if (!confirm("ต้องการยกเลิกการลงนามรับรองผลการตรวจสอบเพื่อแก้ไขข้อมูลใหม่ใช่ไหม?")) return;
  localStorage.removeItem('pyh_chef_certification');

  if (isFirebaseReady() && db) {
    try {
      await setDoc(doc(db, "system_state", "report_certifications"), {
        chef_cert: null,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn("Firestore revoke chef_cert error:", e);
    }
  }

  const dateEl = document.getElementById('chef-sign-date-str');
  if (dateEl) dateEl.innerText = 'วันที่ ........ / ........ / ................';
  renderChefCertificationUI();
};

window.setChefApproval = function(choice) {
  let cert = null;
  try {
    const raw = localStorage.getItem('pyh_chef_certification');
    if (raw) cert = JSON.parse(raw);
  } catch(e) {}

  const prevSig = cert?.signatureImg || null;
  const defaultChef = getCleanName(document.getElementById('report-reviewer-name')?.value.trim() || "นายคมสัน ศรีสิงห์");
  const now = new Date();
  const fullThaiDateStr = formatThaiFullDate(now);

  const certData = {
    officer: cert?.officer || defaultChef,
    role: 'chef_inspector',
    choice: choice, // 'ack' or 'approve'
    signatureImg: prevSig,
    certifiedAt: now.toISOString(),
    certifiedDateStr: fullThaiDateStr,
    certifiedTimeStr: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  };

  localStorage.setItem('pyh_chef_certification', JSON.stringify(certData));
  window.renderChefCertificationUI();
};

window.renderChefCertificationUI = function () {
  const container = document.getElementById('chef-cert-container');
  const memoContainer = document.getElementById('memo-chef-cert-container');
  const nameEl = document.getElementById('report-display-chef-name');
  const dateEl = document.getElementById('chef-sign-date-str');

  let cert = null;
  try {
    const raw = localStorage.getItem('pyh_chef_certification');
    if (raw) cert = JSON.parse(raw);
  } catch (e) { }

  const defaultChef = getCleanName(document.getElementById('report-reviewer-name')?.value.trim() || "นายคมสัน ศรีสิงห์");
  const isChefOrAdmin = (currentUserRole === 'chef_inspector' || currentUserRole === 'chef inspector' || currentUserRole === 'admin');

  // อัปเดตตัวเลือกในกล่องบันทึกข้อความ [ ] โปรดรับทราบ [ ] โปรดพิจารณาอนุมัติ
  const choice = cert?.choice || 'ack';
  const memoAckEl = document.getElementById('memo-chef-opt-ack');
  const memoApproveEl = document.getElementById('memo-chef-opt-approve');
  if (memoAckEl) {
    memoAckEl.innerHTML = (choice === 'ack') ? '<b>[ ✓ ] โปรดรับทราบ</b>' : '[ &nbsp; ] โปรดรับทราบ';
  }
  if (memoApproveEl) {
    memoApproveEl.innerHTML = (choice === 'approve') ? '<b>[ ✓ ] โปรดพิจารณาอนุมัติ</b>' : '[ &nbsp; ] โปรดพิจารณาอนุมัติ';
  }

  const cleanName = cert?.officer ? getCleanName(cert.officer) : defaultChef;

  let sigVisualHtml = '';
  if (cert && cert.signatureImg) {
    sigVisualHtml = `<img src="${cert.signatureImg}" alt="ลายมือชื่อ หน.กลุ่มงาน" style="max-height:48px; max-width:140px; object-fit:contain; display:block; margin:0 auto;">`;
  } else if (cert && cert.officer) {
    sigVisualHtml = `
      <span style="font-family:'TH Sarabun New', 'Sarabun', 'Cordia New', sans-serif; font-size:16px; font-weight:700; color:#0f172a; letter-spacing:0.5px; font-style:italic; line-height:1.2;">
        ${cleanName}
      </span>
    `;
  }

  // เติมลง memoContainer ในบันทึกข้อความ
  if (memoContainer) {
    if (sigVisualHtml) {
      memoContainer.innerHTML = `
        <div style="min-height:36px; display:flex; flex-direction:column; align-items:center; justify-content:flex-end;">
          ${sigVisualHtml}
          ${isChefOrAdmin ? `
            <div class="no-print" style="display:flex; gap:6px; margin-top:2px;">
              <button onclick="openSignatureModal('chef')"
                style="background:none; border:none; color:#4338ca; font-size:9.5px; cursor:pointer; text-decoration:underline; padding:0;">
                (วาด/เปลี่ยนลายเซ็น)
              </button>
              <button onclick="revokeChefInspection()"
                style="background:none; border:none; color:#dc2626; font-size:9.5px; cursor:pointer; text-decoration:underline; padding:0;">
                (ยกเลิก)
              </button>
            </div>
          ` : ''}
        </div>
      `;
    } else {
      memoContainer.innerHTML = `
        <div class="no-print" style="margin-bottom:4px;">
          <button onclick="openSignatureModal('chef')" class="btn-sm"
            style="background:linear-gradient(135deg, #4338ca, #3730a3); color:white; font-size:11px; padding:3px 12px; font-weight:700; border:none; border-radius:9999px; cursor:pointer; box-shadow:0 2px 6px rgba(67,56,202,0.25);">
            ✍️ เซ็นชื่อ หน.กลุ่มงาน
          </button>
        </div>
        <div class="only-print" style="height:20px;"></div>
      `;
    }
  }

  // เติมลง container ของรายงานสถิติละเอียด (Detailed Report)
  if (container) {
    if (nameEl) nameEl.innerHTML = `( ${cleanName} )`;

    let displayDate = cert?.certifiedDateStr;
    if (!displayDate || displayDate.includes('/')) {
      const dt = cert?.certifiedAt ? new Date(cert.certifiedAt) : new Date();
      displayDate = formatThaiFullDate(isNaN(dt.getTime()) ? new Date() : dt);
    }
    if (dateEl) dateEl.innerText = displayDate;

    if (sigVisualHtml) {
      container.innerHTML = `
        <div style="min-height:24px; display:flex; flex-direction:column; align-items:center; justify-content:flex-end;">
          ${sigVisualHtml}
          ${isChefOrAdmin ? `
            <button onclick="revokeChefInspection()" class="no-print"
              style="background:none; border:none; color:#dc2626; font-size:9.5px; cursor:pointer; text-decoration:underline; margin-top:1px; padding:0;">
              (ยกเลิก/ลงนามใหม่)
            </button>
          ` : ''}
        </div>
      `;
    } else {
      if (isChefOrAdmin) {
        container.innerHTML = `
          <div class="no-print" style="margin-bottom:4px;">
            <button onclick="openSignatureModal('chef')" class="btn-sm"
              style="background:linear-gradient(135deg, #4338ca, #3730a3); color:white; font-size:11px; padding:4px 12px; font-weight:700; border:none; border-radius:9999px; cursor:pointer; box-shadow:0 2px 6px rgba(67,56,202,0.25);">
              ✍️ ลงนามรับรองผลตรวจ
            </button>
          </div>
          <div class="only-print" style="height:20px;"></div>
        `;
      } else {
        container.innerHTML = `
          <div class="no-print" style="display:inline-block; padding:3px 8px; background:#fffbeb; border:1px dashed #f59e0b; border-radius:6px; font-size:10.5px; color:#b45309;">
            ⏳ รอผู้ตรวจสอบรับรองผล
          </div>
          <div class="only-print" style="height:20px;"></div>
        `;
      }
    }
  }
};



