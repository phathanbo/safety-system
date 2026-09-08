// firebase-config.js
// ระบบตรวจสอบความปลอดภัย - โรงพยาบาลพยุหะคีรี (Pyuha Safety System)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getFirestore, collection, addDoc, getDocs, doc, setDoc, getDoc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  getStorage, ref, uploadBytes, getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { 
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, 
  onAuthStateChanged, signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// *** Firebase Config - emergency-check-system ***
const firebaseConfig = {
  apiKey: "AIzaSyCyfdacNzBWR8MLQQ-JPQyDa80MuEo2xAM",
  authDomain: "emergency-check-system.firebaseapp.com",
  databaseURL: "https://emergency-check-system-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "emergency-check-system",
  storageBucket: "emergency-check-system.firebasestorage.app",
  messagingSenderId: "244835888874",
  appId: "1:244835888874:web:015cc54899dab4c4f3f193",
  measurementId: "G-SJ41PVF7G6"
};

// ฟังก์ชันตรวจสอบว่ามีการตั้งค่า Firebase จริงหรือยัง
export function isFirebaseReady() {
  return firebaseConfig.apiKey && 
         !firebaseConfig.apiKey.includes("YOUR_API_KEY") &&
         firebaseConfig.projectId &&
         firebaseConfig.projectId.length > 0;
}

let app = null;
let db = null;
let storage = null;
let auth = null;

try {
  if (isFirebaseReady()) {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    storage = getStorage(app);
    auth = getAuth(app);
    console.log("🔥 Connected to Firebase Services successfully");
  } else {
    console.warn("ℹ️ Running in Local / Demo mode. To connect to Cloud, update firebaseConfig in firebase-config.js");
  }
} catch (e) {
  console.warn("⚠️ Firebase init warning:", e.message);
}

export { 
  app,
  db, 
  storage, 
  auth,
  collection, 
  addDoc, 
  getDocs, 
  doc, 
  setDoc,
  getDoc,
  updateDoc, 
  deleteDoc,
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp,
  ref, 
  uploadBytes, 
  getDownloadURL,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
};
