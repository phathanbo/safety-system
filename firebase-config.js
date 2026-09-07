// firebase-config.js
// ระบบตรวจสอบความปลอดภัย - โรงพยาบาลพยุหะคีรี (Pyuha Safety System)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getFirestore, collection, addDoc, getDocs, doc, setDoc, getDoc, updateDoc, 
  query, orderBy, onSnapshot, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  getStorage, ref, uploadBytes, getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { 
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, 
  onAuthStateChanged, signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// *** นำค่า config จาก Firebase Console ของท่านมาใส่ตรงนี้ ***
const firebaseConfig = {
  apiKey: "AIzaSyYOUR_API_KEY",
  authDomain: "pyuha-safety.firebaseapp.com",
  projectId: "pyuha-safety",
  storageBucket: "pyuha-safety.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};

// ฟังก์ชันตรวจสอบว่ามีการตั้งค่า Firebase จริงหรือยัง
export function isFirebaseReady() {
  return firebaseConfig.apiKey && 
         !firebaseConfig.apiKey.includes("YOUR_API_KEY") &&
         firebaseConfig.projectId !== "pyuha-safety";
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
