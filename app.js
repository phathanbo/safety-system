// app.js
// ระบบตรวจสอบความปลอดภัยถังดับเพลิงและไฟฉุกเฉิน โรงพยาบาลพยุหะคีรี (Pyuha Safety System)

import { 
  db, storage, auth, isFirebaseReady,
  collection, addDoc, getDocs, doc, setDoc, getDoc, updateDoc, 
  query, orderBy, onSnapshot, serverTimestamp, ref, uploadBytes, getDownloadURL,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut
} from './firebase-config.js';

// ข้อมูลผังอาคารทั้ง 6 โซนของ รพ.พยุหะคีรี
const floorConfigs = {
  building_hpc: {
    name: 'อาคารส่งเสริมสุขภาพ',
    imageUrl: 'maps/hpc_floorplan.jpg',
    bounds: [[0, 0], [563, 1000]]
  },
  building_ipd: {
    name: 'อาคารผู้ป่วยใน (IPD)',
    imageUrl: 'maps/ipd_floorplan.jpg',
    bounds: [[0, 0], [563, 1000]]
  },
  building_nisit: {
    name: 'อาคารนิสิตคุณากร (Covid 19)',
    imageUrl: 'maps/nisit_floorplan.jpg',
    bounds: [[0, 0], [563, 1000]]
  },
  building_er_upper: {
    name: 'อาคารอุบัติเหตุ (ชั้นบน)',
    imageUrl: 'maps/er_upper_floorplan.jpg',
    bounds: [[0, 0], [563, 1000]]
  },
  building_er_lower: {
    name: 'อาคารอุบัติเหตุ (ชั้นล่าง)',
    imageUrl: 'maps/er_lower_floorplan.jpg',
    bounds: [[0, 0], [563, 1000]]
  },
  building_opd_dm: {
    name: 'ห้องเบาหวาน ตึก OPD',
    imageUrl: 'maps/opd_dm_floorplan.jpg',
    bounds: [[0, 0], [563, 1000]]
  }
};

let currentOfficer = localStorage.getItem('pyh_officer') || "นายสุวิทย์ พวงสมบัติ (นายช่างเทคนิค)";
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
// 1. การสลับแท็บเมนู
// ==========================================
window.switchTab = function(tabId) {
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
    }, 150);
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
// 2. จัดการข้อมูลอุปกรณ์ (Assets Initialization)
// ==========================================
async function initAssets() {
  const localSaved = localStorage.getItem('pyh_assets_data');
  if (localSaved) {
    try {
      assetsList = JSON.parse(localSaved);
    } catch(e) {
      console.warn("Failed to parse local assets", e);
    }
  }

  // หากไม่มีข้อมูล ให้โหลดจาก initial_assets.json
  if (!assetsList || assetsList.length === 0) {
    try {
      const resp = await fetch('initial_assets.json');
      const data = await resp.json();
      assetsList = data.assets || [];
      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
    } catch(e) {
      console.error("Could not load initial_assets.json", e);
    }
  }

  // โหลดประวัติการตรวจที่มีในเครื่อง
  const localLogs = localStorage.getItem('pyh_inspection_logs');
  if (localLogs) {
    try {
      inspectionLogs = JSON.parse(localLogs);
    } catch(e) {}
  }

  // หากเปิดใช้ Firebase จริง ให้ซิงก์จาก Firestore
  if (isFirebaseReady() && db) {
    try {
      const q = collection(db, "assets");
      onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
          const cloudAssets = [];
          snapshot.forEach(d => cloudAssets.push({ firestoreId: d.id, ...d.data() }));
          assetsList = cloudAssets;
          localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));
        }
        updateDashboardUI();
        renderMapPins();
      });

      const qLogs = query(collection(db, "inspection_logs"), orderBy("timestamp", "desc"));
      onSnapshot(qLogs, (snapshot) => {
        inspectionLogs = [];
        snapshot.forEach(d => inspectionLogs.push({ id: d.id, ...d.data() }));
        renderHistoryTable();
      });
    } catch(e) {
      console.warn("Firebase sync error, using local fallback", e);
    }
  }

  updateDashboardUI();
  renderHistoryTable();
  initMap();
}

// อัปเดตข้อมูลสรุป Dashboard & KPIs
function updateDashboardUI() {
  const total = assetsList.length;
  const ready = assetsList.filter(a => a.status === 'READY').length;
  const issue = assetsList.filter(a => a.status === 'ISSUE').length;
  const checkedThisMonth = assetsList.filter(a => a.lastChecked).length;
  const coverageRate = total > 0 ? Math.round((checkedThisMonth / total) * 100) : 0;

  const totalEl = document.getElementById('total-count');
  const readyEl = document.getElementById('ready-count');
  const issueEl = document.getElementById('issue-count');
  const rateEl = document.getElementById('coverage-rate');

  if (totalEl) totalEl.innerText = total;
  if (readyEl) readyEl.innerText = ready;
  if (issueEl) issueEl.innerText = issue;
  if (rateEl) rateEl.innerText = `${coverageRate}%`;
}

// ==========================================
// 3. แผนที่ Leaflet (Campus + 6 Floor Plans)
// ==========================================
function initMap() {
  const mapElem = document.getElementById('floor-map');
  if (!mapElem) return;

  // สร้าง Map Instance เริ่มต้น
  map = L.map('floor-map', {
    crs: L.CRS.Simple,
    minZoom: -1,
    maxZoom: 2
  });

  changeMapLevel();
}

window.changeMapLevel = function() {
  const selectedMode = document.getElementById('map-mode-select').value;
  currentMapMode = selectedMode;

  if (currentTileLayer && map.hasLayer(currentTileLayer)) map.removeLayer(currentTileLayer);
  if (currentOverlayLayer && map.hasLayer(currentOverlayLayer)) map.removeLayer(currentOverlayLayer);
  markers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
  markers = [];

  if (selectedMode === 'campus') {
    map.options.crs = L.CRS.EPSG3857;
    currentTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
      maxZoom: 19,
      attribution: '© OpenStreetMap - รพ.พยุหะคีรี'
    }).addTo(map);
    map.setView([15.4544, 100.1347], 18);
  } else {
    const cfg = floorConfigs[selectedMode];
    if (!cfg) return;

    map.options.crs = L.CRS.Simple;
    currentOverlayLayer = L.imageOverlay(cfg.imageUrl, cfg.bounds).addTo(map);
    map.fitBounds(cfg.bounds);
  }

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

window.startRelocatePin = function(assetId) {
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
    map.once('click', function(e) {
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

window.cancelRelocatePin = function() {
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

window.startAddAssetOnDashboard = function() {
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
    map.once('click', function(e) {
      if (!isAddingAssetOnDashboard) return;

      if (currentMapMode === 'campus') {
        quickAddCampusCoord = { lat: e.latlng.lat, lng: e.latlng.lng };
        quickAddFloorCoord = [280, 500];
      } else {
        const newY = Math.round(e.latlng.lat);
        const newX = Math.round(e.latlng.lng);
        quickAddFloorCoord = [newY, newX];
        quickAddCampusCoord = { lat: 15.4544, lng: 100.1347 };
      }

      window.cancelAddAssetOnDashboard();
      window.openQuickAddModal();
    });
  }
};

window.cancelAddAssetOnDashboard = function() {
  isAddingAssetOnDashboard = false;
  const addBanner = document.getElementById('map-add-asset-banner');
  if (addBanner) addBanner.style.display = 'none';
  if (map) map.getContainer().style.cursor = '';
};

window.openQuickAddModal = function() {
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

window.closeQuickAddModal = function() {
  const modal = document.getElementById('quick-add-modal');
  if (modal) modal.classList.add('hidden');
  isAddingAssetOnDashboard = false;
};

window.autoSuggestQuickAddId = function() {
  const typeSelect = document.getElementById('quick-add-type');
  const idInput = document.getElementById('quick-add-id');
  if (!idInput) return;

  const isFE = typeSelect ? (typeSelect.value.includes('ถังดับเพลิง') || typeSelect.value.includes('Dry') || typeSelect.value.includes('CO2')) : true;
  const prefix = isFE ? 'PYH-FE-' : 'PYH-EM-';

  let maxNum = 0;
  assetsList.forEach(a => {
    if (a.assetId && a.assetId.startsWith(prefix)) {
      const numPart = parseInt(a.assetId.replace(prefix, ''), 10);
      if (!isNaN(numPart) && numPart > maxNum) maxNum = numPart;
    }
  });

  const nextNum = String(maxNum + 1).padStart(2, '0');
  idInput.value = `${prefix}${nextNum}`;
};

window.submitQuickAddAsset = async function() {
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
  localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

  if (isFirebaseReady() && db) {
    try {
      const docRef = await addDoc(collection(db, "assets"), {
        ...newAsset,
        createdAt: serverTimestamp()
      });
      newAsset.firestoreId = docRef.id;
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

  if (currentMapMode === 'campus') {
    assetsList.forEach(item => {
      if (!item.campusCoord) return;
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

        marker.on('dragstart', function() {
          marker.closePopup();
          if (map) map.dragging.disable();
        });

        marker.on('dragend', function(e) {
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
          <b>${item.assetId}</b><br>
          ${item.type}<br>
          ${item.building} (${item.location})<br>
          สถานะ: <b style="color:${color}">${isReady ? 'พร้อมใช้งาน' : 'ชำรุด/แจ้งซ่อม'}</b><br>
          ${adminPopupHtml}
          <button onclick="handleScanned('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background:#00695c; color:white;">ตรวจเช็กจุดนี้</button>
        </div>
      `);
      markers.push(marker);
    });
  } else {
    // ปักหมุดบนผังอาคาร
    const buildingAssets = assetsList.filter(a => a.buildingId === currentMapMode);
    buildingAssets.forEach(item => {
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

        marker.on('dragstart', function() {
          marker.closePopup();
          if (map) map.dragging.disable();
        });

        marker.on('dragend', function(e) {
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
          <strong style="color: #0284c7;">${item.assetId}</strong><br>
          <b>ประเภท:</b> ${item.type}<br>
          <b>จุดติดตั้ง:</b> ${item.location}<br>
          <b>สถานะ:</b> <span style="color:${pinColor}; font-weight:bold;">
            ${isReady ? 'พร้อมใช้งาน' : 'ชำรุด/แจ้งซ่อม'}
          </span><br>
          ${adminPopupHtml}
          <button onclick="handleScanned('${item.assetId}')" class="btn-sm" style="margin-top:6px; width:100%; background: #00695c; color: white;">
            บันทึกตรวจเช็กจุดนี้
          </button>
        </div>
      `);
      markers.push(marker);
    });
  }
}

window.locateUserGPS = function() {
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
function startScanner() {
  const qrBox = document.getElementById("qr-reader");
  if (!qrBox) return;

  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("qr-reader");
  }
  
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      stopScanner();
      handleScanned(decodedText.trim());
    },
    () => {}
  ).catch(err => {
    console.log("Scanner warning:", err);
  });
}

window.stopScanner = function() {
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(()=>{});
  }
};

// ==========================================
// 5. จัดการแบบฟอร์มตรวจสอบ (Checklist FE vs EM)
// ==========================================
window.handleScanned = function(assetId) {
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
      const namePart = currentOfficer ? currentOfficer.split(String.fromCharCode(40))[0].trim() : 'นายสมหมาย ใจดี';
      const rolePart = (currentOfficer && currentOfficer.includes(String.fromCharCode(40)))
        ? currentOfficer.split(String.fromCharCode(40))[1].replace(String.fromCharCode(41), '').trim()
        : 'ช่างซ่อมบำรุง / งานอาคารสถานที่';
      nameInput.value = namePart;
      roleInput.value = rolePart;
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

      // จัดการภาพถ่าย (Firebase Storage หรือ Data URL Fallback)
      if (photoFile) {
        if (isFirebaseReady() && storage) {
          const storageRef = ref(storage, `inspections/${assetId}_${Date.now()}.jpg`);
          const uploadRes = await uploadBytes(storageRef, photoFile);
          photoURL = await getDownloadURL(uploadRes.ref);
        } else {
          photoURL = await readFileAsDataURL(photoFile);
        }
      }

      // ดึงชื่อและตำแหน่งช่างที่กรอกจากแบบฟอร์ม
      const inspectorName = document.getElementById('inspect-inspector-name')?.value.trim() || 'นายสมหมาย ใจดี';
      const inspectorRole = document.getElementById('inspect-inspector-role')?.value.trim() || 'ช่างซ่อมบำรุง';
      const inspectorFullName = inspectorRole ? `${inspectorName} (${inspectorRole})` : inspectorName;
      currentOfficer = inspectorFullName;
      saveUserSession(currentOfficer, currentUserRole);

      const now = new Date();
      const logEntry = {
        id: `LOG_${Date.now()}`,
        assetId: assetId,
        inspector: inspectorFullName,
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
      assetsList[assetIndex].lastInspector = inspectorFullName;
      assetsList[assetIndex].lastPhoto = photoURL;
      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

      if (isFirebaseReady() && db && assetsList[assetIndex].firestoreId) {
        await updateDoc(doc(db, "assets", assetsList[assetIndex].firestoreId), {
          status: isPass ? "READY" : "ISSUE",
          lastChecked: serverTimestamp(),
          lastInspector: inspectorFullName,
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

window.initRegisterMap = function() {
  const regMapElem = document.getElementById('register-map');
  if (!regMapElem) return;

  if (!registerMap) {
    registerMap = L.map('register-map', {
      crs: L.CRS.Simple,
      minZoom: -1,
      maxZoom: 1
    });

    registerMap.on('click', function(e) {
      const y = Math.round(e.latlng.lat);
      const x = Math.round(e.latlng.lng);
      setRegisterCoords(y, x);
    });
  }

  window.updateRegisterMapFloor();
};

window.updateRegisterMapFloor = function() {
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
  registerMap.fitBounds(cfg.bounds);

  const curY = parseInt(document.getElementById('reg-coord-y').value) || 280;
  const curX = parseInt(document.getElementById('reg-coord-x').value) || 500;
  setRegisterCoords(curY, curX);
  setTimeout(() => registerMap.invalidateSize(), 250);
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
      html: '<div class="admin-draggable-pin" style="background:#0284c7; border:2px solid #ffffff; box-shadow:0 0 8px rgba(0,0,0,0.5); width:20px; height:20px; border-radius:50%; cursor:grab;"></div>',
      className: 'custom-pin-container',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    registerMarker = L.marker([y, x], {
      icon: pinIcon,
      draggable: true,
      title: 'คลิกลากเพื่อกำหนดจุดติดตั้ง'
    }).addTo(registerMap);

    registerMarker.on('dragend', function(e) {
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
    const campusCoord = { lat: 15.4544, lng: 100.1347 };

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
        const docRef = await addDoc(collection(db, "assets"), {
          ...newAsset,
          serverCreated: serverTimestamp()
        });
        newAsset.firestoreId = docRef.id;
      } catch(err) {
        console.warn("Firestore add error:", err);
      }
    }

    assetsList.push(newAsset);
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
    alert(`ลงทะเบียนอุปกรณ์ ${assetId} สำเร็จ! พร้อมพิมพ์สติกเกอร์`);
  });
}

// ==========================================
// 7. ประวัติการตรวจ (Audit Trail)
// ==========================================
function renderHistoryTable() {
  const tbody = document.getElementById('history-rows');
  if (!tbody) return;
  tbody.innerHTML = "";

  if (inspectionLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#64748b; padding:20px;">ยังไม่มีประวัติการตรวจเช็ก</td></tr>`;
    return;
  }

  inspectionLogs.slice(0, 50).forEach(log => {
    const isPass = log.status === 'READY';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${log.timestampStr || log.timestampISO || '-'}</td>
      <td><b>${log.assetId}</b></td>
      <td>${log.inspector || '-'}</td>
      <td><span class="badge ${isPass ? 'badge-ready' : 'badge-issue'}">${isPass ? 'ปกติ' : 'ชำรุด'}</span></td>
      <td>${log.photoURL ? `<a href="${log.photoURL}" target="_blank"><img class="img-thumb" src="${log.photoURL}" alt="ภาพหลักฐาน"></a>` : '-'}</td>
      <td>${log.notes || '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================
// 8. การสำรองข้อมูลและการโอนย้าย (Backup & Migration)
// ==========================================
window.exportSystemData = function() {
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
    a.download = `backup_pyuha_safety_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    alert("ดาวน์โหลดไฟล์สำรองข้อมูล (JSON) สำเร็จแล้ว สามารถนำไปใช้ในระบบของโรงพยาบาลได้ทันที");
  } catch(e) {
    alert("เกิดข้อผิดพลาดในการส่งออกข้อมูล: " + e.message);
  }
};

window.importSystemData = function(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.assets) throw new Error("รูปแบบไฟล์ JSON ไม่ถูกต้อง");

      if (!confirm(`พบข้อมูลอุปกรณ์ ${data.assets.length} จุด ยืนยันการนำเข้าข้อมูลหรือไม่?`)) return;

      assetsList = data.assets;
      localStorage.setItem('pyh_assets_data', JSON.stringify(assetsList));

      if (data.inspection_logs) {
        inspectionLogs = data.inspection_logs;
        localStorage.setItem('pyh_inspection_logs', JSON.stringify(inspectionLogs));
      }

      // หากมี Firebase พร้อม ให้บันทึกลง Cloud
      if (isFirebaseReady() && db) {
        for (const item of assetsList) {
          const { firestoreId, ...cleanAsset } = item;
          await addDoc(collection(db, "assets"), cleanAsset);
        }
      }

      alert("นำเข้าข้อมูลสำเร็จครบถ้วน!");
      location.reload();
    } catch(err) {
      alert("นำเข้าข้อมูลไม่สำเร็จ: " + err.message);
    }
  };
  reader.readAsText(file);
};

// ==========================================
// 9. ระบบจัดการผู้ใช้และระดับสิทธิ์ (RBAC) & ผู้ดูแลระบบ (Admin)
// ==========================================
const DEFAULT_SYSTEM_USERS = [
  {
    name: "ผู้ดูแลระบบไอทีและอาคาร",
    dept: "ศูนย์สารสนเทศและเทคโนโลยี รพ.พยุหะคีรี",
    email: "admin@pyuhahospital.go.th",
    password: "admin1234",
    role: "admin",
    verified: true,
    createdAt: "2026-09-01T08:00:00.000Z"
  },
  {
    name: "นายสุวิทย์ พวงสมบัติ",
    dept: "นายช่างเทคนิค",
    email: "suwit@pyuhahospital.go.th",
    password: "123456",
    role: "inspector",
    verified: true,
    createdAt: "2026-09-01T08:30:00.000Z"
  },
  {
    name: "นางสาวศิริพรรณ ชมพูภู่",
    dept: "ผู้อำนวยการโรงพยาบาลพยุหะคีรี",
    email: "director@pyuhahospital.go.th",
    password: "123456",
    role: "executive",
    verified: true,
    createdAt: "2026-09-01T09:00:00.000Z"
  }
];

function getStoredUsers() {
  try {
    const raw = localStorage.getItem('pyh_system_users');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn("Error reading users from localStorage", e);
  }
  localStorage.setItem('pyh_system_users', JSON.stringify(DEFAULT_SYSTEM_USERS));
  return DEFAULT_SYSTEM_USERS;
}

function saveStoredUsers(users) {
  localStorage.setItem('pyh_system_users', JSON.stringify(users));
}

window.openAuthModal = function() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('hidden');
};

window.closeAuthModal = function() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('hidden');
};

window.toggleAuthMode = function(mode) {
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

window.loginWithEmail = async function() {
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

    currentOfficer = user.name + " " + String.fromCharCode(40) + user.dept + String.fromCharCode(41);
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

window.registerUser = async function() {
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
    } catch(err) {
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
window.adminCreateTechnician = function() {
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
window.adminVerifyUser = function(userEmail) {
  const users = getStoredUsers();
  const user = users.find(u => u.email.toLowerCase() === userEmail.toLowerCase());
  if (!user) return;

  user.verified = true;
  saveStoredUsers(users);
  window.renderAdminUserList();
  alert("ยืนยันตัวตนและอนุมัติสิทธิ์ให้: " + user.name + " เรียบร้อยแล้ว");
};

// ฟังก์ชันสำหรับแอดมิน: รีเซ็ตรหัสผ่าน
window.adminResetPassword = function(userEmail) {
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
window.adminDeleteUser = function(userEmail) {
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
window.renderAdminUserList = function() {
  const tbody = document.getElementById('admin-users-table-body');
  if (!tbody) return;

  const users = getStoredUsers();
  let html = '';

  users.forEach(u => {
    const roleLabel = u.role === 'admin' 
      ? '👨‍💼 ผู้ดูแลระบบ' 
      : u.role === 'executive' 
        ? '👩‍⚕️ ผู้บริหาร / ผอ.' 
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
  localStorage.setItem('pyh_officer', name);
  localStorage.setItem('pyh_role', role);
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
    if (role === 'admin') roleEl.innerText = 'ผู้ดูแลระบบ (Admin)';
    else if (role === 'executive') roleEl.innerText = 'ผู้อำนวยการ / ผู้บริหาร รพ.';
    else roleEl.innerText = 'เจ้าหน้าที่ผู้ตรวจเช็ก (Inspector)';
  }
  if (badgeOfficer) badgeOfficer.innerText = name;

  // ควบคุมแท็บเมนูตามสิทธิ์การใช้งาน (RBAC)
  const navDashboard = document.getElementById('tab-nav-dashboard');
  const navScanner = document.getElementById('tab-nav-scanner');
  const navRegister = document.getElementById('tab-nav-register');
  const navHistory = document.getElementById('tab-nav-history');
  const navReport = document.getElementById('tab-nav-report');
  const navBackup = document.getElementById('tab-nav-backup');
  const navAdmin = document.getElementById('tab-nav-admin');

  const reportControlsCard = document.getElementById('report-controls-card');
  const execToolbar = document.getElementById('executive-report-toolbar');
  const adminNotice = document.getElementById('admin-map-drag-notice');
  const adminAddAssetBtn = document.getElementById('admin-add-asset-btn');

  currentUserRole = role;
  document.body.classList.remove('role-admin', 'role-executive', 'role-inspector');
  document.body.classList.add('role-' + role);

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

  } else {
    // 3. แอดมิน: แสดงครบทุกแท็บ และเปิดโหมดขยับจุดติดตั้ง + ปุ่มเพิ่มจุดติดตั้งบนผัง
    if (navDashboard) navDashboard.style.display = 'inline-block';
    if (navScanner) navScanner.style.display = 'inline-block';
    if (navRegister) navRegister.style.display = 'inline-block';
    if (navHistory) navHistory.style.display = 'inline-block';
    if (navReport) navReport.style.display = 'inline-block';
    if (navBackup) navBackup.style.display = 'inline-block';
    if (navAdmin) navAdmin.style.display = 'inline-block';

    if (adminNotice) adminNotice.classList.remove('hidden');
    if (adminAddAssetBtn) adminAddAssetBtn.style.display = 'inline-block';
  }

  // อัปเดตหมุดบนแผนที่ตามสิทธิ์ (Admin สามารถลากได้)
  if (typeof renderMapPins === 'function') {
    renderMapPins();
  }
}

window.logoutUser = function() {
  if (isFirebaseReady() && auth) {
    signOut(auth);
  }
  localStorage.removeItem('pyh_officer');
  localStorage.removeItem('pyh_role');
  currentOfficer = "นายสุวิทย์ พวงสมบัติ " + String.fromCharCode(40) + "นายช่างเทคนิค" + String.fromCharCode(41);
  currentUserRole = "inspector";
  applyUserSession(currentOfficer, currentUserRole);
  document.getElementById('auth-modal').classList.remove('hidden');
};

window.setOfficerProfile = function() {
  const newName = prompt("กรุณาระบุชื่อและตำแหน่งผู้ตรวจเช็ก:", currentOfficer);
  if (newName && newName.trim()) {
    currentOfficer = newName.trim();
    saveUserSession(currentOfficer, currentUserRole);
  }
};

// ==========================================
// 10. เริ่มต้นการทำงาน (Window Load)
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
  getStoredUsers();
  applyUserSession(currentOfficer, currentUserRole);
  initAssets();
  if (currentUserRole === 'admin' && typeof window.renderAdminUserList === 'function') {
    window.renderAdminUserList();
  }

  if (isFirebaseReady() && auth) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (userDoc.exists()) {
          const profile = userDoc.data();
          currentOfficer = `${profile.name} (${profile.department})`;
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
  building_opd_dm: { name: 'ห้องเบาหวาน ตึก OPD', short: 'OPD เบาหวาน' }
};

window.generateExecutiveReport = function() {
  const container = document.getElementById('report-content-body');
  if (!container) return;

  const period = document.getElementById('report-period')?.value || "กันยายน 2569";
  const buildingFilter = document.getElementById('report-building-filter')?.value || "all";

  // ส่วนที่ 1: ผู้จัดทำและเสนอรายงาน
  const authorName = document.getElementById('report-author-name')?.value.trim() || "นายสุวิทย์ พวงสมบัติ";
  const authorPos = document.getElementById('report-author-pos')?.value.trim() || "นายช่างเทคนิค";
  const author = `${authorName} (${authorPos})`;

  // ส่วนที่ 2: ผู้บริหารผู้อนุมัติคำสั่งการ
  const approverName = document.getElementById('report-approver-name')?.value.trim() || "นางสาวศิริพรรณ ชมพูภู่";
  const approverPos = document.getElementById('report-approver-pos')?.value.trim() || "ผู้อำนวยการโรงพยาบาลพยุหะคีรี";
  const approver = `${approverName} (${approverPos})`;

  const includeAllItems = document.getElementById('report-include-all-items')?.checked ?? true;

  const targetAssets = (buildingFilter === 'all')
    ? assetsList
    : assetsList.filter(a => a.buildingId === buildingFilter);

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
          <td>${item.type}</td>
          <td><b>${item.building}</b><br><span style="color:#64748b; font-size:11.5px;">${item.location}</span></td>
          <td style="color:#b91c1c;">${note}</td>
          <td>${item.lastInspector || '-'}</td>
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
    const checkedDate = a.lastChecked ? new Date(a.lastChecked).toLocaleDateString('th-TH') : 'ยังไม่ได้ตรวจ';
    allItemsRowsHtml += `
      <tr>
        <td style="text-align:center; font-size:11px;">${i + 1}</td>
        <td><b>${a.assetId}</b></td>
        <td>${a.type}</td>
        <td>${a.building} - ${a.location}</td>
        <td style="text-align:center;">
          <span class="badge ${isReady ? 'badge-ready' : 'badge-issue'}">
            ${isReady ? 'พร้อมใช้งาน' : 'ชำรุด/แจ้งซ่อม'}
          </span>
        </td>
        <td style="text-align:center; font-size:11.5px;">${checkedDate}</td>
        <td style="font-size:11.5px;">${a.lastInspector || '-'}</td>
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

      <!-- เอกสารแนบท้าย: บัญชีทะเบียนการตรวจสอบอุปกรณ์ทั้งหมดในงวด -->
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
  container.scrollIntoView({ behavior: 'smooth' });
};

window.simulateFullInspection = function() {
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
  window.generateExecutiveReport();

  alert(`⚡ จำลองผลการตรวจเช็กเสร็จสิ้นครบ 100% (${assetsList.length} จุดตรวจ)\n• ผลปกติพร้อมใช้งาน: ${assetsList.filter(a => a.status === 'READY').length} จุด\n• พบข้อบกพร่องแจ้งซ่อม: ${assetsList.filter(a => a.status === 'ISSUE').length} จุด (ER1-01, HPC-02, IPD-03)\nระบบได้ประมวลผลรายงานสรุปเสนอผู้บริหารให้ทันทีด้านล่าง!`);
};

window.printExecutiveReport = function() {
  const reportContainer = document.getElementById('report-content-body');
  if (!reportContainer || !reportContainer.innerHTML.trim()) {
    window.generateExecutiveReport();
  }
  window.print();
};

window.autoLoadExecutiveFullReport = function() {
  const reportControlsCard = document.getElementById('report-controls-card');
  const execToolbar = document.getElementById('executive-report-toolbar');

  if (reportControlsCard) reportControlsCard.style.display = 'none';
  if (execToolbar) execToolbar.style.display = 'block';

  if (typeof window.generateExecutiveReport === 'function') {
    window.generateExecutiveReport();
  }
};


